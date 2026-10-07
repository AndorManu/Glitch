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
//! 3. [`wake_end`] decides whether the transcript *starts* with "hey
//!    glitch" or "okay glitch" (fuzzy on whisper's spelling of the name), and
//!    [`wake_confidence`] whether whisper was sure of those tokens. "Hey,
//!    Glitch!" wakes him; "Glitch", "a glitch in the system", German
//!    "gleich" and mumbles don't.
//!
//! A wake-word command is still treated as outside content (a video or a
//! podcast can say "Hey Glitch, open ..."): every action with a side effect
//! waits for the user's OK. See `Agent::send_with`.

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

/// The wake phrase is "hey glitch" or "okay glitch": a bare "Glitch" is a
/// word that comes up in videos and podcasts ("a glitch in the system"),
/// and short lead-ins ("a", "he") are what whisper makes of any syllable.
/// These are the spellings of "hey"/"okay" whisper uses.
const GREETINGS: &[&str] = &["hey", "hay", "okay", "ok"];

/// May come before the greeting ("Oh, hey Glitch").
const FILLERS: &[&str] = &["oh", "um", "uh"];

/// Spellings of "glitch" whisper produced on synthetic speech that are more
/// than one edit away.
const SOUNDALIKES: &[&str] = &["glitz", "glitzy", "klitsch", "glitschy", "gletsch"];

/// Real words one edit away from "glitch" that must not count: German
/// "gleich" (= "right away", very common), "glitchy" (an adjective).
const NOT_THE_NAME: &[&str] = &["gleich", "glitchy", "glitched", "glitches", "flitch", "glitcher"];

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
    if w.len() < 5 || NOT_THE_NAME.contains(&w) {
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

/// Byte offset of the first letter after `e` (skipping ", " and the like).
fn next_word(text: &str, e: usize) -> usize {
    text[e..].char_indices().find(|(_, c)| c.is_alphanumeric()).map_or(text.len(), |(i, _)| e + i)
}

fn lower(text: &str, (s, e): (usize, usize)) -> String {
    text[s..e].to_lowercase().replace('’', "'")
}

/// If `text` starts with the wake phrase ("hey glitch" / "okay glitch",
/// optionally after "oh"/"um"), the byte offset right after it and the
/// punctuation following it; `None` if it doesn't.
pub fn wake_end(text: &str) -> Option<usize> {
    let ws = words(text);
    let mut i = 0;
    if ws.first().is_some_and(|&w| FILLERS.contains(&lower(text, w).as_str())) {
        i = 1;
    }
    let first = lower(text, *ws.get(i)?);
    // "Heyglitch" written as one word.
    if first.strip_prefix("hey").is_some_and(is_glitch) {
        return Some(next_word(text, ws[i].1));
    }
    if !GREETINGS.contains(&first.as_str()) {
        return None;
    }
    let name = *ws.get(i + 1)?;
    is_glitch(&lower(text, name)).then(|| next_word(text, name.1))
}

/// Whether whisper's transcript of an utterance is the wake phrase.
pub fn is_wake(text: &str) -> bool {
    wake_end(text).is_some()
}

/// Whisper must be at least this sure of every token of the wake phrase.
/// Calibrated on synthetic speech (see dev/wake-check.mjs).
pub const MIN_CONFIDENCE: f32 = 0.5;

/// How sure whisper was of the wake phrase: the lowest probability of the
/// tokens that spell it. `tokens` are whisper's (text, probability) pairs in
/// order (special tokens left out). `None` if the text isn't the wake phrase.
pub fn wake_confidence(tokens: &[(String, f32)]) -> Option<f32> {
    let text: String = tokens.iter().map(|(t, _)| t.as_str()).collect();
    let lead = text.len() - text.trim_start().len();
    let after = wake_end(text.trim_start())? + lead;
    // Up to the end of the name itself (not the punctuation after it).
    let end = text[..after].trim_end_matches(|c: char| !c.is_alphanumeric()).len();
    let mut at = 0;
    let mut min = f32::INFINITY;
    for (t, p) in tokens {
        if at < end && t.chars().any(char::is_alphanumeric) {
            min = min.min(*p);
        }
        at += t.len();
    }
    min.is_finite().then_some(min)
}

/// A transcript wakes Glitch: the phrase, said clearly enough.
pub fn is_confident_wake(tokens: &[(String, f32)]) -> bool {
    wake_confidence(tokens).is_some_and(|c| c >= MIN_CONFIDENCE)
}

/// Looser than [`wake_end`], only for cutting the name off the command's
/// transcript (the bigger model may write "Glitch, open YouTube" for what
/// the wake check heard as "Hey Glitch, open").
fn spoken_name_end(text: &str) -> Option<usize> {
    if let Some(e) = wake_end(text) {
        return Some(e);
    }
    let ws = words(text);
    let (n, &w) = ws.iter().enumerate().take(3).find(|(_, w)| is_glitch(&lower(text, **w)))?;
    let leads_ok = ws[..n].iter().all(|w| {
        let l = lower(text, *w);
        GREETINGS.contains(&l.as_str())
            || FILLERS.contains(&l.as_str())
            || ["hi", "hello", "a", "he"].contains(&l.as_str())
    });
    leads_ok.then(|| next_word(text, w.1))
}

/// The command in a transcript that starts with the wake phrase ("Hey
/// Glitch, open YouTube." -> "Open YouTube."). Without it, the whole text.
/// `None` if only the wake phrase was said.
pub fn strip_wake(text: &str) -> Option<String> {
    let rest = match spoken_name_end(text) {
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
            "Okay Glitch, set a timer.",
            "OK, Glitch.",
            "Hey Glitz, open YouTube.",
            "Hey glitch's open youtube",
            "Heyglitch",
            "Hey, Litch. Open YouTube.",
            "Oh, hey Glitch",
            "Hay Glitch, what's up?",
        ] {
            assert!(is_wake(t), "{t}");
        }
        for t in [
            "",
            "Glitch",
            "Glitch, open YouTube.",
            "There's a glitch in the game.",
            "A glitch in the system.",
            "He glitched out.",
            "A Glitch, open YouTube.",
            "He, Glitch, open YouTube.",
            "Hi Glitch.",
            "Hey glitchy thing.",
            "Hey glitches.",
            "Ich komme gleich.",
            "Hey, gleich geht's los.",
            "Okay, gleich.",
            "Hey Mitch, open the door.",
            "Hey, pitch it to me.",
            "Open YouTube.",
            "The Glitch is a raccoon.",
            "Hey, what's up?",
            "Switch it off.",
            "Hey there Glitch",
            "Thanks for watching!",
            "Hey Rich",
            "[BLANK_AUDIO]",
        ] {
            assert!(!is_wake(t), "{t}");
        }
    }

    fn toks(parts: &[(&str, f32)]) -> Vec<(String, f32)> {
        parts.iter().map(|(t, p)| (t.to_string(), *p)).collect()
    }

    #[test]
    fn confidence() {
        let clear = toks(&[(" Hey", 0.95), (" Gl", 0.8), ("itch", 0.9), (",", 0.7), (" open", 0.2), (" YouTube", 0.3)]);
        assert_eq!(wake_confidence(&clear), Some(0.8), "only the wake phrase's tokens count");
        assert!(is_confident_wake(&clear));
        let mumbled = toks(&[(" Hey", 0.9), (" Gl", 0.3), ("itch", 0.6), (".", 0.9)]);
        assert_eq!(wake_confidence(&mumbled), Some(0.3));
        assert!(!is_confident_wake(&mumbled));
        let other = toks(&[(" There", 0.9), ("'s", 0.9), (" a", 0.9), (" glitch", 0.9)]);
        assert_eq!(wake_confidence(&other), None);
        assert!(!is_confident_wake(&[]));
    }

    #[test]
    fn stripping_the_wake_word() {
        assert_eq!(strip_wake("Hey Glitch, open YouTube.").as_deref(), Some("Open YouTube."));
        assert_eq!(
            strip_wake(" Hey glitch. Open YouTube and play lo-fi.").as_deref(),
            Some("Open YouTube and play lo-fi.")
        );
        // Looser for the command: the big model may drop or change "hey".
        assert_eq!(strip_wake("Glitch what's the weather").as_deref(), Some("What's the weather"));
        assert_eq!(strip_wake("Hi Glitch, open YouTube.").as_deref(), Some("Open YouTube."));
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
        assert!(!is_glitch("gleich") && !is_glitch("glitchy") && !is_glitch("itch") && !is_glitch("glit"));
        assert_eq!(edit_distance("kitten", "sitting"), 3);
        assert_eq!(edit_distance("", "abc"), 3);
    }
}
