//! "Hey Glitch": the optional, always-on wake word (off by default).
//!
//! While armed, one thread keeps the microphone open and feeds it to the
//! utterance [`Segmenter`]: in a quiet room that is all that runs (no
//! model, a few multiplications per sample). When someone talks, the start
//! of the utterance goes to whisper once ([`detect`]); if it begins with
//! "Glitch", the chat opens, he perks up and the same microphone stream is
//! handed to a normal hands-free voice command, *including* what was said
//! so far, so "Hey Glitch, open YouTube" in one breath works as well as
//! "Hey Glitch." ... "Open YouTube.".
//!
//! Push-to-talk borrows the open stream too (no ~0.8 s mic warm-up).
//! The wake check pauses while a command runs, while Glitch reads a reply
//! aloud (he'd hear himself), and for a moment after either.
//!
//! Privacy: the audio never leaves the thread except as text to the chat
//! after the wake word; the tray menu, its tooltip and the chat bubble show
//! that he is listening, and Windows/macOS show their own mic indicator.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use glitch_core::voice::audio::{prepare_for_whisper, resample};
use glitch_core::voice::wake::{self as wake_core, Segmenter, WakeConfig};
use glitch_core::voice::SAMPLE_RATE;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::capture::{self, MicError};
use super::session::{AudioSink, ErrorSink};
use super::{stt, VoiceState};
use crate::state::AppState;

/// Ignore the microphone this long after a command or after Glitch spoke
/// (room echo, the user's "thanks").
const QUIET_AFTER: Duration = Duration::from_millis(1_200);

/// Where the open microphone stream goes besides the wake check.
enum TapState {
    /// Nobody else listens.
    Off,
    /// The wake word was heard; a command is starting. Audio collects here
    /// until it attaches (nothing is lost while its thread starts).
    Waiting(Vec<f32>),
    /// A voice command is recording from this stream.
    Attached(AudioSink),
    /// The listener stopped (or its microphone failed).
    Closed,
}

pub struct Tap {
    state: Mutex<TapState>,
    pub rate: u32,
}

/// Dropping it detaches the command from the stream (= "mic off" for it).
pub struct TapGuard(Arc<Tap>);

impl Drop for TapGuard {
    fn drop(&mut self) {
        let mut s = self.0.state.lock().unwrap();
        if !matches!(*s, TapState::Closed) {
            *s = TapState::Off;
        }
    }
}

impl Tap {
    fn new(rate: u32) -> Self {
        Self { state: Mutex::new(TapState::Off), rate }
    }

    /// Hand the stream to a recording: returns the guard and the audio that
    /// was waiting for it (the utterance with the wake word, or nothing for
    /// push-to-talk). `None` if the stream is closed or already in use.
    pub fn attach(self: &Arc<Self>, sink: AudioSink) -> Option<(TapGuard, Vec<f32>)> {
        let mut s = self.state.lock().unwrap();
        let pre = match std::mem::replace(&mut *s, TapState::Off) {
            TapState::Off => vec![],
            TapState::Waiting(buf) => buf,
            other @ (TapState::Attached(_) | TapState::Closed) => {
                *s = other;
                return None;
            }
        };
        *s = TapState::Attached(sink);
        Some((TapGuard(self.clone()), pre))
    }

    /// Feed a chunk to whoever listens; `false` if nobody does (then the
    /// wake check gets it).
    fn feed(&self, chunk: &[f32]) -> bool {
        match &mut *self.state.lock().unwrap() {
            TapState::Off | TapState::Closed => false,
            TapState::Waiting(buf) => {
                buf.extend_from_slice(chunk);
                true
            }
            TapState::Attached(sink) => {
                sink(chunk);
                true
            }
        }
    }

    fn close(&self) {
        *self.state.lock().unwrap() = TapState::Closed;
    }
}

/// A running listener.
pub struct Listener {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    pub tap: Arc<Tap>,
}

impl Listener {
    fn shutdown(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// For Settings, the tray and the bubble.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct WakeStatus {
    /// The setting.
    pub enabled: bool,
    /// The microphone is open and he listens for "Hey Glitch".
    pub armed: bool,
    /// Why it isn't armed although enabled: "needs_model", "voice_off",
    /// "unavailable", or a microphone error code ("mic_denied", ...).
    pub problem: Option<&'static str>,
    pub message: Option<String>,
}

/// What one utterance sounded like to the wake check.
#[derive(Debug, Clone)]
pub struct Detection {
    pub text: String,
    pub wake: bool,
    /// Something follows the wake word ("Hey Glitch, open YouTube"), so the
    /// command has already started.
    pub has_command: bool,
    /// Whisper's certainty of the wake phrase (`None`: not the phrase).
    pub confidence: Option<f32>,
}

/// Prime whisper with "Hey Glitch." for the wake check? Measured with
/// dev/wake-check.mjs: the prompt makes whisper *skip* the phrase when the
/// command follows in one breath (it reads the prompt as already said) and
/// parrot it on noise, so it's off.
pub const WAKE_PROMPT: bool = false;

/// "Hey." then a pause then "Glitch." still counts if the name comes within this.
const GREETING_GAP: Duration = Duration::from_millis(2_500);

/// The wake check, utterance by utterance (remembers a lone "Hey." for the
/// next one).
pub struct Detector {
    greeting_at: Option<Instant>,
    pub prompt: bool,
}

impl Default for Detector {
    fn default() -> Self {
        Self { greeting_at: None, prompt: WAKE_PROMPT }
    }
}

impl Detector {
    /// One utterance (`audio` mono at `rate`). `None` if there's too little
    /// speech in it to bother whisper.
    pub fn check(&mut self, model: &stt::Model, audio: &[f32], rate: u32) -> Result<Option<Detection>, String> {
        let after_greeting = self.greeting_at.take().is_some_and(|t| t.elapsed() < GREETING_GAP);
        let Some(samples) = prepare_for_whisper(&resample(audio, rate, SAMPLE_RATE)) else { return Ok(None) };
        let mut tokens = stt::transcribe_wake(model, &samples, self.prompt)?;
        let text = tokens.iter().map(|(t, _)| t.as_str()).collect::<String>().trim().to_string();
        if wake_core::is_greeting_only(&text) {
            self.greeting_at = Some(Instant::now());
        }
        if after_greeting && !wake_core::is_wake(&text) {
            // Judge "Glitch, open YouTube" as the end of "Hey ... Glitch".
            tokens.insert(0, ("Hey".into(), 1.0));
            if !tokens.get(1).is_some_and(|(t, _)| t.starts_with(' ')) {
                tokens.insert(1, (" ".into(), 1.0));
            }
        }
        let confidence = wake_core::wake_confidence(&tokens);
        let wake = confidence.is_some_and(|c| c >= wake_core::MIN_CONFIDENCE);
        let full: String = tokens.iter().map(|(t, _)| t.as_str()).collect();
        let has_command = wake && wake_core::strip_wake(full.trim()).is_some();
        Ok(Some(Detection { text, wake, has_command, confidence }))
    }
}

/// Arm or disarm to match the settings (and whether it can work at all).
/// Cheap to call often; blocks up to ~2 s while the microphone opens.
pub fn sync(app: &AppHandle) {
    let vs = app.state::<VoiceState>();
    let settings = app.state::<AppState>().settings();
    let enabled = settings.voice.wake_word;
    let problem = if !enabled {
        None
    } else if !settings.voice.enabled {
        Some("voice_off")
    } else if super::unavailable_reason().is_some() {
        Some("unavailable")
    } else if !vs.is_downloaded(super::current_model(app)) {
        Some("needs_model")
    } else {
        None
    };
    let want = enabled && problem.is_none();
    let mut slot = vs.wake.lock().unwrap();
    let mut status = WakeStatus { enabled, armed: false, problem, message: None };
    if want {
        if slot.as_ref().is_some_and(|l| l.thread.as_ref().is_some_and(|t| !t.is_finished())) {
            status.armed = true;
        } else {
            if let Some(old) = slot.take() {
                old.shutdown();
            }
            match spawn(app) {
                Ok(l) => {
                    *slot = Some(l);
                    status.armed = true;
                }
                Err(e) => {
                    status.problem = Some(e.code());
                    status.message = Some(e.message());
                }
            }
        }
    } else if let Some(old) = slot.take() {
        old.shutdown();
    }
    drop(slot);
    set_status(app, status);
}

fn set_status(app: &AppHandle, status: WakeStatus) {
    let vs = app.state::<VoiceState>();
    let changed = {
        let mut s = vs.wake_status.lock().unwrap();
        let changed = *s != status;
        *s = status.clone();
        changed
    };
    if changed {
        crate::voice::tray::show_wake(app, &status);
        let _ = app.emit("wake", &status);
    }
}

pub fn status(app: &AppHandle) -> WakeStatus {
    app.state::<VoiceState>().wake_status.lock().unwrap().clone()
}

/// Stop listening for good (quitting).
pub fn shutdown(app: &AppHandle) {
    if let Some(l) = app.state::<VoiceState>().wake.lock().unwrap().take() {
        l.shutdown();
    }
}

/// The open stream, if armed (for push-to-talk and wake commands).
pub fn tap(app: &AppHandle) -> Option<Arc<Tap>> {
    app.state::<VoiceState>().wake.lock().unwrap().as_ref().map(|l| l.tap.clone())
}

fn spawn(app: &AppHandle) -> Result<Listener, MicError> {
    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    let (etx, erx) = mpsc::channel::<String>();
    let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<u32, MicError>>(1);
    let stop = Arc::new(AtomicBool::new(false));
    let tap_slot: Arc<Mutex<Option<Arc<Tap>>>> = Arc::default();
    let (app2, stop2, tap2) = (app.clone(), stop.clone(), tap_slot.clone());
    let thread = std::thread::Builder::new()
        .name("glitch-wake".into())
        .spawn(move || {
            // The microphone belongs to this thread (cpal streams aren't Send
            // on every platform): opened here, closed when it ends.
            let mic = capture::open(
                move |s: &[f32]| {
                    let _ = tx.send(s.to_vec());
                },
                move |e| {
                    let _ = etx.send(e);
                },
            );
            let mic = match mic {
                Ok(m) => m,
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };
            let tap = Arc::new(Tap::new(mic.sample_rate));
            *tap2.lock().unwrap() = Some(tap.clone());
            let _ = ready_tx.send(Ok(mic.sample_rate));
            let failure = run(&app2, &stop2, &tap, &rx, &erx);
            tap.close();
            drop(mic);
            if let Some(e) = failure {
                eprintln!("glitch: wake word stopped: {e}");
                let mut st = status(&app2);
                st.armed = false;
                st.problem = Some("mic_failed");
                st.message = Some(e);
                set_status(&app2, st);
            }
        })
        .map_err(|e| MicError::Failed(e.to_string()))?;
    match ready_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(_rate)) => {
            let tap = tap_slot.lock().unwrap().clone().expect("tap set before ready");
            Ok(Listener { stop, thread: Some(thread), tap })
        }
        Ok(Err(e)) => {
            let _ = thread.join();
            Err(e)
        }
        Err(_) => {
            stop.store(true, Ordering::SeqCst);
            Err(MicError::Failed("the microphone didn't start".into()))
        }
    }
}

/// The model the wake check uses: "base" if it's downloaded (measured: tiny
/// without a prompt hears "Hey Glitch" in only ~20% of clips, base in ~95%),
/// else the one voice commands use.
fn wake_model(app: &AppHandle) -> &'static glitch_core::voice::models::SpeechModel {
    let vs = app.state::<VoiceState>();
    match glitch_core::voice::models::find("base") {
        Some(base) if vs.is_downloaded(base) => base,
        _ => super::current_model(app),
    }
}

/// Whether the wake check should ignore the microphone right now.
fn paused(vs: &VoiceState) -> bool {
    vs.phase_name() != "idle" || vs.speaking.load(Ordering::SeqCst) || Instant::now() < *vs.quiet_until.lock().unwrap()
}

/// Keep the wake check quiet for a moment (after a command or speech).
pub fn quiet_for_a_moment(vs: &VoiceState) {
    *vs.quiet_until.lock().unwrap() = Instant::now() + QUIET_AFTER;
}

/// The listener loop. Returns a failure message if the microphone died.
fn run(
    app: &AppHandle,
    stop: &AtomicBool,
    tap: &Tap,
    rx: &mpsc::Receiver<Vec<f32>>,
    erx: &mpsc::Receiver<String>,
) -> Option<String> {
    let vs = app.state::<VoiceState>();
    let mut seg = Segmenter::new(tap.rate, WakeConfig::default());
    let mut detector = Detector::default();
    let mut was_paused = false;
    while !stop.load(Ordering::SeqCst) {
        if let Ok(e) = erx.try_recv() {
            return Some(e);
        }
        let chunk = match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(c) => c,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => return Some("the microphone stopped".into()),
        };
        if tap.feed(&chunk) {
            was_paused = true;
            continue;
        }
        if paused(&vs) {
            was_paused = true;
            continue;
        }
        if was_paused {
            // Fresh start: half an utterance from before isn't one.
            seg.reset();
            was_paused = false;
        }
        let Some(check) = seg.push(&chunk) else { continue };
        let model_path = vs.model_path(wake_model(app));
        let t = Instant::now();
        let result = vs.stt.get(&model_path, stt::load).and_then(|m| {
            let r = detector.check(&m, &check.audio, tap.rate);
            drop(m);
            vs.stt.touch();
            r
        });
        match result {
            Ok(Some(d)) => {
                if cfg!(debug_assertions) {
                    eprintln!("glitch: wake check {:?} {:?} -> {} in {:?}", d.text, d.confidence, d.wake, t.elapsed());
                }
                if d.wake {
                    // Collect the stream for the command from here on.
                    *tap.state.lock().unwrap() = TapState::Waiting(check.audio);
                    seg.reset();
                    if !super::start_from_wake(app, d.has_command) {
                        *tap.state.lock().unwrap() = TapState::Off;
                    }
                }
            }
            Ok(None) => {}
            Err(e) => eprintln!("glitch: wake check failed: {e}"),
        }
    }
    None
}

/// Opens the microphone for a command: the armed stream if there is one
/// (no warm-up), else a fresh one. Returns the guard, rate and pre-roll.
pub fn open_for_command(
    app: &AppHandle,
    on_audio: AudioSink,
    on_error: ErrorSink,
) -> Result<(CommandMic, u32, Vec<f32>), MicError> {
    if let Some(tap) = tap(app) {
        let rate = tap.rate;
        // `on_audio` is moved into the tap; take it back if attaching fails.
        let sink: Arc<Mutex<Option<AudioSink>>> = Arc::new(Mutex::new(Some(on_audio)));
        let s2 = sink.clone();
        let forward: AudioSink = Box::new(move |c: &[f32]| {
            if let Some(f) = s2.lock().unwrap().as_mut() {
                f(c)
            }
        });
        if let Some((guard, pre)) = tap.attach(forward) {
            drop(on_error); // the listener reports a dying microphone by closing the tap
            return Ok((CommandMic::Tap(guard), rate, pre));
        }
        let on_audio = sink.lock().unwrap().take().expect("not attached");
        let m = capture::open(on_audio, on_error)?;
        let rate = m.sample_rate;
        return Ok((CommandMic::Own(m), rate, vec![]));
    }
    let m = capture::open(on_audio, on_error)?;
    let rate = m.sample_rate;
    Ok((CommandMic::Own(m), rate, vec![]))
}

/// The microphone a command records from; dropping it ends the recording.
pub enum CommandMic {
    #[allow(dead_code)] // held for its Drop
    Tap(TapGuard),
    #[allow(dead_code)]
    Own(capture::Mic),
}

/// Toggle from the tray menu.
pub fn toggle(app: &AppHandle) {
    let s = app.state::<AppState>().update_settings(|s| s.voice.wake_word = !s.voice.wake_word);
    let _ = app.emit("settings-changed", &s);
    let app = app.clone();
    std::thread::spawn(move || sync(&app));
}

/// The bubble's system voice started/stopped reading a reply aloud.
/// A deadline rather than a flag: if the webview never says "done" (a
/// cancelled utterance may not), the wake word comes back on its own.
pub fn set_speaking(app: &AppHandle, on: bool) {
    let vs = app.state::<VoiceState>();
    let until = Instant::now() + if on { SYSTEM_VOICE_MAX } else { QUIET_AFTER };
    *vs.quiet_until.lock().unwrap() = until;
}

/// The system voice reads at most ~280 characters: well under this.
const SYSTEM_VOICE_MAX: Duration = Duration::from_secs(45);
