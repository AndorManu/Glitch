//! Live check of app control against a REAL window with the REAL native
//! Hands (UI Automation, focus, typing) and a REAL Ollama model:
//! "open notepad and type hello", N times, each against a fresh classic
//! Notepad stand-in that this test starts itself (examples/fake_notepad.rs,
//! copied as notepad.exe into a temp folder, with its own temp file).
//!
//! It can never touch the user's own apps: `GLITCH_HANDS_ONLY_PIDS` limits
//! Glitch to the one process this test started, and that process is killed
//! by its own handle after each run.
//!
//!   cargo build -p glitch --example fake_notepad
//!   cargo test -p glitch hands_live -- --ignored --nocapture
//!   (GLITCH_LIVE_MODEL=qwen2.5:7b, GLITCH_LIVE_RUNS=5)

use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use glitch_core::agent::{Agent, Progress, Step};
use glitch_core::ai::ollama::OllamaClient;
use glitch_core::ai::AiProvider;
use glitch_core::platform::{AppEntry, Platform};

use crate::hands::NativeHands;

struct LivePlatform {
    exe: PathBuf,
    file: PathBuf,
    child: Mutex<Option<Child>>,
}

impl Platform for LivePlatform {
    fn open_url(&self, url: &str) -> io::Result<()> {
        eprintln!("  (not opening {url})");
        Ok(())
    }
    fn open_path(&self, _: &Path) -> io::Result<()> {
        Ok(())
    }
    fn launch_app(&self, app: &AppEntry) -> io::Result<()> {
        assert_eq!(app.name, "Notepad", "the test only knows Notepad");
        let mut c = self.child.lock().unwrap();
        if c.is_none() {
            let child = Command::new(&self.exe).arg(&self.file).spawn()?;
            // From now on Glitch may see (only) this process.
            std::env::set_var("GLITCH_HANDS_ONLY_PIDS", child.id().to_string());
            *c = Some(child);
        }
        Ok(())
    }
    fn installed_apps(&self) -> Vec<AppEntry> {
        vec![AppEntry { name: "Notepad".into(), launch_path: self.exe.clone() }]
    }
    fn search_roots(&self) -> Vec<PathBuf> {
        vec![]
    }
    fn home_dir(&self) -> Option<PathBuf> {
        None
    }
}

/// The text in the stand-in's EDIT control.
fn edit_text(pid: u32) -> Option<String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        FindWindowExW, FindWindowW, GetWindowThreadProcessId, SendMessageTimeoutW, SMTO_ABORTIFHUNG, WM_GETTEXT,
    };
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    unsafe {
        let mut win = FindWindowW(wide("Notepad").as_ptr(), std::ptr::null());
        // The first "Notepad" class window of OUR process.
        let mut tries = 0;
        while !win.is_null() && tries < 50 {
            let mut p = 0u32;
            GetWindowThreadProcessId(win, &mut p);
            if p == pid {
                break;
            }
            win = FindWindowExW(std::ptr::null_mut(), win, wide("Notepad").as_ptr(), std::ptr::null());
            tries += 1;
        }
        if win.is_null() {
            return None;
        }
        let edit = FindWindowExW(win, std::ptr::null_mut(), wide("Edit").as_ptr(), std::ptr::null());
        let mut buf = vec![0u16; 4096];
        let mut n = 0usize;
        SendMessageTimeoutW(edit, WM_GETTEXT, buf.len(), buf.as_mut_ptr() as isize, SMTO_ABORTIFHUNG, 2000, &mut n);
        Some(String::from_utf16_lossy(&buf[..n]))
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "live: needs Ollama and a desktop; see the module docs"]
async fn hands_live_notepad_type_hello() {
    let model = std::env::var("GLITCH_LIVE_MODEL").unwrap_or_else(|_| "qwen3.5:4b".into());
    let runs: usize = std::env::var("GLITCH_LIVE_RUNS").ok().and_then(|r| r.parse().ok()).unwrap_or(5);
    let deps = std::env::current_exe().unwrap();
    let fake = deps.parent().unwrap().parent().unwrap().join("examples").join("fake_notepad.exe");
    assert!(fake.exists(), "build it first: cargo build -p glitch --example fake_notepad ({})", fake.display());
    let dir = tempfile::Builder::new().prefix("glitch-hands-live-").tempdir().unwrap();
    let exe = dir.path().join("notepad.exe");
    std::fs::copy(&fake, &exe).unwrap();
    // Nothing is visible to Glitch until the test's own process exists.
    std::env::set_var("GLITCH_HANDS_ONLY_PIDS", "0");

    let ollama = Arc::new(OllamaClient::new("http://127.0.0.1:11434", "5m"));
    let _ = ollama.warm_up(&model, "5m").await;
    let mut passes = 0;
    for run in 1..=runs {
        let file = dir.path().join(format!("glitch-hands-{run}.txt"));
        std::fs::write(&file, "").unwrap();
        let platform = Arc::new(LivePlatform { exe: exe.clone(), file, child: Mutex::new(None) });
        let mut agent = Agent::new(ollama.clone(), platform.clone());
        agent.set_hands(Some(NativeHands::new(None, false)));
        let steps = Arc::new(Mutex::new(Vec::<String>::new()));
        let s2 = steps.clone();
        agent.set_progress(Some(Arc::new(move |p| {
            if let Progress::Step { label, .. } = p {
                s2.lock().unwrap().push(label);
            }
        })));
        let t0 = Instant::now();
        let mut confirms = Vec::new();
        let mut step = agent.send(&model, "open notepad and type hello").await;
        while let Ok(Step::Confirm { id, title, .. }) = &step {
            if confirms.len() >= 6 {
                break;
            }
            confirms.push(title.clone());
            step = agent.confirm(&model, &id.clone(), true).await;
        }
        let ms = t0.elapsed().as_millis();
        let reply = match &step {
            Ok(Step::Reply { text, .. }) => text.clone(),
            Ok(Step::Confirm { title, .. }) => format!("(still asking: {title})"),
            Err(e) => format!("(error: {e})"),
        };
        let child = platform.child.lock().unwrap().take();
        let text = child.as_ref().and_then(|c| edit_text(c.id())).unwrap_or_default();
        let ok = text.trim().eq_ignore_ascii_case("hello");
        passes += ok as usize;
        println!(
            "{} run {run}  {ms:>6} ms  typed {text:?}  cards {confirms:?}\n      steps {:?}\n      \u{201c}{reply}\u{201d}",
            if ok { "PASS" } else { "FAIL" },
            steps.lock().unwrap()
        );
        if let Some(mut c) = child {
            let _ = c.kill();
            let _ = c.wait();
        }
        std::env::set_var("GLITCH_HANDS_ONLY_PIDS", "0");
    }
    println!("notepad (real window, {model}): {passes}/{runs}");
    assert!(passes > 0, "no run passed");
}
