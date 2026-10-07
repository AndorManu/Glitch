//! Everything the two web pages can ask the Rust side to do.
//! The AI model never calls these; only the UI does (on user clicks).

use std::time::Duration;

use glitch_core::agent::{AgentError, Step};
use glitch_core::ai::ollama::PullProgress;
use glitch_core::ai::AiError;
use glitch_core::models::{self, Recommendation};
use glitch_core::platform::{self, Os, Platform};
use glitch_core::settings::Settings;
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
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

impl From<AiError> for UiError {
    fn from(e: AiError) -> Self {
        let code = match &e {
            AiError::Unreachable(_) => "ollama_unreachable",
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
pub fn start_ollama() -> Result<(), UiError> {
    let install = platform::find_ollama().ok_or_else(|| UiError::new("ollama_missing", "Ollama isn't installed"))?;
    platform::start_ollama(&install).map_err(|e| UiError::new("start_failed", e.to_string()))
}

#[tauri::command]
pub fn open_ollama_download(state: State<'_, AppState>) -> Result<(), UiError> {
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
    let model = state.settings().model.ok_or_else(|| UiError::new("no_model", "Pick a model in settings first"))?;
    let _ = app.emit("mood", "thinking");
    let result = state.agent.lock().await.send(&model, text).await;
    let _ = app.emit("mood", mood_after(&result));
    result.map_err(UiError::from)
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
    let result = state.agent.lock().await.confirm(&model, &id, approved).await;
    let _ = app.emit("mood", mood_after(&result));
    result.map_err(UiError::from)
}

fn mood_after(result: &Result<Step, AgentError>) -> &'static str {
    match result {
        Ok(Step::Reply { .. }) => "happy",
        Ok(Step::Confirm { .. }) => "asking",
        Err(_) => "idle",
    }
}

#[tauri::command]
pub async fn reset_chat(state: State<'_, AppState>) -> Result<(), UiError> {
    state.agent.lock().await.reset();
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
    onboarding_done: Option<bool>,
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
    let old_model = state.settings().model;
    let new = state.update_settings(|s| {
        if let Some(m) = patch.model {
            s.model = Some(m);
        }
        if let Some(v) = patch.movement_enabled {
            s.movement_enabled = v;
        }
        if let Some(v) = patch.onboarding_done {
            s.onboarding_done = v;
        }
    });
    // Switching models: free the old one's memory right away.
    if let Some(old) = old_model.filter(|o| Some(o) != new.model.as_ref()) {
        let ollama = state.ollama.clone();
        tauri::async_runtime::spawn(async move {
            let _ = ollama.unload(&old).await;
        });
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

#[tauri::command]
pub fn mascot_clicked(app: AppHandle) {
    open_chat(&app, true);
}

#[tauri::command]
pub fn show_bubble(app: AppHandle) {
    open_chat(&app, false);
}

#[tauri::command]
pub fn hide_bubble(app: AppHandle) {
    windows::hide_bubble(&app);
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
pub fn show_panel(app: AppHandle, state: State<'_, AppState>, view: Option<String>) {
    let view = match view.as_deref() {
        Some("setup") => "setup",
        Some("settings") => "settings",
        _ if state.settings().onboarding_done => "settings",
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
pub fn finish_setup(app: AppHandle) {
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
    if let Some(model) = state.settings().model {
        let _ = tokio::time::timeout(Duration::from_millis(1500), state.ollama.unload(&model)).await;
    }
    app.exit(0);
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
