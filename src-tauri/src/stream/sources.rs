//! Where stream events come from besides the webhook: Streamer.bot's
//! WebSocket server (localhost) and Twitch chat (anonymous, read-only, TLS).
//! Both reconnect on their own with a growing pause; the tasks are aborted
//! by `stream::apply` when the setting changes or the overlay is turned off.

use std::time::Duration;

use glitch_core::stream::{irc, streamerbot, ws};
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

use super::{handle_event, set_source};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

fn backoff(attempt: u32, max_s: u64) -> Duration {
    Duration::from_secs((2u64 << attempt.min(5)).min(max_s))
}

// ------------------------------------------------------------- Streamer.bot

pub async fn streamerbot(app: AppHandle, url: String) {
    let target = match ws::parse_local_url(&url) {
        Ok(t) => t,
        Err(e) => return set_source(&app, false, "error", e),
    };
    let mut attempt = 0;
    loop {
        set_source(&app, false, "connecting", format!("{}:{}", target.host, target.port));
        let (wait, detail) = match streamerbot_once(&app, &target).await {
            Ok(()) => {
                attempt = 0;
                (backoff(0, 30), "Streamer.bot closed the connection".to_string())
            }
            Err(Stop::Auth) => (
                Duration::from_secs(60),
                "Streamer.bot asks for a password: turn off \"Authentication\" for its WebSocket server, or use the webhook".to_string(),
            ),
            Err(Stop::Failed(e)) => {
                attempt += 1;
                (backoff(attempt, 30), e)
            }
        };
        set_source(&app, false, "error", detail);
        tokio::time::sleep(wait).await;
    }
}

enum Stop {
    Auth,
    Failed(String),
}

impl From<std::io::Error> for Stop {
    fn from(e: std::io::Error) -> Self {
        Stop::Failed(e.to_string())
    }
}

async fn streamerbot_once(app: &AppHandle, t: &ws::Target) -> Result<(), Stop> {
    let host = if t.host == "[::1]" { "::1" } else { t.host.as_str() };
    let mut sock = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((host, t.port)))
        .await
        .map_err(|_| Stop::Failed("Streamer.bot didn't answer (is its WebSocket server started?)".into()))?
        .map_err(|_| Stop::Failed("Streamer.bot isn't running, or its WebSocket server is off".into()))?;
    let key = ws::new_key();
    sock.write_all(ws::handshake(t, &key).as_bytes()).await?;
    // Read the handshake response head.
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break p;
        }
        if buf.len() > 16 * 1024 {
            return Err(Stop::Failed("not a WebSocket server".into()));
        }
        let n = tokio::time::timeout(CONNECT_TIMEOUT, sock.read(&mut chunk))
            .await
            .map_err(|_| Stop::Failed("no answer".into()))??;
        if n == 0 {
            return Err(Stop::Failed("the connection closed during the handshake".into()));
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    ws::check_response(&String::from_utf8_lossy(&buf[..head_end]), &key).map_err(Stop::Failed)?;
    buf.drain(..head_end + 4);
    for req in streamerbot::subscribe_requests() {
        sock.write_all(&ws::encode(ws::OP_TEXT, req.as_bytes(), ws::random_mask())).await?;
    }
    set_source(app, false, "connected", "Listening for follows, subs, raids and chat");
    let mut asm = ws::Assembler::default();
    loop {
        while let Some((frame, used)) = ws::decode(&buf).map_err(Stop::Failed)? {
            buf.drain(..used);
            let Some((op, payload)) = asm.push(frame).map_err(Stop::Failed)? else { continue };
            match op {
                ws::OP_TEXT => match streamerbot::parse(&String::from_utf8_lossy(&payload)) {
                    streamerbot::Message::Hello { auth: true } => return Err(Stop::Auth),
                    streamerbot::Message::Event(e) => {
                        handle_event(app, &e, false);
                    }
                    _ => {}
                },
                ws::OP_PING => sock.write_all(&ws::encode(ws::OP_PONG, &payload, ws::random_mask())).await?,
                ws::OP_CLOSE => {
                    let _ = sock.write_all(&ws::encode(ws::OP_CLOSE, &[], ws::random_mask())).await;
                    return Ok(());
                }
                _ => {}
            }
        }
        let n = sock.read(&mut chunk).await?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

// ------------------------------------------------------------- Twitch chat

pub async fn twitch(app: AppHandle, channel: String) {
    let mut attempt = 0;
    loop {
        set_source(&app, true, "connecting", format!("#{channel}"));
        let detail = match twitch_once(&app, &channel).await {
            Ok(()) => {
                attempt = 0;
                "Twitch asked to reconnect".to_string()
            }
            Err(e) => {
                attempt += 1;
                e
            }
        };
        set_source(&app, true, "error", detail);
        tokio::time::sleep(backoff(attempt, 60)).await;
    }
}

async fn twitch_once(app: &AppHandle, channel: &str) -> Result<(), String> {
    let tcp = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((irc::HOST, irc::PORT)))
        .await
        .map_err(|_| "Twitch chat didn't answer".to_string())?
        .map_err(|e| format!("can't reach Twitch chat: {e}"))?;
    let tls = tokio_native_tls::native_tls::TlsConnector::new().map_err(|e| e.to_string())?;
    let tls = tokio_native_tls::TlsConnector::from(tls);
    let stream = tokio::time::timeout(CONNECT_TIMEOUT, tls.connect(irc::HOST, tcp))
        .await
        .map_err(|_| "Twitch chat didn't answer".to_string())?
        .map_err(|e| format!("secure connection to Twitch failed: {e}"))?;
    let (read, mut write) = tokio::io::split(stream);
    let nick =
        (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(7))
            % 89_999;
    for line in irc::login(channel, nick) {
        write.write_all(format!("{line}\r\n").as_bytes()).await.map_err(|e| e.to_string())?;
    }
    let mut lines = BufReader::new(read).lines();
    loop {
        // Twitch PINGs about every 5 minutes; 7 minutes of silence = dead.
        let line = match tokio::time::timeout(Duration::from_secs(420), lines.next_line()).await {
            Err(_) => return Err("Twitch chat went quiet".into()),
            Ok(Err(e)) => return Err(e.to_string()),
            Ok(Ok(None)) => return Err("Twitch closed the connection".into()),
            Ok(Ok(Some(l))) => l,
        };
        if line.len() > 8192 {
            continue;
        }
        match irc::parse(&line) {
            irc::Line::Ping(p) => {
                write.write_all(format!("PONG :{p}\r\n").as_bytes()).await.map_err(|e| e.to_string())?
            }
            irc::Line::Joined => set_source(app, true, "connected", format!("Reading #{channel} (read-only)")),
            irc::Line::Reconnect => return Ok(()),
            irc::Line::Event(e) => {
                handle_event(app, &e, false);
            }
            irc::Line::Other => {}
        }
    }
}
