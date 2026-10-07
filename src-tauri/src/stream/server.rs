//! The overlay's HTTP server: 127.0.0.1 only, one short-lived task per
//! connection, at most `MAX_CONNECTIONS` at once. Routing and token checks
//! are `glitch_core::stream::http::route` (unit-tested there).

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use glitch_core::stream::http::{self, HttpError, Route};
use glitch_core::stream::parse_webhook_json;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast::error::RecvError;

use super::{emit_status, StreamHub};

const MAX_CONNECTIONS: usize = 32;
/// Overlay pages connected at once (OBS + a preview or two is plenty).
const MAX_EVENT_STREAMS: u64 = 8;
/// A request head + body must arrive within this.
const READ_TIMEOUT: Duration = Duration::from_secs(5);
/// Event streams get a comment line this often (keeps proxies and OBS happy, notices closed pages).
const KEEPALIVE: Duration = Duration::from_secs(15);

/// The page's own rules: scripts, styles and images from this server only;
/// it may talk only to this server.
const PAGE_CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/// `tokens`: (view token, write token).
pub async fn serve(app: AppHandle, port: u16, tokens: (String, String), alive: Arc<AtomicBool>) {
    let listener = match TcpListener::bind(("127.0.0.1", port)).await {
        Ok(l) => l,
        Err(e) => {
            let msg = if e.kind() == std::io::ErrorKind::AddrInUse {
                format!("Port {port} is already in use by another program. Pick another port.")
            } else {
                format!("Couldn't start the overlay server: {e}")
            };
            eprintln!("glitch: stream overlay: {msg}");
            *app.state::<StreamHub>().error.lock().unwrap() = Some(msg);
            emit_status(&app);
            return;
        }
    };
    eprintln!("glitch: stream overlay on http://127.0.0.1:{port}/overlay");
    emit_status(&app);
    let open = Arc::new(AtomicUsize::new(0));
    loop {
        let Ok((sock, _)) = listener.accept().await else { continue };
        if open.load(Ordering::Relaxed) >= MAX_CONNECTIONS {
            drop(sock);
            continue;
        }
        open.fetch_add(1, Ordering::Relaxed);
        let (app, tokens, open, alive) = (app.clone(), tokens.clone(), open.clone(), alive.clone());
        tauri::async_runtime::spawn(async move {
            let _ = handle(&app, sock, port, &tokens, &alive).await;
            open.fetch_sub(1, Ordering::Relaxed);
        });
    }
}

async fn read_request(sock: &mut TcpStream) -> Result<(http::Request, Vec<u8>), u16> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 2048];
    let req = loop {
        match http::parse_head(&buf) {
            Ok(Some(r)) => break r,
            Ok(None) => {}
            Err(HttpError::TooLarge) => return Err(413),
            Err(HttpError::Bad(_)) => return Err(400),
        }
        let n =
            tokio::time::timeout(READ_TIMEOUT, sock.read(&mut chunk)).await.map_err(|_| 400u16)?.map_err(|_| 400u16)?;
        if n == 0 {
            return Err(400);
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    while buf.len() < req.head_len + req.content_length {
        let n =
            tokio::time::timeout(READ_TIMEOUT, sock.read(&mut chunk)).await.map_err(|_| 400u16)?.map_err(|_| 400u16)?;
        if n == 0 {
            return Err(400);
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let body = buf[req.head_len..req.head_len + req.content_length].to_vec();
    Ok((req, body))
}

fn text(status: u16, msg: &str) -> Vec<u8> {
    http::response(status, "text/plain; charset=utf-8", msg.as_bytes(), false)
}

/// A file from the built frontend (embedded in release builds; read from
/// `dist/` in `tauri dev`).
fn asset(app: &AppHandle, path: &str) -> Option<Vec<u8>> {
    app.asset_resolver().get(path.to_string()).map(|a| a.bytes)
}

async fn handle(
    app: &AppHandle,
    mut sock: TcpStream,
    port: u16,
    tokens: &(String, String),
    alive: &AtomicBool,
) -> std::io::Result<()> {
    let (req, body) = match read_request(&mut sock).await {
        Ok(r) => r,
        Err(code) => return sock.write_all(&text(code, http::reason(code))).await,
    };
    let head_only = req.method == "HEAD";
    // Never log the request target: it carries the view token.
    let out = match http::route(&req, port, &tokens.0, &tokens.1) {
        Route::BadHost | Route::Forbidden => text(403, "Forbidden"),
        Route::Unauthorized => {
            text(401, "Wrong or old token. Copy the link (or the bot token) again from Glitch's settings.")
        }
        // No CORS headers anywhere, so OPTIONS preflights fail here too.
        Route::MethodNotAllowed => text(405, "Method Not Allowed"),
        Route::NotFound => text(404, "Not Found"),
        Route::Static(path) => match asset(app, &path) {
            Some(bytes) => http::response(200, http::content_type(&path), &bytes, head_only),
            None => text(404, "Not Found"),
        },
        Route::Page => match asset(app, "overlay.html") {
            Some(bytes) => {
                let mut r = http::response(200, "text/html; charset=utf-8", &bytes, head_only);
                // Add our CSP header right after the status line.
                let at = r.windows(2).position(|w| w == b"\r\n").unwrap_or(0) + 2;
                r.splice(at..at, format!("Content-Security-Policy: {PAGE_CSP}\r\n").into_bytes());
                r
            }
            None => text(503, "The overlay page isn't built. Run `npm run build` (dev) or reinstall Glitch."),
        },
        Route::Config => {
            let s = app.state::<crate::state::AppState>().settings().stream_overlay;
            http::response(200, "application/json", super::config_json(&s).to_string().as_bytes(), head_only)
        }
        Route::StreamEvent => match parse_webhook_json(&body) {
            Ok(e) => {
                if super::handle_event(app, &e, false) {
                    text(202, "ok")
                } else {
                    text(429, "skipped (reactions off, chat lines hidden, or too many at once)")
                }
            }
            Err(msg) => text(400, &msg),
        },
        Route::Events if app.state::<StreamHub>().viewers.load(Ordering::Relaxed) >= MAX_EVENT_STREAMS => {
            text(503, "Too many overlay pages are open.")
        }
        Route::Events => return events(app, sock, alive).await,
    };
    sock.write_all(&out).await?;
    sock.shutdown().await
}

/// Server-sent events until the page goes away or the server stops.
async fn events(app: &AppHandle, mut sock: TcpStream, alive: &AtomicBool) -> std::io::Result<()> {
    let hub = app.state::<StreamHub>();
    let mut rx = hub.tx.subscribe();
    sock.write_all(&http::sse_head()).await?;
    let first: Vec<Vec<u8>> =
        [hub.config.lock().unwrap().clone(), hub.mirror.lock().unwrap().clone()].into_iter().flatten().collect();
    for f in first {
        sock.write_all(&f).await?;
    }
    hub.viewers.fetch_add(1, Ordering::Relaxed);
    emit_status(app);
    let result = async {
        loop {
            if !alive.load(Ordering::Relaxed) {
                return Ok(());
            }
            match tokio::time::timeout(KEEPALIVE, rx.recv()).await {
                Ok(Ok(frame)) if frame.is_empty() => continue,
                Ok(Ok(frame)) => sock.write_all(&frame).await?,
                Ok(Err(RecvError::Lagged(_))) => continue,
                Ok(Err(RecvError::Closed)) => return Ok(()),
                Err(_) => sock.write_all(b": keepalive\n\n").await?,
            }
        }
    }
    .await;
    hub.viewers.fetch_sub(1, Ordering::Relaxed);
    emit_status(app);
    result
}
