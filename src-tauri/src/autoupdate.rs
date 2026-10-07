//! Auto-update with tauri-plugin-updater against GitHub Releases.
//!
//! - Where: only `tauri.conf.json > plugins > updater > endpoints`, one pinned
//!   HTTPS URL (`latest.json` of the latest GitHub release).
//! - Trust: every download is checked against the minisign public key in
//!   `tauri.conf.json` before it is installed; the private key never leaves
//!   the owner's machine / the CI secret.
//! - When: 45 s after start and once a day (Settings > Features > Updates),
//!   or "Check now". Nothing is downloaded or installed without a click on
//!   "Install" in Glitch's bubble; "Later" hides that version for a day.
//! - The webviews get no updater plugin permissions: everything goes
//!   through the commands below.

use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use glitch_core::autoupdate::{self, CHECK_EVERY_SECS, FIRST_CHECK_SECS};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::commands::UiError;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Available {
    pub version: String,
    pub notes: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateStatus {
    pub current: String,
    pub auto_check: bool,
    pub checking: bool,
    /// A newer version, if the last check found one.
    pub available: Option<Available>,
    /// Should the bubble offer it now (not snoozed with "Later")?
    pub offer: bool,
    /// Downloading/installing: 0-100, or null while the size is unknown.
    pub installing: Option<Option<u8>>,
    /// Unix seconds of the last finished check (0 = never).
    pub last_check: u64,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct Updates {
    pending: Mutex<Option<Update>>,
    checking: Mutex<bool>,
    installing: Mutex<Option<Option<u8>>>,
    last_check: Mutex<u64>,
    error: Mutex<Option<String>>,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub fn status(app: &AppHandle) -> UpdateStatus {
    let u = app.state::<Updates>();
    let settings = app.state::<AppState>().settings().auto_update;
    let available = u
        .pending
        .lock()
        .unwrap()
        .as_ref()
        .map(|p| Available { version: p.version.clone(), notes: autoupdate::short_notes(p.body.as_deref()) });
    let offer = available.as_ref().is_some_and(|a| autoupdate::should_offer(&settings, &a.version, now()));
    let checking = *u.checking.lock().unwrap();
    let installing = *u.installing.lock().unwrap();
    let last_check = *u.last_check.lock().unwrap();
    let error = u.error.lock().unwrap().clone();
    UpdateStatus {
        current: app.package_info().version.to_string(),
        auto_check: settings.auto_check,
        checking,
        available,
        offer,
        installing,
        last_check,
        error,
    }
}

fn emit_status(app: &AppHandle) {
    let _ = app.emit("update-status", status(app));
}

/// Ask GitHub once. A failure (offline, no release yet) is only remembered
/// for the settings card, never shown in the bubble. `from_timer`: a new
/// version also opens the bubble (a click on "Check now" already has the panel open).
async fn check(app: &AppHandle, from_timer: bool) -> Result<Option<Available>, String> {
    let u = app.state::<Updates>();
    {
        let mut c = u.checking.lock().unwrap();
        if *c {
            return Err("already checking".into());
        }
        *c = true;
    }
    emit_status(app);
    let result = async {
        let updater = app.updater().map_err(|e| e.to_string())?;
        updater.check().await.map_err(|e| e.to_string())
    }
    .await;
    *u.checking.lock().unwrap() = false;
    *u.last_check.lock().unwrap() = now();
    let out = match result {
        Ok(found) => {
            *u.error.lock().unwrap() = None;
            let avail = found
                .as_ref()
                .map(|p| Available { version: p.version.clone(), notes: autoupdate::short_notes(p.body.as_deref()) });
            *u.pending.lock().unwrap() = found;
            Ok(avail)
        }
        Err(e) => {
            eprintln!("glitch: update check failed: {e}");
            *u.error.lock().unwrap() = Some("Couldn't check for updates (offline, or GitHub didn't answer).".into());
            Err(e)
        }
    };
    emit_status(app);
    // A new version that wasn't snoozed: Glitch says so in his bubble.
    if let Ok(Some(a)) = &out {
        let s = app.state::<AppState>().settings().auto_update;
        if autoupdate::should_offer(&s, &a.version, now()) {
            let _ = app.emit("update-available", a);
            if from_timer {
                crate::commands::open_chat(app, false);
            }
        }
    }
    out
}

/// Start the background checks (on start + daily, while "Check for updates" is on).
pub fn setup(app: &AppHandle) {
    app.manage(Updates::default());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(FIRST_CHECK_SECS)).await;
        loop {
            if app.state::<AppState>().settings().auto_update.auto_check {
                let _ = check(&app, true).await;
            }
            tokio::time::sleep(Duration::from_secs(CHECK_EVERY_SECS)).await;
        }
    });
}

#[tauri::command]
pub fn update_status(app: AppHandle) -> UpdateStatus {
    status(&app)
}

/// "Check now" in Settings: also offers in the bubble when one is found.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<UpdateStatus, UiError> {
    check(&app, false)
        .await
        .map_err(|_| UiError::new("update_check_failed", "Couldn't check for updates. Are you online?"))?;
    Ok(status(&app))
}

#[tauri::command]
pub fn update_set_auto(app: AppHandle, on: bool) -> UpdateStatus {
    let new = app.state::<AppState>().update_settings(|s| s.auto_update.auto_check = on);
    let _ = app.emit("settings-changed", &new);
    status(&app)
}

/// "Later": no bubble for this version for a day.
#[tauri::command]
pub fn update_later(app: AppHandle) {
    let version = app.state::<Updates>().pending.lock().unwrap().as_ref().map(|p| p.version.clone());
    if let Some(v) = version {
        app.state::<AppState>().update_settings(|s| {
            s.auto_update.snoozed_version = Some(v);
            s.auto_update.snoozed_at = now();
        });
    }
    emit_status(&app);
}

/// "Install": download, verify the signature, install, restart. The plugin
/// refuses anything not signed by the key in tauri.conf.json.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), UiError> {
    let u = app.state::<Updates>();
    let Some(update) = u.pending.lock().unwrap().clone() else {
        return Err(UiError::new("no_update", "There's no new version to install."));
    };
    {
        let mut i = u.installing.lock().unwrap();
        if i.is_some() {
            return Ok(());
        }
        *i = Some(None);
    }
    emit_status(&app);
    let mut done: u64 = 0;
    let mut last_pct: Option<u8> = None;
    let progress_app = app.clone();
    let result = update
        .download_and_install(
            move |chunk, total| {
                done += chunk as u64;
                let pct = total.filter(|t| *t > 0).map(|t| ((done * 100) / t).min(100) as u8);
                if pct != last_pct {
                    last_pct = pct;
                    *progress_app.state::<Updates>().installing.lock().unwrap() = Some(pct);
                    emit_status(&progress_app);
                }
            },
            || {},
        )
        .await;
    match result {
        Ok(()) => {
            // Save the chat and memory, then start the new version.
            if let Ok(mut agent) = app.state::<AppState>().agent.try_lock() {
                agent.persist();
            }
            app.restart();
        }
        Err(e) => {
            eprintln!("glitch: update install failed: {e}");
            *u.installing.lock().unwrap() = None;
            let msg = if e.to_string().to_lowercase().contains("signature") {
                "That download wasn't signed by Glitch's key, so I didn't install it."
            } else {
                "The update didn't download. Try again in a bit?"
            };
            *u.error.lock().unwrap() = Some(msg.into());
            emit_status(&app);
            Err(UiError::new("update_failed", msg))
        }
    }
}
