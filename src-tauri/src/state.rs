use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use glitch_core::agent::Agent;
use glitch_core::ai::ollama::OllamaClient;
use glitch_core::memory::MemoryStore;
use glitch_core::platform::{AppEntry, Platform, SystemPlatform};
use glitch_core::settings::Settings;
use tauri::menu::CheckMenuItem;
use tauri::Wry;

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

impl AppState {
    pub fn new(config_dir: PathBuf) -> Self {
        let settings_path = config_dir.join("settings.json");
        let memory_path = config_dir.join("memory.json");
        let settings = Settings::load(&settings_path);
        let ollama = Arc::new(OllamaClient::new(&settings.ollama_url, &settings.keep_alive));
        let platform: Arc<dyn Platform> = if std::env::var_os(DRY_RUN_ENV).is_some_and(|v| v == "1") {
            eprintln!("glitch: {DRY_RUN_ENV}=1, opening things is only logged");
            Arc::new(DryRunPlatform(SystemPlatform))
        } else {
            Arc::new(SystemPlatform)
        };
        let mut agent = Agent::new(ollama.clone(), platform.clone());
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
