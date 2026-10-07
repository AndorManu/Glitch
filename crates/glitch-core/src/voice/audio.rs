//! Turning whatever the microphone gives us into what whisper wants:
//! 16 kHz mono f32, speech only, not too quiet, at least one second long.

use super::SAMPLE_RATE;

/// Append interleaved multi-channel audio to `out` as mono (channel average).
pub fn mix_to_mono(out: &mut Vec<f32>, interleaved: &[f32], channels: usize) {
    if channels <= 1 {
        out.extend_from_slice(interleaved);
        return;
    }
    let scale = 1.0 / channels as f32;
    out.extend(interleaved.chunks_exact(channels).map(|frame| frame.iter().sum::<f32>() * scale));
}

/// Zero crossings of the sinc kernel on each side. 16 gives a steep
/// anti-aliasing filter (>60 dB stop band with the Blackman window) and is
/// still cheap: about 50 ms of CPU for 30 s of 48 kHz audio.
const ZERO_CROSSINGS: f64 = 16.0;
/// Keep the pass band a little below the new Nyquist frequency.
const ROLLOFF: f64 = 0.94;

/// Windowed-sinc resampler for a whole recording (we only resample once,
/// after the user lets go, so there's no need for a streaming filter).
/// Handles any rate pair, including non-integer ratios like 44.1k → 16k.
pub fn resample(input: &[f32], from_hz: u32, to_hz: u32) -> Vec<f32> {
    if from_hz == to_hz || input.is_empty() || from_hz == 0 || to_hz == 0 {
        return input.to_vec();
    }
    let ratio = to_hz as f64 / from_hz as f64;
    // Cut-off relative to the input's Nyquist: below the output Nyquist when
    // downsampling (anti-aliasing), the input's own when upsampling.
    let cutoff = ratio.min(1.0) * ROLLOFF;
    // Kernel half-width in input samples.
    let half = ZERO_CROSSINGS / cutoff;
    let out_len = ((input.len() as f64) * ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for n in 0..out_len {
        let t = n as f64 / ratio; // position in input samples
        let first = ((t - half).ceil().max(0.0)) as usize;
        let last = ((t + half).floor() as usize).min(input.len() - 1);
        let (mut acc, mut norm) = (0.0f64, 0.0f64);
        for (k, &x) in input.iter().enumerate().take(last + 1).skip(first) {
            let d = t - k as f64;
            let w = cutoff * sinc(cutoff * d) * blackman(d / half);
            acc += w * x as f64;
            norm += w;
        }
        // Normalising keeps DC gain exactly 1, also at the edges.
        out.push(if norm.abs() > 1e-9 { (acc / norm) as f32 } else { 0.0 });
    }
    out
}

fn sinc(x: f64) -> f64 {
    if x.abs() < 1e-12 {
        1.0
    } else {
        let px = std::f64::consts::PI * x;
        px.sin() / px
    }
}

/// Blackman window on [-1, 1].
fn blackman(x: f64) -> f64 {
    if x.abs() >= 1.0 {
        return 0.0;
    }
    let a = std::f64::consts::PI * (x + 1.0); // 0..2π across the window
    0.42 - 0.5 * a.cos() + 0.08 * (2.0 * a).cos()
}

pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}

/// RMS → 0..1 for the little level meter: −60 dBFS (quiet room) is empty,
/// −12 dBFS (loud, close speech) is full.
pub fn meter_level(rms: f32) -> f32 {
    if rms <= 1e-6 {
        return 0.0;
    }
    let db = 20.0 * rms.log10();
    ((db + 60.0) / 48.0).clamp(0.0, 1.0)
}

/// Speech is quieter than this (RMS of a 20 ms frame, about −42 dBFS) only
/// on a really bad microphone. Used together with an adaptive noise floor.
pub const MIN_SPEECH_RMS: f32 = 0.008;

/// Keep this much audio around the detected speech (whisper likes a little
/// lead-in, and soft word endings are often below the threshold).
const PAD_MS: usize = 300;
/// Whisper complains (and guesses badly) below one second of input.
const MIN_INPUT_MS: usize = 1_100;
/// Less detected speech than this is a click or a cough, not a command.
const MIN_SPEECH_MS: usize = 200;
/// Quiet recordings are boosted towards this peak (at most `MAX_GAIN` times).
const TARGET_PEAK: f32 = 0.9;
const MAX_GAIN: f32 = 20.0;

/// Prepare a 16 kHz recording for whisper: cut silence at both ends, lift a
/// quiet recording's volume, pad to at least ~1 s. `None` if there's no
/// speech in it at all (then don't bother loading the model).
pub fn prepare_for_whisper(samples: &[f32]) -> Option<Vec<f32>> {
    let frame = SAMPLE_RATE as usize / 50; // 20 ms
    let frames: Vec<f32> = samples.chunks(frame).map(rms).collect();
    if frames.is_empty() {
        return None;
    }
    // Threshold: well above the quietest part of the recording (the room),
    // but below the loudest part (a recording that is all speech has no
    // quiet part), and never below the absolute minimum. Whether there was
    // speech at all is the recorder's VAD's call; this only trims.
    let mut sorted = frames.clone();
    sorted.sort_by(f32::total_cmp);
    let floor = sorted[sorted.len() / 10];
    let loud = sorted[sorted.len() - 1 - sorted.len() / 20];
    let threshold = (floor * 3.0).min(loud * 0.3).max(MIN_SPEECH_RMS);
    let speech: Vec<usize> = frames.iter().enumerate().filter(|(_, r)| **r > threshold).map(|(i, _)| i).collect();
    if speech.len() * 20 < MIN_SPEECH_MS {
        return None;
    }
    let pad = PAD_MS * SAMPLE_RATE as usize / 1000;
    let start = (speech[0] * frame).saturating_sub(pad);
    let end = ((speech[speech.len() - 1] + 1) * frame + pad).min(samples.len());
    let mut out = samples[start..end].to_vec();

    let peak = out.iter().fold(0.0f32, |m, s| m.max(s.abs()));
    if peak > 0.0 && peak < TARGET_PEAK {
        let gain = (TARGET_PEAK / peak).min(MAX_GAIN);
        out.iter_mut().for_each(|s| *s *= gain);
    }
    let min_len = MIN_INPUT_MS * SAMPLE_RATE as usize / 1000;
    if out.len() < min_len {
        out.resize(min_len, 0.0);
    }
    Some(out)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn sine(freq: f64, rate: u32, secs: f64, amp: f32) -> Vec<f32> {
        let n = (rate as f64 * secs) as usize;
        (0..n).map(|i| amp * (2.0 * std::f64::consts::PI * freq * i as f64 / rate as f64).sin() as f32).collect()
    }

    /// RMS difference between `got` and an ideal sine, skipping the edges
    /// (where any finite filter has to guess).
    fn error_vs_sine(got: &[f32], freq: f64, rate: u32, amp: f32) -> f32 {
        let ideal = sine(freq, rate, got.len() as f64 / rate as f64 + 1.0, amp);
        let skip = rate as usize / 20;
        let diff: Vec<f32> = got[skip..got.len() - skip].iter().zip(&ideal[skip..]).map(|(a, b)| a - b).collect();
        rms(&diff)
    }

    #[test]
    fn mono_mix() {
        let mut out = vec![];
        mix_to_mono(&mut out, &[1.0, 0.0, 0.5, 0.5, -1.0, 1.0], 2);
        assert_eq!(out, vec![0.5, 0.5, 0.0]);
        mix_to_mono(&mut out, &[0.25], 1);
        assert_eq!(out.len(), 4);
        // A trailing partial frame is dropped rather than mixed wrongly.
        let mut out = vec![];
        mix_to_mono(&mut out, &[1.0, 1.0, 1.0, 1.0], 3);
        assert_eq!(out, vec![1.0]);
    }

    #[test]
    fn resample_sine_48k_and_44k_to_16k() {
        for from in [48_000u32, 44_100, 22_050, 16_000, 8_000] {
            let input = sine(440.0, from, 1.0, 0.5);
            let out = resample(&input, from, SAMPLE_RATE);
            let expected = (input.len() as f64 * SAMPLE_RATE as f64 / from as f64).floor() as usize;
            assert_eq!(out.len(), expected, "{from}");
            let err = error_vs_sine(&out, 440.0, SAMPLE_RATE, 0.5);
            assert!(err < 2e-3, "{from} Hz: rms error {err}");
        }
    }

    #[test]
    fn resample_keeps_speech_band() {
        // 3.4 kHz (top of the classic telephone band) survives 48k → 16k.
        let out = resample(&sine(3400.0, 48_000, 0.5, 0.5), 48_000, SAMPLE_RATE);
        let err = error_vs_sine(&out, 3400.0, SAMPLE_RATE, 0.5);
        assert!(err < 5e-3, "rms error {err}");
    }

    #[test]
    fn resample_removes_aliases() {
        // 12 kHz can't exist at 16 kHz; without a filter it'd fold to 4 kHz.
        let out = resample(&sine(12_000.0, 48_000, 0.5, 0.5), 48_000, SAMPLE_RATE);
        let skip = 800;
        let level = rms(&out[skip..out.len() - skip]);
        assert!(level < 0.005, "alias level {level}");
    }

    #[test]
    fn meter() {
        assert_eq!(meter_level(0.0), 0.0);
        assert_eq!(meter_level(0.0005), 0.0); // −66 dBFS
        assert!((meter_level(0.015_85) - 0.5).abs() < 0.01); // −36 dBFS
        assert_eq!(meter_level(1.0), 1.0);
    }

    fn speech_like(secs: f64) -> Vec<f32> {
        // Two tones, loud enough to count as speech.
        sine(220.0, SAMPLE_RATE, secs, 0.2)
            .iter()
            .zip(sine(1300.0, SAMPLE_RATE, secs, 0.05))
            .map(|(a, b)| a + b)
            .collect()
    }

    #[test]
    fn prepare_trims_silence_and_pads() {
        let quiet = vec![0.0005f32; SAMPLE_RATE as usize]; // 1 s of room noise
        let mut rec = quiet.clone();
        rec.extend(speech_like(0.8));
        rec.extend(&quiet);
        rec.extend(&quiet);
        let out = prepare_for_whisper(&rec).unwrap();
        // 0.8 s speech + 2 × 0.3 s padding (±1 frame)
        let secs = out.len() as f32 / SAMPLE_RATE as f32;
        assert!((1.35..1.45).contains(&secs), "{secs}");
    }

    #[test]
    fn prepare_pads_short_commands_to_a_second() {
        let mut rec = vec![0.0; 4000];
        rec.extend(speech_like(0.3));
        let out = prepare_for_whisper(&rec).unwrap();
        assert_eq!(out.len(), SAMPLE_RATE as usize * 11 / 10);
    }

    #[test]
    fn prepare_boosts_quiet_speech() {
        let peak = |v: &[f32]| v.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        let rec: Vec<f32> = speech_like(1.0).iter().map(|s| s * 0.3).collect();
        let out = prepare_for_whisper(&rec).unwrap();
        assert!((0.85..=0.91).contains(&peak(&out)), "{}", peak(&out));
        // Very quiet: boosted at most 20×, so hiss doesn't become a roar.
        let rec: Vec<f32> = speech_like(1.0).iter().map(|s| s * 0.1).collect();
        let out = prepare_for_whisper(&rec).unwrap();
        assert!((peak(&out) - peak(&rec) * 20.0).abs() < 1e-3);
    }

    #[test]
    fn prepare_rejects_silence_and_clicks() {
        assert!(prepare_for_whisper(&[]).is_none());
        assert!(prepare_for_whisper(&vec![0.0; 32_000]).is_none());
        assert!(prepare_for_whisper(&vec![0.001; 32_000]).is_none());
        // A 60 ms click in 2 s of silence.
        let mut rec = vec![0.0; 32_000];
        rec[8000..8960].iter_mut().for_each(|s| *s = 0.5);
        assert!(prepare_for_whisper(&rec).is_none());
    }
}
