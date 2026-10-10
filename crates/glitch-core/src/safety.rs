//! The safety switches: the panic button ("Hide Glitch / Pause everything")
//! and "Start with Windows". Pure rules only: the settings that persist, and
//! parsing / checking the panic hotkey. Registering the hotkey, hiding the
//! windows and the registry live in `src-tauri` (pause.rs, autostart.rs).

use std::fmt;

use serde::{Deserialize, Serialize};

pub const DEFAULT_PANIC_HOTKEY: &str = "Ctrl+Alt+Shift+G";

/// Persisted in settings.json under `safety`. Missing in older files: defaults.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct SafetySettings {
    /// The panic button is on: Glitch is hidden and everything is paused.
    /// Stays that way across restarts until it is toggled off.
    pub paused: bool,
    /// Global hotkey that toggles the pause, as `Chord::label` writes it.
    pub panic_hotkey: String,
    /// Start Glitch when the user signs in to Windows. Off by default.
    pub start_with_windows: bool,
}

impl Default for SafetySettings {
    fn default() -> Self {
        Self { paused: false, panic_hotkey: DEFAULT_PANIC_HOTKEY.into(), start_with_windows: false }
    }
}

impl SafetySettings {
    /// A hand-edited or damaged hotkey falls back to the default (never an
    /// app that starts without a working panic button).
    pub fn sanitized(mut self) -> Self {
        match check_hotkey(&self.panic_hotkey, &[]) {
            Ok(chord) => self.panic_hotkey = chord.label(),
            Err(_) => self.panic_hotkey = DEFAULT_PANIC_HOTKEY.into(),
        }
        self
    }
}

/// Text of the one tray item that does both jobs.
pub fn tray_label(paused: bool) -> &'static str {
    if paused {
        "Show Glitch"
    } else {
        "Hide Glitch / Pause everything"
    }
}

/// A key combination: modifiers plus one key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chord {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    /// The Windows / Command key.
    pub meta: bool,
    /// Canonical key name: "A".."Z", "0".."9", "F1".."F24", "Space", "Up", "Home"...
    pub key: String,
}

impl Chord {
    /// "Ctrl+Alt+Shift+G": also what the global-shortcut plugin parses.
    pub fn label(&self) -> String {
        let mut parts: Vec<&str> = Vec::new();
        if self.ctrl {
            parts.push("Ctrl");
        }
        if self.alt {
            parts.push("Alt");
        }
        if self.shift {
            parts.push("Shift");
        }
        if self.meta {
            parts.push("Super");
        }
        parts.push(&self.key);
        parts.join("+")
    }

    fn modifiers(&self) -> usize {
        [self.ctrl, self.alt, self.shift, self.meta].iter().filter(|m| **m).count()
    }
}

/// Why a hotkey was refused (the message is shown to the user as is).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HotkeyError {
    Empty,
    NoKey,
    TwoKeys,
    UnknownKey(String),
    /// Needs at least two modifiers, one of them Ctrl, Alt or Super.
    TooFewModifiers,
    /// Windows or a very common shortcut of other apps.
    Taken(&'static str),
    /// Another Glitch shortcut.
    UsedByGlitch(String),
}

impl fmt::Display for HotkeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HotkeyError::Empty => write!(f, "Type a shortcut, for example Ctrl+Alt+Shift+G."),
            HotkeyError::NoKey => write!(f, "Add a key after the modifiers, for example Ctrl+Alt+Shift+G."),
            HotkeyError::TwoKeys => write!(f, "Use one key plus modifiers (Ctrl, Alt, Shift, Super)."),
            HotkeyError::UnknownKey(k) => write!(f, "\u{201c}{k}\u{201d} isn't a key I can listen for."),
            HotkeyError::TooFewModifiers => {
                write!(f, "Use at least two modifiers, one of them Ctrl, Alt or Super, so it can't fire by accident.")
            }
            HotkeyError::Taken(by) => write!(f, "That shortcut belongs to {by}. Pick another one."),
            HotkeyError::UsedByGlitch(what) => write!(f, "Glitch already uses that for {what}. Pick another one."),
        }
    }
}

impl std::error::Error for HotkeyError {}

fn key_name(raw: &str) -> Option<String> {
    let k = raw.trim();
    let up = k.to_uppercase();
    let named = |n: &str| Some(n.to_string());
    if up.chars().count() == 1 {
        let c = up.chars().next()?;
        if c.is_ascii_alphanumeric() {
            return Some(up);
        }
    }
    // KeyG / Digit5, as the browser and the plugin write them.
    if let Some(rest) = up.strip_prefix("KEY").filter(|r| r.len() == 1 && r.chars().all(|c| c.is_ascii_uppercase())) {
        return Some(rest.to_string());
    }
    if let Some(rest) = up.strip_prefix("DIGIT").filter(|r| r.len() == 1 && r.chars().all(|c| c.is_ascii_digit())) {
        return Some(rest.to_string());
    }
    if let Some(n) = up.strip_prefix('F').and_then(|n| n.parse::<u8>().ok()) {
        if (1..=24).contains(&n) {
            return Some(format!("F{n}"));
        }
    }
    match up.as_str() {
        "SPACE" | "SPACEBAR" => named("Space"),
        "UP" | "ARROWUP" => named("Up"),
        "DOWN" | "ARROWDOWN" => named("Down"),
        "LEFT" | "ARROWLEFT" => named("Left"),
        "RIGHT" | "ARROWRIGHT" => named("Right"),
        "HOME" => named("Home"),
        "END" => named("End"),
        "PAGEUP" | "PGUP" => named("PageUp"),
        "PAGEDOWN" | "PGDN" => named("PageDown"),
        "INSERT" | "INS" => named("Insert"),
        "DELETE" | "DEL" => named("Delete"),
        _ => None,
    }
}

/// Parse "ctrl + alt + shift + g" (any case, `CmdOrCtrl`, `Win`, `Option`
/// accepted) into a [`Chord`]. Only the syntax is checked here.
pub fn parse_hotkey(text: &str) -> Result<Chord, HotkeyError> {
    let text = text.trim();
    if text.is_empty() {
        return Err(HotkeyError::Empty);
    }
    let mut chord = Chord { ctrl: false, alt: false, shift: false, meta: false, key: String::new() };
    let mut key: Option<String> = None;
    for part in text.split('+').map(str::trim) {
        if part.is_empty() {
            // "Ctrl++" would be the + key; keep it simple and refuse.
            return Err(HotkeyError::NoKey);
        }
        match part.to_lowercase().as_str() {
            "ctrl" | "control" | "cmdorctrl" | "commandorcontrol" | "cmdorcontrol" | "commandorctrl" => {
                chord.ctrl = true
            }
            "alt" | "option" | "opt" => chord.alt = true,
            "shift" => chord.shift = true,
            "super" | "win" | "windows" | "meta" | "cmd" | "command" => chord.meta = true,
            _ => {
                let name = key_name(part).ok_or_else(|| HotkeyError::UnknownKey(part.to_string()))?;
                if key.replace(name).is_some() {
                    return Err(HotkeyError::TwoKeys);
                }
            }
        }
    }
    chord.key = key.ok_or(HotkeyError::NoKey)?;
    Ok(chord)
}

/// Combinations Windows or nearly every program already uses. Refused on top
/// of the "two modifiers" rule.
fn taken_by_others(c: &Chord) -> Option<&'static str> {
    let only = |ctrl, alt, shift, meta| c.ctrl == ctrl && c.alt == alt && c.shift == shift && c.meta == meta;
    let k = c.key.as_str();
    // Windows itself.
    if only(true, true, false, false) && k == "Delete" {
        return Some("Windows (security screen)");
    }
    if only(false, true, false, false) && matches!(k, "F4") {
        return Some("Windows (close window)");
    }
    if c.meta && c.modifiers() == 1 {
        return Some("Windows");
    }
    // Browsers and editors: Ctrl+Shift+<letter> that people use all day.
    if only(true, false, true, false)
        && matches!(
            k,
            "T" | "N" | "W" | "P" | "I" | "J" | "B" | "Q" | "R" | "Delete" | "S" | "A" | "K" | "O" | "F" | "Z"
        )
    {
        return Some("your browser and editors");
    }
    if only(true, true, false, false) && matches!(k, "Up" | "Down" | "Left" | "Right") {
        return Some("your graphics driver (screen rotation)");
    }
    if c.meta && c.alt && !c.ctrl && !c.shift && matches!(k, "G" | "R") {
        return Some("the Xbox Game Bar");
    }
    if only(true, true, false, false) && matches!(k, "T" | "W") {
        return Some("your terminal and browser");
    }
    None
}

/// Full check of a hotkey the user typed. `others` are Glitch's other global
/// shortcuts as (what it does, key combination) so they can't collide.
pub fn check_hotkey(text: &str, others: &[(&str, &str)]) -> Result<Chord, HotkeyError> {
    let chord = parse_hotkey(text)?;
    if chord.modifiers() < 2 || !(chord.ctrl || chord.alt || chord.meta) {
        return Err(HotkeyError::TooFewModifiers);
    }
    if let Some(by) = taken_by_others(&chord) {
        return Err(HotkeyError::Taken(by));
    }
    for (what, combo) in others {
        if parse_hotkey(combo).is_ok_and(|o| o == chord) {
            return Err(HotkeyError::UsedByGlitch((*what).to_string()));
        }
    }
    Ok(chord)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_hotkey_is_valid_and_canonical() {
        let c = check_hotkey(DEFAULT_PANIC_HOTKEY, &[]).unwrap();
        assert_eq!(c.label(), DEFAULT_PANIC_HOTKEY);
        assert!(c.ctrl && c.alt && c.shift && !c.meta);
        assert_eq!(SafetySettings::default().panic_hotkey, DEFAULT_PANIC_HOTKEY);
    }

    #[test]
    fn spellings_normalise_to_one_label() {
        for t in [
            "ctrl+alt+shift+g",
            "Control + Alt + Shift + G",
            "SHIFT+ALT+CTRL+KeyG",
            " alt+shift+ctrl+g ",
            "CmdOrCtrl+Option+Shift+g",
        ] {
            assert_eq!(check_hotkey(t, &[]).unwrap().label(), "Ctrl+Alt+Shift+G", "{t}");
        }
        assert_eq!(check_hotkey("Win+Shift+F9", &[]).unwrap().label(), "Shift+Super+F9");
        assert_eq!(check_hotkey("ctrl+alt+space", &[]).unwrap().label(), "Ctrl+Alt+Space");
        assert_eq!(check_hotkey("ctrl+alt+5", &[]).unwrap().label(), "Ctrl+Alt+5");
        assert_eq!(check_hotkey("ctrl+alt+PgDn", &[]).unwrap().label(), "Ctrl+Alt+PageDown");
        assert_eq!(check_hotkey("ctrl+alt+f12", &[]).unwrap().label(), "Ctrl+Alt+F12");
    }

    #[test]
    fn syntax_errors_say_what_is_wrong() {
        assert_eq!(parse_hotkey(""), Err(HotkeyError::Empty));
        assert_eq!(parse_hotkey("   "), Err(HotkeyError::Empty));
        assert_eq!(parse_hotkey("ctrl+alt"), Err(HotkeyError::NoKey));
        assert_eq!(parse_hotkey("ctrl+alt+"), Err(HotkeyError::NoKey));
        assert_eq!(parse_hotkey("ctrl+g+h"), Err(HotkeyError::TwoKeys));
        assert!(matches!(parse_hotkey("ctrl+alt+banana"), Err(HotkeyError::UnknownKey(k)) if k == "banana"));
        assert!(matches!(parse_hotkey("ctrl+alt+F25"), Err(HotkeyError::UnknownKey(_))));
        assert!(matches!(parse_hotkey("ctrl+alt+F0"), Err(HotkeyError::UnknownKey(_))));
        for e in [HotkeyError::Empty, HotkeyError::NoKey, HotkeyError::TwoKeys, HotkeyError::TooFewModifiers] {
            assert!(!e.to_string().is_empty());
        }
    }

    #[test]
    fn accidental_hotkeys_are_refused() {
        // One modifier, or only Shift + something.
        for t in ["g", "ctrl+g", "alt+g", "shift+g", "ctrl+shift"] {
            assert!(check_hotkey(t, &[]).is_err(), "{t}");
        }
        assert_eq!(check_hotkey("ctrl+g", &[]), Err(HotkeyError::TooFewModifiers));
        assert_eq!(check_hotkey("shift+f9", &[]), Err(HotkeyError::TooFewModifiers));
    }

    #[test]
    fn windows_and_common_app_shortcuts_are_refused() {
        for t in [
            "ctrl+alt+delete",
            "alt+ctrl+del",
            "ctrl+shift+t",
            "ctrl+shift+n",
            "ctrl+shift+delete",
            "ctrl+alt+left",
            "win+alt+g",
        ] {
            assert!(matches!(check_hotkey(t, &[]), Err(HotkeyError::Taken(_))), "{t}");
        }
        // ...but other Ctrl+Alt+letter / Ctrl+Alt+Shift+letter combinations are free.
        for t in ["ctrl+alt+g", "ctrl+alt+shift+g", "ctrl+alt+shift+p", "alt+shift+f9", "win+alt+h"] {
            assert!(check_hotkey(t, &[]).is_ok(), "{t}");
        }
    }

    #[test]
    fn glitchs_other_shortcuts_are_a_conflict() {
        let others = [("push-to-talk", "CmdOrCtrl+Shift+Space")];
        let err = check_hotkey("ctrl+shift+space", &others).unwrap_err();
        assert_eq!(err, HotkeyError::UsedByGlitch("push-to-talk".into()));
        assert!(err.to_string().contains("push-to-talk"));
        assert!(check_hotkey("ctrl+alt+shift+space", &others).is_ok());
    }

    #[test]
    fn a_damaged_saved_hotkey_falls_back_to_the_default() {
        for bad in ["", "banana", "ctrl", "ctrl+g", "ctrl+alt+delete"] {
            let s = SafetySettings { panic_hotkey: bad.into(), ..Default::default() }.sanitized();
            assert_eq!(s.panic_hotkey, DEFAULT_PANIC_HOTKEY, "{bad:?}");
        }
        let s = SafetySettings { panic_hotkey: "alt+ctrl+f9".into(), ..Default::default() }.sanitized();
        assert_eq!(s.panic_hotkey, "Ctrl+Alt+F9");
    }

    #[test]
    fn the_tray_item_flips_its_text() {
        assert_eq!(tray_label(false), "Hide Glitch / Pause everything");
        assert_eq!(tray_label(true), "Show Glitch");
    }

    #[test]
    fn old_files_get_safe_defaults_and_partial_sections_fill_in() {
        let d = SafetySettings::default();
        assert!(!d.paused && !d.start_with_windows);
        let s: SafetySettings = serde_json::from_str(r#"{"paused":true}"#).unwrap();
        assert!(s.paused && !s.start_with_windows);
        assert_eq!(s.panic_hotkey, DEFAULT_PANIC_HOTKEY);
    }
}
