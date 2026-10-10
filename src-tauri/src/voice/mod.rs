//! Voice commands: push-to-talk, fully local.
//!
//! Hold the mic button in the chat bubble (or the global hotkey), talk, let
//! go: the microphone records only while held (a quick tap records one
//! sentence hands-free), whisper.cpp turns it into text on this computer,
//! and the bubble sends that text exactly like a typed message.
//!
//! Lightweight by construction: while idle there is no audio stream, no
//! thread and no model in memory. A recording has its own thread that ends
//! with it; the speech model is loaded when you start talking and freed a
//! minute after the last use (see `stt::Keeper`).
//!
//! * `capture`: microphone (cpal), Windows + macOS
//! * `session`: one command from mic to text (tested with a fake mic)
//! * `stt`: whisper model loading/unloading and transcription
//! * `download`: speech-model download (resume, size + SHA-256 check)
//! * `hotkey`: the global push-to-talk shortcut
//! * `commands`: what the bubble and the settings panel can call

pub mod capture;
pub mod commands;
pub mod download;
pub mod hotkey;
#[cfg(test)]
mod live_check;
pub mod session;
pub mod stt;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use glitch_core::voice::models::{self as speech_models, SpeechModel};
use glitch_core::voice::vad::Mode;
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;
use session::{Control, VoiceEvent};

/// Where we are. Only one voice command at a time.
#[derive(Default)]
enum Phase {
    #[default]
    Idle,
    Listening(Arc<Control>),
    Transcribing(Arc<Control>),
}

/// A model download in progress (one at a time).
pub struct DownloadJob {
    pub model: &'static str,
    pub cancel: Arc<AtomicBool>,
    pub done: u64,
    pub total: u64,
}

pub struct VoiceState {
    models_dir: PathBuf,
    phase: Mutex<Phase>,
    stt: Arc<stt::Keeper<stt::Model>>,
    download: Mutex<Option<DownloadJob>>,
    hotkey: Mutex<hotkey::HotkeyStatus>,
    /// When the hotkey went down (to tell a tap from a hold).
    hotkey_down: Mutex<Option<Instant>>,
    /// A "needs model" offer the bubble may have missed (it was just opened).
    offer_pending: AtomicBool,
}

impl VoiceState {
    fn new(models_dir: PathBuf) -> Self {
        Self {
            models_dir,
            phase: Mutex::default(),
            stt: Arc::new(stt::Keeper::new(stt::KEEP_ALIVE)),
            download: Mutex::default(),
            hotkey: Mutex::default(),
            hotkey_down: Mutex::default(),
            offer_pending: AtomicBool::new(false),
        }
    }

    pub fn model_path(&self, m: &SpeechModel) -> PathBuf {
        self.models_dir.join(m.file)
    }

    pub fn is_downloaded(&self, m: &SpeechModel) -> bool {
        self.model_path(m).is_file()
    }

    fn phase_name(&self) -> &'static str {
        match *self.phase.lock().unwrap() {
            Phase::Idle => "idle",
            Phase::Listening(_) => "listening",
            Phase::Transcribing(_) => "transcribing",
        }
    }

    fn control(&self) -> Option<Arc<Control>> {
        match &*self.phase.lock().unwrap() {
            Phase::Idle => None,
            Phase::Listening(c) | Phase::Transcribing(c) => Some(c.clone()),
        }
    }
}

/// Why voice can't be used on this machine at all (`None` = it can).
pub fn unavailable_reason() -> Option<&'static str> {
    if !capture::SUPPORTED {
        Some("platform")
    } else if !stt::cpu_supported() {
        Some("cpu")
    } else {
        None
    }
}

/// The speech model the settings ask for (or the one that fits this RAM).
pub fn current_model(app: &AppHandle) -> &'static SpeechModel {
    let settings = app.state::<AppState>().settings();
    speech_models::resolve(settings.voice.model.as_deref(), glitch_core::models::total_ram_bytes())
}

/// Called once from `main`'s setup: registers state and the hotkey. Loads
/// nothing else.
pub fn setup(app: &AppHandle) {
    let dir = app
        .path()
        .app_local_data_dir()
        .or_else(|_| app.path().app_data_dir())
        .unwrap_or_else(|_| std::env::temp_dir().join("glitch"))
        .join("speech-models");
    app.manage(VoiceState::new(dir));
    hotkey::sync(app);
}

fn emit(app: &AppHandle, e: &VoiceEvent) {
    let _ = app.emit("voice", e);
}

/// Start listening. Does nothing if a voice command is already running.
/// Everything that happens next arrives as "voice" events.
pub fn start(app: &AppHandle, mode: Mode) {
    // The panic button: the microphone stays off.
    if crate::pause::is_paused() {
        return;
    }
    let vs = app.state::<VoiceState>();
    let settings = app.state::<AppState>().settings();
    if !settings.voice.enabled {
        return;
    }
    if let Some(reason) = unavailable_reason() {
        let message = match reason {
            "cpu" => "this computer's processor is too old for the speech model",
            _ => "voice isn't available on this system",
        };
        emit(app, &VoiceEvent::Error { code: "voice_unsupported", message: message.into() });
        return;
    }
    let model = current_model(app);
    if !vs.is_downloaded(model) {
        vs.offer_pending.store(true, Ordering::SeqCst);
        emit(app, &VoiceEvent::NeedsModel { model: *model });
        return;
    }
    let ctl = {
        let mut phase = vs.phase.lock().unwrap();
        if !matches!(*phase, Phase::Idle) {
            return;
        }
        let ctl = Arc::new(Control::new(mode));
        *phase = Phase::Listening(ctl.clone());
        ctl
    };
    vs.offer_pending.store(false, Ordering::SeqCst);
    let _ = app.emit("mood", "listening");

    let path = vs.model_path(model);
    // Load the model while the user is still talking.
    let (keeper, p) = (vs.stt.clone(), path.clone());
    let _ = std::thread::Builder::new().name("glitch-voice-load".into()).spawn(move || {
        let _ = keeper.get(&p, stt::load);
    });

    let language = glitch_core::voice::whisper_language(&settings.voice.language);
    let handle = app.clone();
    let spawned = std::thread::Builder::new().name("glitch-voice".into()).spawn(move || {
        let app = handle;
        // Back to idle however this thread ends (even on a panic).
        struct Reset(AppHandle);
        impl Drop for Reset {
            fn drop(&mut self) {
                *self.0.state::<VoiceState>().phase.lock().unwrap() = Phase::Idle;
            }
        }
        let _reset = Reset(app.clone());
        let vs = app.state::<VoiceState>();
        let abort = ctl.abort.clone();
        session::run(
            &ctl,
            |on_audio, on_error| {
                capture::open(on_audio, on_error).map(|m| {
                    let rate = m.sample_rate;
                    (m, rate)
                })
            },
            |samples| {
                let model = vs.stt.get(&path, stt::load).map_err(|e| format!("couldn't load the speech model: {e}"))?;
                let text = stt::transcribe(&model, samples, language, abort);
                drop(model);
                vs.stt.touch();
                text
            },
            |e| {
                match &e {
                    VoiceEvent::Transcribing => {
                        *vs.phase.lock().unwrap() = Phase::Transcribing(ctl.clone());
                        let _ = app.emit("mood", "thinking");
                    }
                    VoiceEvent::Idle { .. } | VoiceEvent::Error { .. } => {
                        let _ = app.emit("mood", "idle");
                    }
                    // "heard": the bubble sends it right away, which sets
                    // the mood to "thinking" again (no flicker in between).
                    _ => {}
                }
                emit(&app, &e);
            },
        );
    });
    if let Err(e) = spawned {
        *vs.phase.lock().unwrap() = Phase::Idle;
        emit(app, &VoiceEvent::Error { code: "mic_failed", message: e.to_string() });
    }
}

/// Let go: stop recording and transcribe.
pub fn stop(app: &AppHandle) {
    if let Some(c) = app.state::<VoiceState>().control() {
        c.stop();
    }
}

/// A quick tap: keep listening until the user goes quiet.
pub fn hands_free(app: &AppHandle) {
    if let Some(c) = app.state::<VoiceState>().control() {
        c.set_hands_free();
    }
}

/// Throw the current recording/transcription away.
pub fn cancel(app: &AppHandle) {
    if let Some(c) = app.state::<VoiceState>().control() {
        c.cancel();
    }
}

/// Free the speech model now if it's the one at `path` (or any, if `None`).
pub fn unload(app: &AppHandle, path: Option<&Path>) {
    let vs = app.state::<VoiceState>();
    if path.is_none() || vs.stt.loaded_path().as_deref() == path {
        vs.stt.unload();
    }
}
