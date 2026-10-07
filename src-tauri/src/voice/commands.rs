//! What the chat bubble and the settings panel can ask the voice side to do.
//! (Registered in main.rs next to the other commands.)

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use glitch_core::settings::Settings;
use glitch_core::voice::models::{self as speech_models, SpeechModel, MODELS};
use glitch_core::voice::vad::Mode;
use glitch_core::voice::{valid_language, LANGUAGES};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use super::download::{self, DownloadError, Expected};
use super::hotkey::{self, HotkeyStatus};
use super::{current_model, tts, unavailable_reason, wake, DownloadJob, VoiceState};
use crate::commands::UiError;
use crate::state::AppState;

fn err(code: &'static str, message: impl Into<String>) -> UiError {
    UiError { code, message: message.into() }
}

#[derive(Serialize)]
pub struct ModelView {
    #[serde(flatten)]
    model: SpeechModel,
    size_mb: u64,
    downloaded: bool,
}

#[derive(Serialize)]
pub struct LanguageView {
    code: &'static str,
    label: &'static str,
}

#[derive(Serialize, Clone)]
pub struct DownloadView {
    model: &'static str,
    done: u64,
    total: u64,
}

#[derive(Serialize)]
pub struct VoiceStatus {
    /// `false` on Linux or on a CPU too old for the speech model.
    available: bool,
    unavailable_reason: Option<&'static str>,
    os: &'static str,
    enabled: bool,
    /// "idle" | "listening" | "transcribing"
    phase: &'static str,
    hotkey: HotkeyStatus,
    /// The model voice uses now (setting or RAM-based pick).
    model: &'static str,
    /// The pick for this computer's RAM.
    recommended: &'static str,
    /// Whether `model` is chosen by RAM (no explicit choice).
    model_auto: bool,
    models: Vec<ModelView>,
    language: String,
    languages: Vec<LanguageView>,
    speak_replies: bool,
    download: Option<DownloadView>,
    /// The bubble should show the "download the speech model?" offer (it
    /// was opened by the hotkey and may have missed the event).
    offer_pending: bool,
    /// "Hey Glitch" (setting + whether the mic is open for it right now).
    wake: wake::WakeStatus,
    /// "system" | "glitch"
    read_aloud_voice: String,
    /// The character voice's download state.
    tts: tts::TtsStatus,
}

fn os_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

#[tauri::command]
pub fn voice_status(app: AppHandle) -> VoiceStatus {
    let vs = app.state::<VoiceState>();
    let settings = app.state::<AppState>().settings();
    let reason = unavailable_reason();
    let download =
        vs.download.lock().unwrap().as_ref().map(|j| DownloadView { model: j.model, done: j.done, total: j.total });
    VoiceStatus {
        available: reason.is_none(),
        unavailable_reason: reason,
        os: os_name(),
        enabled: settings.voice.enabled,
        phase: vs.phase_name(),
        hotkey: hotkey::status(&app),
        model: current_model(&app).id,
        recommended: speech_models::recommended(glitch_core::models::total_ram_bytes()).id,
        model_auto: settings.voice.model.as_deref().and_then(speech_models::find).is_none(),
        models: MODELS
            .iter()
            .map(|m| ModelView { model: *m, size_mb: m.size_mb(), downloaded: vs.is_downloaded(m) })
            .collect(),
        language: settings.voice.language.clone(),
        languages: LANGUAGES.iter().map(|(code, label)| LanguageView { code, label }).collect(),
        speak_replies: settings.voice.speak_replies,
        download,
        offer_pending: vs.offer_pending.load(Ordering::SeqCst),
        wake: wake::status(&app),
        read_aloud_voice: settings.voice.read_aloud_voice.clone(),
        tts: tts::status(&app),
    }
}

/// Re-arm/disarm the wake word off the calling thread (opening the
/// microphone can take a moment).
fn resync_wake(app: &AppHandle) {
    let app = app.clone();
    let _ = std::thread::Builder::new().name("glitch-wake-sync".into()).spawn(move || wake::sync(&app));
}

/// Voice settings the UI may change. Missing = unchanged.
#[derive(Deserialize)]
pub struct VoicePatch {
    enabled: Option<bool>,
    /// "tiny" | "base" | "small", or "auto" to pick by RAM.
    model: Option<String>,
    language: Option<String>,
    speak_replies: Option<bool>,
    /// Listen for "Hey Glitch".
    wake_word: Option<bool>,
    /// "system" | "glitch"
    read_aloud_voice: Option<String>,
}

#[tauri::command]
pub async fn update_voice_settings(app: AppHandle, patch: VoicePatch) -> Result<Settings, UiError> {
    if let Some(m) = &patch.model {
        if m != "auto" && speech_models::find(m).is_none() {
            return Err(err("bad_voice_model", format!("\"{m}\" isn't a speech model")));
        }
    }
    if let Some(l) = &patch.language {
        if !valid_language(l) {
            return Err(err("bad_language", format!("\"{l}\" isn't a supported language")));
        }
    }
    if let Some(v) = &patch.read_aloud_voice {
        if v != "system" && v != "glitch" {
            return Err(err("bad_voice", format!("\"{v}\" isn't a read-aloud voice")));
        }
    }
    let before = current_model(&app);
    let wake_affected = patch.enabled.is_some() || patch.wake_word.is_some() || patch.model.is_some();
    let new = app.state::<AppState>().update_settings(|s| {
        if let Some(v) = patch.enabled {
            s.voice.enabled = v;
        }
        if let Some(m) = patch.model {
            s.voice.model = (m != "auto").then_some(m);
        }
        if let Some(l) = patch.language {
            s.voice.language = l;
        }
        if let Some(v) = patch.speak_replies {
            s.voice.speak_replies = v;
        }
        if let Some(v) = patch.wake_word {
            s.voice.wake_word = v;
        }
        if let Some(v) = patch.read_aloud_voice {
            s.voice.read_aloud_voice = v;
        }
    });
    if !new.voice.speak_replies || new.voice.read_aloud_voice != "glitch" {
        tts::stop(&app);
    }
    if !new.voice.enabled {
        super::cancel(&app);
        super::unload(&app, None);
    }
    if current_model(&app) != before {
        super::unload(&app, None);
    }
    if patch.enabled.is_some() {
        hotkey::sync(&app);
    }
    if wake_affected {
        resync_wake(&app);
    }
    let _ = app.emit("settings-changed", &new);
    Ok(new)
}

/// Start listening. `mode`: "hold" (default: until `voice_stop`) or
/// "hands_free" (until the user goes quiet).
#[tauri::command]
pub fn voice_start(app: AppHandle, mode: Option<String>) {
    let mode = if mode.as_deref() == Some("hands_free") { Mode::HandsFree } else { Mode::Hold };
    super::start(&app, mode);
}

#[tauri::command]
pub fn voice_stop(app: AppHandle) {
    super::stop(&app);
}

/// The mic button was only tapped: keep listening until the user is quiet.
#[tauri::command]
pub fn voice_hands_free(app: AppHandle) {
    super::hands_free(&app);
}

#[tauri::command]
pub fn voice_cancel(app: AppHandle) {
    super::cancel(&app);
}

/// The bubble showed (or dismissed) the "download the speech model?" offer.
#[tauri::command]
pub fn voice_offer_seen(app: AppHandle) {
    app.state::<VoiceState>().offer_pending.store(false, Ordering::SeqCst);
}

#[derive(Serialize, Clone)]
struct ErrorView {
    code: &'static str,
    message: String,
}

/// "voice-download" event payload.
#[derive(Serialize, Clone)]
struct DownloadEvent {
    model: &'static str,
    /// "running" | "done" | "failed" | "cancelled"
    state: &'static str,
    done: u64,
    total: u64,
    error: Option<ErrorView>,
}

/// Where models are downloaded from. `GLITCH_SPEECH_MODEL_URL` points it at a
/// mirror or a local test server.
fn base_url() -> String {
    std::env::var("GLITCH_SPEECH_MODEL_URL").unwrap_or_else(|_| speech_models::DEFAULT_BASE_URL.to_string())
}

/// Download a speech model (default: the current one). Progress arrives as
/// "voice-download" events, to every window.
#[tauri::command]
pub async fn voice_download_model(app: AppHandle, model: Option<String>) -> Result<(), UiError> {
    let m: &'static SpeechModel = match model.as_deref() {
        Some(id) => {
            speech_models::find(id).ok_or_else(|| err("bad_voice_model", format!("\"{id}\" isn't a speech model")))?
        }
        None => current_model(&app),
    };
    let vs = app.state::<VoiceState>();
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut job = vs.download.lock().unwrap();
        if let Some(j) = job.as_ref() {
            return if j.model == m.id {
                Ok(())
            } else {
                Err(err("download_busy", "another speech model is downloading"))
            };
        }
        *job = Some(DownloadJob { model: m.id, cancel: cancel.clone(), done: 0, total: m.size_bytes });
    }
    vs.offer_pending.store(false, Ordering::SeqCst);
    let send = |state: &'static str, done: u64, total: u64, error: Option<ErrorView>| {
        let _ = app.emit("voice-download", DownloadEvent { model: m.id, state, done, total, error });
    };
    send("running", 0, m.size_bytes, None);

    let dest = vs.model_path(m);
    let url = speech_models::url(&base_url(), m);
    let mut last = Instant::now() - Duration::from_secs(1);
    let result = download::download(
        &download::client(),
        &url,
        &dest,
        &Expected { sha1: m.sha1, size: m.size_bytes },
        &cancel,
        |done, total| {
            // At most 5 updates a second (plus the last one).
            if last.elapsed() >= Duration::from_millis(200) || done == total {
                last = Instant::now();
                if let Some(j) = vs.download.lock().unwrap().as_mut() {
                    (j.done, j.total) = (done, total);
                }
                send("running", done, total, None);
            }
        },
    )
    .await;
    *vs.download.lock().unwrap() = None;
    match result {
        Ok(()) => {
            send("done", m.size_bytes, m.size_bytes, None);
            // The wake word may have been waiting for this model.
            resync_wake(&app);
            Ok(())
        }
        Err(e) => {
            let state = if e == DownloadError::Cancelled { "cancelled" } else { "failed" };
            send(state, 0, m.size_bytes, Some(ErrorView { code: e.code(), message: e.to_string() }));
            Err(err(e.code(), e.to_string()))
        }
    }
}

#[tauri::command]
pub fn voice_cancel_download(app: AppHandle) {
    if let Some(j) = app.state::<VoiceState>().download.lock().unwrap().as_ref() {
        j.cancel.store(true, Ordering::SeqCst);
    }
}

/// Delete a downloaded speech model (and any half-finished download of it).
#[tauri::command]
pub fn voice_delete_model(app: AppHandle, model: String) -> Result<(), UiError> {
    let m = speech_models::find(&model)
        .ok_or_else(|| err("bad_voice_model", format!("\"{model}\" isn't a speech model")))?;
    let vs = app.state::<VoiceState>();
    if vs.download.lock().unwrap().as_ref().is_some_and(|j| j.model == m.id) {
        return Err(err("download_busy", "that model is downloading right now"));
    }
    let path = vs.model_path(m);
    super::unload(&app, Some(&path));
    for p in [download::part_path(&path), path] {
        match std::fs::remove_file(&p) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(err("delete_failed", e.to_string())),
        }
    }
    resync_wake(&app);
    Ok(())
}

/// The bubble's system voice started/stopped reading a reply aloud (the
/// wake word ignores the microphone meanwhile).
#[tauri::command]
pub fn voice_speaking(app: AppHandle, on: bool) {
    wake::set_speaking(&app, on);
}

/// A message is on its way: get the character voice ready (if it's used).
#[tauri::command]
pub fn voice_tts_prepare(app: AppHandle) {
    tts::prepare(&app);
}

/// Read a reply aloud with Glitch's voice. An error means "use the system
/// voice instead" (not downloaded, no speakers, ...).
#[tauri::command]
pub fn voice_tts_speak(app: AppHandle, text: String) -> Result<(), UiError> {
    if text.chars().count() > 1_000 {
        return Err(err("too_long", "that's too long to read aloud"));
    }
    tts::speak(&app, &text).map_err(|e| err("tts_failed", e))
}

#[tauri::command]
pub fn voice_tts_stop(app: AppHandle) {
    tts::stop(&app);
}

/// Download the character voice. Progress as "tts-download" events.
#[tauri::command]
pub async fn voice_tts_download(app: AppHandle) -> Result<(), UiError> {
    tts::download_all(&app).await.map_err(|e| err(e.code(), e.to_string()))
}

#[tauri::command]
pub fn voice_tts_cancel_download(app: AppHandle) {
    tts::cancel_download(&app);
}

/// Remove the character voice from disk (read-aloud falls back to the system voice).
#[tauri::command]
pub fn voice_tts_delete(app: AppHandle) -> Result<(), UiError> {
    tts::delete(&app).map_err(|e| err("delete_failed", e))
}

/// Open the OS's microphone privacy settings (after "permission denied").
#[tauri::command]
pub fn voice_open_mic_settings() -> Result<(), UiError> {
    let url = if cfg!(target_os = "windows") {
        "ms-settings:privacy-microphone"
    } else if cfg!(target_os = "macos") {
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
    } else {
        return Err(err("unsupported", "not available on this system"));
    };
    open::that_detached(url).map_err(|e| err("open_failed", e.to_string()))
}
