//! Speech-to-text with whisper.cpp, loaded only while it's useful.
//!
//! The model (75–466 MB) is loaded when the user starts talking (in parallel
//! with recording, so it's usually ready when they let go), kept for a minute
//! for follow-up commands, then freed. While nothing is loaded, no thread is
//! waiting either: the "reaper" thread exists only while a model is.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How long a model stays loaded after its last use.
pub const KEEP_ALIVE: Duration = Duration::from_secs(60);

struct Slot<T> {
    loaded: Option<(PathBuf, Arc<T>)>,
    last_used: Instant,
    reaper: bool,
}

/// Holds at most one loaded model and frees it `keep_alive` after last use.
/// Generic so the lifetime rules are tested without a real model.
pub struct Keeper<T> {
    slot: Arc<Mutex<Slot<T>>>,
    keep_alive: Duration,
}

impl<T: Send + Sync + 'static> Keeper<T> {
    pub fn new(keep_alive: Duration) -> Self {
        Self { slot: Arc::new(Mutex::new(Slot { loaded: None, last_used: Instant::now(), reaper: false })), keep_alive }
    }

    /// The model at `path`, loading it first if needed (blocking; call off
    /// the UI thread). A different model that was loaded is dropped first.
    pub fn get(&self, path: &Path, load: impl FnOnce(&Path) -> Result<T, String>) -> Result<Arc<T>, String> {
        let mut slot = self.slot.lock().unwrap();
        slot.last_used = Instant::now();
        if let Some((p, m)) = &slot.loaded {
            if p == path {
                return Ok(m.clone());
            }
        }
        slot.loaded = None; // free the old one before loading the new one
        let model = Arc::new(load(path)?);
        slot.loaded = Some((path.to_path_buf(), model.clone()));
        slot.last_used = Instant::now();
        if !slot.reaper {
            slot.reaper = true;
            let (s, keep) = (Arc::downgrade(&self.slot), self.keep_alive);
            std::thread::Builder::new()
                .name("glitch-voice-unload".into())
                .spawn(move || reap(s, keep))
                .map_err(|e| e.to_string())?;
        }
        Ok(model)
    }

    /// Restart the keep-alive countdown (call when done using the model).
    pub fn touch(&self) {
        self.slot.lock().unwrap().last_used = Instant::now();
    }

    /// Free the model now (it's really freed once nobody is using it).
    pub fn unload(&self) {
        self.slot.lock().unwrap().loaded = None;
    }

    pub fn loaded_path(&self) -> Option<PathBuf> {
        self.slot.lock().unwrap().loaded.as_ref().map(|(p, _)| p.clone())
    }
}

fn reap<T>(slot: std::sync::Weak<Mutex<Slot<T>>>, keep: Duration) {
    loop {
        let wait = {
            let Some(slot) = slot.upgrade() else { return };
            let mut s = slot.lock().unwrap();
            let idle = s.last_used.elapsed();
            let in_use = s.loaded.as_ref().is_some_and(|(_, m)| Arc::strong_count(m) > 1);
            if s.loaded.is_none() || (idle >= keep && !in_use) {
                s.loaded = None;
                s.reaper = false;
                return;
            }
            if in_use {
                keep.min(Duration::from_millis(500))
            } else {
                keep - idle
            }
        };
        std::thread::sleep(wait.max(Duration::from_millis(20)));
    }
}

/// `min(4, cores)` threads for whisper.
pub fn threads() -> i32 {
    std::thread::available_parallelism().map(|n| n.get().min(4)).unwrap_or(2) as i32
}

/// The whisper build targets AVX2/FMA/F16C on x86-64 (see .cargo/config.toml).
/// On an older CPU it would crash, so voice is switched off there instead.
pub fn cpu_supported() -> bool {
    #[cfg(target_arch = "x86_64")]
    {
        std::arch::is_x86_feature_detected!("avx2")
            && std::arch::is_x86_feature_detected!("fma")
            && std::arch::is_x86_feature_detected!("f16c")
            && std::arch::is_x86_feature_detected!("bmi2")
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        true
    }
}

pub type Model = whisper_rs::WhisperContext;

pub fn load(path: &Path) -> Result<Model, String> {
    static QUIET: std::sync::Once = std::sync::Once::new();
    // whisper.cpp logs a lot to stderr; route it to nowhere.
    QUIET.call_once(whisper_rs::install_logging_hooks);
    // CPU only (no GPU backends are compiled in): small, predictable, works everywhere.
    whisper_rs::WhisperContext::new_with_params(path, whisper_rs::WhisperContextParameters::default())
        .map_err(|e| e.to_string())
}

/// The encoder window (whisper's `audio_ctx`) for `samples` of 16 kHz audio:
/// one position per 20 ms (320 samples) plus ~2.5 s of margin, rounded up to
/// 64, at most the full 30 s (1500). Measured on SAPI speech: base and
/// bigger are right from 256 up, but the `tiny` model mishears and loops
/// ("Elon Musk's cage cage cage...") below 768 (half the window), so it gets
/// at least that; tiny is fast enough for it not to matter.
pub fn audio_ctx(samples: usize, tiny: bool) -> i32 {
    let needed = samples.div_ceil(320) + 128;
    let min = if tiny { 768 } else { 384 };
    (needed.div_ceil(64) * 64).clamp(min, 1500) as i32
}

/// A cap on the tokens whisper may produce for `samples` of audio (people
/// say at most ~4 words a second, ~1.5 tokens per word): stops a rare
/// repetition loop from running for seconds.
pub fn max_tokens(samples: usize) -> i32 {
    (samples / 16_000 * 8 + 24) as i32
}

/// Run whisper on 16 kHz mono audio. `language`: `None` = detect.
/// Setting `abort` stops it early (returns an empty string).
pub fn transcribe(
    model: &Model,
    samples: &[f32],
    language: Option<&str>,
    abort: Arc<AtomicBool>,
) -> Result<String, String> {
    use whisper_rs::{FullParams, SamplingStrategy};
    let mut state = model.create_state().map_err(|e| e.to_string())?;
    let mut p = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    p.set_n_threads(threads());
    p.set_language(Some(language.unwrap_or("auto")));
    p.set_translate(false);
    p.set_no_context(true);
    p.set_no_timestamps(true);
    // whisper's encoder always works on a 30 s window; for a 2 s command
    // that's ~90 % wasted. Shrinking the window to the audio's length (plus
    // margin) makes a command ~5-10x faster on CPU at the same accuracy.
    // tiny has 4 encoder layers, base 6, small 12.
    p.set_audio_ctx(audio_ctx(samples.len(), model.model_n_audio_layer() <= 4));
    p.set_single_segment(true);
    p.set_max_tokens(max_tokens(samples.len()));
    p.set_suppress_blank(true);
    p.set_suppress_nst(true);
    p.set_print_special(false);
    p.set_print_progress(false);
    p.set_print_realtime(false);
    p.set_print_timestamps(false);
    // Not `set_abort_callback_safe`: in whisper-rs 0.16 its trampoline casts
    // the user data to the wrong type, so whisper.cpp reads garbage, aborts
    // the encoder and every transcription fails with error -6 ("failed to
    // encode"). A plain C callback reading our AtomicBool instead; `abort`
    // outlives the `full` call below, which is the only user of the pointer.
    unsafe extern "C" fn should_abort(user_data: *mut std::ffi::c_void) -> bool {
        // SAFETY: user_data is `&*abort` (an AtomicBool), alive for the call.
        unsafe { (*(user_data as *const AtomicBool)).load(Ordering::Relaxed) }
    }
    // SAFETY: see above; the pointer is only read during `state.full`.
    unsafe {
        p.set_abort_callback(Some(should_abort));
        p.set_abort_callback_user_data(Arc::as_ptr(&abort) as *mut std::ffi::c_void);
    }
    state.full(p, samples).map_err(|e| e.to_string())?;
    drop(abort);
    let mut text = String::new();
    for seg in state.as_iter() {
        if let Ok(s) = seg.to_str_lossy() {
            text.push_str(&s);
        }
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use super::*;

    static LIVE: AtomicUsize = AtomicUsize::new(0);

    /// Stands in for a whisper model; counts how many exist.
    struct Fake(#[allow(dead_code)] PathBuf);
    impl Fake {
        fn load(p: &Path) -> Result<Fake, String> {
            LIVE.fetch_add(1, Ordering::SeqCst);
            Ok(Fake(p.to_path_buf()))
        }
    }
    impl Drop for Fake {
        fn drop(&mut self) {
            LIVE.fetch_sub(1, Ordering::SeqCst);
        }
    }

    fn wait_until(f: impl Fn() -> bool) -> bool {
        let t = Instant::now();
        while t.elapsed() < Duration::from_secs(3) {
            if f() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        false
    }

    // One test so the global LIVE counter isn't shared between parallel tests.
    #[test]
    fn model_lifetime() {
        let keep = Duration::from_millis(150);
        let k: Keeper<Fake> = Keeper::new(keep);
        assert!(k.loaded_path().is_none());
        assert_eq!(LIVE.load(Ordering::SeqCst), 0);

        // Loaded once, reused while warm.
        let a = Path::new("/models/a.bin");
        let m1 = k.get(a, Fake::load).unwrap();
        let m2 = k.get(a, |_| panic!("should be reused")).unwrap();
        assert!(Arc::ptr_eq(&m1, &m2));
        drop((m1, m2));
        assert_eq!(LIVE.load(Ordering::SeqCst), 1);

        // Freed after the keep-alive, and the reaper thread goes away.
        assert!(wait_until(|| LIVE.load(Ordering::SeqCst) == 0));
        assert!(k.loaded_path().is_none());
        assert!(wait_until(|| !k.slot.lock().unwrap().reaper));

        // Never freed while in use, even past the keep-alive.
        let busy = k.get(a, Fake::load).unwrap();
        std::thread::sleep(keep * 3);
        assert_eq!(LIVE.load(Ordering::SeqCst), 1);
        drop(busy);
        k.touch();
        assert!(wait_until(|| LIVE.load(Ordering::SeqCst) == 0));

        // Switching models frees the old one first; unload() is immediate.
        let _x = k.get(a, Fake::load).unwrap();
        let b = Path::new("/models/b.bin");
        let y = k.get(b, Fake::load).unwrap();
        drop(_x);
        assert_eq!(LIVE.load(Ordering::SeqCst), 1);
        assert_eq!(k.loaded_path().as_deref(), Some(b));
        drop(y);
        k.unload();
        assert_eq!(LIVE.load(Ordering::SeqCst), 0);

        // A failed load leaves nothing behind.
        assert!(k.get(a, |_| Err("broken file".into())).is_err());
        assert!(k.loaded_path().is_none());
    }

    /// Real whisper.cpp, if a model file is given:
    /// `GLITCH_TEST_WHISPER_MODEL=/path/ggml-tiny.bin cargo test -p glitch real_whisper -- --nocapture`
    #[test]
    fn real_whisper_if_available() {
        let Ok(path) = std::env::var("GLITCH_TEST_WHISPER_MODEL") else { return };
        let k: Keeper<Model> = Keeper::new(Duration::from_millis(100));
        let t = Instant::now();
        let model = k.get(Path::new(&path), load).expect("model loads");
        eprintln!("loaded in {:?}", t.elapsed());
        // 2 s of a 220 Hz hum: whisper must run and return *something* (or nothing).
        let hum: Vec<f32> =
            (0..32_000).map(|i| 0.3 * (i as f32 * 220.0 * std::f32::consts::TAU / 16_000.0).sin()).collect();
        let t = Instant::now();
        let text = transcribe(&model, &hum, None, Arc::default()).expect("transcribes");
        eprintln!("transcribed in {:?}: {text:?}", t.elapsed());
        // Abort works.
        let abort = Arc::new(AtomicBool::new(true));
        let _ = transcribe(&model, &hum, Some("en"), abort);
        drop(model);
        k.touch();
        let t = Instant::now();
        while k.loaded_path().is_some() && t.elapsed() < Duration::from_secs(3) {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(k.loaded_path().is_none(), "model freed after keep-alive");
    }

    #[test]
    fn encoder_window() {
        // Short commands: a small window; tiny at least half.
        assert_eq!(audio_ctx(0, false), 384);
        assert_eq!(audio_ctx(32_000, false), 384);
        assert_eq!(audio_ctx(32_000, true), 768);
        // 10 s: 500 positions + margin.
        assert_eq!(audio_ctx(16_000 * 10, false), 640);
        // 20 s: 1000 positions + margin.
        assert_eq!(audio_ctx(16_000 * 20, true), 1152);
        for tiny in [false, true] {
            let ctx = |s: usize| audio_ctx(s * 16_000, tiny);
            assert!((1..28).all(|s| ctx(s) as usize >= s * 50 + 100));
            // Long recordings get the full window, never more.
            assert_eq!(ctx(30), 1500);
            assert_eq!(ctx(60), 1500);
            assert!((0..40).all(|s| ctx(s) % 64 == 0 || ctx(s) == 1500));
        }
    }

    #[test]
    fn token_cap() {
        // "Open Twitter on Elon Musk's page." is ~10 tokens in 2.6 s.
        assert!(max_tokens(41_600) >= 30);
        assert_eq!(max_tokens(16_000 * 30), 264);
    }

    #[test]
    fn thread_count() {
        assert!((1..=4).contains(&threads()));
    }
}
