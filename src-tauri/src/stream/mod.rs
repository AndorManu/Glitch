//! Streaming overlay: Glitch as an OBS browser source.
//!
//! When on (Settings > Features > Streaming overlay), a small HTTP server on
//! 127.0.0.1 serves `overlay.html` (src/overlay/) at
//! `http://127.0.0.1:<port>/overlay?token=<secret>`. The page gets its
//! settings, the desktop Glitch's animation ("mirror" mode) and reactions to
//! stream events over server-sent events. Stream events come from
//! `POST /stream-event` (any bot or script, with the separate write token in
//! a header), Streamer.bot's WebSocket server, or Twitch chat read anonymously. The pure parts live in
//! `glitch_core::stream` and are unit-tested there.

mod server;
mod sources;

use std::sync::atomic::AtomicBool;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Instant;

use glitch_core::settings::{Settings, StreamSettings};
use glitch_core::stream::{self, irc, ws, EventKind, StreamEvent, Throttle};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::broadcast;

use crate::commands::UiError;
use crate::state::AppState;

/// Live state of a connection (shown in the settings card).
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct SourceStatus {
    /// "off" | "connecting" | "connected" | "error"
    pub state: &'static str,
    pub detail: String,
}

impl SourceStatus {
    fn off() -> Self {
        Self { state: "off", detail: String::new() }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct StreamStatus {
    pub enabled: bool,
    /// The server is listening.
    pub running: bool,
    pub error: Option<String>,
    /// The URL to paste into OBS (empty while off). Read-only.
    pub url: String,
    /// Where bots POST events (needs the write token in a header).
    pub webhook: String,
    /// Overlay pages connected right now (OBS, a browser tab...).
    pub viewers: u64,
    pub streamerbot: SourceStatus,
    pub twitch: SourceStatus,
    /// The overlay settings for the Settings card, tokens blanked (the panel
    /// may not read the whole settings file; the URL and bot token are copied
    /// from Rust).
    pub settings: StreamSettings,
}

#[derive(Default)]
struct Running {
    /// What the running server was started with (restart when it changes).
    port: u16,
    tokens: (String, String),
    server: Option<JoinHandle<()>>,
    /// Cleared when that server stops: its open connections close too.
    alive: Arc<AtomicBool>,
    streamerbot_cfg: Option<String>,
    streamerbot: Option<JoinHandle<()>>,
    twitch_cfg: Option<String>,
    twitch: Option<JoinHandle<()>>,
}

pub struct StreamHub {
    /// Server-sent-event frames for every connected overlay page.
    tx: broadcast::Sender<Vec<u8>>,
    run: Mutex<Running>,
    /// Last mirror frame and config frame, sent first to new pages.
    mirror: Mutex<Option<Vec<u8>>>,
    config: Mutex<Option<Vec<u8>>>,
    throttle: Mutex<Throttle>,
    error: Mutex<Option<String>>,
    streamerbot: Mutex<SourceStatus>,
    twitch: Mutex<SourceStatus>,
    viewers: AtomicU64,
    started: Instant,
}

impl Default for StreamHub {
    fn default() -> Self {
        Self {
            tx: broadcast::channel(64).0,
            run: Mutex::new(Running::default()),
            mirror: Mutex::new(None),
            config: Mutex::new(None),
            throttle: Mutex::new(Throttle::default()),
            error: Mutex::new(None),
            streamerbot: Mutex::new(SourceStatus::off()),
            twitch: Mutex::new(SourceStatus::off()),
            viewers: AtomicU64::new(0),
            started: Instant::now(),
        }
    }
}

impl StreamHub {
    fn send(&self, event: &str, data: &serde_json::Value) -> Vec<u8> {
        let frame = glitch_core::stream::http::sse_frame(event, &data.to_string());
        let _ = self.tx.send(frame.clone());
        frame
    }

    fn now_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }
}

fn hub(app: &AppHandle) -> State<'_, StreamHub> {
    app.state::<StreamHub>()
}

pub fn overlay_url(s: &StreamSettings) -> String {
    format!("http://127.0.0.1:{}/overlay?token={}", s.port, s.view_token)
}

fn config_json(s: &StreamSettings) -> serde_json::Value {
    json!({
        "mode": s.mode,
        "size": s.size,
        "position": s.position,
        "show_chat": s.show_chat,
    })
}

pub fn status(app: &AppHandle) -> StreamStatus {
    let s = app.state::<AppState>().settings().stream_overlay;
    let h = hub(app);
    let error = h.error.lock().unwrap().clone();
    let running = h.run.lock().unwrap().server.is_some() && error.is_none();
    let streamerbot = h.streamerbot.lock().unwrap().clone();
    let twitch = h.twitch.lock().unwrap().clone();
    StreamStatus {
        enabled: s.enabled,
        running,
        error,
        url: if s.enabled { overlay_url(&s) } else { String::new() },
        webhook: if s.enabled { format!("http://127.0.0.1:{}/stream-event", s.port) } else { String::new() },
        viewers: h.viewers.load(Ordering::Relaxed),
        streamerbot,
        twitch,
        settings: StreamSettings { view_token: String::new(), write_token: String::new(), ..s },
    }
}

fn emit_status(app: &AppHandle) {
    let _ = app.emit("stream-status", status(app));
}

pub(crate) fn set_source(app: &AppHandle, twitch: bool, state: &'static str, detail: impl Into<String>) {
    let h = hub(app);
    let slot = if twitch { &h.twitch } else { &h.streamerbot };
    let new = SourceStatus { state, detail: detail.into() };
    let changed = {
        let mut cur = slot.lock().unwrap();
        let changed = *cur != new;
        *cur = new;
        changed
    };
    if changed {
        emit_status(app);
    }
}

/// Start up: make the tokens on first use, then start what the settings say.
pub fn setup(app: &AppHandle) {
    app.manage(StreamHub::default());
    let state = app.state::<AppState>();
    let s = state.settings().stream_overlay;
    if s.view_token.is_empty() || s.write_token.is_empty() || s.view_token == s.write_token {
        state.update_settings(|s| {
            s.stream_overlay.view_token = stream::new_token();
            s.stream_overlay.write_token = stream::new_token();
        });
    }
    apply(app);
}

/// Bring the server and the connections in line with the settings.
pub fn apply(app: &AppHandle) {
    let s = app.state::<AppState>().settings().stream_overlay;
    let h = hub(app);
    *h.config.lock().unwrap() = Some(h.send("config", &config_json(&s)));
    let mut run = h.run.lock().unwrap();

    // The server.
    let want_server = s.enabled.then(|| (s.port, (s.view_token.clone(), s.write_token.clone())));
    let have_server = run.server.as_ref().map(|_| (run.port, run.tokens.clone()));
    if want_server != have_server {
        if let Some(t) = run.server.take() {
            t.abort();
            run.alive.store(false, Ordering::Relaxed);
            let _ = h.tx.send(Vec::new()); // wake the open event streams so they notice
        }
        *h.error.lock().unwrap() = None;
        if let Some((port, tokens)) = want_server {
            run.port = port;
            run.tokens = tokens.clone();
            run.alive = Arc::new(AtomicBool::new(true));
            run.server = Some(tauri::async_runtime::spawn(server::serve(app.clone(), port, tokens, run.alive.clone())));
        }
    }

    // Streamer.bot.
    let sb = (s.enabled && s.streamerbot).then(|| s.streamerbot_url.clone());
    if sb != run.streamerbot_cfg {
        if let Some(t) = run.streamerbot.take() {
            t.abort();
        }
        run.streamerbot_cfg = sb.clone();
        match sb {
            Some(url) => run.streamerbot = Some(tauri::async_runtime::spawn(sources::streamerbot(app.clone(), url))),
            None => *h.streamerbot.lock().unwrap() = SourceStatus::off(),
        }
    }

    // Twitch chat.
    let tw = if s.enabled { irc::channel_name(&s.twitch_channel) } else { None };
    if tw != run.twitch_cfg {
        if let Some(t) = run.twitch.take() {
            t.abort();
        }
        run.twitch_cfg = tw.clone();
        match tw {
            Some(ch) => run.twitch = Some(tauri::async_runtime::spawn(sources::twitch(app.clone(), ch))),
            None => *h.twitch.lock().unwrap() = SourceStatus::off(),
        }
    }
    drop(run);
    emit_status(app);
}

/// A stream event arrived (webhook, Streamer.bot, Twitch, test button).
/// Returns false when it was dropped (reactions off, chat hidden, flood).
pub fn handle_event(app: &AppHandle, e: &StreamEvent, test: bool) -> bool {
    let s = app.state::<AppState>().settings().stream_overlay;
    if !s.enabled || (!s.react && !test) || (e.kind == EventKind::Chat && !s.show_chat) {
        return false;
    }
    let h = hub(app);
    if !test && !h.throttle.lock().unwrap().allow(e.kind, h.now_ms()) {
        return false;
    }
    let r = stream::reaction(e);
    h.send("react", &json!({ "kind": e.kind, "action": r.action, "line": r.line, "speaker": r.speaker }));
    // Mirror mode: the desktop Glitch acts it out (and the overlay copies him).
    if s.mode == "mirror" {
        let _ = app.emit_to("mascot", "mascot-action", r.action);
    }
    true
}

/// What Glitch said in the desktop chat, when the user lets it on stream.
pub fn said(app: &AppHandle, text: &str) {
    let s = app.state::<AppState>().settings().stream_overlay;
    if s.enabled && s.mirror_chat {
        hub(app).send("say", &json!({ "line": stream::clean(text, 280) }));
    }
}

static MIRROR_SEQ: AtomicU64 = AtomicU64::new(0);

/// The desktop Glitch's animation changed (sent by the mascot page while
/// the overlay is on).
#[tauri::command]
pub fn stream_mirror(app: AppHandle, animation: String, facing_left: bool) {
    let valid = !animation.is_empty()
        && animation.len() <= 40
        && animation.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !valid || !app.state::<AppState>().settings().stream_overlay.enabled {
        return;
    }
    let h = hub(&app);
    let seq = MIRROR_SEQ.fetch_add(1, Ordering::Relaxed);
    let frame = h.send("mirror", &json!({ "animation": animation, "facing_left": facing_left, "seq": seq }));
    *h.mirror.lock().unwrap() = Some(frame);
}

#[tauri::command]
pub fn stream_status(app: AppHandle) -> StreamStatus {
    status(&app)
}

#[derive(Deserialize, Default)]
pub struct StreamPatch {
    enabled: Option<bool>,
    port: Option<u16>,
    mode: Option<String>,
    size: Option<f32>,
    position: Option<String>,
    react: Option<bool>,
    show_chat: Option<bool>,
    mirror_chat: Option<bool>,
    streamerbot: Option<bool>,
    streamerbot_url: Option<String>,
    twitch_channel: Option<String>,
}

/// Check a patch; the cleaned-up values to store.
fn validate(p: &mut StreamPatch) -> Result<(), UiError> {
    if let Some(port) = p.port {
        if port < 1024 {
            return Err(UiError::new("bad_port", "Pick a port from 1024 to 65535."));
        }
    }
    if let Some(m) = &p.mode {
        if !matches!(m.as_str(), "mirror" | "walk") {
            return Err(UiError::new("bad_mode", "Mode is mirror or walk."));
        }
    }
    if let Some(pos) = &p.position {
        if !matches!(pos.as_str(), "left" | "center" | "right") {
            return Err(UiError::new("bad_position", "Position is left, center or right."));
        }
    }
    if let Some(size) = &mut p.size {
        if !size.is_finite() {
            return Err(UiError::new("bad_size", "Size must be a number."));
        }
        *size = size.clamp(0.5, 3.0);
    }
    if let Some(url) = &mut p.streamerbot_url {
        ws::parse_local_url(url).map_err(|e| UiError::new("bad_url", format!("Streamer.bot address: {e}.")))?;
        *url = url.trim().to_string();
    }
    if let Some(ch) = &mut p.twitch_channel {
        if ch.trim().is_empty() {
            ch.clear();
        } else {
            *ch = irc::channel_name(ch)
                .ok_or_else(|| UiError::new("bad_channel", "That doesn't look like a Twitch channel name."))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn update_stream_settings(app: AppHandle, mut patch: StreamPatch) -> Result<Settings, UiError> {
    validate(&mut patch)?;
    let new = app.state::<AppState>().update_settings(|s| {
        let t = &mut s.stream_overlay;
        let p = patch;
        macro_rules! set {
            ($($f:ident),*) => { $(if let Some(v) = p.$f { t.$f = v; })* };
        }
        set!(
            enabled,
            port,
            mode,
            size,
            position,
            react,
            show_chat,
            mirror_chat,
            streamerbot,
            streamerbot_url,
            twitch_channel
        );
    });
    let _ = app.emit("settings-changed", &new);
    apply(&app);
    Ok(new)
}

/// "New links": the old OBS URL and the old bot token stop working.
#[tauri::command]
pub fn stream_new_token(app: AppHandle) -> StreamStatus {
    let new = app.state::<AppState>().update_settings(|s| {
        s.stream_overlay.view_token = stream::new_token();
        s.stream_overlay.write_token = stream::new_token();
    });
    let _ = app.emit("settings-changed", &new);
    apply(&app);
    status(&app)
}

#[tauri::command]
pub fn stream_test_event(app: AppHandle, kind: String) -> Result<(), UiError> {
    let k = EventKind::parse(&kind).ok_or_else(|| UiError::new("bad_kind", "follow, sub, raid or chat"))?;
    let text = match k {
        EventKind::Chat => "hi Glitch! this is a test",
        EventKind::Raid => "12",
        _ => "",
    };
    if !handle_event(&app, &StreamEvent::new(k, "TestViewer", text), true) {
        return Err(UiError::new("stream_off", "Turn the overlay on first (and chat lines, for a chat test)."));
    }
    Ok(())
}

/// Copy the OBS URL ("url") or the bot token ("write_token"). Done in Rust:
/// the webview clipboard API needs focus and permission juggling.
#[tauri::command]
pub fn stream_copy(app: AppHandle, what: String) -> Result<(), UiError> {
    let s = app.state::<AppState>().settings().stream_overlay;
    if !s.enabled {
        return Err(UiError::new("stream_off", "Turn the overlay on first."));
    }
    let text = match what.as_str() {
        "url" => overlay_url(&s),
        "write_token" => s.write_token.clone(),
        _ => return Err(UiError::new("bad_copy", "url or write_token")),
    };
    let mut cb = arboard::Clipboard::new().map_err(|e| UiError::new("clipboard", e.to_string()))?;
    cb.set_text(text).map_err(|e| UiError::new("clipboard", e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_validation() {
        let mut p = StreamPatch { size: Some(9.0), ..Default::default() };
        validate(&mut p).unwrap();
        assert_eq!(p.size, Some(3.0));
        assert!(validate(&mut StreamPatch { port: Some(80), ..Default::default() }).is_err());
        assert!(validate(&mut StreamPatch { mode: Some("dance".into()), ..Default::default() }).is_err());
        let mut p = StreamPatch { twitch_channel: Some("#SomeOne".into()), ..Default::default() };
        validate(&mut p).unwrap();
        assert_eq!(p.twitch_channel.as_deref(), Some("someone"));
        let mut p = StreamPatch { twitch_channel: Some("  ".into()), ..Default::default() };
        validate(&mut p).unwrap();
        assert_eq!(p.twitch_channel.as_deref(), Some(""));
        assert!(validate(&mut StreamPatch { streamerbot_url: Some("ws://example.com/".into()), ..Default::default() })
            .is_err());
    }

    #[test]
    fn url_has_token() {
        let s = StreamSettings { view_token: "abc".into(), write_token: "w".into(), ..Default::default() };
        assert_eq!(overlay_url(&s), "http://127.0.0.1:7799/overlay?token=abc");
    }
}
