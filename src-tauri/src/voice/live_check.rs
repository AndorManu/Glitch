//! Live checks on a real machine: real microphone, real model download, real
//! whisper on real (synthesized) speech. All `#[ignore]`d: they need the
//! network, a microphone or a few hundred MB of model. Run them with
//! `node dev/voice-check.mjs` (generates the speech files and sets the env
//! vars), or by hand:
//!
//! ```text
//! GLITCH_VOICE_WAVS=dir/with/wavs GLITCH_VOICE_MODELS=dir \
//!   cargo test -p glitch --release live_ -- --ignored --nocapture --test-threads=1
//! ```
//!
//! * `GLITCH_VOICE_MODELS`: where models are (downloaded to if missing)
//! * `GLITCH_VOICE_CHECK_MODELS`: which, e.g. "tiny,base" (default)
//! * `GLITCH_VOICE_WAVS`: a folder of `name.wav` files; `name.txt` next to
//!   one holds words the transcript must contain (space-separated)

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use glitch_core::voice::models::{self as speech_models, SpeechModel};
use glitch_core::voice::vad::Mode;

use super::capture::MicError;
use super::download;
use super::session::{self, AudioSink, Control, ErrorSink, VoiceEvent};
use super::stt;

fn models_dir() -> PathBuf {
    std::env::var_os("GLITCH_VOICE_MODELS")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("glitch-voice").join("models"))
}

fn check_models() -> Vec<&'static SpeechModel> {
    std::env::var("GLITCH_VOICE_CHECK_MODELS")
        .unwrap_or_else(|_| "tiny,base".into())
        .split(',')
        .filter_map(|id| speech_models::find(id.trim()))
        .collect()
}

/// Downloads a model like the app does, but first cuts the download off
/// part-way (cancel) to prove resuming + the SHA-1 check on the real server.
async fn fetch(m: &SpeechModel) -> PathBuf {
    let dest = models_dir().join(m.file);
    if dest.is_file() {
        eprintln!("[download] {} already present", m.file);
        return dest;
    }
    let url = speech_models::url(speech_models::DEFAULT_BASE_URL, m);
    let exp = download::Expected { sha1: m.sha1, size: m.size_bytes };
    let client = download::client();

    // 1. Start, cancel after ~15 MB.
    let cancel = AtomicBool::new(false);
    let t = Instant::now();
    let r = download::download(&client, &url, &dest, &exp, &cancel, |done, _| {
        if done > 15 << 20 {
            cancel.store(true, Ordering::SeqCst);
        }
    })
    .await;
    let part = download::part_path(&dest);
    let kept = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    assert_eq!(r, Err(download::DownloadError::Cancelled));
    assert!(kept > 0 && !dest.exists(), "part file kept, nothing final yet");
    eprintln!("[download] {}: cancelled at {} MB after {:?}", m.file, kept >> 20, t.elapsed());

    // 2. Resume to the end; must start where it stopped and pass SHA-1.
    let cancel = AtomicBool::new(false);
    let first = Mutex::new(None);
    let t = Instant::now();
    download::download(&client, &url, &dest, &exp, &cancel, |done, total| {
        first.lock().unwrap().get_or_insert((done, total));
    })
    .await
    .expect("resumed download completes and matches the SHA-1");
    let (first_done, total) = first.into_inner().unwrap().unwrap();
    assert!(first_done >= kept, "resumed at {first_done}, not from zero (had {kept})");
    assert!(!part.exists());
    assert_eq!(std::fs::metadata(&dest).unwrap().len(), total);
    eprintln!("[download] {}: resumed at {} MB, done in {:?}, SHA-1 ok", m.file, kept >> 20, t.elapsed());
    dest
}

#[tokio::test]
#[ignore = "downloads models from Hugging Face"]
async fn live_download() {
    for m in check_models() {
        fetch(m).await;
    }
}

/// A 16-bit / float WAV as mono f32 + its sample rate.
fn read_wav(path: &Path) -> (Vec<f32>, u32) {
    let mut r = hound::WavReader::open(path).expect("wav opens");
    let spec = r.spec();
    let interleaved: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => r.samples::<f32>().map(Result::unwrap).collect(),
        hound::SampleFormat::Int => {
            let scale = (1u64 << (spec.bits_per_sample - 1)) as f32;
            r.samples::<i32>().map(|s| s.unwrap() as f32 / scale).collect()
        }
    };
    let mut mono = vec![];
    glitch_core::voice::audio::mix_to_mono(&mut mono, &interleaved, spec.channels as usize);
    (mono, spec.sample_rate)
}

/// A fake microphone playing `audio` in real time (10 ms chunks), then room
/// noise until it's closed. Records when the last speech sample went out.
struct WavMic {
    stop: Arc<AtomicBool>,
    feeder: Option<std::thread::JoinHandle<()>>,
}

impl Drop for WavMic {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(f) = self.feeder.take() {
            let _ = f.join();
        }
    }
}

fn wav_mic(
    audio: Vec<f32>,
    rate: u32,
    speech_end: Arc<Mutex<Option<Instant>>>,
) -> impl FnOnce(AudioSink, ErrorSink) -> Result<(WavMic, u32), MicError> {
    move |mut sink, _| {
        let stop = Arc::new(AtomicBool::new(false));
        let s = stop.clone();
        let feeder = std::thread::spawn(move || {
            let chunk = rate as usize / 100;
            let start = Instant::now();
            // Some quiet room before the speech, like a real recording.
            let noise = |n: usize, k: usize| -> Vec<f32> {
                (0..n).map(|i| if (i + k).is_multiple_of(2) { 0.0008 } else { -0.0008 }).collect()
            };
            let mut script = noise(rate as usize * 3 / 10, 0);
            // Cut the synthesizer's trailing silence so "speech ended" is
            // when the last word actually ends (room noise follows).
            let end = audio.iter().rposition(|x| x.abs() > 0.01).map_or(audio.len(), |i| i + 1);
            script.extend_from_slice(&audio[..end]);
            let speech_until = script.len();
            let mut sent = 0usize;
            let mut k = 0;
            while !s.load(Ordering::SeqCst) {
                let c = if sent < speech_until {
                    script[sent..(sent + chunk).min(speech_until)].to_vec()
                } else {
                    k += 1;
                    noise(chunk, k)
                };
                sent += c.len();
                sink(&c);
                if sent >= speech_until {
                    speech_end.lock().unwrap().get_or_insert_with(Instant::now);
                }
                // Real-time pacing.
                let due = start + Duration::from_secs_f64(sent as f64 / rate as f64);
                if let Some(wait) = due.checked_duration_since(Instant::now()) {
                    std::thread::sleep(wait);
                }
            }
        });
        Ok((WavMic { stop, feeder: Some(feeder) }, rate))
    }
}

/// Words the transcript must contain, from `name.txt` (or built-in for the
/// two standard phrases).
fn expected_words(wav: &Path) -> Vec<String> {
    let txt = wav.with_extension("txt");
    let s = std::fs::read_to_string(&txt).unwrap_or_default();
    s.split_whitespace().map(|w| w.to_lowercase()).collect()
}

fn normalize(s: &str) -> String {
    s.to_lowercase().chars().map(|c| if c.is_alphanumeric() || c == '\'' { c } else { ' ' }).collect()
}

/// One voice command through the real session code with real whisper.
/// Returns (transcript, latency after the speech ended).
fn one_command(model: &stt::Keeper<stt::Model>, path: &Path, wav: &Path, mode: Mode) -> (String, Duration) {
    let (audio, rate) = read_wav(wav);
    let speech_end = Arc::new(Mutex::new(None));
    let ctl = Arc::new(Control::new(mode));
    // Hold mode: "let go" the moment the speech is over.
    let stopper = (mode == Mode::Hold).then(|| {
        let (c, se) = (ctl.clone(), speech_end.clone());
        std::thread::spawn(move || {
            let t = Instant::now();
            while se.lock().unwrap().is_none() && t.elapsed() < Duration::from_secs(30) {
                std::thread::sleep(Duration::from_millis(2));
            }
            c.stop();
        })
    });
    let mut heard = None;
    let mut last = None;
    session::run(
        &ctl,
        wav_mic(audio, rate, speech_end.clone()),
        |samples| {
            let t = Instant::now();
            let m = model.get(path, stt::load)?;
            // The app's default language setting is "auto" (detect).
            let lang = std::env::var("GLITCH_VOICE_LANGUAGE").unwrap_or_else(|_| "auto".into());
            let r = stt::transcribe(&m, samples, glitch_core::voice::whisper_language(&lang), ctl.abort.clone());
            eprintln!(
                "    whisper: {:.1} s of audio in {} ms",
                samples.len() as f32 / 16_000.0,
                t.elapsed().as_millis()
            );
            r
        },
        |e| {
            if let VoiceEvent::Heard { text } = &e {
                heard = Some(text.clone());
            }
            if !matches!(e, VoiceEvent::Listening { .. }) {
                last = Some(e);
            }
        },
    );
    let done = Instant::now();
    if let Some(s) = stopper {
        s.join().unwrap();
    }
    let ended = speech_end.lock().unwrap().expect("speech was played");
    let text = heard.unwrap_or_else(|| panic!("{}: nothing heard, last event {last:?}", wav.display()));
    (text, done - ended)
}

#[test]
#[ignore = "needs speech WAVs and a whisper model (node dev/voice-check.mjs)"]
fn live_wav_pipeline() {
    let dir = PathBuf::from(std::env::var("GLITCH_VOICE_WAVS").expect("GLITCH_VOICE_WAVS"));
    let mut wavs: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|e| e == "wav"))
        .collect();
    wavs.sort();
    assert!(!wavs.is_empty(), "no .wav files in {}", dir.display());
    let rt = tokio::runtime::Runtime::new().unwrap();
    eprintln!("[cpu] avx2/fma/f16c/bmi2 supported: {}, whisper threads: {}", stt::cpu_supported(), stt::threads());
    let mut failures = vec![];
    for m in check_models() {
        let path = rt.block_on(fetch(m));
        let keeper: stt::Keeper<stt::Model> = stt::Keeper::new(Duration::from_secs(60));
        let t = Instant::now();
        keeper.get(&path, stt::load).expect("model loads");
        eprintln!("[{}] loaded in {:?} (the app loads it while you talk)", m.id, t.elapsed());
        for wav in &wavs {
            for mode in [Mode::Hold, Mode::HandsFree] {
                let (text, latency) = one_command(&keeper, &path, wav, mode);
                let got = normalize(&text);
                let missing: Vec<_> =
                    expected_words(wav).into_iter().filter(|w| !got.split_whitespace().any(|g| g == w)).collect();
                let name = wav.file_name().unwrap().to_string_lossy();
                eprintln!(
                    "[{}] {name} {mode:?}: {text:?} in {} ms after speech ended{}",
                    m.id,
                    latency.as_millis(),
                    if missing.is_empty() { String::new() } else { format!("  MISSING {missing:?}") }
                );
                if !missing.is_empty() {
                    failures.push(format!("{}/{name}/{mode:?}: missing {missing:?} in {text:?}", m.id));
                }
            }
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
#[test]
#[ignore = "uses the real microphone for 2 s"]
fn live_mic() {
    use cpal::traits::{DeviceTrait, HostTrait};
    let host = cpal::default_host();
    eprintln!("[mic] host: {:?}", host.id());
    match host.input_devices() {
        Ok(devs) => {
            for d in devs {
                let name = d.description().map(|d| d.name().to_string()).unwrap_or_else(|e| format!("? ({e})"));
                let cfg = d.default_input_config().map(|c| format!("{c:?}")).unwrap_or_else(|e| format!("error: {e}"));
                eprintln!("[mic] input: {name}: {cfg}");
            }
        }
        Err(e) => eprintln!("[mic] can't list inputs: {e}"),
    }
    // How long opening takes when the user presses the button (what is said
    // before the stream runs is lost), first and second time.
    for i in 0..2 {
        let t = Instant::now();
        let first = Arc::new(Mutex::new(None));
        let f = first.clone();
        let mic = super::capture::open(
            move |_| {
                f.lock().unwrap().get_or_insert_with(Instant::now);
            },
            |_| {},
        );
        let opened = t.elapsed();
        std::thread::sleep(Duration::from_millis(300));
        let first_audio = first.lock().unwrap().map(|x| x - t);
        drop(mic);
        eprintln!("[mic] open #{i}: open() returned after {opened:?}, first audio after {first_audio:?}");
    }
    let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
    let errors = Arc::new(Mutex::new(Vec::<String>::new()));
    let (s, e) = (samples.clone(), errors.clone());
    let t = Instant::now();
    match super::capture::open(move |c| s.lock().unwrap().extend_from_slice(c), move |m| e.lock().unwrap().push(m)) {
        Ok(mic) => {
            let opened = t.elapsed();
            let rate = mic.sample_rate;
            std::thread::sleep(Duration::from_secs(2));
            drop(mic);
            let s = samples.lock().unwrap();
            let rms = glitch_core::voice::audio::rms(&s);
            let peak = s.iter().fold(0f32, |m, x| m.max(x.abs()));
            eprintln!(
                "[mic] opened in {opened:?}; {rate} Hz; got {:.2} s of audio; RMS {rms:.5}, peak {peak:.4}; errors {:?}",
                s.len() as f32 / rate as f32,
                errors.lock().unwrap()
            );
            let per: Vec<String> =
                s.chunks(rate as usize / 4).map(|c| format!("{:.4}", glitch_core::voice::audio::rms(c))).collect();
            eprintln!("[mic] RMS per 250 ms: {}", per.join(" "));
            if peak == 0.0 {
                eprintln!(
                    "[mic] only exact zeros: the input is muted (mute key/switch, or volume 0 in Sound settings)"
                );
            }
            assert!(!s.is_empty(), "the microphone delivered no audio");
        }
        Err(e) => eprintln!("[mic] couldn't open: {} ({})", e.code(), e.message()),
    }
}
