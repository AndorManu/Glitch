use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use glitch_core::agent::{Agent, Progress, ProgressSink};
use glitch_core::ai::ollama::OllamaClient;
use glitch_core::memory::MemoryStore;
use glitch_core::platform::{AppEntry, Platform, SystemPlatform};
use glitch_core::settings::Settings;
use tauri::menu::CheckMenuItem;
use tauri::{AppHandle, Emitter, Wry};

use crate::desktop::NativeDesktop;

/// Set to `1` by `dev/windows-smoke.mjs` (and CI): everything works for real
/// except that opening a URL, file or app is only logged, so an automated run
/// never opens browser tabs or programs on the machine.
pub const DRY_RUN_ENV: &str = "GLITCH_DRY_RUN_ACTIONS";

/// The real platform, with `open_*` / `launch_app` replaced by a log line.
struct DryRunPlatform(SystemPlatform);

impl Platform for DryRunPlatform {
    fn open_url(&self, url: &str) -> io::Result<()> {
        eprintln!("glitch (dry run): would open url {url}");
        Ok(())
    }
    fn open_path(&self, path: &Path) -> io::Result<()> {
        eprintln!("glitch (dry run): would open path {}", path.display());
        Ok(())
    }
    fn launch_app(&self, app: &AppEntry) -> io::Result<()> {
        eprintln!("glitch (dry run): would launch app {}", app.name);
        Ok(())
    }
    fn installed_apps(&self) -> Vec<AppEntry> {
        self.0.installed_apps()
    }
    fn search_roots(&self) -> Vec<PathBuf> {
        self.0.search_roots()
    }
    fn home_dir(&self) -> Option<PathBuf> {
        self.0.home_dir()
    }
}

pub struct AppState {
    pub settings: Mutex<Settings>,
    pub settings_path: PathBuf,
    pub memory_path: PathBuf,
    pub ollama: Arc<OllamaClient>,
    /// Async mutex: a chat turn holds it across awaits (one turn at a time).
    pub agent: tokio::sync::Mutex<Agent>,
    pub platform: Arc<dyn Platform>,
    /// Tray "Let Glitch wander" item, kept in sync with the settings.
    pub wander_item: Mutex<Option<CheckMenuItem<Wry>>>,
    /// Tray "Chaos mode" item, kept in sync with the settings.
    pub chaos_item: Mutex<Option<CheckMenuItem<Wry>>>,
    /// Last view the panel was asked to show ("setup" or "settings").
    pub panel_view: Mutex<String>,
}

/// What the agent is doing, for the bubble ("agent-progress" events) and
/// Glitch's face ("mood": "looking" while he takes a screenshot).
fn progress_sink(app: AppHandle) -> ProgressSink {
    Arc::new(move |p: Progress| {
        match &p {
            Progress::Looking { active: true, .. } => {
                let _ = app.emit("mood", "looking");
            }
            Progress::Looking { active: false, .. } => {
                let _ = app.emit("mood", "thinking");
            }
            _ => {}
        }
        let _ = app.emit("agent-progress", &p);
    })
}

/// Where Glitch's data lives (undo.json sits next to settings.json).
pub fn data_dir(settings_path: &Path) -> PathBuf {
    settings_path.parent().map(Path::to_path_buf).unwrap_or_default()
}

/// Desktop control for the agent: the switch (it needs app control too),
/// where files may be moved (the user's own folders), and the undo log.
/// Debug builds: `GLITCH_DESKTOP_FILE_ROOT=<folder>` limits file moves to
/// exactly that folder (the live tests use a temp folder).
pub fn configure_desktop(agent: &mut Agent, settings: &Settings, data_dir: &Path) {
    use glitch_core::hands::fsmove::FileGuard;
    use glitch_core::hands::undo::UndoLog;
    let on = settings.hands_enabled && settings.hands_desktop_enabled;
    if !on {
        // Off: but "Undo" still works for what was moved before.
        agent.set_desktop_control(
            false,
            None,
            settings.hands_enabled.then(|| UndoLog::open(data_dir.join("undo.json"))),
        );
        return;
    }
    let guard = match std::env::var_os("GLITCH_DESKTOP_FILE_ROOT").filter(|_| cfg!(debug_assertions)) {
        Some(root) => Some(FileGuard::with_roots(vec![PathBuf::from(root)])),
        None => dirs::home_dir().map(|home| {
            let extra: Vec<PathBuf> = [
                dirs::desktop_dir(),
                dirs::document_dir(),
                dirs::download_dir(),
                dirs::picture_dir(),
                dirs::video_dir(),
                dirs::audio_dir(),
            ]
            .into_iter()
            .flatten()
            .collect();
            FileGuard::for_home(&home, &extra)
        }),
    };
    agent.set_desktop_control(true, guard, Some(UndoLog::open(data_dir.join("undo.json"))));
}

impl AppState {
    pub fn new(app: &AppHandle, config_dir: PathBuf) -> Self {
        let settings_path = config_dir.join("settings.json");
        let memory_path = config_dir.join("memory.json");
        let (settings, recovery) = Settings::load_with_report(&settings_path);
        if recovery.unreadable || !recovery.dropped.is_empty() {
            eprintln!(
                "glitch: settings.json had problems ({}); kept a copy at {:?}",
                if recovery.unreadable {
                    "unreadable, using defaults".to_string()
                } else {
                    format!("reset {}", recovery.dropped.join(", "))
                },
                recovery.backup
            );
        }
        let ollama = Arc::new(OllamaClient::new(&settings.ollama_url, &settings.keep_alive));
        let dry_run = std::env::var_os(DRY_RUN_ENV).is_some_and(|v| v == "1");
        let platform: Arc<dyn Platform> = if dry_run {
            eprintln!("glitch: {DRY_RUN_ENV}=1, opening things is only logged");
            Arc::new(DryRunPlatform(SystemPlatform))
        } else {
            Arc::new(SystemPlatform)
        };
        let mut agent = Agent::new(ollama.clone(), platform.clone());
        agent.set_desktop(Arc::new(NativeDesktop::new(app.clone(), dry_run)));
        agent.set_progress(Some(progress_sink(app.clone())));
        agent.set_screen_enabled(settings.screen_enabled);
        agent.set_notes_trusted(settings.notes_trusted);
        agent.set_hands(crate::hands::for_setting(app, settings.hands_enabled));
        agent.set_hands_model(settings.hands_model.clone());
        configure_desktop(&mut agent, &settings, &config_dir);
        if settings.memory_enabled {
            agent.set_memory(Some(MemoryStore::load(&memory_path)));
        }
        Self {
            settings: Mutex::new(settings),
            settings_path,
            memory_path,
            ollama,
            agent: tokio::sync::Mutex::new(agent),
            platform,
            wander_item: Mutex::new(None),
            chaos_item: Mutex::new(None),
            panel_view: Mutex::new("setup".into()),
        }
    }

    pub fn settings(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    /// Change settings, save them, and return the new value.
    pub fn update_settings(&self, f: impl FnOnce(&mut Settings)) -> Settings {
        let new = {
            let mut s = self.settings.lock().unwrap();
            f(&mut s);
            if let Err(e) = s.save(&self.settings_path) {
                eprintln!("glitch: could not save settings: {e}");
            }
            s.clone()
        };
        // Outside the settings lock: menu calls hop to the main thread.
        let item = self.wander_item.lock().unwrap().clone();
        if let Some(item) = item {
            let _ = item.set_checked(new.movement_enabled);
        }
        let item = self.chaos_item.lock().unwrap().clone();
        if let Some(item) = item {
            let _ = item.set_checked(new.chaos_enabled);
        }
        new
    }
}
