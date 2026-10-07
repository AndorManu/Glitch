//! "Hey Glitch": the wake word, the pure half.
//!
//! There is no small, freely licensed "hey glitch" keyword model (the
//! openWakeWord pre-trained models are CC BY-NC-SA and only cover their own
//! phrases; training one needs thousands of synthetic clips and a GPU). So
//! the wake word reuses what voice already has, gated hard so it costs
//! next to nothing while the room is quiet:
//!
//! 1. [`Segmenter`]: an energy detector (same idea as [`super::vad`]) cuts
//!    the microphone stream into utterances. Silence never leaves this step:
//!    a few multiplications per sample, no model, no allocation.
//! 2. Each utterance's first [`WakeConfig::window_ms`] (with a little audio
//!    from before it) is handed to whisper once, in English, with a tiny
//!    token budget.
//! 3. [`wake_end`] decides whether the transcript *starts* with "glitch"
//!    (optionally after "hey", "hi", "okay", ...), fuzzily, so "Hey, Glitch!",
//!    "Hey glitch" and "Glitch, open YouTube" wake him, but "there's a glitch
//!    in the game" does not.

use std::collections::VecDeque;

use super::audio::{rms, MIN_SPEECH_RMS};

#[derive(Debug, Clone, Copy)]
pub struct WakeConfig {
    /// Audio kept from before an utterance starts (soft first consonants).
    pub pre_roll_ms: u32,
    /// This much quiet ends an utterance.
    pub end_silence_ms: u32,
    /// Less voiced audio than this is a click, a cough, a door: not checked.
    pub min_speech_ms: u32,
    /// An utterance is checked once, after this long (or when it ends, if
    /// sooner). "Hey Glitch" takes ~0.6-0.9 s; the rest of the window
    /// usually holds the start of the command, which whisper uses as
    /// context.
    pub window_ms: u32,
    /// A frame is voiced if its RMS is this many times the noise floor.
    pub noise_ratio: f32,
}

impl Default for WakeConfig {
    fn default() -> Self {
        Self { pre_roll_ms: 300, end_silence_ms: 400, min_speech_ms: 300, window_ms: 2_000, noise_ratio: 3.0 }
    }
}

/// An utterance worth asking whisper about.
#[derive(Debug, Clone, PartialEq)]
pub struct Check {
    /// Mono audio at the segmenter's sample rate, pre-roll included.
    pub audio: Vec<f32>,
    /// The utterance already ended (the speaker paused); otherwise it is
    /// still going on as this is checked.
    pub ended: bool,
}

const FRAME_MS: u32 = 20;
const MAX_NOISE_FLOOR: f32 = 0.03;

struct Utterance {
    audio: Vec<f32>,
    voiced_ms: u32,
    silence_ms: u32,
    len_ms: u32,
    checked: bool,
}

/// Cuts a live mono stream into utterances. Feed it everything the
/// microphone delivers; it returns a [`Check`] at most once per utterance.
pub struct Segmenter {
    cfg: WakeConfig,
    frame_len: usize,
    partial: Vec<f32>,
    pre_roll: VecDeque<f32>,
    pre_roll_len: usize,
    noise_floor: Option<f32>,
    utterance: Option<Utterance>,
}

impl Segmenter {
    pub fn new(sample_rate: u32, cfg: WakeConfig) -> Self {
        let frame_len = (sample_rate * FRAME_MS / 1000).max(1) as usize;
        let pre_roll_len = (sample_rate as u64 * cfg.pre_roll_ms as u64 / 1000) as usize;
        Self {
            cfg,
            frame_len,
            partial: Vec::with_capacity(frame_len),
            pre_roll: VecDeque::with_capacity(pre_roll_len + frame_len),
            pre_roll_len,
            noise_floor: None,
            utterance: None,
        }
    }

    /// Forget the current utterance (while Glitch talks, or after a command).
    /// The noise floor is kept: the room didn't change.
    pub fn reset(&mut self) {
        self.partial.clear();
        self.pre_roll.clear();
        self.utterance = None;
    }

    /// Someone is talking right now (an utterance is open).
    pub fn in_utterance(&self) -> bool {
        self.utterance.is_some()
    }

    pub fn push(&mut self, mono: &[f32]) -> Option<Check> {
        let mut out = None;
        let mut rest = mono;
        while !rest.is_empty() {
            let take = (self.frame_len - self.partial.len()).min(rest.len());
            self.partial.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
            if self.partial.len() == self.frame_len {
                let frame = std::mem::take(&mut self.partial);
                if let Some(c) = self.frame(&frame) {
                    out.get_or_insert(c);
                }
                self.partial = frame;
                self.partial.clear();
            }
        }
        out
    }

    fn voiced(&mut self, r: f32) -> bool {
        let floor = *self.noise_floor.get_or_insert(r.min(MAX_NOISE_FLOOR));
        let voiced = r > (floor * self.cfg.noise_ratio).max(MIN_SPEECH_RMS);
        // Fast down, slow up (much slower while voiced): follows the room.
        let k = if r < floor {
            0.3
        } else if voiced {
            0.002
        } else {
            0.02
        };
        self.noise_floor = Some((floor * (1.0 - k) + r * k).min(MAX_NOISE_FLOOR));
        voiced
    }

    fn frame(&mut self, frame: &[f32]) -> Option<Check> {
        let voiced = self.voiced(rms(frame));
        let cfg = self.cfg;
        let Some(u) = self.utterance.as_mut() else {
            if voiced {
                let mut audio: Vec<f32> = self.pre_roll.drain(..).collect();
                audio.extend_from_slice(frame);
                self.utterance =
                    Some(Utterance { audio, voiced_ms: FRAME_MS, silence_ms: 0, len_ms: FRAME_MS, checked: false });
            } else {
                self.pre_roll.extend(frame);
                let extra = self.pre_roll.len().saturating_sub(self.pre_roll_len);
                self.pre_roll.drain(..extra);
            }
            return None;
        };
        u.len_ms += FRAME_MS;
        if voiced {
            u.voiced_ms += FRAME_MS;
            u.silence_ms = 0;
        } else {
            u.silence_ms += FRAME_MS;
        }
        if !u.checked {
            u.audio.extend_from_slice(frame);
        }
        let ended = u.silence_ms >= cfg.end_silence_ms;
        let mut check = None;
        if !u.checked && u.voiced_ms >= cfg.min_speech_ms && (ended || u.len_ms >= cfg.window_ms) {
            u.checked = true;
            check = Some(Check { audio: std::mem::take(&mut u.audio), ended });
        }
        if ended {
            self.utterance = None;
            self.pre_roll.clear();
        }
        check
    }
}

// ------------------------------------------------------------- matching

/// Words that may come before "glitch" ("hey glitch", "okay glitch", ...),
/// including how whisper sometimes spells them.
const LEAD_INS: &[&str] = &[
    "hey", "hi", "hello", "hay", "hei", "heh", "he", "hey'", "a", "ah", "oh", "okay", "ok", "yo", "ey", "eh", "um",
    "uh",
];

/// Spellings of "glitch" whisper produced on synthetic and real speech that
/// are more than one edit away.
const SOUNDALIKES: &[&str] =
    &["glitz", "glitzy", "glitches", "glitched", "klitsch", "gleich", "glitchy", "glitschy", "gletsch"];

fn edit_distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut cur = vec![i + 1; b.len() + 1];
        for (j, cb) in b.iter().enumerate() {
            cur[j + 1] = (prev[j] + usize::from(ca != *cb)).min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        prev = cur;
    }
    prev[b.len()]
}

/// Is this (lower-case) word "glitch", give or take whisper's spelling?
pub fn is_glitch(word: &str) -> bool {
    let w = word.trim_matches('\'');
    let w = w.strip_suffix("'s").unwrap_or(w);
    if w.len() < 4 {
        return false;
    }
    w == "glitch" || edit_distance(w, "glitch") <= 1 || SOUNDALIKES.contains(&w)
}

/// Words with their byte ranges in `text` (letters, digits, apostrophes).
fn words(text: &str) -> Vec<(usize, usize)> {
    let mut out = vec![];
    let mut start = None;
    for (i, c) in text.char_indices() {
        let part = c.is_alphanumeric() || c == '\'' || c == '’';
        match (part, start) {
            (true, None) => start = Some(i),
            (false, Some(s)) => {
                out.push((s, i));
                start = None;
            }
            _ => {}
        }
    }
    if let Some(s) = start {
        out.push((s, text.len()));
    }
    out
}

/// How many words may come before "glitch".
const MAX_LEAD_INS: usize = 2;

/// If `text` starts with the wake word, the byte offset right after it (and
/// the punctuation/space following it); `None` if it doesn't.
pub fn wake_end(text: &str) -> Option<usize> {
    for (n, (s, e)) in words(text).into_iter().enumerate() {
        let w = text[s..e].to_lowercase().replace('’', "'");
        // "Heyglitch" / "Hi-Glitch" written as one word.
        let glued = ["hey", "hi"].iter().any(|p| w.strip_prefix(p).is_some_and(is_glitch));
        if is_glitch(&w) || glued {
            let after = text[e..].char_indices().find(|(_, c)| c.is_alphanumeric()).map_or(text.len(), |(i, _)| e + i);
            return Some(after);
        }
        if n >= MAX_LEAD_INS || !LEAD_INS.contains(&w.as_str()) {
            return None;
        }
    }
    None
}

/// Whether whisper's transcript of an utterance is the wake word.
pub fn is_wake(text: &str) -> bool {
    wake_end(text).is_some()
}

/// The command in a transcript that starts with the wake word ("Hey Glitch,
/// open YouTube." → "open YouTube."). Without a wake word, the whole text
/// (the main model may spell "Glitch" differently than the wake check did).
/// `None` if only the wake word was said.
pub fn strip_wake(text: &str) -> Option<String> {
    let rest = match wake_end(text) {
        Some(i) => &text[i..],
        None => text,
    };
    let rest = rest.trim();
    if rest.chars().filter(|c| c.is_alphanumeric()).count() < 2 {
        return None;
    }
    // "open YouTube." reads oddly as a chat message; capitalise it.
    let mut c = rest.chars();
    let first = c.next()?;
    Some(first.to_uppercase().chain(c).collect())
}

#[cfg(test)]
mod tests {
    use super::super::audio::tests::sine;
    use super::*;

    const RATE: u32 = 48_000;

    fn hiss(secs: f64) -> Vec<f32> {
        let mut x: u32 = 0x9e37_79b9;
        (0..(RATE as f64 * secs) as usize)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                (x as f32 / u32::MAX as f32 * 2.0 - 1.0) * 0.002
            })
            .collect()
    }

    fn feed(seg: &mut Segmenter, audio: &[f32]) -> Vec<Check> {
        // 10 ms chunks, like a microphone.
        audio.chunks(RATE as usize / 100).filter_map(|c| seg.push(c)).collect()
    }

    fn secs(c: &Check) -> f64 {
        c.audio.len() as f64 / RATE as f64
    }

    #[test]
    fn silence_is_never_checked() {
        let mut seg = Segmenter::new(RATE, WakeConfig::default());
        assert!(feed(&mut seg, &hiss(30.0)).is_empty());
        assert!(!seg.in_utterance());
        // Digital silence too.
        assert!(feed(&mut seg, &vec![0.0; RATE as usize * 5]).is_empty());
    }

    #[test]
    fn short_utterance_is_checked_when_it_ends() {
        let mut seg = Segmenter::new(RATE, WakeConfig::default());
        let mut a = hiss(1.0);
        a.extend(sine(220.0, RATE, 0.8, 0.2)); // "hey glitch"
        a.extend(hiss(1.0));
        let checks = feed(&mut seg, &a);
        assert_eq!(checks.len(), 1);
        assert!(checks[0].ended);
        // pre-roll + speech + the silence that ended it
        assert!((1.4..1.6).contains(&secs(&checks[0])), "{}", secs(&checks[0]));
    }

    #[test]
    fn long_utterance_is_checked_once_early() {
        let mut seg = Segmenter::new(RATE, WakeConfig::default());
        let mut a = hiss(0.5);
        let speech = sine(220.0, RATE, 6.0, 0.2);
        a.extend(&speech);
        let mut checks = vec![];
        let mut at = None;
        for (i, c) in a.chunks(RATE as usize / 100).enumerate() {
            if let Some(c) = seg.push(c) {
                at.get_or_insert(i);
                checks.push(c);
            }
        }
        assert_eq!(checks.len(), 1, "one check per utterance, however long");
        assert!(!checks[0].ended);
        // ~0.5 s of silence, then 2 s into the speech.
        assert!((240..=260).contains(&at.unwrap()), "{at:?}");
        assert!(seg.in_utterance());
        // After a pause the next utterance is checked again.
        let mut b = hiss(0.6);
        b.extend(sine(220.0, RATE, 0.5, 0.2));
        b.extend(hiss(0.6));
        assert_eq!(feed(&mut seg, &b).len(), 1);
    }

    #[test]
    fn clicks_are_ignored_and_reset_forgets() {
        let mut seg = Segmenter::new(RATE, WakeConfig::default());
        let mut a = hiss(0.5);
        a.extend(sine(220.0, RATE, 0.1, 0.5)); // a click on the desk
        a.extend(hiss(1.0));
        assert!(feed(&mut seg, &a).is_empty());
        let mut b = hiss(0.5);
        b.extend(sine(220.0, RATE, 1.0, 0.2));
        feed(&mut seg, &b);
        seg.reset();
        assert!(!seg.in_utterance());
        assert!(feed(&mut seg, &hiss(1.0)).is_empty());
    }

    #[test]
    fn steady_noise_becomes_the_floor() {
        // A fan that starts loud: after it settles, speech above it is found.
        let mut seg = Segmenter::new(RATE, WakeConfig::default());
        let fan: Vec<f32> = hiss(5.0).iter().map(|s| s * 6.0).collect();
        let first = feed(&mut seg, &fan);
        assert!(first.len() <= 1);
        let mut a = sine(220.0, RATE, 0.8, 0.3);
        a.extend(fan.iter().take(RATE as usize));
        assert_eq!(feed(&mut seg, &a).len(), 1);
    }

    #[test]
    fn wake_phrases() {
        for t in [
            "Hey Glitch.",
            "Hey, Glitch!",
            " hey glitch open youtube",
            "Glitch, what's the weather?",
            "Hi Glitch.",
            "Okay Glitch, set a timer.",
            "Hey Glitz, open YouTube.",
            "Hey glitch's open youtube",
            "Heyglitch",
            "Hey, Litch. Open YouTube.",
            "Oh hey Glitch",
            "Hey Glitches, open YouTube.",
        ] {
            assert!(is_wake(t), "{t}");
        }
        for t in [
            "",
            "There's a glitch in the game.",
            "Hey Mitch, open the door.",
            "Hey, pitch it to me.",
            "Open YouTube.",
            "The Glitch is a raccoon.",
            "Hey, what's up?",
            "Switch it off.",
            "Hey there Glitch",
            "Thanks for watching!",
            "Rich people",
            "[BLANK_AUDIO]",
        ] {
            assert!(!is_wake(t), "{t}");
        }
    }

    #[test]
    fn stripping_the_wake_word() {
        assert_eq!(strip_wake("Hey Glitch, open YouTube.").as_deref(), Some("Open YouTube."));
        assert_eq!(
            strip_wake(" Hey glitch. Open YouTube and play lo-fi.").as_deref(),
            Some("Open YouTube and play lo-fi.")
        );
        assert_eq!(strip_wake("Glitch what's the weather").as_deref(), Some("What's the weather"));
        assert_eq!(strip_wake("Hey Glitch."), None);
        assert_eq!(strip_wake("Hey, Glitch!"), None);
        // The main model heard the name differently: send it all.
        assert_eq!(strip_wake("Hey Mitch, open YouTube.").as_deref(), Some("Hey Mitch, open YouTube."));
        assert_eq!(strip_wake("Hé Glitch, ça va?").as_deref(), Some("Hé Glitch, ça va?"));
    }

    #[test]
    fn fuzzy_name() {
        assert!(is_glitch("glitch") && is_glitch("glich") && is_glitch("klitch") && is_glitch("glitz"));
        assert!(!is_glitch("pitch") && !is_glitch("witch") && !is_glitch("mitch") && !is_glitch("lit"));
        assert_eq!(edit_distance("kitten", "sitting"), 3);
        assert_eq!(edit_distance("", "abc"), 3);
    }
}
