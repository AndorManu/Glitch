//! A tiny energy-based voice activity detector, fed while recording.
//!
//! It answers two questions every 20 ms: "is someone talking?" (for the
//! level meter and for trimming) and "should we stop now?":
//!
//! * **Hold** (mic button or hotkey held down): never stops by itself, except
//!   at the 30 s safety limit. Letting go stops.
//! * **Hands-free** (a quick tap): stops ~0.8 s after the user stops talking,
//!   or after a few seconds if they never start.

use super::audio::{meter_level, rms, MIN_SPEECH_RMS};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Hold,
    HandsFree,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    /// Hands-free: the user said something and then went quiet.
    Silence,
    /// Hands-free: nothing was said at all.
    NoSpeech,
    /// Safety limit (both modes).
    MaxLength,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Continue,
    Stop(StopReason),
}

#[derive(Debug, Clone, Copy)]
pub struct VadConfig {
    /// Hands-free: stop after this much quiet. 0.8 s: pauses between words
    /// are shorter (up to ~0.7 s still continues, see the tests), and the
    /// text arrives ~1.2-1.5 s after the last word with the base model
    /// (measured on Windows; 1.2 s here made it 1.6-1.9 s).
    pub silence_stop_ms: u32,
    pub no_speech_stop_ms: u32,
    pub max_ms: u32,
    /// Speech must last this long before it counts (ignores clicks and taps
    /// on the desk).
    pub min_speech_ms: u32,
    /// A frame is speech if its RMS is this many times the noise floor.
    pub noise_ratio: f32,
}

impl Default for VadConfig {
    fn default() -> Self {
        Self { silence_stop_ms: 800, no_speech_stop_ms: 6_000, max_ms: 30_000, min_speech_ms: 100, noise_ratio: 3.0 }
    }
}

const FRAME_MS: u32 = 20;
/// The noise floor can't climb above this (a loud room must not turn speech
/// into "noise").
const MAX_NOISE_FLOOR: f32 = 0.03;

pub struct Vad {
    cfg: VadConfig,
    mode: Mode,
    frame_len: usize,
    partial: Vec<f32>,
    noise_floor: Option<f32>,
    speech_run_ms: u32,
    heard_speech: bool,
    silence_ms: u32,
    elapsed_ms: u32,
    level: f32,
    peak: f32,
}

impl Vad {
    pub fn new(sample_rate: u32, mode: Mode, cfg: VadConfig) -> Self {
        let frame_len = (sample_rate * FRAME_MS / 1000).max(1) as usize;
        Self {
            cfg,
            mode,
            frame_len,
            partial: Vec::with_capacity(frame_len),
            noise_floor: None,
            speech_run_ms: 0,
            heard_speech: false,
            silence_ms: 0,
            elapsed_ms: 0,
            level: 0.0,
            peak: 0.0,
        }
    }

    pub fn mode(&self) -> Mode {
        self.mode
    }

    /// Switch modes mid-recording (a tap turns a "hold" into hands-free).
    pub fn set_mode(&mut self, mode: Mode) {
        self.mode = mode;
    }

    /// Feed mono samples (any length); returns whether to keep recording.
    pub fn push(&mut self, mono: &[f32]) -> Decision {
        for &s in mono {
            self.peak = self.peak.max(s.abs());
        }
        let mut rest = mono;
        while !rest.is_empty() {
            let take = (self.frame_len - self.partial.len()).min(rest.len());
            self.partial.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
            if self.partial.len() == self.frame_len {
                let r = rms(&self.partial);
                self.partial.clear();
                self.frame(r);
            }
        }
        self.decision()
    }

    fn frame(&mut self, r: f32) {
        self.elapsed_ms += FRAME_MS;
        self.level = meter_level(r);
        let floor = *self.noise_floor.get_or_insert(r.min(MAX_NOISE_FLOOR));
        let speech = r > (floor * self.cfg.noise_ratio).max(MIN_SPEECH_RMS);
        if speech {
            self.speech_run_ms += FRAME_MS;
            if self.speech_run_ms >= self.cfg.min_speech_ms {
                self.heard_speech = true;
            }
            self.silence_ms = 0;
            // The floor creeps up very slowly while talking (in case the
            // first frames were unusually quiet).
            self.noise_floor = Some((floor * 0.998 + r * 0.002).min(MAX_NOISE_FLOOR));
        } else {
            self.speech_run_ms = 0;
            self.silence_ms += FRAME_MS;
            // Fast down, slow up: follows the quietest recent level.
            let k = if r < floor { 0.3 } else { 0.02 };
            self.noise_floor = Some((floor * (1.0 - k) + r * k).min(MAX_NOISE_FLOOR));
        }
    }

    pub fn decision(&self) -> Decision {
        if self.elapsed_ms >= self.cfg.max_ms {
            return Decision::Stop(StopReason::MaxLength);
        }
        if self.mode == Mode::HandsFree {
            if self.heard_speech && self.silence_ms >= self.cfg.silence_stop_ms {
                return Decision::Stop(StopReason::Silence);
            }
            if !self.heard_speech && self.elapsed_ms >= self.cfg.no_speech_stop_ms {
                return Decision::Stop(StopReason::NoSpeech);
            }
        }
        Decision::Continue
    }

    pub fn heard_speech(&self) -> bool {
        self.heard_speech
    }

    /// 0..1, for the level meter (latest 20 ms frame).
    pub fn level(&self) -> f32 {
        self.level
    }

    pub fn elapsed_ms(&self) -> u32 {
        self.elapsed_ms
    }

    /// Every sample so far was exactly zero. Real microphones always hiss a
    /// little, so this means the OS is feeding us silence, which is what
    /// macOS does when the microphone permission was denied.
    pub fn digital_silence(&self) -> bool {
        self.elapsed_ms > 0 && self.peak == 0.0
    }
}

#[cfg(test)]
mod tests {
    use super::super::audio::tests::sine;
    use super::*;

    const RATE: u32 = 48_000;

    fn noise(secs: f64, amp: f32) -> Vec<f32> {
        // Deterministic pseudo-random hiss.
        let mut x: u32 = 0x1234_5678;
        (0..(RATE as f64 * secs) as usize)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                (x as f32 / u32::MAX as f32 * 2.0 - 1.0) * amp
            })
            .collect()
    }

    fn speech(secs: f64) -> Vec<f32> {
        sine(180.0, RATE, secs, 0.15).iter().zip(noise(secs, 0.002)).map(|(a, b)| a + b).collect()
    }

    /// Feed in 10 ms chunks like an audio callback; returns when it stopped.
    fn run(vad: &mut Vad, audio: &[f32]) -> (Decision, u32) {
        for chunk in audio.chunks(RATE as usize / 100) {
            if let Decision::Stop(r) = vad.push(chunk) {
                return (Decision::Stop(r), vad.elapsed_ms());
            }
        }
        (Decision::Continue, vad.elapsed_ms())
    }

    #[test]
    fn hands_free_stops_after_speech_then_silence() {
        let mut vad = Vad::new(RATE, Mode::HandsFree, VadConfig::default());
        let mut audio = noise(0.5, 0.002);
        audio.extend(speech(1.5));
        audio.extend(noise(3.0, 0.002));
        let (d, at) = run(&mut vad, &audio);
        assert_eq!(d, Decision::Stop(StopReason::Silence));
        // 0.5 s + 1.5 s + 0.8 s of silence
        assert!((2_780..=2_860).contains(&at), "{at}");
        assert!(vad.heard_speech());
    }

    #[test]
    fn short_pauses_between_words_dont_stop() {
        let mut vad = Vad::new(RATE, Mode::HandsFree, VadConfig::default());
        let mut audio = speech(0.6);
        audio.extend(noise(0.7, 0.002));
        audio.extend(speech(0.6));
        audio.extend(noise(0.7, 0.002));
        audio.extend(speech(0.6));
        assert_eq!(run(&mut vad, &audio).0, Decision::Continue);
    }

    #[test]
    fn hands_free_gives_up_if_nobody_talks() {
        let mut vad = Vad::new(RATE, Mode::HandsFree, VadConfig::default());
        let (d, at) = run(&mut vad, &noise(10.0, 0.003));
        assert_eq!(d, Decision::Stop(StopReason::NoSpeech));
        assert_eq!(at, 6_000);
        assert!(!vad.heard_speech());
    }

    #[test]
    fn hold_mode_only_stops_at_the_limit() {
        let mut vad = Vad::new(RATE, Mode::Hold, VadConfig::default());
        let mut audio = speech(1.0);
        audio.extend(noise(5.0, 0.002));
        assert_eq!(run(&mut vad, &audio).0, Decision::Continue);
        let (d, at) = run(&mut vad, &noise(30.0, 0.002));
        assert_eq!(d, Decision::Stop(StopReason::MaxLength));
        assert_eq!(at, 30_000);
    }

    #[test]
    fn switching_to_hands_free_mid_way() {
        let mut vad = Vad::new(RATE, Mode::Hold, VadConfig::default());
        let mut audio = speech(1.0);
        audio.extend(noise(2.0, 0.002));
        assert_eq!(run(&mut vad, &audio).0, Decision::Continue);
        vad.set_mode(Mode::HandsFree);
        // Already 2 s of silence after speech: stops on the next frame.
        assert_eq!(vad.push(&noise(0.02, 0.002)), Decision::Stop(StopReason::Silence));
    }

    #[test]
    fn clicks_are_not_speech() {
        let mut vad = Vad::new(RATE, Mode::HandsFree, VadConfig::default());
        let mut audio = noise(0.5, 0.002);
        audio.extend(vec![0.6; RATE as usize / 25]); // 40 ms click
        audio.extend(noise(2.0, 0.002));
        run(&mut vad, &audio);
        assert!(!vad.heard_speech());
    }

    #[test]
    fn loud_room_still_detects_speech() {
        let mut vad = Vad::new(RATE, Mode::HandsFree, VadConfig::default());
        let mut audio = noise(1.0, 0.03); // noisy café
        audio.extend(sine(200.0, RATE, 1.0, 0.4).iter().zip(noise(1.0, 0.03)).map(|(a, b)| a + b));
        run(&mut vad, &audio);
        assert!(vad.heard_speech());
    }

    #[test]
    fn level_and_digital_silence() {
        let mut vad = Vad::new(RATE, Mode::Hold, VadConfig::default());
        assert!(!vad.digital_silence()); // nothing yet
        vad.push(&vec![0.0; RATE as usize]);
        assert!(vad.digital_silence());
        assert_eq!(vad.level(), 0.0);
        vad.push(&speech(0.1));
        assert!(!vad.digital_silence());
        assert!(vad.level() > 0.5);
    }

    #[test]
    fn odd_chunk_sizes() {
        let mut vad = Vad::new(44_100, Mode::Hold, VadConfig::default());
        for _ in 0..100 {
            vad.push(&[0.0; 441]);
        }
        assert_eq!(vad.elapsed_ms(), 1_000);
        vad.push(&[0.0; 7]);
        assert_eq!(vad.elapsed_ms(), 1_000);
    }
}
