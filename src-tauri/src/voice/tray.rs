//! The tray side of the wake word: a "Listen for “Hey Glitch”" check item
//! and a tooltip that says when the microphone is open.

use tauri::menu::CheckMenuItem;
use tauri::{AppHandle, Manager, Wry};

use super::wake::WakeStatus;
use super::VoiceState;
use crate::state::AppState;

pub const MENU_ID: &str = "wake";

const LABEL: &str = "Listen for “Hey Glitch”";

/// The menu item (created with the tray in main.rs).
pub fn menu_item(app: &AppHandle) -> tauri::Result<CheckMenuItem<Wry>> {
    let on = app.state::<AppState>().settings().voice.wake_word;
    let item = CheckMenuItem::with_id(app, MENU_ID, LABEL, true, on, None::<&str>)?;
    *app.state::<VoiceState>().tray_item.lock().unwrap() = Some(item.clone());
    Ok(item)
}

/// Tooltip text for a wake-word state. Unit-tested.
pub fn tooltip(status: &WakeStatus) -> &'static str {
    if status.armed {
        "Glitch · listening for “Hey Glitch” (mic on)"
    } else {
        "Glitch"
    }
}

/// Reflect the wake-word state in the tray.
pub fn show_wake(app: &AppHandle, status: &WakeStatus) {
    let item = app.state::<VoiceState>().tray_item.lock().unwrap().clone();
    if let Some(item) = item {
        let _ = item.set_checked(status.enabled);
        let _ = item.set_text(if status.armed { "Listening for “Hey Glitch” (mic on)" } else { LABEL });
    }
    if let Some(tray) = app.tray_by_id("glitch") {
        let _ = tray.set_tooltip(Some(tooltip(status)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tooltip_says_when_the_mic_is_open() {
        let mut s = WakeStatus::default();
        assert_eq!(tooltip(&s), "Glitch");
        s.enabled = true;
        assert_eq!(tooltip(&s), "Glitch", "enabled but not armed (no model): mic closed");
        s.armed = true;
        assert!(tooltip(&s).contains("mic on"));
    }
}
