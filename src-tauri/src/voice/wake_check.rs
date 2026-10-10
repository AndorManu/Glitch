//! Live checks for the wake word and the character voice. All `#[ignore]`d
//! (they need speech models, a microphone or the Piper download). Run with
//! `node dev/wake-check.mjs`, which makes the test audio and sets:
//!
//! * `GLITCH_WAKE_WAVS`: folder with `pos_*.wav` (must wake, then yield a
//!   command mentioning YouTube) and `neg_*.wav` (must never wake)
//! * `GLITCH_VOICE_MODELS`: folder with `ggml-<model>.bin`
//! * `GLITCH_WAKE_MODELS`: which models to try, e.g. "tiny,base"
//! * `GLITCH_TTS_DIR`: folder with `piper/` and the voice (for `live_tts`)

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use glitch_core::voice::audio::{prepare_for_whisper, resample};
use glitch_core::voice::models as speech_models;
use glitch_core::voice::wake::{self as wake_core, Segmenter, WakeConfig};
use glitch_core::voice::{transcript, SAMPLE_RATE};

use super::{capture, stt, tts, wake};

/// CPU time used by this whole process so far (all threads).
fn cpu_time() -> Duration {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::FILETIME;
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
        let z = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let (mut c, mut e, mut k, mut u) = (z, z, z, z);
        // SAFETY: plain out-parameters for the current process.
        unsafe { GetProcessTimes(GetCurrentProcess(), &mut c, &mut e, &mut k, &mut u) };
        let t = |f: FILETIME| ((f.dwHighDateTime as u64) << 32 | f.dwLowDateTime as u64) * 100;
        Duration::from_nanos(t(k) + t(u))
    }
    #[cfg(not(windows))]
    {
        Duration::ZERO
    }
}

fn read_wav(path: &Path) -> (Vec<f32>, u32) {
    let mut r = hound::WavReader::open(path).unwrap();
    let spec = r.spec();
    let raw: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => r.samples::<i16>().map(|s| s.unwrap() as f32 / 32768.0).collect(),
        hound::SampleFormat::Float => r.samples::<f32>().map(|s| s.unwrap()).collect(),
    };
    let mut mono = vec![];
    glitch_core::voice::audio::mix_to_mono(&mut mono, &raw, spec.channels as usize);
    (mono, spec.sample_rate)
}

/// A quiet room around the clip: -60 dBFS hiss.
fn hiss(n: usize, seed: &mut u32) -> Vec<f32> {
    (0..n)
        .map(|_| {
            *seed ^= *seed << 13;
            *seed ^= *seed >> 17;
            *seed ^= *seed << 5;
            (*seed as f32 / u32::MAX as f32 * 2.0 - 1.0) * 0.001
        })
        .collect()
}

fn wavs(prefix: &str) -> Vec<PathBuf> {
    let Some(dir) = std::env::var_os("GLITCH_WAKE_WAVS") else { return vec![] };
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.extension().is_some_and(|x| x == "wav") && p.file_name().unwrap().to_string_lossy().starts_with(prefix)
        })
        .collect();
    v.sort();
    v
}

fn models() -> Vec<(&'static str, PathBuf)> {
    let dir = std::env::var_os("GLITCH_VOICE_MODELS")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("glitch-voice").join("models"));
    std::env::var("GLITCH_WAKE_MODELS")
        .unwrap_or_else(|_| "tiny,base".into())
        .split(',')
        .filter_map(|id| speech_models::find(id.trim()))
        .map(|m| (m.id, dir.join(m.file)))
        .filter(|(_, p)| p.is_file())
        .collect()
}

struct Outcome {
    woke: bool,
    checks: usize,
    texts: Vec<(String, Option<f32>)>,
    /// The command after the wake word, as the hand-over would transcribe it.
    command: Option<String>,
    whisper: Duration,
}

/// One clip through the listener's pipeline, as fast as possible.
fn run_clip(model: &stt::Model, audio: &[f32], rate: u32, prompt: bool) -> Outcome {
    let mut seg = Segmenter::new(rate, WakeConfig::default());
    let mut detector = wake::Detector::default();
    detector.prompt = prompt;
    let mut out = Outcome { woke: false, checks: 0, texts: vec![], command: None, whisper: Duration::ZERO };
    let chunk = rate as usize / 100;
    let mut fed = 0;
    for c in audio.chunks(chunk) {
        fed += c.len();
        let Some(check) = seg.push(c) else { continue };
        out.checks += 1;
        let t = Instant::now();
        let d = detector.check(model, &check.audio, rate).unwrap();
        out.whisper += t.elapsed();
        let Some(d) = d else { continue };
        out.texts.push((d.text.clone(), d.confidence));
        if d.wake && !out.woke {
            out.woke = true;
            // What the hands-free command would record: the check's audio
            // and the rest of the clip (it ends with silence).
            let mut rec = check.audio.clone();
            rec.extend_from_slice(&audio[fed..]);
            let speech = prepare_for_whisper(&resample(&rec, rate, SAMPLE_RATE)).unwrap();
            let raw = stt::transcribe(model, &speech, Some("en"), Arc::new(AtomicBool::new(false))).unwrap();
            out.command = transcript::clean(&raw).and_then(|t| wake_core::strip_wake(&t));
            seg.reset();
        }
    }
    out
}

#[test]
#[ignore]
fn live_wake_wavs() {
    let (pos, neg) = (wavs("pos_"), wavs("neg_"));
    assert!(!pos.is_empty() && !neg.is_empty(), "run `node dev/wake-check.mjs`");
    let mut seed = 0x2545_f491;
    let prompts: Vec<bool> = match std::env::var("GLITCH_WAKE_PROMPT").as_deref() {
        Ok("1") => vec![true],
        Ok("both") => vec![false, true],
        _ => vec![wake::WAKE_PROMPT],
    };
    for ((id, path), prompt) in models().into_iter().flat_map(|m| prompts.iter().map(move |p| (m.clone(), *p))) {
        let k: stt::Keeper<stt::Model> = stt::Keeper::new(Duration::from_secs(600));
        let model = k.get(&path, stt::load).unwrap();
        let id = if prompt { format!("{id}+prompt") } else { id.to_string() };
        eprintln!("\n===== model {id} =====");

        let (mut tp, mut cmd_ok, mut pos_conf) = (0, 0, vec![]);
        let mut latencies = vec![];
        for p in &pos {
            let (clip, rate) = read_wav(p);
            let mut a = hiss(rate as usize, &mut seed);
            a.extend(&clip);
            a.extend(hiss(rate as usize * 3 / 2, &mut seed));
            let o = run_clip(&model, &a, rate, prompt);
            latencies.push(o.whisper.as_secs_f64() * 1000.0 / o.checks.max(1) as f64);
            let name = p.file_stem().unwrap().to_string_lossy();
            if o.woke {
                tp += 1;
                if let Some(c) = o.texts.iter().find_map(|(_, c)| *c) {
                    pos_conf.push(c);
                }
            }
            let good = o.command.as_deref().is_some_and(|c| c.to_lowercase().contains("youtube"));
            cmd_ok += usize::from(good);
            eprintln!(
                "[{id}] {} {name}: {:?} -> {:?}",
                if o.woke && good {
                    "ok  "
                } else if o.woke {
                    "CMD?"
                } else {
                    "MISS"
                },
                o.texts,
                o.command
            );
        }

        let (mut fp, mut secs, mut checks, mut whisper) = (0, 0.0, 0, Duration::ZERO);
        let cpu0 = cpu_time();
        let t0 = Instant::now();
        let mut near = vec![];
        for p in &neg {
            let (clip, rate) = read_wav(p);
            secs += clip.len() as f64 / rate as f64;
            let mut a = clip;
            a.extend(hiss(rate as usize, &mut seed));
            let o = run_clip(&model, &a, rate, prompt);
            checks += o.checks;
            whisper += o.whisper;
            for (t, c) in &o.texts {
                if c.is_some() {
                    near.push((t.clone(), *c));
                }
            }
            if o.woke {
                fp += 1;
                eprintln!("[{id}] FALSE WAKE in {}: {:?}", p.display(), o.texts);
            }
        }
        let cpu = cpu_time() - cpu0;
        let wall = t0.elapsed();
        latencies.sort_by(f64::total_cmp);
        eprintln!("[{id}] wake-phrase transcripts in negatives (text, confidence): {near:?}");
        eprintln!("[{id}] positive confidences: {pos_conf:?}");
        eprintln!(
            "[{id}] TRUE POSITIVES {tp}/{} ({:.0}%), command extracted {cmd_ok}/{}",
            pos.len(),
            100.0 * tp as f64 / pos.len() as f64,
            pos.len()
        );
        eprintln!(
            "[{id}] FALSE WAKES {fp} in {:.1} min of non-matching audio ({checks} checks, {:.1} per minute)",
            secs / 60.0,
            checks as f64 / (secs / 60.0)
        );
        eprintln!(
            "[{id}] wake check: median {:.0} ms, p90 {:.0} ms per utterance; CPU while audio is all speech/music: {:.1}% of one core (process CPU {:.1} s for {:.1} s of audio, wall {:.1} s)",
            latencies[latencies.len() / 2],
            latencies[latencies.len() * 9 / 10],
            100.0 * cpu.as_secs_f64() / secs,
            cpu.as_secs_f64(),
            secs,
            wall.as_secs_f64()
        );
        let _ = whisper;
        drop(model);
    }
}

/// The armed listener's loop on the real microphone with the room quiet:
/// how much CPU does "armed but nobody talks" cost?
#[test]
#[ignore]
fn live_wake_mic_idle() {
    let secs: u64 = std::env::var("GLITCH_WAKE_IDLE_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(60);
    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    let mic = match capture::open(
        move |s: &[f32]| {
            let _ = tx.send(s.to_vec());
        },
        |_| {},
    ) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[idle] no microphone: {e:?}");
            return;
        }
    };
    let mut seg = Segmenter::new(mic.sample_rate, WakeConfig::default());
    std::thread::sleep(Duration::from_millis(500));
    while rx.try_recv().is_ok() {}
    let (cpu0, t0) = (cpu_time(), Instant::now());
    let (mut checks, mut chunks, mut samples) = (0, 0, 0usize);
    while t0.elapsed() < Duration::from_secs(secs) {
        if let Ok(c) = rx.recv_timeout(Duration::from_millis(100)) {
            chunks += 1;
            samples += c.len();
            if seg.push(&c).is_some() {
                checks += 1;
            }
        }
    }
    let cpu = cpu_time() - cpu0;
    drop(mic);
    eprintln!(
        "[idle] {secs} s armed at {} Hz: {chunks} mic buffers, {samples} samples, {checks} utterances that would go to whisper; CPU {:.0} ms = {:.2}% of one core",
        samples as u64 / secs.max(1),
        cpu.as_secs_f64() * 1000.0,
        100.0 * cpu.as_secs_f64() / t0.elapsed().as_secs_f64()
    );
}

/// Piper's time to first audio: cold (process start + voice load) and on
/// standby (started while the model thinks, as the app does).
#[test]
#[ignore]
fn live_tts() {
    let Some(dir) = std::env::var_os("GLITCH_TTS_DIR").map(PathBuf::from) else { return };
    let ts = tts::TtsState::new(dir.clone());
    if !ts.installed() {
        eprintln!("[tts] no Piper/voice in {}", dir.display());
        return;
    }
    let text = "Sure! Opening YouTube for you.\nAnything else I can do?\n";
    let first_audio = |child: &mut std::process::Child, t: Instant| {
        use std::io::Read;
        let mut out = child.stdout.take().unwrap();
        let mut buf = [0u8; 4096];
        let n = out.read(&mut buf).unwrap();
        let first = t.elapsed();
        let mut total = n;
        let mut rest = vec![];
        total += out.read_to_end(&mut rest).unwrap();
        (first, total)
    };
    use std::io::Write;
    for i in 0..3 {
        let t = Instant::now();
        let mut c = tts::spawn_piper_for_test(&ts).unwrap();
        c.stdin.take().unwrap().write_all(text.as_bytes()).unwrap();
        let (first, bytes) = first_audio(&mut c, t);
        let _ = c.wait();
        eprintln!("[tts] cold #{i}: first audio after {:?}, {:.2} s of audio", first, bytes as f64 / 2.0 / 22_050.0);
    }
    for i in 0..3 {
        let mut c = tts::spawn_piper_for_test(&ts).unwrap();
        std::thread::sleep(Duration::from_millis(2_000));
        let t = Instant::now();
        c.stdin.take().unwrap().write_all(text.as_bytes()).unwrap();
        let (first, _) = first_audio(&mut c, t);
        let _ = c.wait();
        eprintln!("[tts] standby #{i}: first audio after {first:?}");
    }
    let t = Instant::now();
    match tts::open_output_for_test() {
        Ok(rate) => eprintln!("[tts] speakers opened in {:?} at {rate} Hz", t.elapsed()),
        Err(e) => eprintln!("[tts] no speakers: {e}"),
    }
}
