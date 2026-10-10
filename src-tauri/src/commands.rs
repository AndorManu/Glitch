//! Everything the two web pages can ask the Rust side to do.
//! The AI model never calls these; only the UI does (on user clicks).

use std::time::Duration;

use glitch_core::agent::{AgentError, Step};
use glitch_core::ai::ollama::PullProgress;
use glitch_core::ai::{AiError, AiProvider};
use glitch_core::memory::{Fact, JournalEntry, MemoryStore};
use glitch_core::models::{self, Recommendation};
use glitch_core::platform::{self, Os};
use glitch_core::settings::Settings;
use glitch_core::world::{self, Ledge, ScreenRect};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::AppState;
use crate::windows;

/// Error shape the UI understands: `code` picks the friendly help text.
#[derive(Debug, Serialize)]
pub struct UiError {
    pub code: &'static str,
    pub message: String,
}

impl UiError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

impl From<AiError> for UiError {
    fn from(e: AiError) -> Self {
        let code = match &e {
            AiError::Unreachable(_) => "ollama_unreachable",
            AiError::TimedOut => "ai_timeout",
            AiError::ModelNotFound(_) => "model_missing",
            AiError::Api { .. } | AiError::InvalidResponse(_) => "ai_error",
        };
        UiError::new(code, e.to_string())
    }
}

impl From<AgentError> for UiError {
    fn from(e: AgentError) -> Self {
        match e {
            AgentError::Ai(ai) => ai.into(),
            AgentError::Confirm(c) => UiError::new("stale_confirmation", c.to_string()),
        }
    }
}

#[derive(Serialize)]
pub struct OllamaStatus {
    /// "running" | "stopped" (installed, not running) | "missing"
    state: &'static str,
    version: Option<String>,
    download_url: &'static str,
}

#[derive(Serialize)]
pub struct InstalledModel {
    name: String,
    size_gb: f32,
    /// `None` if Ollama couldn't tell us.
    supports_tools: Option<bool>,
}

#[derive(Serialize)]
pub struct SetupStatus {
    os: &'static str,
    ollama: OllamaStatus,
    recommendation: Recommendation,
    installed: Vec<InstalledModel>,
    settings: Settings,
}

fn os_name() -> &'static str {
    match Os::current() {
        Os::Windows => "windows",
        Os::MacOs => "macos",
        Os::Linux => "linux",
    }
}

#[tauri::command]
pub async fn setup_status(state: State<'_, AppState>) -> Result<SetupStatus, UiError> {
    let ollama = state.ollama.clone();
    let version = ollama.version().await.ok();
    let ollama_state = if version.is_some() {
        "running"
    } else if platform::find_ollama().is_some() {
        "stopped"
    } else {
        "missing"
    };
    let mut installed = Vec::new();
    if version.is_some() {
        for m in ollama.list_models().await.unwrap_or_default() {
            let supports_tools = ollama.capabilities(&m.name).await.ok().map(|c| c.iter().any(|c| c == "tools"));
            installed.push(InstalledModel {
                size_gb: (m.size as f64 / 1e9 * 10.0).round() as f32 / 10.0,
                name: m.name,
                supports_tools,
            });
        }
    }
    Ok(SetupStatus {
        os: os_name(),
        ollama: OllamaStatus { state: ollama_state, version, download_url: platform::ollama_download_url() },
        recommendation: models::recommend(models::total_ram_bytes()),
        installed,
        settings: state.settings(),
    })
}

#[tauri::command]
pub async fn start_ollama() -> Result<(), UiError> {
    let install = platform::find_ollama().ok_or_else(|| UiError::new("ollama_missing", "Ollama isn't installed"))?;
    platform::start_ollama(&install).map_err(|e| UiError::new("start_failed", e.to_string()))
}

#[tauri::command]
pub async fn open_ollama_download(state: State<'_, AppState>) -> Result<(), UiError> {
    state.platform.open_url(platform::ollama_download_url()).map_err(|e| UiError::new("open_failed", e.to_string()))
}

/// Ollama model names look like "qwen3.5:2b" or "user/model:tag".
fn valid_model_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name.chars().all(|c| c.is_ascii_alphanumeric() || "._:-/".contains(c))
        && !name.starts_with(['-', '/', '.'])
}

#[tauri::command]
pub async fn pull_model(
    state: State<'_, AppState>,
    name: String,
    on_progress: Channel<PullProgress>,
) -> Result<(), UiError> {
    if !valid_model_name(&name) {
        return Err(UiError::new("bad_model_name", format!("\"{name}\" isn't a valid model name")));
    }
    let ollama = state.ollama.clone();
    // Ollama sends hundreds of progress lines; only forward whole-percent steps.
    let mut last: Option<(String, u64)> = None;
    ollama
        .pull(&name, move |p| {
            let pct = match (p.completed, p.total) {
                (Some(c), Some(t)) if t > 0 => c * 100 / t,
                _ => 0,
            };
            let key = (p.status.clone(), pct);
            if last.as_ref() != Some(&key) {
                last = Some(key);
                let _ = on_progress.send(p);
            }
        })
        .await
        .map_err(UiError::from)
}

#[tauri::command]
pub async fn send_message(app: AppHandle, state: State<'_, AppState>, text: String) -> Result<Step, UiError> {
    let text = text.trim();
    if text.is_empty() {
        return Err(UiError::new("empty", "Type something first!"));
    }
    // Keep the small model's context (and the agent lock) sane.
    const MAX_INPUT_CHARS: usize = 4000;
    if text.chars().count() > MAX_INPUT_CHARS {
        return Err(UiError::new("too_long", "That's a lot of text! Could you make it shorter?"));
    }
    let model = state.settings().model.ok_or_else(|| UiError::new("no_model", "Pick a model in settings first"))?;
    let _ = app.emit("mood", "thinking");
    let result = state.agent.lock().await.send(&model, text).await;
    let _ = app.emit("mood", mood_after(&result));
    after_turn(&app, &model, &result);
    result.map_err(UiError::from)
}

/// After a finished reply: fold old messages into memory if the chat got long
/// (the model is still loaded right now, so this is cheap), and save the end
/// of the chat so it survives a restart. Runs in the background.
fn after_turn(app: &AppHandle, model: &str, result: &Result<Step, AgentError>) {
    let Ok(Step::Reply { actions, text }) = result else { return };
    // The stream overlay shows it too, only if the user allowed that.
    crate::stream::said(app, text);
    let memory_touched = actions.iter().any(|a| a.starts_with("Remembered") || a.starts_with("Forgot"));
    let (app, model) = (app.clone(), model.to_string());
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let mut agent = state.agent.lock().await;
        let mut changed = memory_touched;
        if agent.needs_compaction() {
            match agent.compact(&model, false).await {
                Ok(_) => changed = true,
                Err(e) => eprintln!("glitch: memory compaction failed: {e}"),
            }
        }
        agent.persist();
        if changed {
            let _ = app.emit("memory-changed", ());
        }
    });
}

#[tauri::command]
pub async fn confirm_action(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    approved: bool,
) -> Result<Step, UiError> {
    let model = state.settings().model.ok_or_else(|| UiError::new("no_model", "Pick a model first"))?;
    let _ = app.emit("mood", "thinking");
    let (result, notes_trusted) = {
        let mut agent = state.agent.lock().await;
        let result = agent.confirm(&model, &id, approved).await;
        (result, agent.notes_trusted())
    };
    // The first allowed note: later notes don't ask again (saved).
    if notes_trusted && !state.settings().notes_trusted {
        state.update_settings(|s| s.notes_trusted = true);
    }
    let _ = app.emit("mood", mood_after(&result));
    after_turn(&app, &model, &result);
    result.map_err(UiError::from)
}

fn mood_after(result: &Result<Step, AgentError>) -> &'static str {
    match result {
        Ok(Step::Reply { .. }) => "happy",
        Ok(Step::Confirm { .. }) => "asking",
        Err(_) => "idle",
    }
}

/// How long the model stays loaded while the chat bubble is open.
const WARM_KEEP_ALIVE: &str = "10m";

/// The chat bubble is open (called on open and every couple of minutes while
/// it stays open): load the model now and keep it loaded, so the first answer
/// doesn't wait for it. Best effort, never an error for the UI.
#[tauri::command]
pub async fn warm_model(state: State<'_, AppState>) -> Result<(), UiError> {
    let Some(model) = state.settings().model else { return Ok(()) };
    let ollama = state.ollama.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = ollama.warm_up(&model, WARM_KEEP_ALIVE).await {
            eprintln!("glitch: warming up {model} failed: {e}");
        }
    });
    Ok(())
}

/// The chat bubble closed: back to the short keep-alive from the settings,
/// so the model's memory is given back soon (only if it is still loaded:
/// never load it just for this).
#[tauri::command]
pub async fn cool_model(state: State<'_, AppState>) -> Result<(), UiError> {
    let settings = state.settings();
    let Some(model) = settings.model else { return Ok(()) };
    let ollama = state.ollama.clone();
    tauri::async_runtime::spawn(async move {
        if ollama.is_loaded(&model).await {
            let _ = ollama.warm_up(&model, &settings.keep_alive).await;
        }
    });
    Ok(())
}

/// New chat. With memory on, the old chat is first folded into memory (best
/// effort: skipped if Ollama is unavailable or slow).
#[tauri::command]
pub async fn reset_chat(app: AppHandle, state: State<'_, AppState>) -> Result<(), UiError> {
    let model = state.settings().model;
    let mut agent = state.agent.lock().await;
    // The chat is cleared either way; problems are reported so the UI can
    // say what happened instead of failing silently.
    let mut problem: Option<UiError> = None;
    if let (Some(model), true) = (model, agent.memory().is_some() && !agent.history().is_empty()) {
        // Only if the model is still in RAM: never load gigabytes just to
        // summarise. Otherwise the chat is kept as carry-over instead.
        if state.ollama.is_loaded(&model).await {
            match tokio::time::timeout(Duration::from_secs(60), agent.compact(&model, true)).await {
                Ok(Ok(_)) => {}
                Ok(Err(e)) => {
                    problem = Some(UiError::new(
                        "chat_not_summarised",
                        format!("Chat cleared, but I couldn't fold it into my memory first: {e}"),
                    ))
                }
                Err(_) => {
                    problem = Some(UiError::new(
                        "chat_not_summarised",
                        "Chat cleared, but folding it into my memory took too long, so I skipped that.",
                    ))
                }
            }
        } else {
            agent.persist();
        }
    }
    agent.reset();
    agent.persist();
    if let Some(Err(e)) = agent.memory().map(|m| m.save()) {
        problem = Some(UiError::new("save_failed", format!("Chat cleared, but I couldn't save my memory: {e}")));
    }
    let _ = app.emit("memory-changed", ());
    problem.map_or(Ok(()), Err)
}

#[derive(Serialize)]
pub struct MemoryView {
    enabled: bool,
    facts: Vec<Fact>,
    summary: String,
    journal: Vec<JournalEntry>,
}

#[tauri::command]
pub async fn get_memory(state: State<'_, AppState>) -> Result<MemoryView, UiError> {
    let agent = state.agent.lock().await;
    Ok(match agent.memory() {
        Some(m) => MemoryView {
            enabled: true,
            facts: m.data.facts.clone(),
            summary: m.data.summary.clone(),
            journal: m.data.journal.clone(),
        },
        None => MemoryView { enabled: false, facts: vec![], summary: String::new(), journal: vec![] },
    })
}

#[tauri::command]
pub async fn forget_memory(app: AppHandle, state: State<'_, AppState>, id: u64) -> Result<bool, UiError> {
    let gone = state.agent.lock().await.forget_fact(id);
    let _ = app.emit("memory-changed", ());
    Ok(gone)
}

/// Forget everything: facts, summaries, journal and the saved chat.
#[tauri::command]
pub async fn clear_memory(app: AppHandle, state: State<'_, AppState>) -> Result<(), UiError> {
    let mut agent = state.agent.lock().await;
    agent.clear_memory();
    agent.reset();
    agent.persist();
    let _ = app.emit("memory-changed", ());
    Ok(())
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings()
}

/// Fields the UI may change. Everything is optional; missing = unchanged.
#[derive(Deserialize)]
pub struct SettingsPatch {
    model: Option<String>,
    movement_enabled: Option<bool>,
    chaos_enabled: Option<bool>,
    onboarding_done: Option<bool>,
    memory_enabled: Option<bool>,
    screen_enabled: Option<bool>,
    /// "Let Glitch control apps".
    hands_enabled: Option<bool>,
    /// "Smarter brain for app control": a model name, or "" for the normal brain.
    hands_model: Option<String>,
}

#[tauri::command]
pub async fn update_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    patch: SettingsPatch,
) -> Result<Settings, UiError> {
    if let Some(m) = &patch.model {
        if !valid_model_name(m) {
            return Err(UiError::new("bad_model_name", format!("\"{m}\" isn't a valid model name")));
        }
    }
    if let Some(m) = patch.hands_model.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
        if !valid_model_name(m) {
            return Err(UiError::new("bad_model_name", format!("\"{m}\" isn't a valid model name")));
        }
    }
    let old_model = state.settings().model;
    let new = state.update_settings(|s| {
        if let Some(m) = patch.model {
            s.model = Some(m);
        }
        if let Some(v) = patch.movement_enabled {
            s.movement_enabled = v;
        }
        if let Some(v) = patch.chaos_enabled {
            s.chaos_enabled = v;
        }
        if let Some(v) = patch.onboarding_done {
            s.onboarding_done = v;
        }
        if let Some(v) = patch.memory_enabled {
            s.memory_enabled = v;
        }
        if let Some(v) = patch.screen_enabled {
            s.screen_enabled = v;
        }
        if let Some(v) = patch.hands_enabled {
            s.hands_enabled = v;
        }
        if let Some(m) = &patch.hands_model {
            s.hands_model = Some(m.trim().to_string()).filter(|m| !m.is_empty());
        }
    });
    if let Some(on) = patch.screen_enabled {
        state.agent.lock().await.set_screen_enabled(on);
    }
    if patch.hands_enabled.is_some() || patch.hands_model.is_some() {
        let mut agent = state.agent.lock().await;
        if let Some(on) = patch.hands_enabled {
            agent.set_hands(crate::hands::for_setting(&app, on));
        }
        agent.set_hands_model(new.hands_model.clone());
    }
    if let Some(on) = patch.memory_enabled {
        let mut agent = state.agent.lock().await;
        if on && agent.memory().is_none() {
            agent.set_memory(Some(MemoryStore::load(&state.memory_path)));
        } else if !on && agent.memory().is_some() {
            // Keep the file (so turning it back on restores it), stop using it.
            agent.persist();
            agent.set_memory(None);
        }
        let _ = app.emit("memory-changed", ());
    }
    // Switching models: free the old one's memory right away.
    if let Some(old) = old_model.filter(|o| Some(o) != new.model.as_ref()) {
        let ollama = state.ollama.clone();
        tauri::async_runtime::spawn(async move {
            let _ = ollama.unload(&old).await;
        });
    }
    if !new.chaos_enabled || !new.movement_enabled {
        crate::chaos::stop_all(&app);
    }
    let _ = app.emit("settings-changed", &new);
    Ok(new)
}

/// What a click on Glitch (or the tray's "Chat") does: the chat bubble, or
/// the setup wizard if setup isn't finished yet.
pub fn open_chat(app: &AppHandle, toggle: bool) {
    if app.state::<AppState>().settings().onboarding_done {
        if toggle {
            windows::toggle_bubble(app)
        } else {
            windows::show_bubble(app)
        }
    } else {
        show_panel_view(app, "setup");
    }
}

pub fn show_panel_view(app: &AppHandle, view: &str) {
    *app.state::<AppState>().panel_view.lock().unwrap() = view.to_string();
    windows::show_panel(app, view);
}

// The commands below can create a window. They are `async` because on
// Windows creating a webview window from a sync command deadlocks (see the
// WebviewWindowBuilder docs / wry#583).

#[tauri::command]
pub async fn mascot_clicked(app: AppHandle) {
    open_chat(&app, true);
}

#[tauri::command]
pub async fn show_bubble(app: AppHandle) {
    open_chat(&app, false);
}

#[tauri::command]
pub fn hide_bubble(app: AppHandle) {
    windows::hide_bubble_from_page(&app);
}

/// The bubble page started its close animation (it calls `hide_bubble` when
/// done). Until then a click on Glitch reopens the bubble instead of closing it.
#[tauri::command]
pub fn bubble_closing() {
    windows::bubble_closing();
}

/// The bubble page reports its content height (CSS px); returns where its
/// tail should point.
#[tauri::command]
pub fn resize_bubble(app: AppHandle, height: f64) -> Option<windows::BubbleLayout> {
    windows::resize_bubble(&app, height)
}

/// Open the panel. `view`: "setup" or "settings"; default depends on whether
/// setup is finished.
#[tauri::command]
pub async fn show_panel(app: AppHandle, view: Option<String>) {
    let onboarded = app.state::<AppState>().settings().onboarding_done;
    let view = match view.as_deref() {
        Some("setup") => "setup",
        Some("settings") => "settings",
        _ if onboarded => "settings",
        _ => "setup",
    };
    show_panel_view(&app, view);
}

/// The panel page asks which view to show when it loads.
#[tauri::command]
pub fn panel_view(state: State<'_, AppState>) -> String {
    state.panel_view.lock().unwrap().clone()
}

#[tauri::command]
pub fn hide_panel(app: AppHandle) {
    windows::hide_panel(&app);
}

/// Setup wizard finished: close it and say hi from the bubble.
#[tauri::command]
pub async fn finish_setup(app: AppHandle) {
    windows::hide_panel(&app);
    windows::show_bubble(&app);
}

#[tauri::command]
pub async fn quit(app: AppHandle) {
    quit_app(&app).await;
}

/// Unload the model (best effort, max ~1.5 s) so RAM is freed immediately,
/// then exit.
pub async fn quit_app(app: &AppHandle) {
    let state = app.state::<AppState>();
    if let Ok(mut agent) = state.agent.try_lock() {
        agent.persist();
    }
    if let Some(model) = state.settings().model {
        let _ = tokio::time::timeout(Duration::from_millis(1500), state.ollama.unload(&model)).await;
    }
    app.exit(0);
}

#[derive(Serialize)]
pub struct WorldSnapshot {
    area: ScreenRect,
    scale: f64,
    ledges: Vec<Ledge>,
    /// Whole frames of the windows that have ledges (for sliding down their
    /// sides, wall jumps).
    frames: Vec<WindowFrame>,
}

#[derive(Serialize)]
pub struct WindowFrame {
    id: u64,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

/// Screen edges + other apps' window tops (see glitch_core::world).
#[tauri::command]
pub async fn world_snapshot(app: AppHandle) -> Result<WorldSnapshot, UiError> {
    let mascot =
        app.get_webview_window(windows::MASCOT).ok_or_else(|| UiError::new("no_window", "mascot window missing"))?;
    let scale = mascot.scale_factor().unwrap_or(1.0);
    let area = windows::work_area_of(&mascot).ok_or_else(|| UiError::new("no_monitor", "no monitor found"))?;
    let area = ScreenRect { x: area.x, y: area.y, w: area.w, h: area.h };
    // Room above an edge for Glitch to stand (his body is ~90 CSS px tall).
    let headroom = (120.0 * scale) as i32;
    // Only edges long enough to read as something to stand on.
    let min_width = (140.0 * scale) as i32;
    let windows =
        tauri::async_runtime::spawn_blocking(move || crate::world_native::app_windows(scale)).await.unwrap_or_default();
    let ledges = world::ledges(&windows, area, headroom, min_width);
    let frames = windows
        .iter()
        .filter(|w| ledges.iter().any(|l| l.id == w.id))
        .map(|w| WindowFrame { id: w.id, x: w.rect.x, y: w.rect.y, w: w.rect.w, h: w.rect.h })
        .collect();
    Ok(WorldSnapshot { area, scale, ledges, frames })
}

/// Which part of the mascot window is Glitch's body (CSS px); `None` = all.
#[tauri::command]
pub fn set_hitbox(app: AppHandle, hitbox: State<'_, crate::hover::Hitbox>, rect: Option<crate::hover::LocalRect>) {
    if rect.is_some() {
        *hitbox.last_body.lock().unwrap() = rect;
    }
    *hitbox.body.lock().unwrap() = rect;
    if rect.is_none() {
        // Dragging starts now: catch the mouse immediately, don't wait for the poller.
        if let Some(w) = app.get_webview_window(windows::MASCOT) {
            let _ = w.set_ignore_cursor_events(false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_names() {
        for ok in ["qwen3.5:2b", "llama3.2:3b", "user/model:latest", "qwen3:0.6b"] {
            assert!(valid_model_name(ok), "{ok}");
        }
        for bad in ["", "-rm", "a b", "../x", "model;rm", "/abs", &"x".repeat(200)] {
            assert!(!valid_model_name(bad), "{bad}");
        }
    }
}
