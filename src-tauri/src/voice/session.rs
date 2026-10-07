//! One voice command, start to finish, on its own short-lived thread:
//! open the mic → record until let go / silence → close the mic → whisper →
//! clean up → hand the text to the chat bubble.
//!
//! Written against closures (open the mic, transcribe, emit an event) so the
//! whole flow is tested with a fake microphone and a fake model.

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use glitch_core::voice::audio::{prepare_for_whisper, resample};
use glitch_core::voice::models::SpeechModel;
use glitch_core::voice::vad::{Decision, Mode, Vad, VadConfig};
use glitch_core::voice::{transcript, wake, SAMPLE_RATE};
use serde::Serialize;

use super::capture::MicError;

/// Sent to the windows as the "voice" event.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum VoiceEvent {
    /// Recording. Repeated ~15×/s with the input level (0..1) for the meter.
    Listening {
        level: f32,
        hands_free: bool,
    },
    /// Recording is over, the mic is off, whisper is working.
    Transcribing,
    /// What the user said: the bubble sends it like a typed message.
    Heard {
        text: String,
    },
    /// Back to idle without a message: "cancelled", "nothing_heard", or
    /// "wake_only" (he heard "Hey Glitch" and then nothing).
    Idle {
        reason: &'static str,
    },
    Error {
        code: &'static str,
        message: String,
    },
    /// The speech model isn't downloaded yet: the bubble offers to get it.
    NeedsModel {
        model: SpeechModel,
    },
}

const RUN: u8 = 0;
const STOP: u8 = 1;
const CANCEL: u8 = 2;

/// How the UI steers a running session.
pub struct Control {
    cmd: AtomicU8,
    hands_free: AtomicBool,
    /// Also stops a running whisper transcription.
    pub abort: Arc<AtomicBool>,
    /// Started by the wake word: the transcript starts with "Hey Glitch",
    /// which is cut off before it is sent.
    from_wake: bool,
    /// Audio from before the recording (the wake-word utterance) and
    /// whether it counts as the start of the command for the silence
    /// detector (it does when the command followed the name in one go).
    preroll: Mutex<Option<(Vec<f32>, bool)>>,
}

impl Control {
    pub fn new(mode: Mode) -> Self {
        Self {
            cmd: AtomicU8::new(RUN),
            hands_free: AtomicBool::new(mode == Mode::HandsFree),
            abort: Arc::default(),
            from_wake: false,
            preroll: Mutex::default(),
        }
    }

    /// A hands-free command after "Hey Glitch". `has_command`: the name was
    /// followed by more words in the same breath.
    pub fn from_wake(has_command: bool) -> Self {
        Self { from_wake: true, preroll: Mutex::new(Some((vec![], has_command))), ..Self::new(Mode::HandsFree) }
    }

    pub fn is_from_wake(&self) -> bool {
        self.from_wake
    }

    /// The audio that came before the microphone was handed over (set while
    /// opening it; empty for push-to-talk).
    pub fn set_preroll(&self, audio: Vec<f32>) {
        let mut p = self.preroll.lock().unwrap();
        let counts = p.as_ref().is_some_and(|(_, c)| *c);
        *p = Some((audio, counts));
    }

    /// Stop recording and transcribe what we have.
    pub fn stop(&self) {
        let _ = self.cmd.compare_exchange(RUN, STOP, Ordering::SeqCst, Ordering::SeqCst);
    }

    /// Stop and throw it away.
    pub fn cancel(&self) {
        self.cmd.store(CANCEL, Ordering::SeqCst);
        self.abort.store(true, Ordering::SeqCst);
    }

    /// Keep recording until the user goes quiet (a tap instead of a hold).
    pub fn set_hands_free(&self) {
        self.hands_free.store(true, Ordering::SeqCst);
    }

    pub fn hands_free(&self) -> bool {
        self.hands_free.load(Ordering::SeqCst)
    }

    pub fn cancelled(&self) -> bool {
        self.cmd.load(Ordering::SeqCst) == CANCEL
    }
}

pub type AudioSink = Box<dyn FnMut(&[f32]) + Send>;
pub type ErrorSink = Box<dyn FnMut(String) + Send>;

/// What recording produced.
#[derive(Debug, PartialEq)]
pub enum Recorded {
    /// 16 kHz mono speech, trimmed and ready for whisper.
    Speech(Vec<f32>),
    NothingHeard,
    Cancelled,
    /// Only exact zeros: the OS gave us a muted stream (macOS does this when
    /// the microphone permission is off).
    DigitalSilence,
}

const LEVEL_EVERY: Duration = Duration::from_millis(66);

/// Record until stopped. `open_mic` opens the microphone and returns a guard
/// (dropping it closes the mic) and its sample rate.
pub fn record<M>(
    ctl: &Control,
    open_mic: impl FnOnce(AudioSink, ErrorSink) -> Result<(M, u32), MicError>,
    cfg: VadConfig,
    mut on_level: impl FnMut(f32, bool),
) -> Result<Recorded, MicError> {
    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    let (etx, erx) = mpsc::channel::<String>();
    let (mic, rate) = open_mic(
        Box::new(move |s: &[f32]| {
            let _ = tx.send(s.to_vec());
        }),
        Box::new(move |e| {
            let _ = etx.send(e);
        }),
    )?;
    let mode = if ctl.hands_free() { Mode::HandsFree } else { Mode::Hold };
    let mut vad = Vad::new(rate, mode, cfg);
    let mut audio: Vec<f32> = Vec::with_capacity(rate as usize * 4);
    let max_len = rate as usize * (cfg.max_ms as usize / 1000 + 1);
    let mut last_level = Instant::now() - LEVEL_EVERY;
    if let Some((pre, counts)) = ctl.preroll.lock().unwrap().take() {
        audio.extend_from_slice(&pre);
        if counts {
            vad.push(&pre);
        }
    }
    on_level(0.0, ctl.hands_free());

    let mut failure = None;
    loop {
        match ctl.cmd.load(Ordering::SeqCst) {
            CANCEL => break,
            STOP => break,
            _ => {}
        }
        if ctl.hands_free() && vad.mode() == Mode::Hold {
            vad.set_mode(Mode::HandsFree);
        }
        if let Ok(e) = erx.try_recv() {
            failure = Some(MicError::Failed(e));
            break;
        }
        match rx.recv_timeout(Duration::from_millis(30)) {
            Ok(chunk) => {
                if audio.len() < max_len {
                    audio.extend_from_slice(&chunk);
                }
                if let Decision::Stop(_) = vad.push(&chunk) {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                failure = Some(MicError::Failed("the microphone stopped".into()));
                break;
            }
        }
        if last_level.elapsed() >= LEVEL_EVERY {
            last_level = Instant::now();
            on_level(vad.level(), vad.mode() == Mode::HandsFree);
        }
    }
    // Microphone off right now, before the slow part.
    drop(mic);

    if ctl.cancelled() {
        return Ok(Recorded::Cancelled);
    }
    if let Some(f) = failure {
        return Err(f);
    }
    if vad.digital_silence() && vad.elapsed_ms() >= 300 {
        return Ok(Recorded::DigitalSilence);
    }
    if !vad.heard_speech() {
        return Ok(Recorded::NothingHeard);
    }
    let speech = prepare_for_whisper(&resample(&audio, rate, SAMPLE_RATE));
    Ok(speech.map_or(Recorded::NothingHeard, Recorded::Speech))
}

/// The whole command: record, transcribe, clean, report. Every path ends
/// with exactly one of `Heard`, `Idle` or `Error`.
pub fn run<M>(
    ctl: &Control,
    open_mic: impl FnOnce(AudioSink, ErrorSink) -> Result<(M, u32), MicError>,
    transcribe: impl FnOnce(&[f32]) -> Result<String, String>,
    mut emit: impl FnMut(VoiceEvent),
) {
    let recorded = record(ctl, open_mic, VadConfig::default(), |level, hands_free| {
        emit(VoiceEvent::Listening { level, hands_free })
    });
    let speech = match recorded {
        Ok(Recorded::Speech(s)) => s,
        Ok(Recorded::Cancelled) => return emit(VoiceEvent::Idle { reason: "cancelled" }),
        Ok(Recorded::NothingHeard) if ctl.from_wake => return emit(VoiceEvent::Idle { reason: "wake_only" }),
        Ok(Recorded::NothingHeard) => return emit(VoiceEvent::Idle { reason: "nothing_heard" }),
        Ok(Recorded::DigitalSilence) => {
            return emit(VoiceEvent::Error { code: "mic_silent", message: "the microphone only sent silence".into() })
        }
        Err(e) => return emit(VoiceEvent::Error { code: e.code(), message: e.message() }),
    };
    emit(VoiceEvent::Transcribing);
    let result = transcribe(&speech);
    if ctl.cancelled() {
        return emit(VoiceEvent::Idle { reason: "cancelled" });
    }
    match result {
        Ok(raw) => match transcript::clean(&raw) {
            Some(text) if ctl.from_wake => match wake::strip_wake(&text) {
                Some(text) => emit(VoiceEvent::Heard { text }),
                None => emit(VoiceEvent::Idle { reason: "wake_only" }),
            },
            Some(text) => emit(VoiceEvent::Heard { text }),
            None => emit(VoiceEvent::Idle { reason: "nothing_heard" }),
        },
        Err(message) => emit(VoiceEvent::Error { code: "stt_failed", message }),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::thread::JoinHandle;

    use super::*;

    const RATE: u32 = 48_000;

    /// A fake microphone: a thread that feeds `script` (10 ms chunks, much
    /// faster than real time), then silence, until dropped.
    struct FakeMic {
        stop: Arc<AtomicBool>,
        dropped: Arc<AtomicBool>,
        feeder: Option<JoinHandle<()>>,
    }

    impl Drop for FakeMic {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            if let Some(f) = self.feeder.take() {
                f.join().unwrap();
            }
            self.dropped.store(true, Ordering::SeqCst);
        }
    }

    fn tone(secs: f64, amp: f32) -> Vec<f32> {
        (0..(RATE as f64 * secs) as usize)
            .map(|i| amp * (2.0 * std::f64::consts::PI * 200.0 * i as f64 / RATE as f64).sin() as f32)
            .collect()
    }

    fn hiss(secs: f64) -> Vec<f32> {
        (0..(RATE as f64 * secs) as usize).map(|i| if i % 2 == 0 { 0.001 } else { -0.001 }).collect()
    }

    fn fake_mic(
        script: Vec<f32>,
        tail: f32,
        dropped: Arc<AtomicBool>,
    ) -> impl FnOnce(AudioSink, ErrorSink) -> Result<(FakeMic, u32), MicError> {
        move |mut sink, _err| {
            let stop = Arc::new(AtomicBool::new(false));
            let s = stop.clone();
            let feeder = std::thread::spawn(move || {
                let chunk = RATE as usize / 100;
                for c in script.chunks(chunk) {
                    if s.load(Ordering::SeqCst) {
                        return;
                    }
                    sink(c);
                    std::thread::sleep(Duration::from_millis(1));
                }
                let silence = vec![tail; chunk];
                while !s.load(Ordering::SeqCst) {
                    sink(&silence);
                    std::thread::sleep(Duration::from_millis(1));
                }
            });
            Ok((FakeMic { stop, dropped, feeder: Some(feeder) }, RATE))
        }
    }

    fn collect(
        ctl: &Control,
        open: impl FnOnce(AudioSink, ErrorSink) -> Result<(FakeMic, u32), MicError>,
        text: &str,
        mic_dropped: Arc<AtomicBool>,
    ) -> (Vec<VoiceEvent>, bool) {
        let events = Mutex::new(vec![]);
        let called = AtomicBool::new(false);
        run(
            ctl,
            open,
            |samples| {
                called.store(true, Ordering::SeqCst);
                assert!(mic_dropped.load(Ordering::SeqCst), "mic must be off before transcribing");
                // 16 kHz, trimmed: about 1 s of tone + padding.
                let secs = samples.len() as f32 / SAMPLE_RATE as f32;
                assert!((1.0..2.0).contains(&secs), "{secs}");
                Ok(text.to_string())
            },
            |e| events.lock().unwrap().push(e),
        );
        (events.into_inner().unwrap(), called.load(Ordering::SeqCst))
    }

    fn last(events: &[VoiceEvent]) -> &VoiceEvent {
        events.last().unwrap()
    }

    #[test]
    fn hands_free_sentence_is_heard_and_mic_closed() {
        let dropped = Arc::new(AtomicBool::new(false));
        let mut script = hiss(0.3);
        script.extend(tone(1.0, 0.2));
        let ctl = Control::new(Mode::HandsFree);
        let (events, called) =
            collect(&ctl, fake_mic(script, 0.001, dropped.clone()), " Open YouTube. [BLANK_AUDIO]", dropped.clone());
        assert!(called);
        assert!(dropped.load(Ordering::SeqCst));
        assert!(matches!(events[0], VoiceEvent::Listening { level, hands_free: true } if level == 0.0));
        assert!(events.iter().any(|e| matches!(e, VoiceEvent::Listening { level, .. } if *level > 0.5)));
        assert_eq!(events[events.len() - 2], VoiceEvent::Transcribing);
        assert_eq!(last(&events), &VoiceEvent::Heard { text: "Open YouTube.".into() });
    }

    #[test]
    fn hold_then_release() {
        let dropped = Arc::new(AtomicBool::new(false));
        let ctl = Arc::new(Control::new(Mode::Hold));
        let c = ctl.clone();
        // "Let go" once the tone has been fed.
        let stopper = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            c.stop();
        });
        let (events, called) = collect(&ctl, fake_mic(tone(1.0, 0.2), 0.001, dropped.clone()), "hello", dropped);
        stopper.join().unwrap();
        assert!(called);
        assert_eq!(last(&events), &VoiceEvent::Heard { text: "hello".into() });
    }

    #[test]
    fn cancel_throws_it_away() {
        let dropped = Arc::new(AtomicBool::new(false));
        let ctl = Arc::new(Control::new(Mode::Hold));
        let c = ctl.clone();
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            c.cancel();
        });
        let (events, called) = collect(&ctl, fake_mic(tone(5.0, 0.2), 0.001, dropped.clone()), "x", dropped.clone());
        t.join().unwrap();
        assert!(!called);
        assert!(dropped.load(Ordering::SeqCst));
        assert_eq!(last(&events), &VoiceEvent::Idle { reason: "cancelled" });
        assert!(ctl.abort.load(Ordering::SeqCst));
    }

    #[test]
    fn nothing_said() {
        let dropped = Arc::new(AtomicBool::new(false));
        let ctl = Control::new(Mode::HandsFree);
        let (events, called) = collect(&ctl, fake_mic(vec![], 0.001, dropped.clone()), "x", dropped);
        assert!(!called, "no speech: the model isn't even used");
        assert_eq!(last(&events), &VoiceEvent::Idle { reason: "nothing_heard" });
    }

    #[test]
    fn junk_transcript_is_nothing() {
        let dropped = Arc::new(AtomicBool::new(false));
        let ctl = Control::new(Mode::HandsFree);
        let (events, _) =
            collect(&ctl, fake_mic(tone(1.0, 0.2), 0.001, dropped.clone()), " [Music] (silence)", dropped);
        assert_eq!(last(&events), &VoiceEvent::Idle { reason: "nothing_heard" });
    }

    #[test]
    fn muted_stream_is_reported() {
        let dropped = Arc::new(AtomicBool::new(false));
        let ctl = Control::new(Mode::HandsFree);
        let (events, called) = collect(&ctl, fake_mic(vec![], 0.0, dropped.clone()), "x", dropped);
        assert!(!called);
        assert!(matches!(last(&events), VoiceEvent::Error { code: "mic_silent", .. }));
    }

    #[test]
    fn mic_errors() {
        let ctl = Control::new(Mode::Hold);
        let mut events = vec![];
        run(
            &ctl,
            |_, _| Err::<((), u32), _>(MicError::Denied("access is denied".into())),
            |_| panic!("no audio, no transcription"),
            |e| events.push(e),
        );
        assert_eq!(events, vec![VoiceEvent::Error { code: "mic_denied", message: "access is denied".into() }]);

        // Unplugged mid-way.
        let mut events = vec![];
        run(
            &ctl,
            |_audio, mut err: ErrorSink| {
                err("device removed".into());
                Ok(((), RATE))
            },
            |_| panic!("no transcription"),
            |e| events.push(e),
        );
        assert!(matches!(last(&events), VoiceEvent::Error { code: "mic_failed", .. }));
    }

    #[test]
    fn whisper_errors() {
        let dropped = Arc::new(AtomicBool::new(false));
        let ctl = Control::new(Mode::HandsFree);
        let mut events = vec![];
        run(
            &ctl,
            fake_mic(tone(1.0, 0.2), 0.001, dropped),
            |_| Err("model file is damaged".into()),
            |e| events.push(e),
        );
        assert_eq!(last(&events), &VoiceEvent::Error { code: "stt_failed", message: "model file is damaged".into() });
    }

    /// A wake-word command: `pre` is what the wake listener already had,
    /// `script` what the mic delivers after the hand-over.
    fn wake_run(has_command: bool, pre: Vec<f32>, script: Vec<f32>, text: &str) -> (Vec<VoiceEvent>, Option<f32>) {
        let dropped = Arc::new(AtomicBool::new(false));
        let ctl = Control::from_wake(has_command);
        let open = fake_mic(script, 0.001, dropped);
        let events = Mutex::new(vec![]);
        let secs = Mutex::new(None);
        run(
            &ctl,
            |a, e| {
                let r = open(a, e);
                ctl.set_preroll(pre);
                r
            },
            |samples| {
                *secs.lock().unwrap() = Some(samples.len() as f32 / SAMPLE_RATE as f32);
                Ok(text.to_string())
            },
            |e| events.lock().unwrap().push(e),
        );
        (events.into_inner().unwrap(), secs.into_inner().unwrap())
    }

    #[test]
    fn wake_command_in_one_breath() {
        // "Hey Glitch, open YouTube" was all in the pre-roll, then silence:
        // it stops on its own and the name is cut off.
        let mut pre = hiss(0.3);
        pre.extend(tone(1.5, 0.2));
        pre.extend(hiss(0.4));
        let (events, secs) = wake_run(true, pre, vec![], " Hey Glitch, open YouTube.");
        assert_eq!(last(&events), &VoiceEvent::Heard { text: "Open YouTube.".into() });
        // The pre-roll's speech is part of what whisper hears.
        assert!(secs.unwrap() >= 1.5, "{secs:?}");
    }

    #[test]
    fn wake_then_pause_then_command() {
        // "Hey Glitch." ... (pause) ... "open YouTube": the pause doesn't
        // end it, the command after it is recorded too.
        let mut pre = hiss(0.3);
        pre.extend(tone(0.7, 0.2));
        pre.extend(hiss(0.4));
        let mut script = hiss(1.0);
        script.extend(tone(1.0, 0.2));
        let (events, secs) = wake_run(false, pre, script, "Hey Glitch. Open YouTube.");
        assert_eq!(last(&events), &VoiceEvent::Heard { text: "Open YouTube.".into() });
        assert!(secs.unwrap() >= 2.5, "both parts: {secs:?}");
    }

    #[test]
    fn wake_word_alone_is_quietly_dropped() {
        let mut pre = hiss(0.3);
        pre.extend(tone(0.7, 0.2));
        // Nobody says anything after the name.
        let (events, _) = wake_run(false, pre.clone(), vec![], "x");
        assert_eq!(last(&events), &VoiceEvent::Idle { reason: "wake_only" });
        // Or whisper only hears the name.
        let (events, _) = wake_run(true, pre, vec![], "Hey Glitch!");
        assert_eq!(last(&events), &VoiceEvent::Idle { reason: "wake_only" });
    }

    #[test]
    fn event_json_shape() {
        let j = |e: VoiceEvent| serde_json::to_value(e).unwrap();
        assert_eq!(
            j(VoiceEvent::Listening { level: 0.5, hands_free: false }),
            serde_json::json!({"phase":"listening","level":0.5,"hands_free":false})
        );
        assert_eq!(j(VoiceEvent::Heard { text: "hi".into() }), serde_json::json!({"phase":"heard","text":"hi"}));
        assert_eq!(
            j(VoiceEvent::Idle { reason: "cancelled" }),
            serde_json::json!({"phase":"idle","reason":"cancelled"})
        );
        let m = j(VoiceEvent::NeedsModel { model: *glitch_core::voice::models::find("base").unwrap() });
        assert_eq!(m["phase"], "needs_model");
        assert_eq!(m["model"]["id"], "base");
        assert!(m["model"].get("sha1").is_none());
    }
}
