//! "Update me": the shell half (see glitch_core::update_me for the logic).
//!
//! * the local event endpoint (started/stopped with its switch);
//! * `glitch --notify "..."` and `glitch --glitch-claude-hook` (client mode,
//!   handled in `main` before any window exists);
//! * Claude Code connect / disconnect;
//! * saved reminders (a 15 s ticker) and the daily briefing;
//! * the notification digest (a poller thread on Windows).
//!
//! How Glitch tells the user: the mascot gets "mascot-update" (a short act:
//! run over, knock on the screen, hold a sign), the bubble gets
//! "glitch-update" (a speech with optional buttons). Outside text is only
//! ever *shown*; it never reaches the chat agent, so it can't trigger tools.

use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use glitch_core::ai::{AiProvider, ChatRequest};
use glitch_core::settings::{Location, Settings, UpdateMeSettings};
use glitch_core::update_me::notifications::{self, Access, Digest, NotificationSource};
use glitch_core::update_me::reminders::ReminderStore;
use glitch_core::update_me::{briefing, claude_code, endpoint, when, Level, UpdateEvent};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::UiError;
use crate::state::AppState;

const TICK: Duration = Duration::from_secs(15);
const POLL: Duration = Duration::from_secs(4);
/// The digest sign comes back at most this often.
const SIGN_EVERY: Duration = Duration::from_secs(120);
const STATE_FILE: &str = "update-me-state.json";

// ---------------------------------------------------------------- payloads

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Choice {
    pub id: &'static str,
    pub label: &'static str,
}

/// What the bubble says ("glitch-update").
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct UpdateSpeech {
    /// "rem:3", "digest:1", "ev:7", "brief:1"
    pub id: String,
    pub text: String,
    /// "reminder" | "claude" | "event" | "digest" | "briefing"
    pub icon: &'static str,
    pub choices: Vec<Choice>,
}

/// What the mascot does ("mascot-update"). The mascot maps the names to
/// animations it has (see src/mascot/update-act.ts).
#[derive(Debug, Clone, Serialize)]
pub struct MascotUpdate {
    pub steps: Vec<&'static str>,
    pub sign: Option<String>,
    /// How long the sign stays up (ms).
    pub sign_ms: u64,
}

// ------------------------------------------------------------------- state

pub struct UpdateMe {
    config_dir: PathBuf,
    endpoint: Mutex<Option<(u16, tauri::async_runtime::JoinHandle<()>)>>,
    reminders: Mutex<ReminderStore>,
    digest: Mutex<Digest>,
    /// The latest speech the bubble hasn't confirmed seeing.
    pending: Mutex<Option<UpdateSpeech>>,
    source: Arc<dyn NotificationSource>,
    poller: Mutex<Option<Arc<AtomicBool>>>,
    last_sign: Mutex<Option<Instant>>,
    /// Set while a summary is being made (one at a time).
    summarising: AtomicBool,
    seq: AtomicU64,
    /// Debug builds with GLITCH_FAKE_NOTIFICATIONS=1: the fake source to feed.
    fake: Option<Arc<notifications::FakeSource>>,
}

fn source() -> (Arc<dyn NotificationSource>, Option<Arc<notifications::FakeSource>>) {
    if cfg!(debug_assertions) && std::env::var_os("GLITCH_FAKE_NOTIFICATIONS").is_some_and(|v| v == "1") {
        eprintln!("glitch: GLITCH_FAKE_NOTIFICATIONS=1, the notification reader reads a fake feed");
        let fake = Arc::new(notifications::FakeSource::default());
        return (fake.clone(), Some(fake));
    }
    #[cfg(target_os = "windows")]
    return (Arc::new(crate::notify_win::WindowsSource), None);
    #[cfg(not(target_os = "windows"))]
    return (Arc::new(Unavailable), None);
}

/// macOS / Linux: no public API for other apps' notifications.
#[cfg(not(target_os = "windows"))]
struct Unavailable;

#[cfg(not(target_os = "windows"))]
impl NotificationSource for Unavailable {
    fn access(&self) -> Access {
        Access::Unavailable
    }
    fn request_access(&self) -> Access {
        Access::Unavailable
    }
    fn current(&self) -> Result<Vec<notifications::Toast>, String> {
        Err("reading notifications only works on Windows".into())
    }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct SavedState {
    briefing: briefing::BriefingState,
}

fn now_unix() -> i64 {
    chrono::Local::now().timestamp()
}

impl UpdateMe {
    pub fn new(config_dir: PathBuf) -> Self {
        let (source, fake) = source();
        Self {
            reminders: Mutex::new(ReminderStore::load(&config_dir.join(glitch_core::update_me::reminders::FILE_NAME))),
            config_dir,
            endpoint: Mutex::new(None),
            digest: Mutex::new(Digest::default()),
            pending: Mutex::new(None),
            source,
            poller: Mutex::new(None),
            last_sign: Mutex::new(None),
            summarising: AtomicBool::new(false),
            seq: AtomicU64::new(0),
            fake,
        }
    }

    fn next_id(&self, kind: &str) -> String {
        format!("{kind}:{}", self.seq.fetch_add(1, Ordering::Relaxed) + 1)
    }

    fn endpoint_file(&self) -> PathBuf {
        self.config_dir.join(endpoint::FILE_NAME)
    }

    fn load_state(&self) -> SavedState {
        std::fs::read_to_string(self.config_dir.join(STATE_FILE))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn save_state(&self, s: &SavedState) {
        let _ = std::fs::write(self.config_dir.join(STATE_FILE), serde_json::to_vec_pretty(s).unwrap_or_default());
    }

    fn save_reminders(store: &ReminderStore) {
        if let Err(e) = store.save() {
            eprintln!("glitch: could not save reminders: {e}");
        }
    }
}

fn um(app: &AppHandle) -> State<'_, UpdateMe> {
    app.state::<UpdateMe>()
}

fn feature(app: &AppHandle) -> UpdateMeSettings {
    app.state::<AppState>().settings().update_me
}

// ---------------------------------------------------------------- delivery

/// Tell the user: the mascot's act now, then (if `bubble`) the speech in
/// the chat bubble, opened without taking the keyboard focus.
fn deliver(app: &AppHandle, act: Option<MascotUpdate>, speech: UpdateSpeech, bubble: bool) {
    *um(app).pending.lock().unwrap() = Some(speech.clone());
    let delay = act.as_ref().map_or(0, |a| if a.steps.contains(&"run") { 2600 } else { 1200 });
    if let Some(act) = act {
        let _ = app.emit("mascot-update", act);
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if bubble {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            crate::windows::show_bubble_unfocused(&app);
        }
        let _ = app.emit("glitch-update", speech);
    });
}

/// An event from the endpoint (a script, a build, the Claude Code hook).
fn on_event(app: &AppHandle, e: UpdateEvent) {
    let f = feature(app);
    let claude = e.source == "claude-code";
    if claude && !f.claude_code_enabled {
        eprintln!("glitch: Claude Code event ignored (Claude Code buddy is off)");
        return;
    }
    let sign = match (claude, e.kind.as_deref()) {
        (true, Some("needs_input")) => "Claude Code needs you".to_string(),
        (true, _) => "Claude Code is done".to_string(),
        _ => e.sign(),
    };
    let steps = if claude { vec!["run", "knock_screen", "hold_sign"] } else { vec!["knock_screen", "hold_sign"] };
    let icon = if claude { "claude" } else { "event" };
    let text = match (claude, &e.project) {
        (true, Some(p)) if e.kind.as_deref() == Some("needs_input") => {
            format!("Claude Code needs you in {p}: {}", e.body)
        }
        (true, Some(p)) => format!("Claude Code is done in {p}!"),
        _ => e.speech(),
    };
    let speech = UpdateSpeech { id: um(app).next_id("ev"), text, icon, choices: vec![] };
    let level = e.level;
    let act = MascotUpdate { steps, sign: Some(sign), sign_ms: if level == Level::Error { 12_000 } else { 8_000 } };
    deliver(app, Some(act), speech, true);
}

// ---------------------------------------------------------------- endpoint

pub fn start_endpoint(app: &AppHandle) {
    let me = um(app);
    if me.endpoint.lock().unwrap().is_some() {
        return;
    }
    let path = me.endpoint_file();
    let token = match endpoint::load_or_create_token(&path) {
        Ok(t) => t,
        Err(e) => return eprintln!("glitch: event endpoint off, no token: {e}"),
    };
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let (listener, port) = match endpoint::bind().await {
            Ok(x) => x,
            Err(e) => return eprintln!("glitch: event endpoint couldn't start: {e}"),
        };
        let info = endpoint::EndpointInfo { port: Some(port), token: token.clone(), pid: std::process::id() };
        if let Err(e) = endpoint::write_info(&path, &info) {
            return eprintln!("glitch: couldn't write {}: {e}", path.display());
        }
        let sink_app = app2.clone();
        let sink: endpoint::Sink = Arc::new(move |e| on_event(&sink_app, e));
        let task = tauri::async_runtime::spawn(endpoint::serve(listener, token, sink));
        eprintln!("glitch: event endpoint on 127.0.0.1:{port}");
        *um(&app2).endpoint.lock().unwrap() = Some((port, task));
    });
}

pub fn stop_endpoint(app: &AppHandle) {
    let me = um(app);
    if let Some((_, task)) = me.endpoint.lock().unwrap().take() {
        task.abort();
    }
    let path = me.endpoint_file();
    if let Some(mut info) = endpoint::read_info(&path) {
        info.port = None;
        let _ = endpoint::write_info(&path, &info);
    }
}

// ------------------------------------------------------------- client mode

const MAX_HOOK_INPUT: u64 = 256 * 1024;

/// `glitch --notify "text" [--body ..] [--level ..] [--source ..]` and
/// `glitch --glitch-claude-hook` (stdin: the hook's JSON). Runs before any
/// window exists; returns the exit code, or `None` for a normal start.
pub fn cli(identifier: &str) -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let hook = args.iter().any(|a| a == claude_code::HOOK_FLAG);
    let notify_at = args.iter().position(|a| a == "--notify");
    if !hook && notify_at.is_none() {
        return None;
    }
    let event = if hook {
        // Never block or fail Claude Code: read stdin with a cap and a timeout.
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut s = String::new();
            let _ = std::io::stdin().take(MAX_HOOK_INPUT).read_to_string(&mut s);
            let _ = tx.send(s);
        });
        let input = rx.recv_timeout(Duration::from_secs(3)).unwrap_or_default();
        match claude_code::event_from_hook(&input) {
            Some(e) => serde_json::to_value(e).unwrap_or_default(),
            None => return Some(0),
        }
    } else {
        let value = |flag: &str| args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned();
        let title = notify_at.and_then(|i| args.get(i + 1)).cloned().unwrap_or_default();
        json!({
            "title": title,
            "body": value("--body").unwrap_or_default(),
            "level": value("--level").unwrap_or_default(),
            "source": value("--source").unwrap_or_else(|| "script".into()),
        })
    };
    let Some(info) = endpoint::default_info_path(identifier).and_then(|p| endpoint::read_info(&p)) else {
        eprintln!("glitch: Glitch isn't set up on this computer yet (no endpoint.json)");
        return Some(if hook { 0 } else { 2 });
    };
    match endpoint::notify(&info, &event) {
        Ok(()) => Some(0),
        Err(e) => {
            eprintln!("glitch: {e}");
            Some(if hook { 0 } else { 1 })
        }
    }
}

// --------------------------------------------------------------- reminders

fn reminder_speech(app: &AppHandle, d: &glitch_core::update_me::reminders::Due) -> UpdateSpeech {
    let _ = app;
    let choices = if d.last {
        vec![Choice { id: "done", label: "OK" }]
    } else {
        vec![Choice { id: "done", label: "Done" }, Choice { id: "snooze", label: "Snooze 10 min" }]
    };
    UpdateSpeech { id: format!("rem:{}", d.id), text: d.line.clone(), icon: "reminder", choices }
}

/// Used by the `set_reminder` tool (through NativeDesktop).
pub fn add_reminder(app: &AppHandle, due: i64, text: &str) -> Result<(), String> {
    if !feature(app).reminders_enabled {
        return Err("saved reminders are switched off (Settings > Features)".into());
    }
    let me = um(app);
    let mut store = me.reminders.lock().unwrap();
    store.add(text, due, now_unix())?;
    store.save().map_err(|e| format!("couldn't save the reminder: {e}"))?;
    drop(store);
    let _ = app.emit("reminders-changed", ());
    Ok(())
}

fn tick_reminders(app: &AppHandle) {
    if !feature(app).reminders_enabled {
        return;
    }
    let me = um(app);
    let due = {
        let mut store = me.reminders.lock().unwrap();
        let due = store.take_due(now_unix());
        if !due.is_empty() {
            UpdateMe::save_reminders(&store);
        }
        due
    };
    // Several at once: the last one speaks (the others nag again later).
    if let Some(d) = due.last() {
        let first = !d.line.starts_with("Last") && d.line.starts_with("Reminder");
        let act = MascotUpdate {
            steps: if first { vec!["knock_screen", "hold_sign"] } else { vec!["knock_screen"] },
            sign: Some(glitch_core::tools::ellipsize(&d.text, 28)),
            sign_ms: 8000,
        };
        let speech = reminder_speech(app, d);
        deliver(app, Some(act), speech, true);
        let _ = app.emit("reminders-changed", ());
    }
}

// ----------------------------------------------------------- notifications

fn digest_speech(app: &AppHandle) -> Option<UpdateSpeech> {
    let groups = um(app).digest.lock().unwrap().groups();
    if groups.is_empty() {
        return None;
    }
    Some(UpdateSpeech {
        id: um(app).next_id("digest"),
        text: format!("While you were busy: {}. Want the short version?", notifications::sign_text(&groups)),
        icon: "digest",
        choices: vec![
            Choice { id: "tell", label: "Tell me" },
            Choice { id: "later", label: "Later" },
            Choice { id: "clear", label: "Clear" },
        ],
    })
}

fn poll_once(app: &AppHandle) {
    let f = feature(app);
    let me = um(app);
    if me.source.access() != Access::Allowed {
        return;
    }
    let toasts = match me.source.current() {
        Ok(t) => t,
        Err(e) => return eprintln!("glitch: reading notifications failed: {e}"),
    };
    let new = me.digest.lock().unwrap().ingest(toasts, &f.notifications_blocklist, now_unix());
    if new == 0 {
        return;
    }
    let groups = me.digest.lock().unwrap().groups();
    let _ = app.emit("digest-changed", &groups);
    let Some(speech) = digest_speech(app) else { return };
    *me.pending.lock().unwrap() = Some(speech);
    if f.notifications_quiet {
        return;
    }
    let mut last = me.last_sign.lock().unwrap();
    if last.is_some_and(|t| t.elapsed() < SIGN_EVERY) {
        return;
    }
    *last = Some(Instant::now());
    drop(last);
    let act = MascotUpdate {
        steps: vec!["run", "hold_sign"],
        sign: Some(notifications::sign_text(&groups)),
        sign_ms: 20_000,
    };
    let _ = app.emit("mascot-update", act);
}

pub fn start_notifications(app: &AppHandle) {
    let me = um(app);
    let mut poller = me.poller.lock().unwrap();
    if poller.is_some() {
        return;
    }
    // The consent prompt has to come from the UI thread.
    let src = me.source.clone();
    let _ = app.run_on_main_thread(move || {
        let _ = src.request_access();
    });
    let running = Arc::new(AtomicBool::new(true));
    *poller = Some(running.clone());
    let app = app.clone();
    std::thread::spawn(move || {
        while running.load(Ordering::Relaxed) {
            poll_once(&app);
            std::thread::sleep(POLL);
        }
    });
}

pub fn stop_notifications(app: &AppHandle) {
    let me = um(app);
    if let Some(flag) = me.poller.lock().unwrap().take() {
        flag.store(false, Ordering::Relaxed);
    }
    me.digest.lock().unwrap().clear();
}

/// The model summary: no tools, the toasts as data, validated in Rust.
/// Falls back to a plain summary if there is no model or it misbehaves.
async fn summarise(app: &AppHandle) -> UpdateSpeech {
    let pending = um(app).digest.lock().unwrap().pending().to_vec();
    let state = app.state::<AppState>();
    let mut summaries = notifications::fallback_summaries(&pending);
    if let Some(model) = state.settings().model {
        let request = notifications::summary_request(&pending);
        let reply = tokio::time::timeout(
            Duration::from_secs(60),
            state.ollama.chat(ChatRequest { model: &model, messages: &request, tools: &[] }),
        )
        .await;
        match reply {
            Ok(Ok(m)) => match notifications::parse_summaries(&m.content, &pending) {
                Ok(s) => summaries = s,
                Err(e) => eprintln!("glitch: notification summary unusable ({e}), plain one instead"),
            },
            Ok(Err(e)) => eprintln!("glitch: notification summary failed: {e}"),
            Err(_) => eprintln!("glitch: notification summary took too long"),
        }
    }
    um(app).digest.lock().unwrap().clear();
    let _ = app.emit("digest-changed", Vec::<notifications::Group>::new());
    let lines: Vec<String> = summaries.iter().map(|s| format!("{}: {}", s.app, s.line)).collect();
    UpdateSpeech { id: um(app).next_id("ev"), text: lines.join("\n"), icon: "digest", choices: vec![] }
}

// ---------------------------------------------------------------- briefing

async fn fetch_json(url: &str) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(6)).build().map_err(|e| e.to_string())?;
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.json().await.map_err(|e| e.to_string())
}

async fn build_briefing(app: &AppHandle) -> briefing::Briefing {
    let f = feature(app);
    let now = chrono::Local::now().naive_local();
    let weather = match &f.location {
        Some(loc) => match fetch_json(&briefing::forecast_url(loc)).await {
            Ok(v) => briefing::parse_forecast(&v).map(|w| briefing::weather_line(&w, short_place(&loc.name))),
            Err(e) => {
                eprintln!("glitch: weather for the briefing failed: {e}");
                None
            }
        },
        None => None,
    };
    let end_of_day = now.date().and_hms_opt(23, 59, 59).and_then(when::to_unix).unwrap_or(i64::MAX);
    let reminders: Vec<_> = if f.reminders_enabled {
        um(app)
            .reminders
            .lock()
            .unwrap()
            .between(now_unix(), end_of_day)
            .into_iter()
            .filter_map(|r| when::from_unix(r.next).map(|t| (t, r.text)))
            .collect()
    } else {
        vec![]
    };
    let todos = glitch_core::desktop::default_notes_file()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|n| briefing::todos_from_notes(&n))
        .unwrap_or_default();
    briefing::compose(now, weather, &reminders, todos)
}

/// "Berlin, Land Berlin, Germany" -> "Berlin".
fn short_place(name: &str) -> &str {
    name.split(',').next().unwrap_or(name).trim()
}

// ---------------------------------------------------------------- commands

#[derive(Serialize)]
pub struct ReminderView {
    id: u64,
    text: String,
    when: String,
}

#[derive(Serialize)]
pub struct UpdateMeStatus {
    os: &'static str,
    settings: UpdateMeSettings,
    endpoint_port: Option<u16>,
    endpoint_file: PathBuf,
    claude: Option<claude_code::Status>,
    claude_error: Option<String>,
    notifications_access: Access,
    digest: Vec<notifications::Group>,
    reminders: Vec<ReminderView>,
}

fn hook_command() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = dunce_like(exe);
    claude_code::hook_command(&exe)
}

/// `\\?\C:\...` -> `C:\...` (current_exe can return verbatim paths).
fn dunce_like(p: PathBuf) -> PathBuf {
    let s = p.display().to_string();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => p,
    }
}

fn status_of(app: &AppHandle) -> UpdateMeStatus {
    let me = um(app);
    let now = chrono::Local::now().naive_local();
    let (claude, claude_error) = match (claude_code::settings_path(), hook_command()) {
        (Some(path), Ok(cmd)) => (Some(claude_code::status(&path, &cmd)), None),
        (None, _) => (None, Some("couldn't find your home folder".into())),
        (_, Err(e)) => (None, Some(e)),
    };
    let reminders = me
        .reminders
        .lock()
        .unwrap()
        .list()
        .into_iter()
        .map(|r| ReminderView {
            id: r.id,
            when: when::from_unix(r.next).map(|t| when::label(t, now)).unwrap_or_default(),
            text: r.text,
        })
        .collect();
    let endpoint_port = me.endpoint.lock().unwrap().as_ref().map(|(p, _)| *p);
    let digest = me.digest.lock().unwrap().groups();
    UpdateMeStatus {
        os: if cfg!(target_os = "windows") {
            "windows"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else {
            "linux"
        },
        settings: feature(app),
        endpoint_port,
        endpoint_file: me.endpoint_file(),
        claude,
        claude_error,
        notifications_access: me.source.access(),
        digest,
        reminders,
    }
}

#[tauri::command]
pub fn update_me_status(app: AppHandle) -> UpdateMeStatus {
    status_of(&app)
}

/// Fields the panel may change; missing = unchanged.
#[derive(Deserialize, Default)]
pub struct UpdateMePatch {
    endpoint_enabled: Option<bool>,
    claude_code_enabled: Option<bool>,
    notifications_enabled: Option<bool>,
    notifications_quiet: Option<bool>,
    notifications_blocklist: Option<Vec<String>>,
    reminders_enabled: Option<bool>,
    briefing_enabled: Option<bool>,
    location: Option<Location>,
    clear_location: Option<bool>,
}

#[tauri::command]
pub async fn update_me_set(app: AppHandle, patch: UpdateMePatch) -> Result<UpdateMeStatus, UiError> {
    let state = app.state::<AppState>();
    if let Some(list) = &patch.notifications_blocklist {
        if list.len() > 100 || list.iter().any(|s| s.chars().count() > 60) {
            return Err(UiError::new("bad_list", "That list is too long"));
        }
    }
    let new: Settings = state.update_settings(|s| {
        let u = &mut s.update_me;
        if let Some(v) = patch.endpoint_enabled {
            u.endpoint_enabled = v;
        }
        if let Some(v) = patch.claude_code_enabled {
            u.claude_code_enabled = v;
        }
        if let Some(v) = patch.notifications_enabled {
            u.notifications_enabled = v;
        }
        if let Some(v) = patch.notifications_quiet {
            u.notifications_quiet = v;
        }
        if let Some(v) = patch.notifications_blocklist {
            u.notifications_blocklist = v.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
        }
        if let Some(v) = patch.reminders_enabled {
            u.reminders_enabled = v;
        }
        if let Some(v) = patch.briefing_enabled {
            u.briefing_enabled = v;
        }
        if let Some(loc) = patch.location {
            u.location = Some(Location { name: glitch_core::update_me::clean(&loc.name, 80), ..loc });
        }
        if patch.clear_location == Some(true) {
            u.location = None;
        }
    });
    apply(&app, &new.update_me).await;
    let _ = app.emit("settings-changed", &new);
    Ok(status_of(&app))
}

/// Start/stop what the switches say (at startup and after a change).
pub async fn apply(app: &AppHandle, f: &UpdateMeSettings) {
    if f.endpoint_enabled {
        start_endpoint(app);
    } else {
        stop_endpoint(app);
    }
    if f.notifications_enabled {
        start_notifications(app);
    } else {
        stop_notifications(app);
    }
    app.state::<AppState>().agent.lock().await.set_reminders_enabled(f.reminders_enabled);
}

#[tauri::command]
pub async fn claude_connect(app: AppHandle) -> Result<UpdateMeStatus, UiError> {
    let path = claude_code::settings_path().ok_or_else(|| UiError::new("no_home", "Couldn't find your home folder"))?;
    let cmd = hook_command().map_err(|e| UiError::new("unsafe_path", e))?;
    claude_code::connect(&path, &cmd).map_err(|e| UiError::new("claude_settings", e.to_string()))?;
    // Connecting means the user wants the buddy: switch it on too.
    let new = app.state::<AppState>().update_settings(|s| {
        s.update_me.claude_code_enabled = true;
        s.update_me.endpoint_enabled = true;
    });
    apply(&app, &new.update_me).await;
    Ok(status_of(&app))
}

#[tauri::command]
pub async fn claude_disconnect(app: AppHandle) -> Result<UpdateMeStatus, UiError> {
    let path = claude_code::settings_path().ok_or_else(|| UiError::new("no_home", "Couldn't find your home folder"))?;
    claude_code::disconnect(&path).map_err(|e| UiError::new("claude_settings", e.to_string()))?;
    app.state::<AppState>().update_settings(|s| s.update_me.claude_code_enabled = false);
    Ok(status_of(&app))
}

#[tauri::command]
pub fn reminder_delete(app: AppHandle, id: u64) -> UpdateMeStatus {
    {
        let me = um(&app);
        let mut store = me.reminders.lock().unwrap();
        if store.remove(id) {
            UpdateMe::save_reminders(&store);
        }
    }
    status_of(&app)
}

/// The bubble asks for an update it may have missed (it just opened).
#[tauri::command]
pub fn update_pending(app: AppHandle) -> Option<UpdateSpeech> {
    um(&app).pending.lock().unwrap().clone()
}

/// The bubble showed it: don't hand it out again.
#[tauri::command]
pub fn update_seen(app: AppHandle, id: String) {
    let me = um(&app);
    let mut p = me.pending.lock().unwrap();
    // A digest stays offered until answered.
    if p.as_ref().is_some_and(|s| s.id == id && s.icon != "digest") {
        *p = None;
    }
}

/// A button on an update speech. Returns what Glitch says next (if anything).
#[tauri::command]
pub async fn update_choose(app: AppHandle, id: String, choice: String) -> Result<Option<UpdateSpeech>, UiError> {
    let me = um(&app);
    {
        let mut p = me.pending.lock().unwrap();
        if p.as_ref().is_some_and(|s| s.id == id) {
            *p = None;
        }
    }
    if let Some(rid) = id.strip_prefix("rem:").and_then(|n| n.parse::<u64>().ok()) {
        let mut store = me.reminders.lock().unwrap();
        let text = match choice.as_str() {
            "snooze" if store.snooze(rid, 10, now_unix()) => "Fine. Ten minutes, then I'm back.",
            "done" => {
                store.remove(rid);
                "Crossed off. Nice."
            }
            _ => return Ok(None),
        };
        UpdateMe::save_reminders(&store);
        drop(store);
        let _ = app.emit("reminders-changed", ());
        return Ok(Some(UpdateSpeech { id: me.next_id("ev"), text: text.into(), icon: "reminder", choices: vec![] }));
    }
    if id.starts_with("digest:") {
        match choice.as_str() {
            "tell" => {
                if me.summarising.swap(true, Ordering::SeqCst) {
                    return Ok(None);
                }
                let _ = app.emit("mood", "thinking");
                let speech = summarise(&app).await;
                me.summarising.store(false, Ordering::SeqCst);
                let _ = app.emit("mood", "happy");
                return Ok(Some(speech));
            }
            "clear" => {
                me.digest.lock().unwrap().clear();
                let _ = app.emit("digest-changed", Vec::<notifications::Group>::new());
            }
            _ => {}
        }
    }
    Ok(None)
}

/// The first chat of the day: the briefing (once per day), else `None`.
#[tauri::command]
pub async fn briefing_today(app: AppHandle) -> Option<String> {
    let f = feature(&app);
    let state = app.state::<AppState>();
    if !f.briefing_enabled || !state.settings().onboarding_done {
        return None;
    }
    let me = um(&app);
    let today = chrono::Local::now().date_naive();
    let mut saved = me.load_state();
    if !saved.briefing.due(today) {
        return None;
    }
    // Mark first: two quick opens must not brief twice.
    saved.briefing.last = Some(today);
    me.save_state(&saved);
    Some(build_briefing(&app).await.text())
}

/// Places for the weather (Open-Meteo geocoding, no key).
#[tauri::command]
pub async fn location_search(query: String) -> Result<Vec<Location>, UiError> {
    let q = query.trim();
    if q.chars().count() < 2 || q.chars().count() > 80 {
        return Ok(vec![]);
    }
    let v = fetch_json(&briefing::geocode_url(q)).await.map_err(|e| UiError::new("offline", e))?;
    Ok(briefing::parse_geocode(&v))
}

/// "Send a test": goes through the real endpoint like a script would.
#[tauri::command]
pub async fn update_me_test(app: AppHandle) -> Result<(), UiError> {
    let path = um(&app).endpoint_file();
    tauri::async_runtime::spawn_blocking(move || {
        let info = endpoint::read_info(&path).ok_or(endpoint::ClientError::NotListening)?;
        endpoint::notify(
            &info,
            &json!({"title": "Test from Settings", "body": "If you can read this, scripts can reach me.", "source": "settings", "level": "success"}),
        )
    })
    .await
    .map_err(|e| UiError::new("test_failed", e.to_string()))?
    .map_err(|e| UiError::new("test_failed", e.to_string()))
}

/// Debug builds with GLITCH_FAKE_NOTIFICATIONS=1: add a fake toast.
#[tauri::command]
pub fn update_me_fake_toast(app: AppHandle, app_name: String, title: String, body: String) -> Result<(), UiError> {
    let Some(fake) = um(&app).fake.clone() else {
        return Err(UiError::new("not_debug", "only in debug builds with GLITCH_FAKE_NOTIFICATIONS=1"));
    };
    let mut list = fake.toasts.lock().unwrap();
    let id = 10_000 + list.len() as u32;
    list.push(notifications::Toast { id, app: app_name, title, body, arrived: now_unix() });
    Ok(())
}

/// At startup: state, switches, the reminder ticker.
pub fn setup(app: &AppHandle, config_dir: PathBuf) {
    app.manage(UpdateMe::new(config_dir));
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let f = feature(&app);
        apply(&app, &f).await;
        loop {
            tick_reminders(&app);
            tokio::time::sleep(TICK).await;
        }
    });
}

/// On quit: the endpoint file says "not listening".
pub fn shutdown(app: &AppHandle) {
    stop_endpoint(app);
}
