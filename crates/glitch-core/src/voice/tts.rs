//! Glitch's own voice for reading replies aloud: the pure half.
//!
//! A local neural voice (Piper, MIT, run as its own small program) reads
//! the reply; the sound is then played a little faster than it was made,
//! which raises the pitch and the tempo together: a small, quick raccoon
//! instead of a newsreader. Nothing leaves the computer.
//!
//! Downloaded on first use (opt-in, Settings → Features), like the speech
//! models: resumable, size- and SHA-1-checked. The voice is "Joe" (CC0
//! dataset, so no licence strings attached).

use serde::Serialize;

/// One file to download. SHA-1s were computed from the files at these URLs
/// (pinned release and Hugging Face revision paths that don't change).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Asset {
    pub id: &'static str,
    pub url: &'static str,
    /// File name on disk.
    pub file: &'static str,
    pub size_bytes: u64,
    #[serde(skip)]
    pub sha1: &'static str,
}

/// The Piper program for Windows x64 (piper.exe + onnxruntime + espeak-ng
/// data), unpacked into `piper/` after the download.
pub const ENGINE_WINDOWS: Asset = Asset {
    id: "engine",
    url: "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip",
    file: "piper_windows_amd64.zip",
    size_bytes: 22_477_236,
    sha1: "48b7ae8a46c07124aacbd112a1ba0ed4a913e3f0",
};

pub const VOICE: Asset = Asset {
    id: "voice",
    url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/joe/medium/en_US-joe-medium.onnx",
    file: "en_US-joe-medium.onnx",
    size_bytes: 63_201_294,
    sha1: "1c55b66bb6d167b4c11e2fe0a5b912f14cea6f99",
};

/// Piper looks for `<model>.json` next to the model.
pub const VOICE_CONFIG: Asset = Asset {
    id: "voice_config",
    url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/joe/medium/en_US-joe-medium.onnx.json",
    file: "en_US-joe-medium.onnx.json",
    size_bytes: 4_794,
    sha1: "6490a30eabcee7ef78c988293d0e9d8bcedf3947",
};

/// Everything the character voice needs, in download order. `None` where
/// there is no working Piper build (macOS releases miss their libraries,
/// Linux has no voice support at all): read-aloud uses the system voice.
pub fn assets() -> Option<[Asset; 3]> {
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        Some([ENGINE_WINDOWS, VOICE, VOICE_CONFIG])
    } else {
        None
    }
}

/// Total download in MiB (rounded up), for the UI.
pub fn download_mb(assets: &[Asset]) -> u64 {
    assets.iter().map(|a| a.size_bytes).sum::<u64>().div_ceil(1 << 20)
}

/// Played this much faster than synthesized: pitch and tempo both go up
/// (about +2.4 semitones).
pub const PITCH: f64 = 1.15;
/// The tempo we want in the end (1.0 = Piper's normal speed).
pub const SPEED: f64 = 1.08;

/// Piper's `--length_scale` that gives [`SPEED`] after the [`PITCH`] shift.
pub fn length_scale() -> f64 {
    PITCH / SPEED
}

/// The text as Piper input: one sentence per line, so the first sentence is
/// synthesized (and heard) before the rest is done. Very short bits ride
/// along with the next sentence (a pause after "Sure!" sounds odd).
pub fn lines(text: &str) -> Vec<String> {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: Vec<String> = vec![];
    let mut cur = String::new();
    let mut chars = flat.chars().peekable();
    while let Some(c) = chars.next() {
        cur.push(c);
        let end = matches!(c, '.' | '!' | '?') && chars.peek().is_none_or(|n| *n == ' ');
        if end && cur.trim().chars().filter(|c| c.is_alphanumeric()).count() >= 8 {
            out.push(cur.trim().to_string());
            cur.clear();
        }
    }
    if !cur.trim().is_empty() {
        match out.last_mut() {
            Some(last) if cur.trim().chars().filter(|c| c.is_alphanumeric()).count() < 8 => {
                last.push(' ');
                last.push_str(cur.trim());
            }
            _ => out.push(cur.trim().to_string()),
        }
    }
    out
}

/// A streaming linear resampler (Piper's 22 kHz → the speakers' rate) that
/// also applies the pitch shift. Linear is plenty for a voice and costs
/// nothing; it runs on a stream so playback starts with the first sentence.
pub struct Resampler {
    /// Input samples per output sample.
    step: f64,
    /// Position of the next output sample, relative to `prev`.
    pos: f64,
    prev: f32,
}

impl Resampler {
    pub fn new(from_hz: u32, to_hz: u32, pitch: f64) -> Self {
        Self { step: from_hz as f64 * pitch / to_hz.max(1) as f64, pos: 0.0, prev: 0.0 }
    }

    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        // Between `prev` (index -1) and input[0] (index 0) and so on.
        for &x in input {
            while self.pos < 1.0 {
                out.push(self.prev + (x - self.prev) * self.pos as f32);
                self.pos += self.step;
            }
            self.pos -= 1.0;
            self.prev = x;
        }
    }
}

/// Little-endian 16-bit PCM (Piper's `--output_raw`) to f32. A trailing odd
/// byte is returned to be prepended to the next read.
pub fn pcm16_to_f32(bytes: &[u8], out: &mut Vec<f32>) -> Option<u8> {
    let (pairs, rest) = bytes.as_chunks::<2>();
    out.extend(pairs.iter().map(|b| i16::from_le_bytes(*b) as f32 / 32768.0));
    rest.first().copied()
}

/// The mascot's mouth moves for `chars * 45 ms` per "mascot-talk" pulse
/// (1.2-6 s, see creature.ts). The number of characters that keeps it
/// moving for `ms` more.
pub fn talk_chars(ms: u64) -> u64 {
    ms.clamp(1_200, 6_000) / 45
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_table() {
        for a in [ENGINE_WINDOWS, VOICE, VOICE_CONFIG] {
            assert_eq!(a.sha1.len(), 40);
            assert!(a.sha1.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
            assert!(a.url.starts_with("https://") && a.url.ends_with(a.file), "{}", a.id);
        }
        assert_eq!(format!("{}.json", VOICE.file), VOICE_CONFIG.file);
        assert_eq!(download_mb(&[ENGINE_WINDOWS, VOICE, VOICE_CONFIG]), 82);
        assert_eq!(assets().is_some(), cfg!(all(target_os = "windows", target_arch = "x86_64")));
    }

    #[test]
    fn character_voice_numbers() {
        // Higher, a bit quicker, but not a chipmunk.
        assert!((1.1..1.25).contains(&PITCH));
        assert!((1.0..1.15).contains(&SPEED));
        assert!((length_scale() - 1.0648).abs() < 0.001);
    }

    #[test]
    fn sentence_lines() {
        assert_eq!(
            lines("Sure! Opening YouTube for you.\nAnything else?"),
            vec!["Sure! Opening YouTube for you.", "Anything else?"]
        );
        assert_eq!(lines("It costs 3.50 euros. Okay."), vec!["It costs 3.50 euros. Okay."]);
        assert_eq!(lines("no punctuation at all"), vec!["no punctuation at all"]);
        assert_eq!(lines("Hi."), vec!["Hi."]);
        assert!(lines("   ").is_empty());
        assert_eq!(lines("What time is it? It's 5 pm!"), vec!["What time is it? It's 5 pm!"]);
        assert_eq!(lines("What time is it? It is five pm."), vec!["What time is it?", "It is five pm."]);
    }

    #[test]
    fn resampler_rates_and_pitch() {
        let input: Vec<f32> = (0..22_050).map(|i| (i as f32 * 0.01).sin()).collect();
        let mut out = vec![];
        let mut r = Resampler::new(22_050, 48_000, 1.0);
        // In uneven pieces, like reads from a pipe.
        for c in input.chunks(777) {
            r.process(c, &mut out);
        }
        assert!((out.len() as i64 - 48_000).abs() <= 2, "{}", out.len());
        // Pitched up: the same audio lasts 1/PITCH as long.
        let mut out2 = vec![];
        Resampler::new(22_050, 48_000, PITCH).process(&input, &mut out2);
        assert!((out2.len() as f64 - 48_000.0 / PITCH).abs() <= 2.0);
        // Values are interpolated, never overshoot.
        assert!(out.iter().all(|x| x.abs() <= 1.0));
        let mut same = vec![];
        Resampler::new(16_000, 16_000, 1.0).process(&[0.5, 0.25], &mut same);
        assert_eq!(same, vec![0.0, 0.5]);
    }

    #[test]
    fn pcm() {
        let mut out = vec![];
        assert_eq!(pcm16_to_f32(&[0, 0x80, 0xff, 0x7f, 7], &mut out), Some(7));
        assert_eq!(out, vec![-1.0, 32767.0 / 32768.0]);
        assert_eq!(pcm16_to_f32(&[], &mut out), None);
    }

    #[test]
    fn mouth_pulses() {
        assert_eq!(talk_chars(0), 26);
        assert_eq!(talk_chars(3_000), 66);
        assert_eq!(talk_chars(60_000), 133);
    }
}
