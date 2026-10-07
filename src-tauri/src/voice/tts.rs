//! Glitch's own read-aloud voice: Piper (a small local neural TTS program)
//! plus a pitch shift, played through the speakers with cpal.
//!
//! Opt-in: nothing is downloaded until the user picks "Glitch" as the
//! read-aloud voice (Settings → Features). Until then, and whenever this
//! fails, the bubble reads with the system voice as before.
//!
//! Latency: Piper loads its voice in ~0.5 s (4 s the very first time, while
//! Windows scans the new files). So when a message is sent, a Piper process
//! is started *on standby* ([`prepare`]): it loads while the model thinks
//! and waits for text. The first sentence is then heard ~0.1 s after the
//! reply arrives; the rest is synthesized while the first one plays.
//!
//! While audio plays the mascot gets "mascot-talk" pulses (mouth moving)
//! and the wake word plugs its ears.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use glitch_core::voice::tts::{self as core, Asset, Resampler};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::download::{self, DownloadError, Expected};
use super::VoiceState;
use crate::state::AppState;

/// A standby Piper that nobody used is stopped after this long.
const STANDBY_FOR: Duration = Duration::from_secs(90);

struct Standby {
    child: Child,
    stdin: ChildStdin,
    since: Instant,
}

/// One reply being read aloud.
struct Playback {
    stop: AtomicBool,
    child: Mutex<Option<Child>>,
}

pub struct TtsState {
    dir: PathBuf,
    standby: Mutex<Option<Standby>>,
    playing: Mutex<Option<Arc<Playback>>>,
    /// Download in progress: (cancel flag, done, total).
    download: Mutex<Option<(Arc<AtomicBool>, u64, u64)>>,
    /// Time to first audio of the last reply (ms), for the live check.
    pub last_first_audio_ms: AtomicU64,
}

impl TtsState {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            standby: Mutex::default(),
            playing: Mutex::default(),
            download: Mutex::default(),
            last_first_audio_ms: AtomicU64::new(0),
        }
    }

    fn exe(&self) -> PathBuf {
        self.dir.join("piper").join(if cfg!(windows) { "piper.exe" } else { "piper" })
    }

    fn voice(&self) -> PathBuf {
        self.dir.join(core::VOICE.file)
    }

    fn present(&self, a: &Asset) -> bool {
        if a.id == "engine" {
            self.exe().is_file()
        } else {
            self.dir.join(a.file).is_file()
        }
    }

    /// Everything downloaded (and this platform supported).
    pub fn installed(&self) -> bool {
        core::assets().is_some_and(|all| all.iter().all(|a| self.present(a)))
    }
}

/// Spawn Piper waiting for text on stdin; raw 16-bit mono PCM on stdout.
fn spawn_piper(ts: &TtsState) -> std::io::Result<Child> {
    let exe = ts.exe();
    let mut cmd = Command::new(&exe);
    cmd.arg("--model")
        .arg(ts.voice())
        .arg("--output_raw")
        .arg("--quiet")
        .arg("--length_scale")
        .arg(format!("{:.3}", core::length_scale()))
        .arg("--sentence_silence")
        .arg("0.15")
        .current_dir(exe.parent().unwrap_or(Path::new(".")))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
}

/// The voice's sample rate (from its .json; 22050 for "medium" voices).
fn voice_rate(ts: &TtsState) -> u32 {
    std::fs::read_to_string(ts.dir.join(core::VOICE_CONFIG.file))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v["audio"]["sample_rate"].as_u64())
        .map_or(22_050, |r| r as u32)
}

fn wants_glitch_voice(app: &AppHandle) -> bool {
    let v = app.state::<AppState>().settings().voice;
    v.speak_replies && v.read_aloud_voice == "glitch"
}

/// A message was sent and the reply may be read aloud: start Piper now so
/// its voice is loaded by the time the reply arrives.
pub fn prepare(app: &AppHandle) {
    let vs = app.state::<VoiceState>();
    let ts = &vs.tts;
    if !wants_glitch_voice(app) || !ts.installed() {
        return;
    }
    let mut sb = ts.standby.lock().unwrap();
    if let Some(s) = sb.as_mut() {
        if s.since.elapsed() < STANDBY_FOR && matches!(s.child.try_wait(), Ok(None)) {
            s.since = Instant::now();
            return;
        }
        let _ = s.child.kill();
        *sb = None;
    }
    let Ok(mut child) = spawn_piper(ts) else { return };
    let Some(stdin) = child.stdin.take() else { return };
    *sb = Some(Standby { child, stdin, since: Instant::now() });
    drop(sb);
    // Stop it if the reply never comes (or is read with the system voice).
    let app = app.clone();
    let _ = std::thread::Builder::new().name("glitch-tts-standby".into()).spawn(move || {
        std::thread::sleep(STANDBY_FOR + Duration::from_secs(1));
        let vs = app.state::<VoiceState>();
        let mut sb = vs.tts.standby.lock().unwrap();
        if sb.as_ref().is_some_and(|s| s.since.elapsed() >= STANDBY_FOR) {
            if let Some(mut s) = sb.take() {
                let _ = s.child.kill();
                let _ = s.child.wait();
            }
        }
    });
}

#[derive(Serialize, Clone)]
struct TtsEvent {
    /// "playing" | "done"
    state: &'static str,
    first_audio_ms: Option<u64>,
}

/// Read `text` aloud with Glitch's voice. Returns once it started (audio
/// follows in the background); an error means "use the system voice".
pub fn speak(app: &AppHandle, text: &str) -> Result<(), String> {
    let vs = app.state::<VoiceState>();
    if !vs.tts.installed() {
        return Err("the character voice isn't downloaded".into());
    }
    let lines = core::lines(text);
    if lines.is_empty() {
        return Ok(());
    }
    stop(app);
    let t0 = Instant::now();
    let mut standby = vs.tts.standby.lock().unwrap().take();
    if let Some(s) = standby.as_mut() {
        if !matches!(s.child.try_wait(), Ok(None)) {
            standby = None; // it died: start a fresh one
        }
    }
    let (mut child, mut stdin) = match standby {
        Some(s) => (s.child, s.stdin),
        other => {
            if let Some(mut s) = other {
                let _ = s.child.kill();
            }
            let mut c = spawn_piper(&vs.tts).map_err(|e| format!("couldn't start the voice ({e})"))?;
            let i = c.stdin.take().ok_or("no stdin")?;
            (c, i)
        }
    };
    let mut input = lines.join("\n");
    input.push('\n');
    if let Err(e) = stdin.write_all(input.as_bytes()) {
        let _ = child.kill();
        return Err(format!("the voice program stopped ({e})"));
    }
    drop(stdin); // EOF: Piper reads all lines, then exits when done
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let pb = Arc::new(Playback { stop: AtomicBool::new(false), child: Mutex::new(Some(child)) });
    *vs.tts.playing.lock().unwrap() = Some(pb.clone());
    let rate = voice_rate(&vs.tts);
    let app = app.clone();
    std::thread::Builder::new()
        .name("glitch-tts".into())
        .spawn(move || play(&app, &pb, stdout, rate, t0))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Stop reading aloud now.
pub fn stop(app: &AppHandle) {
    let vs = app.state::<VoiceState>();
    let pb = vs.tts.playing.lock().unwrap().take();
    if let Some(pb) = pb {
        pb.stop.store(true, Ordering::SeqCst);
        if let Some(mut c) = pb.child.lock().unwrap().take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

/// Audio thread side: what's left to play (mono, at the output rate).
type Queue = Arc<Mutex<VecDeque<f32>>>;

fn play(app: &AppHandle, pb: &Arc<Playback>, mut stdout: std::process::ChildStdout, rate: u32, t0: Instant) {
    let vs = app.state::<VoiceState>();
    let queue: Queue = Arc::default();
    let out = match output::open(queue.clone()) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("glitch: no speakers for the voice: {e}");
            finish(app, pb);
            return;
        }
    };
    let out_rate = out.rate;
    // Reader: Piper's stdout → f32 → pitch + resample → queue.
    let reading = Arc::new(AtomicBool::new(true));
    let first = Arc::new(Mutex::new(None::<Duration>));
    let (q2, r2, f2, pb2) = (queue.clone(), reading.clone(), first.clone(), pb.clone());
    let reader = std::thread::Builder::new().name("glitch-tts-read".into()).spawn(move || {
        let mut rs = Resampler::new(rate, out_rate, core::PITCH);
        let mut buf = vec![0u8; 8192];
        let mut carry: Option<u8> = None;
        let (mut pcm, mut res) = (Vec::new(), Vec::new());
        loop {
            if pb2.stop.load(Ordering::SeqCst) {
                break;
            }
            let n = match stdout.read(&mut buf[1..]) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            let bytes = match carry.take() {
                Some(b) => {
                    buf[0] = b;
                    &buf[..n + 1]
                }
                None => &buf[1..n + 1],
            };
            pcm.clear();
            carry = core::pcm16_to_f32(bytes, &mut pcm);
            res.clear();
            rs.process(&pcm, &mut res);
            f2.lock().unwrap().get_or_insert_with(|| t0.elapsed());
            q2.lock().unwrap().extend(res.iter().copied());
        }
        r2.store(false, Ordering::SeqCst);
    });
    if reader.is_err() {
        finish(app, pb);
        return;
    }

    let mut started = false;
    let mut last_pulse = Instant::now() - Duration::from_secs(5);
    let mut drained_at: Option<Instant> = None;
    loop {
        if pb.stop.load(Ordering::SeqCst) {
            queue.lock().unwrap().clear();
            break;
        }
        let left = queue.lock().unwrap().len();
        if left > 0 && !started {
            started = true;
            vs.speaking.store(true, Ordering::SeqCst);
            let ms = first.lock().unwrap().map(|d| d.as_millis() as u64);
            if let Some(ms) = ms {
                vs.tts.last_first_audio_ms.store(ms, Ordering::SeqCst);
                if cfg!(debug_assertions) {
                    eprintln!("glitch: character voice: first audio after {ms} ms");
                }
            }
            let _ = app.emit("tts", TtsEvent { state: "playing", first_audio_ms: ms });
        }
        if started && last_pulse.elapsed() >= Duration::from_millis(900) {
            // Keep the mouth moving a little past what's queued (more is
            // usually on its way while Piper reads the next sentence).
            last_pulse = Instant::now();
            let left_ms = left as u64 * 1000 / out_rate.max(1) as u64;
            let more = if reading.load(Ordering::SeqCst) { 1_500 } else { 300 };
            let _ = app.emit(crate::voice::tts::MASCOT_TALK_EVENT, core::talk_chars(left_ms + more));
        }
        if left == 0 && !reading.load(Ordering::SeqCst) {
            // Let the device play out its last buffer.
            let at = *drained_at.get_or_insert_with(Instant::now);
            if at.elapsed() >= Duration::from_millis(150) {
                break;
            }
        } else {
            drained_at = None;
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    drop(out);
    finish(app, pb);
}

/// Same name as the TypeScript constant `MASCOT_TALK_EVENT`.
pub const MASCOT_TALK_EVENT: &str = "mascot-talk";

fn finish(app: &AppHandle, pb: &Arc<Playback>) {
    let vs = app.state::<VoiceState>();
    if let Some(mut c) = pb.child.lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    {
        let mut playing = vs.tts.playing.lock().unwrap();
        if playing.as_ref().is_some_and(|p| Arc::ptr_eq(p, pb)) {
            *playing = None;
        }
    }
    if vs.speaking.swap(false, Ordering::SeqCst) {
        super::wake::quiet_for_a_moment(&vs);
    }
    let _ = app.emit("tts", TtsEvent { state: "done", first_audio_ms: None });
}

// ------------------------------------------------------------ download

#[derive(Serialize, Clone)]
pub struct TtsStatus {
    /// This platform has a Piper build (Windows x64).
    pub supported: bool,
    pub installed: bool,
    pub size_mb: u64,
    /// (done, total) bytes while downloading.
    pub download: Option<(u64, u64)>,
    pub playing: bool,
}

pub fn status(app: &AppHandle) -> TtsStatus {
    let vs = app.state::<VoiceState>();
    let ts = &vs.tts;
    let download = ts.download.lock().unwrap().as_ref().map(|(_, d, t)| (*d, *t));
    let playing = ts.playing.lock().unwrap().is_some();
    TtsStatus {
        supported: core::assets().is_some(),
        installed: ts.installed(),
        size_mb: core::assets().map_or(0, |a| core::download_mb(&a)),
        download,
        playing,
    }
}

/// "tts-download" event payload.
#[derive(Serialize, Clone)]
struct DownloadEvent {
    /// "running" | "done" | "failed" | "cancelled"
    state: &'static str,
    done: u64,
    total: u64,
    error: Option<String>,
    code: Option<&'static str>,
}

/// Download (or finish downloading) Piper and the voice. Progress as
/// "tts-download" events.
pub async fn download_all(app: &AppHandle) -> Result<(), DownloadError> {
    let Some(assets) = core::assets() else {
        return Err(DownloadError::Disk("not available on this system".into()));
    };
    let vs = app.state::<VoiceState>();
    let ts = &vs.tts;
    let total: u64 = assets.iter().map(|a| a.size_bytes).sum();
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut d = ts.download.lock().unwrap();
        if d.is_some() {
            return Ok(());
        }
        *d = Some((cancel.clone(), 0, total));
    }
    let send = |state: &'static str, done: u64, err: Option<&DownloadError>| {
        let _ = app.emit(
            "tts-download",
            DownloadEvent { state, done, total, error: err.map(|e| e.to_string()), code: err.map(|e| e.code()) },
        );
    };
    send("running", 0, None);
    let client = download::client();
    let mut before = 0u64;
    let mut result = Ok(());
    for a in assets {
        if ts.present(&a) {
            before += a.size_bytes;
            continue;
        }
        let dest = ts.dir.join(a.file);
        let mut last = Instant::now() - Duration::from_secs(1);
        let r = download::download(
            &client,
            &url(&a),
            &dest,
            &Expected { sha1: a.sha1, size: a.size_bytes },
            &cancel,
            |done, _| {
                if last.elapsed() >= Duration::from_millis(200) {
                    last = Instant::now();
                    if let Some(d) = ts.download.lock().unwrap().as_mut() {
                        d.1 = before + done;
                    }
                    send("running", before + done, None);
                }
            },
        )
        .await;
        if let Err(e) = r {
            result = Err(e);
            break;
        }
        if a.id == "engine" {
            if let Err(e) = unpack(&dest, &ts.dir).await {
                result = Err(DownloadError::Disk(e));
                break;
            }
        }
        before += a.size_bytes;
    }
    *ts.download.lock().unwrap() = None;
    match &result {
        Ok(()) => send("done", total, None),
        Err(DownloadError::Cancelled) => send("cancelled", before, result.as_ref().err()),
        Err(e) => send("failed", before, Some(e)),
    }
    result
}

/// Where a file comes from. `GLITCH_TTS_URL` points every file at a mirror
/// or a local test server (`<base>/<file>`).
fn url(a: &Asset) -> String {
    match std::env::var("GLITCH_TTS_URL") {
        Ok(base) => format!("{}/{}", base.trim_end_matches('/'), a.file),
        Err(_) => a.url.to_string(),
    }
}

pub fn cancel_download(app: &AppHandle) {
    if let Some((c, _, _)) = app.state::<VoiceState>().tts.download.lock().unwrap().as_ref() {
        c.store(true, Ordering::SeqCst);
    }
}

/// Unpack the Piper zip into `dir/piper` (via a temporary folder, so a
/// `piper/piper.exe` that exists is always complete), then delete the zip.
/// Uses the `tar` that ships with Windows 10+ (bsdtar reads zip files).
async fn unpack(zip: &Path, dir: &Path) -> Result<(), String> {
    let tmp = dir.join("piper.unpacking");
    let _ = tokio::fs::remove_dir_all(&tmp).await;
    tokio::fs::create_dir_all(&tmp).await.map_err(|e| e.to_string())?;
    let tar = std::env::var_os("SystemRoot")
        .map(|r| PathBuf::from(r).join("System32").join("tar.exe"))
        .filter(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from("tar"));
    let mut cmd = Command::new(tar);
    cmd.arg("-xf").arg(zip).arg("-C").arg(&tmp).stdout(Stdio::null()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = tokio::task::spawn_blocking(move || cmd.output()).await.map_err(|e| e.to_string())?;
    let out = out.map_err(|e| format!("couldn't unpack the voice program ({e})"))?;
    if !out.status.success() {
        return Err(format!("couldn't unpack the voice program ({})", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let unpacked = tmp.join("piper");
    if !unpacked.join(if cfg!(windows) { "piper.exe" } else { "piper" }).is_file() {
        return Err("the voice program archive looks wrong".into());
    }
    let target = dir.join("piper");
    let _ = tokio::fs::remove_dir_all(&target).await;
    tokio::fs::rename(&unpacked, &target).await.map_err(|e| e.to_string())?;
    let _ = tokio::fs::remove_dir_all(&tmp).await;
    let _ = tokio::fs::remove_file(zip).await;
    Ok(())
}

/// Delete everything (Settings → "Remove voice").
pub fn delete(app: &AppHandle) -> Result<(), String> {
    stop(app);
    let vs = app.state::<VoiceState>();
    if vs.tts.download.lock().unwrap().is_some() {
        return Err("the voice is downloading right now".into());
    }
    if let Some(mut s) = vs.tts.standby.lock().unwrap().take() {
        let _ = s.child.kill();
        let _ = s.child.wait();
    }
    match std::fs::remove_dir_all(&vs.tts.dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// The speakers, via cpal: plays whatever is in the queue, silence when
/// it's empty. Dropping it closes the stream.
mod output {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    pub use imp::open;

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    mod imp {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
        use cpal::{FromSample, SampleFormat, SizedSample};

        use super::super::Queue;

        pub struct Output {
            _stream: cpal::Stream,
            pub rate: u32,
        }

        pub fn open(queue: Queue) -> Result<Output, String> {
            let host = cpal::default_host();
            let device = host.default_output_device().ok_or("no speakers found")?;
            let supported = device.default_output_config().map_err(|e| e.to_string())?;
            let channels = supported.channels() as usize;
            let rate = supported.sample_rate();
            let config = supported.config();
            let stream = match supported.sample_format() {
                SampleFormat::F32 => build::<f32>(&device, config, channels, queue),
                SampleFormat::I16 => build::<i16>(&device, config, channels, queue),
                SampleFormat::I32 => build::<i32>(&device, config, channels, queue),
                SampleFormat::U16 => build::<u16>(&device, config, channels, queue),
                other => return Err(format!("unsupported speaker format {other}")),
            }
            .map_err(|e| e.to_string())?;
            stream.play().map_err(|e| e.to_string())?;
            Ok(Output { _stream: stream, rate })
        }

        fn build<T>(
            device: &cpal::Device,
            config: cpal::StreamConfig,
            channels: usize,
            queue: Queue,
        ) -> Result<cpal::Stream, cpal::Error>
        where
            T: SizedSample + FromSample<f32>,
        {
            device.build_output_stream::<T, _, _>(
                config,
                move |data: &mut [T], _: &cpal::OutputCallbackInfo| {
                    let mut q = queue.lock().unwrap();
                    for frame in data.chunks_mut(channels.max(1)) {
                        let s = q.pop_front().unwrap_or(0.0).clamp(-1.0, 1.0);
                        for out in frame {
                            *out = T::from_sample(s);
                        }
                    }
                },
                |_e| {},
                None,
            )
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    pub fn open(_queue: super::Queue) -> Result<Output, String> {
        Err("no audio output on this system".into())
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    pub struct Output {
        pub rate: u32,
    }
}

#[cfg(test)]
pub fn spawn_piper_for_test(ts: &TtsState) -> std::io::Result<Child> {
    spawn_piper(ts)
}

#[cfg(test)]
pub fn open_output_for_test() -> Result<u32, String> {
    output::open(Queue::default()).map(|o| o.rate)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_installed_in_an_empty_folder() {
        let dir = tempfile::tempdir().unwrap();
        let ts = TtsState::new(dir.path().to_path_buf());
        assert!(!ts.installed());
        assert_eq!(voice_rate(&ts), 22_050);
        std::fs::write(dir.path().join(core::VOICE_CONFIG.file), r#"{"audio":{"sample_rate":16000}}"#).unwrap();
        assert_eq!(voice_rate(&ts), 16_000);
        if core::assets().is_some() {
            std::fs::create_dir_all(dir.path().join("piper")).unwrap();
            std::fs::write(ts.exe(), b"").unwrap();
            std::fs::write(ts.voice(), b"").unwrap();
            assert!(ts.installed());
        }
    }

    #[test]
    fn mirror_url() {
        // Only this test sets the variable.
        assert!(url(&core::VOICE).starts_with("https://huggingface.co/"));
    }
}
