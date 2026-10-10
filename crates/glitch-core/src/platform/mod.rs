//! The ONLY place where Windows and macOS behave differently.
//!
//! What differs per OS:
//! * where installed apps live and what an "app" file is
//!   (Windows: Start Menu `.lnk` shortcuts, macOS: `.app` bundles)
//! * where Ollama gets installed and how to start it
//!
//! What is shared: opening URLs/files with the default handler (the `open`
//! crate wraps `ShellExecuteW` on Windows and `/usr/bin/open` on macOS) and the
//! user's standard folders (the `dirs` crate uses Known Folder IDs on Windows,
//! so OneDrive-redirected Desktop/Documents work).
//!
//! The per-OS modules are compiled on every OS (they only contain path logic),
//! so their unit tests run in CI on Linux too. [`SystemPlatform`] picks the
//! right one with `cfg!`.

pub mod linux;
pub mod macos;
pub mod windows;

use std::io;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppEntry {
    /// Display name, e.g. "Spotify".
    pub name: String,
    /// What gets opened to launch it (`.lnk` on Windows, `.app` on macOS).
    pub launch_path: PathBuf,
}

/// Side effects the tools need. Tests use a fake implementation.
pub trait Platform: Send + Sync {
    fn open_url(&self, url: &str) -> io::Result<()>;
    /// Open an (already validated) file or folder with its default app.
    fn open_path(&self, path: &Path) -> io::Result<()>;
    fn launch_app(&self, app: &AppEntry) -> io::Result<()>;
    fn installed_apps(&self) -> Vec<AppEntry>;
    /// Folders `search_files` looks in.
    fn search_roots(&self) -> Vec<PathBuf>;
    fn home_dir(&self) -> Option<PathBuf>;
    /// The addresses a host name points to (DNS), to tell whether a web page
    /// is really on the local network. Blocking; may take a few seconds.
    fn resolve_host(&self, host: &str) -> io::Result<Vec<IpAddr>> {
        use std::net::ToSocketAddrs;
        Ok((host, 443).to_socket_addrs()?.map(|a| a.ip()).collect())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Windows,
    MacOs,
    Linux,
}

impl Os {
    pub const fn current() -> Os {
        if cfg!(target_os = "windows") {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::MacOs
        } else {
            Os::Linux
        }
    }
}

/// The real platform.
#[derive(Default)]
pub struct SystemPlatform;

impl Platform for SystemPlatform {
    fn open_url(&self, url: &str) -> io::Result<()> {
        open::that_detached(url)
    }

    fn open_path(&self, path: &Path) -> io::Result<()> {
        open::that_detached(path)
    }

    fn launch_app(&self, app: &AppEntry) -> io::Result<()> {
        // Packaged Windows apps (Calculator, Photos, Store apps).
        if let Some(id) = windows::packaged_app_id(&app.launch_path) {
            return Command::new("explorer.exe")
                .arg(format!("{}{id}", windows::APPS_FOLDER_PREFIX))
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map(|_| ());
        }
        // Opening a .lnk (Windows) or .app bundle (macOS) launches the app.
        open::that_detached(&app.launch_path)
    }

    fn installed_apps(&self) -> Vec<AppEntry> {
        match Os::current() {
            Os::Windows => {
                windows::merge_apps(windows::installed_apps(&windows::start_menu_dirs()), packaged_windows_apps())
            }
            Os::MacOs => macos::installed_apps(&macos::app_dirs(dirs::home_dir().as_deref())),
            Os::Linux => linux::installed_apps(),
        }
    }

    fn search_roots(&self) -> Vec<PathBuf> {
        standard_user_folders()
    }

    fn home_dir(&self) -> Option<PathBuf> {
        dirs::home_dir()
    }
}

/// Packaged Windows apps via PowerShell's `Get-StartApps` (~0.7 s), cached
/// for a few minutes so a chat doesn't pay that on every `open_app`. Empty
/// on other OSes or if PowerShell fails (the shortcut scan still works).
fn packaged_windows_apps() -> Vec<AppEntry> {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    const TTL: Duration = Duration::from_secs(300);
    static CACHE: Mutex<Option<(Instant, Vec<AppEntry>)>> = Mutex::new(None);
    if !cfg!(target_os = "windows") {
        return Vec::new();
    }
    if let Some((at, apps)) = &*CACHE.lock().unwrap() {
        if at.elapsed() < TTL {
            return apps.clone();
        }
    }
    let mut cmd = Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        windows::PACKAGED_APPS_SCRIPT,
    ])
    .stdin(Stdio::null())
    .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let apps = match cmd.output() {
        Ok(out) if out.status.success() => windows::parse_packaged_apps(&String::from_utf8_lossy(&out.stdout)),
        _ => Vec::new(),
    };
    *CACHE.lock().unwrap() = Some((Instant::now(), apps.clone()));
    apps
}

/// Desktop, Documents, Downloads, Pictures, Music, Videos/Movies (the ones that exist).
pub fn standard_user_folders() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = [
        dirs::desktop_dir(),
        dirs::document_dir(),
        dirs::download_dir(),
        dirs::picture_dir(),
        dirs::audio_dir(),
        dirs::video_dir(),
    ]
    .into_iter()
    .flatten()
    .filter(|p| p.is_dir())
    .collect();
    v.dedup();
    v
}

// ---------------------------------------------------------------- Ollama ---

/// Where Ollama was found on this machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum OllamaInstall {
    /// The desktop app (starts the server and shows a tray/menu-bar icon).
    App(PathBuf),
    /// Only the command-line binary (e.g. Homebrew); start with `ollama serve`.
    Cli(PathBuf),
}

pub fn find_ollama() -> Option<OllamaInstall> {
    let path_dirs: Vec<PathBuf> =
        std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    let candidates = match Os::current() {
        Os::Windows => windows::ollama_candidates(dirs::data_local_dir().as_deref(), &path_dirs),
        Os::MacOs => macos::ollama_candidates(dirs::home_dir().as_deref(), &path_dirs),
        Os::Linux => linux::ollama_candidates(&path_dirs),
    };
    candidates.into_iter().find(|c| match c {
        OllamaInstall::App(p) | OllamaInstall::Cli(p) => p.exists(),
    })
}

/// Start Ollama in the background. Only ever called because the user clicked
/// "Start Ollama" in the setup wizard; the AI model has no way to call this.
pub fn start_ollama(install: &OllamaInstall) -> io::Result<()> {
    match install {
        OllamaInstall::App(p) => open::that_detached(p),
        OllamaInstall::Cli(p) => {
            let mut cmd = Command::new(p);
            cmd.arg("serve").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }
            cmd.spawn().map(|_| ())
        }
    }
}

pub fn ollama_download_url() -> &'static str {
    match Os::current() {
        Os::Windows => "https://ollama.com/download/windows",
        Os::MacOs => "https://ollama.com/download/mac",
        Os::Linux => "https://ollama.com/download/linux",
    }
}

/// Lower-case, alphanumerics only: "Microsoft Word 2021" → "microsoftword2021".
pub(crate) fn normalise_name(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// Remove duplicates (same app in the per-user and all-users Start Menu, etc.)
/// and sort by name.
pub(crate) fn dedupe_apps(mut apps: Vec<AppEntry>) -> Vec<AppEntry> {
    apps.sort_by_key(|a| a.name.to_lowercase());
    apps.dedup_by(|a, b| normalise_name(&a.name) == normalise_name(&b.name));
    apps
}

#[cfg(all(test, target_os = "windows"))]
mod windows_live_tests {
    use super::*;

    /// Runs the real `Get-StartApps` query. Hosted CI images may lack the
    /// inbox apps, so only the shape is checked; on a desktop Windows 11
    /// this finds Calculator.
    #[test]
    fn packaged_apps_query_works() {
        let apps = packaged_windows_apps();
        assert!(apps.iter().all(|a| windows::packaged_app_id(&a.launch_path).is_some()));
        if let Some(calc) = apps.iter().find(|a| a.name == "Calculator") {
            assert!(calc.launch_path.to_string_lossy().contains("WindowsCalculator"));
        }
        eprintln!("{} packaged apps, calculator: {}", apps.len(), apps.iter().any(|a| a.name == "Calculator"));
    }
}
