//! The local event endpoint: scripts, builds and the Claude Code hook tell
//! Glitch that something happened.
//!
//! * Listens on `127.0.0.1` only, on a random port, with a per-install
//!   random token. Both are written to `endpoint.json` in Glitch's config
//!   folder (only the user can read it). Requests without the right token
//!   are refused.
//! * Browsers can't use it: requests with an `Origin` header are refused,
//!   the `Host` must be `127.0.0.1:<port>` / `localhost:<port>` (no DNS
//!   rebinding), and the body must be `application/json`.
//! * One route: `POST /notify` with `{title, body, source, level}`.
//!   Small bodies only, a few seconds per connection, rate limited.
//!
//! The client half ([`notify`]) is used by `glitch --notify "..."` and the
//! Claude Code hook (`glitch --claude-hook`): plain blocking std::net, short
//! timeouts, and it never fails loudly (a hook must never break Claude Code).

use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::UpdateEvent;

pub const FILE_NAME: &str = "endpoint.json";
pub const MAX_HEAD: usize = 8 * 1024;
pub const MAX_BODY: usize = 16 * 1024;
/// Events per minute (a runaway script can't flood the user).
pub const RATE_PER_MINUTE: usize = 20;
const CONN_TIMEOUT: Duration = Duration::from_secs(3);

/// What `endpoint.json` holds. `port` is `None` while the endpoint is off.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EndpointInfo {
    pub port: Option<u16>,
    pub token: String,
    #[serde(default)]
    pub pid: u32,
}

/// 32 random bytes as hex, from the OS's random source.
pub fn new_token() -> io::Result<String> {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).map_err(|e| io::Error::other(e.to_string()))?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

fn valid_token(t: &str) -> bool {
    t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn read_info(path: &Path) -> Option<EndpointInfo> {
    let info: EndpointInfo = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    valid_token(&info.token).then_some(info)
}

/// The token from an existing file (per install), or a fresh one.
pub fn load_or_create_token(path: &Path) -> io::Result<String> {
    match read_info(path) {
        Some(i) => Ok(i.token),
        None => new_token(),
    }
}

pub fn write_info(path: &Path, info: &EndpointInfo) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(info)?)?;
    std::fs::rename(&tmp, path)
}

/// Same time for every wrong token (no guessing it byte by byte).
fn token_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub method: String,
    pub path: String,
    /// Lowercase names.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

/// An HTTP answer: status and a small JSON body.
#[derive(Debug, Clone, PartialEq)]
pub struct Response {
    pub status: u16,
    pub body: Value,
}

impl Response {
    fn err(status: u16, msg: &str) -> Self {
        Self { status, body: json!({ "ok": false, "error": msg }) }
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let reason = match self.status {
            200 => "OK",
            400 => "Bad Request",
            401 => "Unauthorized",
            403 => "Forbidden",
            404 => "Not Found",
            405 => "Method Not Allowed",
            413 => "Payload Too Large",
            415 => "Unsupported Media Type",
            429 => "Too Many Requests",
            _ => "Error",
        };
        let body = self.body.to_string();
        format!(
            "HTTP/1.1 {} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            self.status,
            body.len()
        )
        .into_bytes()
    }
}

/// Where the head ends (`\r\n\r\n`), if it has arrived.
fn head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4)
}

/// Parse the head. `Err` = a response to send right away.
pub fn parse_head(head: &[u8]) -> Result<(Request, usize), Response> {
    let text = std::str::from_utf8(head).map_err(|_| Response::err(400, "bad request"))?;
    let mut lines = text.split("\r\n");
    let mut first = lines.next().unwrap_or("").split(' ');
    let (method, path, version) = (first.next().unwrap_or(""), first.next().unwrap_or(""), first.next().unwrap_or(""));
    if method.is_empty() || !path.starts_with('/') || !version.starts_with("HTTP/1.") {
        return Err(Response::err(400, "bad request"));
    }
    let mut headers = Vec::new();
    for line in lines.filter(|l| !l.is_empty()) {
        let (k, v) = line.split_once(':').ok_or_else(|| Response::err(400, "bad header"))?;
        headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
    }
    let req = Request { method: method.into(), path: path.into(), headers, body: Vec::new() };
    if req.header("transfer-encoding").is_some() {
        return Err(Response::err(400, "send a Content-Length body"));
    }
    let len = match req.header("content-length") {
        None => 0,
        Some(v) => v.parse::<usize>().map_err(|_| Response::err(400, "bad Content-Length"))?,
    };
    if len > MAX_BODY {
        return Err(Response::err(413, "body too large"));
    }
    Ok((req, len))
}

/// Everything except reading the socket: checks and the event.
pub fn handle(req: &Request, token: &str, port: u16) -> (Response, Option<UpdateEvent>) {
    // Browsers always send Origin on cross-site POSTs: no web page may use this.
    if req.header("origin").is_some() {
        return (Response::err(403, "browsers can't use this endpoint"), None);
    }
    let host_ok =
        req.header("host").is_some_and(|h| h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}"));
    if !host_ok {
        return (Response::err(403, "wrong Host"), None);
    }
    let given = req
        .header("authorization")
        .and_then(|v| v.strip_prefix("Bearer "))
        .or_else(|| req.header("x-glitch-token"))
        .unwrap_or("");
    if !token_eq(given.trim(), token) {
        return (Response::err(401, "missing or wrong token (see endpoint.json)"), None);
    }
    if req.path != "/notify" {
        return (Response::err(404, "the only route is POST /notify"), None);
    }
    if req.method != "POST" {
        return (Response::err(405, "use POST"), None);
    }
    if !req.header("content-type").is_some_and(|c| c.to_ascii_lowercase().starts_with("application/json")) {
        return (Response::err(415, "Content-Type must be application/json"), None);
    }
    let v: Value = match serde_json::from_slice(&req.body) {
        Ok(v) => v,
        Err(_) => return (Response::err(400, "body must be JSON"), None),
    };
    match UpdateEvent::from_json(&v) {
        Ok(e) => (Response { status: 200, body: json!({ "ok": true }) }, Some(e)),
        Err(msg) => (Response::err(400, &msg), None),
    }
}

/// Sliding one-minute window.
#[derive(Default)]
pub struct RateLimit {
    times: Vec<Instant>,
}

impl RateLimit {
    pub fn allow(&mut self, now: Instant) -> bool {
        self.times.retain(|t| now.duration_since(*t) < Duration::from_secs(60));
        if self.times.len() >= RATE_PER_MINUTE {
            return false;
        }
        self.times.push(now);
        true
    }
}

pub type Sink = Arc<dyn Fn(UpdateEvent) + Send + Sync>;

/// Bind `127.0.0.1:0`. The caller writes the port to endpoint.json and
/// spawns [`serve`].
pub async fn bind() -> io::Result<(TcpListener, u16)> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    Ok((listener, port))
}

/// Accept connections until the task is dropped/aborted.
pub async fn serve(listener: TcpListener, token: String, sink: Sink) {
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let limit = Arc::new(Mutex::new(RateLimit::default()));
    loop {
        let Ok((stream, peer)) = listener.accept().await else { continue };
        // Bound to 127.0.0.1, so this is belt and braces.
        if !peer.ip().is_loopback() {
            continue;
        }
        let (token, sink, limit) = (token.clone(), sink.clone(), limit.clone());
        tokio::spawn(async move {
            let _ = tokio::time::timeout(CONN_TIMEOUT, connection(stream, &token, port, sink, limit)).await;
        });
    }
}

async fn connection(
    mut stream: tokio::net::TcpStream,
    token: &str,
    port: u16,
    sink: Sink,
    limit: Arc<Mutex<RateLimit>>,
) -> io::Result<()> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 2048];
    let end = loop {
        if let Some(end) = head_end(&buf) {
            break end;
        }
        if buf.len() > MAX_HEAD {
            return stream.write_all(&Response::err(413, "headers too large").to_bytes()).await;
        }
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let (mut req, len) = match parse_head(&buf[..end]) {
        Ok(r) => r,
        Err(resp) => return stream.write_all(&resp.to_bytes()).await,
    };
    let mut body = buf[end..].to_vec();
    while body.len() < len {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(len);
    req.body = body;
    let (mut resp, event) = handle(&req, token, port);
    if let Some(e) = event {
        if limit.lock().unwrap().allow(Instant::now()) {
            sink(e);
        } else {
            resp = Response::err(429, "too many events, slow down");
        }
    }
    stream.write_all(&resp.to_bytes()).await?;
    stream.shutdown().await
}

// ------------------------------------------------------------------ client

/// `%APPDATA%\<identifier>\endpoint.json` (or the macOS equivalent).
/// `GLITCH_ENDPOINT_FILE` overrides it (tests, several builds side by side).
pub fn default_info_path(identifier: &str) -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("GLITCH_ENDPOINT_FILE") {
        return Some(PathBuf::from(p));
    }
    dirs::config_dir().map(|d| d.join(identifier).join(FILE_NAME))
}

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("Glitch isn't running (or his event endpoint is switched off)")]
    NotListening,
    #[error("couldn't reach Glitch: {0}")]
    Io(#[from] io::Error),
    #[error("Glitch said no ({0}): {1}")]
    Refused(u16, String),
}

/// POST one event. Short timeouts: never hangs a build or a hook.
pub fn notify(info: &EndpointInfo, event: &Value) -> Result<(), ClientError> {
    let port = info.port.ok_or(ClientError::NotListening)?;
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s =
        TcpStream::connect_timeout(&addr, Duration::from_millis(1500)).map_err(|_| ClientError::NotListening)?;
    s.set_read_timeout(Some(Duration::from_secs(3)))?;
    s.set_write_timeout(Some(Duration::from_secs(3)))?;
    let body = event.to_string();
    let req = format!(
        "POST /notify HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        info.token,
        body.len()
    );
    s.write_all(req.as_bytes())?;
    let mut resp = Vec::new();
    let _ = s.take(64 * 1024).read_to_end(&mut resp);
    let text = String::from_utf8_lossy(&resp);
    let status: u16 = text.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    if status == 200 {
        Ok(())
    } else {
        let body = text.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
        Err(ClientError::Refused(status, body))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(raw: &str) -> Request {
        let bytes = raw.as_bytes();
        let end = head_end(bytes).unwrap();
        let (mut r, len) = parse_head(&bytes[..end]).unwrap();
        r.body = bytes[end..end + len].to_vec();
        r
    }

    const T: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn post(headers: &str, body: &str) -> String {
        format!("POST /notify HTTP/1.1\r\n{headers}Content-Length: {}\r\n\r\n{body}", body.len())
    }

    #[test]
    fn a_good_request_gives_an_event() {
        let raw = post(
            &format!("Host: 127.0.0.1:5000\r\nAuthorization: Bearer {T}\r\nContent-Type: application/json\r\n"),
            r#"{"title":"build done","source":"cargo","level":"success"}"#,
        );
        let (resp, ev) = handle(&req(&raw), T, 5000);
        assert_eq!(resp.status, 200);
        assert_eq!(ev.unwrap().title, "build done");
        // The token may also come as X-Glitch-Token.
        let raw = post(
            &format!("Host: localhost:5000\r\nX-Glitch-Token: {T}\r\nContent-Type: application/json\r\n"),
            r#"{"body":"x"}"#,
        );
        assert_eq!(handle(&req(&raw), T, 5000).0.status, 200);
    }

    #[test]
    fn refuses_bad_tokens_browsers_and_rebinding() {
        let ok_headers =
            format!("Host: 127.0.0.1:5000\r\nAuthorization: Bearer {T}\r\nContent-Type: application/json\r\n");
        let body = r#"{"title":"x"}"#;
        let cases = [
            (post("Host: 127.0.0.1:5000\r\nContent-Type: application/json\r\n", body), 401),
            (post(&ok_headers.replace(T, &"b".repeat(64)), body), 401),
            (post(&ok_headers.replace(T, "short"), body), 401),
            (post(&format!("{ok_headers}Origin: https://evil.example\r\n"), body), 403),
            (post(&ok_headers.replace("127.0.0.1:5000", "evil.example:5000"), body), 403),
            (post(&ok_headers.replace("127.0.0.1:5000", "127.0.0.1:5001"), body), 403),
            (post(&ok_headers.replace("application/json", "text/plain"), body), 415),
            (post(&ok_headers, "not json"), 400),
            (post(&ok_headers, "{}"), 400),
            (post(&ok_headers, body).replace("/notify", "/other"), 404),
            (post(&ok_headers, body).replace("POST", "GET"), 405),
        ];
        for (raw, status) in cases {
            let (resp, ev) = handle(&req(&raw), T, 5000);
            assert_eq!(resp.status, status, "{raw}");
            assert!(ev.is_none());
        }
    }

    #[test]
    fn head_limits() {
        assert_eq!(parse_head(b"garbage\r\n\r\n").unwrap_err().status, 400);
        let big = format!("POST /notify HTTP/1.1\r\nContent-Length: {}\r\n\r\n", MAX_BODY + 1);
        assert_eq!(parse_head(big.as_bytes()).unwrap_err().status, 413);
        let chunked = "POST /notify HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n";
        assert_eq!(parse_head(chunked.as_bytes()).unwrap_err().status, 400);
    }

    #[test]
    fn rate_limit() {
        let mut r = RateLimit::default();
        let t = Instant::now();
        for _ in 0..RATE_PER_MINUTE {
            assert!(r.allow(t));
        }
        assert!(!r.allow(t));
        assert!(r.allow(t + Duration::from_secs(61)));
    }

    #[test]
    fn token_file_is_per_install() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let token = load_or_create_token(&path).unwrap();
        assert!(valid_token(&token));
        assert_ne!(token, new_token().unwrap());
        write_info(&path, &EndpointInfo { port: Some(1234), token: token.clone(), pid: 1 }).unwrap();
        assert_eq!(load_or_create_token(&path).unwrap(), token);
        std::fs::write(&path, "{broken").unwrap();
        assert_ne!(load_or_create_token(&path).unwrap(), token);
    }

    #[tokio::test]
    async fn end_to_end_over_a_real_socket() {
        let (listener, port) = bind().await.unwrap();
        let token = new_token().unwrap();
        let got: Arc<Mutex<Vec<UpdateEvent>>> = Arc::default();
        let g = got.clone();
        let server = tokio::spawn(serve(listener, token.clone(), Arc::new(move |e| g.lock().unwrap().push(e))));
        let info = EndpointInfo { port: Some(port), token: token.clone(), pid: 0 };
        let r = tokio::task::spawn_blocking(move || {
            let good = notify(&info, &json!({"title": "download finished", "source": "browser"}));
            let bad = notify(&EndpointInfo { token: "0".repeat(64), ..info.clone() }, &json!({"title": "x"}));
            (good, bad)
        })
        .await
        .unwrap();
        assert!(r.0.is_ok(), "{:?}", r.0);
        assert!(matches!(r.1, Err(ClientError::Refused(401, _))));
        assert_eq!(got.lock().unwrap().len(), 1);
        assert_eq!(got.lock().unwrap()[0].title, "download finished");
        server.abort();
        // Nobody listening: a clear error, quickly.
        let off = EndpointInfo { port: None, token, pid: 0 };
        assert!(matches!(notify(&off, &json!({"title": "x"})), Err(ClientError::NotListening)));
    }
}
