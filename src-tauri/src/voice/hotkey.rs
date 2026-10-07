//! The global push-to-talk shortcut: Ctrl+Shift+Space (Cmd+Shift+Space on a
//! Mac). Hold it anywhere: the chat bubble opens and Glitch listens until
//! you let go. Tap it: he listens until you stop talking. Tap again to stop.
//!
//! Registered only while voice is enabled. If another app already owns the
//! shortcut, voice still works with the mic button and Settings says so.

use std::time::{Duration, Instant};

use glitch_core::voice::vad::Mode;
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

use super::VoiceState;
use crate::state::AppState;

/// `CmdOrCtrl` = Cmd on macOS, Ctrl elsewhere.
pub const SHORTCUT: &str = "CmdOrCtrl+Shift+Space";

/// Pressed and released faster than this = a tap (hands-free).
pub const TAP: Duration = Duration::from_millis(350);

pub fn label() -> &'static str {
    if cfg!(target_os = "macos") {
        "Cmd+Shift+Space"
    } else {
        "Ctrl+Shift+Space"
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct HotkeyStatus {
    pub label: &'static str,
    pub registered: bool,
    /// Why it couldn't be registered (usually: another app uses it).
    pub error: Option<String>,
}

impl Default for HotkeyStatus {
    fn default() -> Self {
        Self { label: label(), registered: false, error: None }
    }
}

/// Register or unregister the shortcut to match the settings.
pub fn sync(app: &AppHandle) {
    let want = app.state::<AppState>().settings().voice.enabled && super::unavailable_reason().is_none();
    let gs = app.global_shortcut();
    let has = gs.is_registered(SHORTCUT);
    let mut status = HotkeyStatus::default();
    if want && !has {
        if let Err(e) = gs.on_shortcut(SHORTCUT, on_event) {
            eprintln!("glitch: couldn't register the voice shortcut {SHORTCUT}: {e}");
            status.error = Some(e.to_string());
        }
    } else if !want && has {
        let _ = gs.unregister(SHORTCUT);
    }
    status.registered = gs.is_registered(SHORTCUT);
    *app.state::<VoiceState>().hotkey.lock().unwrap() = status;
}

pub fn status(app: &AppHandle) -> HotkeyStatus {
    app.state::<VoiceState>().hotkey.lock().unwrap().clone()
}

fn on_event(app: &AppHandle, _shortcut: &Shortcut, event: ShortcutEvent) {
    match event.state {
        ShortcutState::Pressed => pressed(app),
        ShortcutState::Released => released(app),
    }
}

/// Window work goes off the event thread (creating a webview from inside an
/// event handler can deadlock on Windows).
fn open_bubble(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move { crate::commands::open_chat(&app, false) });
}

fn pressed(app: &AppHandle) {
    if !app.state::<AppState>().settings().onboarding_done {
        // Setup first: this shows the wizard.
        open_bubble(app);
        return;
    }
    let vs = app.state::<VoiceState>();
    match vs.control() {
        None => {
            *vs.hotkey_down.lock().unwrap() = Some(Instant::now());
            super::start(app, Mode::Hold);
            open_bubble(app);
        }
        // Second tap ends a hands-free recording.
        Some(c) if c.hands_free() => c.stop(),
        Some(_) => {}
    }
}

fn released(app: &AppHandle) {
    let Some(down) = app.state::<VoiceState>().hotkey_down.lock().unwrap().take() else { return };
    if down.elapsed() < TAP {
        super::hands_free(app);
    } else {
        super::stop(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcut_parses() {
        let s: Shortcut = SHORTCUT.parse().unwrap();
        use tauri_plugin_global_shortcut::{Code, Modifiers};
        let cmd_or_ctrl = if cfg!(target_os = "macos") { Modifiers::SUPER } else { Modifiers::CONTROL };
        assert!(s.matches(cmd_or_ctrl | Modifiers::SHIFT, Code::Space));
        assert!(label().ends_with("+Shift+Space"));
    }
}
