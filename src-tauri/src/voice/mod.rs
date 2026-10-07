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
//! * `download`: speech-model download (resume, size + SHA-1 check)
//! * `hotkey`: the global push-to-talk shortcut
//! * `wake`: the optional "Hey Glitch" wake word (off by default)
//! * `tts`: Glitch's own read-aloud voice (optional Piper download)
//! * `tray`: the tray menu's wake-word item and tooltip
//! * `commands`: what the bubble and the settings panel can call

pub mod capture;
pub mod commands;
pub mod download;
pub mod hotkey;
#[cfg(test)]
mod live_check;
#[cfg(test)]
mod wake_check;
pub mod session;
pub mod stt;
pub mod tray;
pub mod tts;
pub mod wake;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tauri::menu::CheckMenuItem;
use tauri::Wry;

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
    /// The wake-word listener, while armed.
    wake: Mutex<Option<wake::Listener>>,
    wake_status: Mutex<wake::WakeStatus>,
    /// Glitch is reading a reply aloud (the wake check plugs its ears).
    speaking: AtomicBool,
    /// The wake check ignores the mic until then.
    quiet_until: Mutex<Instant>,
    /// Tray "Listen for “Hey Glitch”" item.
    tray_item: Mutex<Option<CheckMenuItem<Wry>>>,
    pub tts: tts::TtsState,
    /// The last command heard after "Hey Glitch" (and when): a chat
    /// message containing it is outside content (see `origin_of`).
    wake_heard: Mutex<Option<(String, Instant)>>,
}

impl VoiceState {
    fn new(models_dir: PathBuf) -> Self {
        Self {
            models_dir: models_dir.clone(),
            phase: Mutex::default(),
            stt: Arc::new(stt::Keeper::new(stt::KEEP_ALIVE)),
            download: Mutex::default(),
            hotkey: Mutex::default(),
            hotkey_down: Mutex::default(),
            offer_pending: AtomicBool::new(false),
            wake: Mutex::default(),
            wake_status: Mutex::default(),
            speaking: AtomicBool::new(false),
            quiet_until: Mutex::new(Instant::now()),
            tray_item: Mutex::default(),
            tts: tts::TtsState::new(models_dir.with_file_name("voices")),
            wake_heard: Mutex::default(),
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
    // Opening the microphone can take a moment: not on the startup path.
    let app = app.clone();
    let _ = std::thread::Builder::new().name("glitch-wake-arm".into()).spawn(move || wake::sync(&app));
}

fn emit(app: &AppHandle, e: &VoiceEvent) {
    let _ = app.emit("voice", e);
}

/// Start listening. Does nothing if a voice command is already running.
/// Everything that happens next arrives as "voice" events.
pub fn start(app: &AppHandle, mode: Mode) {
    start_with(app, Control::new(mode));
}

/// "Hey Glitch" was heard: open the chat and take the command hands-free
/// (the wake listener hands over its stream). `false` if it didn't start.
pub fn start_from_wake(app: &AppHandle, has_command: bool) -> bool {
    tts::stop(app);
    let started = start_with(app, Control::from_wake(has_command));
    if started {
        let app = app.clone();
        tauri::async_runtime::spawn(async move { crate::commands::open_chat(&app, false) });
    }
    started
}

fn start_with(app: &AppHandle, ctl: Control) -> bool {
    let vs = app.state::<VoiceState>();
    let settings = app.state::<AppState>().settings();
    if !settings.voice.enabled {
        return false;
    }
    if let Some(reason) = unavailable_reason() {
        let message = match reason {
            "cpu" => "this computer's processor is too old for the speech model",
            _ => "voice isn't available on this system",
        };
        emit(app, &VoiceEvent::Error { code: "voice_unsupported", message: message.into() });
        return false;
    }
    let model = current_model(app);
    if !vs.is_downloaded(model) {
        vs.offer_pending.store(true, Ordering::SeqCst);
        emit(app, &VoiceEvent::NeedsModel { model: *model });
        return false;
    }
    let ctl = {
        let mut phase = vs.phase.lock().unwrap();
        if !matches!(*phase, Phase::Idle) {
            return false;
        }
        let ctl = Arc::new(ctl);
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
                let vs = self.0.state::<VoiceState>();
                *vs.phase.lock().unwrap() = Phase::Idle;
                wake::quiet_for_a_moment(&vs);
            }
        }
        let _reset = Reset(app.clone());
        let vs = app.state::<VoiceState>();
        let abort = ctl.abort.clone();
        session::run(
            &ctl,
            |on_audio, on_error| {
                // The wake word's open stream if armed (no warm-up), else a fresh one.
                wake::open_for_command(&app, on_audio, on_error).map(|(m, rate, pre)| {
                    ctl.set_preroll(pre);
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
                    VoiceEvent::Heard { text } if ctl.is_from_wake() => {
                        *vs.wake_heard.lock().unwrap() = Some((text.clone(), Instant::now()));
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
        return false;
    }
    true
}

/// How long a wake-word transcript marks the chat message carrying it.
const WAKE_MESSAGE_WINDOW: std::time::Duration = std::time::Duration::from_secs(180);

/// Where a chat message came from. A message that contains the latest
/// wake-word transcript is [`Origin::WakeWord`] (outside content: every side
/// effect asks first), even if the user typed more around it. Decided here
/// in Rust, so the webview can't mark a wake-word message as trusted.
pub fn origin_of(app: &AppHandle, message: &str) -> glitch_core::agent::Origin {
    let vs = app.state::<VoiceState>();
    let mut heard = vs.wake_heard.lock().unwrap();
    match heard.as_ref() {
        Some((text, at)) if at.elapsed() < WAKE_MESSAGE_WINDOW && message.contains(text.as_str()) => {
            *heard = None;
            glitch_core::agent::Origin::WakeWord
        }
        _ => glitch_core::agent::Origin::Typed,
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
