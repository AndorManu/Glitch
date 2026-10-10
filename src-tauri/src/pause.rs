//! The panic button: "Hide Glitch / Pause everything".
//!
//! One switch, reachable from the tray, a global hotkey (default
//! Ctrl+Alt+Shift+G, configurable in Settings) and the Safety card. When it
//! is on, Glitch:
//!
//! * disappears (the mascot window hides; the chat bubble, sticky note, paw
//!   prints and the app-control banner close);
//! * lets go of anything chaos mode had hold of (a dragged window, the
//!   cursor) and does no chaos, no wandering reactions, no gentle messages;
//! * stops app control (`NativeHands` reports "interrupted" and refuses to act);
//! * stops listening (the microphone, and the stream overlay's server and
//!   Twitch / Streamer.bot connections), and stops the background fetches
//!   (notification reading, update checks);
//! * turns chat messages away until he is back.
//!
//! The state is saved in settings.json (`safety.paused`), so it survives a
//! restart: Glitch then starts hidden, with only the tray icon, until the
//! user shows him again. Every other module just asks [`is_paused`]; the pure
//! rules (hotkey syntax and conflicts, tray text) are in `glitch_core::safety`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use glitch_core::safety::{self, check_hotkey, DEFAULT_PANIC_HOTKEY};
use serde::Serialize;
use tauri::menu::MenuItem;
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutEvent, ShortcutState};

use crate::commands::UiError;
use crate::state::AppState;
use crate::windows::MASCOT;

static PAUSED: AtomicBool = AtomicBool::new(false);

/// Is the panic button on? Cheap enough for every timer and event handler.
pub fn is_paused() -> bool {
    PAUSED.load(Ordering::SeqCst)
}

/// Where the global hotkey stands (shown in Settings).
#[derive(Debug, Clone, Serialize, Default)]
pub struct HotkeyState {
    /// The combination, as saved ("Ctrl+Alt+Shift+G").
    pub combo: String,
    pub registered: bool,
    /// Why it isn't active (usually: another program owns it).
    pub error: Option<String>,
}

#[derive(Default)]
pub struct PauseState {
    /// The one tray item whose text flips between "Hide Glitch / Pause everything" and "Show Glitch".
    tray: Mutex<Option<MenuItem<Wry>>>,
    /// "Chat with Glitch" in the tray: greyed out while paused.
    chat: Mutex<Option<MenuItem<Wry>>>,
    hotkey: Mutex<HotkeyState>,
}

fn state(app: &AppHandle) -> tauri::State<'_, PauseState> {
    app.state::<PauseState>()
}

/// The other global shortcuts Glitch owns (a new panic hotkey must not collide).
fn others() -> Vec<(&'static str, &'static str)> {
    vec![("push-to-talk", crate::voice::hotkey::SHORTCUT)]
}

// ------------------------------------------------------------------ setup

/// Called from `main`'s setup, after `AppState`: restores a saved pause and
/// registers the hotkey.
pub fn setup(app: &AppHandle) {
    app.manage(PauseState::default());
    let s = app.state::<AppState>().settings().safety;
    PAUSED.store(s.paused, Ordering::SeqCst);
    if let Err(e) = register(app, &s.panic_hotkey) {
        eprintln!("glitch: panic hotkey {} not active: {e}", s.panic_hotkey);
    }
}

/// After the window exists: a saved pause starts with Glitch hidden.
pub fn after_windows(app: &AppHandle) {
    if is_paused() {
        eprintln!("glitch: paused (saved from last time), staying hidden");
        enter(app);
    }
}

/// The tray items (built once in `build_tray`).
pub fn tray_items(app: &AppHandle, chat: MenuItem<Wry>) -> tauri::Result<MenuItem<Wry>> {
    let item = MenuItem::with_id(app, "pause", safety::tray_label(is_paused()), true, None::<&str>)?;
    chat.set_enabled(!is_paused())?;
    *state(app).tray.lock().unwrap() = Some(item.clone());
    *state(app).chat.lock().unwrap() = Some(chat);
    Ok(item)
}

// ----------------------------------------------------------------- hotkey

fn on_hotkey(app: &AppHandle, _shortcut: &tauri_plugin_global_shortcut::Shortcut, event: ShortcutEvent) {
    if event.state == ShortcutState::Pressed {
        let app = app.clone();
        // Off the shortcut thread: window work hops to the main thread.
        tauri::async_runtime::spawn(async move {
            toggle(&app);
        });
    }
}

/// Make `combo` the active panic hotkey (replacing the previous one). On
/// failure the previous one stays.
fn register(app: &AppHandle, combo: &str) -> Result<(), String> {
    let gs = app.global_shortcut();
    let previous = state(app).hotkey.lock().unwrap().clone();
    let outcome: Result<(), String> = (|| {
        if previous.registered && previous.combo == combo {
            return Ok(());
        }
        gs.on_shortcut(combo, on_hotkey).map_err(|e| {
            let text = e.to_string();
            if text.to_lowercase().contains("already") {
                "another program already uses that shortcut".to_string()
            } else {
                text
            }
        })?;
        if previous.registered && previous.combo != combo {
            let _ = gs.unregister(previous.combo.as_str());
        }
        Ok(())
    })();
    let st = state(app);
    let mut h = st.hotkey.lock().unwrap();
    match &outcome {
        Ok(()) => *h = HotkeyState { combo: combo.to_string(), registered: true, error: None },
        // Keep the old one running; remember why the new one didn't work.
        Err(e) if previous.registered => h.error = Some(e.clone()),
        Err(e) => *h = HotkeyState { combo: combo.to_string(), registered: false, error: Some(e.clone()) },
    }
    outcome
}

// ------------------------------------------------------------ the switch

/// Flip it. Returns the new state.
pub fn toggle(app: &AppHandle) -> bool {
    let to = !is_paused();
    set_paused(app, to);
    to
}

/// Turn the panic button on or off (saved). Does nothing if it already is.
pub fn set_paused(app: &AppHandle, paused: bool) {
    if PAUSED.swap(paused, Ordering::SeqCst) == paused {
        return;
    }
    let new = app.state::<AppState>().update_settings(|s| s.safety.paused = paused);
    if paused {
        enter(app);
    } else {
        leave(app);
    }
    let _ = app.emit("pause-changed", paused);
    let _ = app.emit("settings-changed", &new);
}

fn sync_tray(app: &AppHandle) {
    let paused = is_paused();
    if let Some(item) = state(app).tray.lock().unwrap().clone() {
        let _ = item.set_text(safety::tray_label(paused));
    }
    if let Some(item) = state(app).chat.lock().unwrap().clone() {
        let _ = item.set_enabled(!paused);
    }
    if let Some(tray) = app.tray_by_id("glitch") {
        let _ = tray.set_tooltip(Some(if paused { "Glitch (paused)" } else { "Glitch" }));
    }
}

/// Everything that has to stop, right now.
fn enter(app: &AppHandle) {
    // Let go of other apps first: that is the part that can annoy someone.
    crate::chaos::stop_all(app);
    crate::chaos::close_extras(app);
    crate::hands::hide_banner(app);
    crate::voice::cancel(app);
    crate::windows::hide_bubble(app);
    crate::stream::apply(app);
    let _ = app.emit("mood", "idle");
    if let Some(w) = app.get_webview_window(MASCOT) {
        let _ = w.hide();
    }
    sync_tray(app);
}

fn leave(app: &AppHandle) {
    crate::stream::apply(app);
    if let Some(w) = app.get_webview_window(MASCOT) {
        let _ = w.show();
    }
    sync_tray(app);
}

// ---------------------------------------------------------------- commands

#[derive(Serialize)]
pub struct SafetyStatus {
    paused: bool,
    hotkey: HotkeyState,
    default_hotkey: &'static str,
    start_with_windows: bool,
    /// "Start with Windows" can be changed on this OS.
    autostart_supported: bool,
    /// What the Windows registry says right now (the saved setting is the wish).
    autostart_active: bool,
    autostart_error: Option<String>,
}

fn status_of(app: &AppHandle) -> SafetyStatus {
    let s = app.state::<AppState>().settings().safety;
    let (active, error) = crate::autostart::status(app);
    SafetyStatus {
        paused: is_paused(),
        hotkey: state(app).hotkey.lock().unwrap().clone(),
        default_hotkey: DEFAULT_PANIC_HOTKEY,
        start_with_windows: s.start_with_windows,
        autostart_supported: crate::autostart::SUPPORTED,
        autostart_active: active,
        autostart_error: error,
    }
}

#[tauri::command]
pub fn safety_status(app: AppHandle) -> SafetyStatus {
    status_of(&app)
}

#[tauri::command]
pub async fn safety_set_paused(app: AppHandle, paused: bool) -> SafetyStatus {
    set_paused(&app, paused);
    status_of(&app)
}

/// Change the panic hotkey. Refused (and the old one kept) if the combination
/// is too easy to hit by accident, belongs to Windows or another Glitch
/// shortcut, or another program already owns it.
#[tauri::command]
pub async fn safety_set_hotkey(app: AppHandle, combo: String) -> Result<SafetyStatus, UiError> {
    let chord = check_hotkey(&combo, &others()).map_err(|e| UiError::new("bad_hotkey", e.to_string()))?;
    let label = chord.label();
    register(&app, &label).map_err(|e| {
        UiError::new("hotkey_unavailable", format!("{label} can't be used: {e}. The previous shortcut still works."))
    })?;
    app.state::<AppState>().update_settings(|s| s.safety.panic_hotkey = label);
    let _ = app.emit("settings-changed", &app.state::<AppState>().settings());
    Ok(status_of(&app))
}

#[tauri::command]
pub async fn safety_set_autostart(app: AppHandle, enabled: bool) -> Result<SafetyStatus, UiError> {
    if !crate::autostart::SUPPORTED {
        return Err(UiError::new("unsupported", "Starting with the computer is only set up for Windows so far."));
    }
    crate::autostart::set(&app, enabled).map_err(|e| UiError::new("autostart_failed", e))?;
    let new = app.state::<AppState>().update_settings(|s| s.safety.start_with_windows = enabled);
    let _ = app.emit("settings-changed", &new);
    Ok(status_of(&app))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri_plugin_global_shortcut::Shortcut;

    /// Every combination the pure parser accepts is one the plugin can register.
    #[test]
    fn canonical_labels_parse_in_the_shortcut_plugin() {
        let samples = [
            DEFAULT_PANIC_HOTKEY,
            "Ctrl+Alt+F9",
            "Ctrl+Alt+5",
            "Ctrl+Alt+Space",
            "Alt+Shift+Up",
            "Ctrl+Alt+PageDown",
            "Ctrl+Alt+Home",
            "Ctrl+Alt+End",
            "Ctrl+Alt+Insert",
            "Alt+Shift+Left",
            "Shift+Super+F9",
            "Ctrl+Alt+Shift+Z",
            "Ctrl+Alt+F24",
        ];
        for s in samples {
            let label = check_hotkey(s, &[]).unwrap_or_else(|e| panic!("{s}: {e}")).label();
            label.parse::<Shortcut>().unwrap_or_else(|e| panic!("{label} doesn't parse in the plugin: {e}"));
        }
    }

    #[test]
    fn the_push_to_talk_shortcut_is_a_known_conflict() {
        let err = check_hotkey("Ctrl+Shift+Space", &others()).unwrap_err();
        assert!(err.to_string().contains("push-to-talk"), "{err}");
    }
}
