//! User settings, stored as a small JSON file in the OS's app-config folder
//! (the Tauri shell decides the folder; this module only needs a path).

use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::ai::ollama;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Ollama model tag to chat with. `None` until the user picks one.
    pub model: Option<String>,
    /// Whether Glitch wanders around the screen.
    pub movement_enabled: bool,
    /// Chaos mode: harmless mischief (dragging other apps' windows a bit,
    /// playing with the cursor, footprints, sticky notes). Only while
    /// `movement_enabled` is on too. Missing in older files → on.
    pub chaos_enabled: bool,
    /// Set once the first-run wizard has been completed.
    pub onboarding_done: bool,
    pub ollama_url: String,
    /// Passed to Ollama as `keep_alive` (duration string like "2m").
    pub keep_alive: String,
    /// Whether Glitch remembers things between chats (memory.json).
    pub memory_enabled: bool,
    /// "Let Glitch see the screen": the look_at_screen tool. Missing in older
    /// files -> on (it only ever runs when a request needs it).
    pub screen_enabled: bool,
    /// The user allowed take_note once; later notes don't ask again.
    pub notes_trusted: bool,
    /// Voice commands (push-to-talk). Missing in older files → defaults.
    pub voice: VoiceSettings,
    /// Streaming overlay (OBS browser source). Off by default.
    pub stream: StreamSettings,
    /// Update checks against GitHub Releases.
    pub updates: UpdateSettings,
}

/// The OBS overlay (src-tauri/src/stream/). Missing in older files: off.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct StreamSettings {
    pub enabled: bool,
    /// Port on 127.0.0.1 for the overlay page and the event webhook.
    pub port: u16,
    /// Secret in the overlay URL; made on first start, new one on "New link".
    pub token: String,
    /// "mirror": the desktop Glitch's animation and bubble.
    /// "walk": a separate stream Glitch walking along the bottom.
    pub mode: String,
    /// Size multiplier (1 = 160 px).
    pub size: f32,
    /// Where he stands in mirror mode, and where the walker starts: "left", "center", "right".
    pub position: String,
    /// React to follows, subs, raids and chat lines.
    pub react: bool,
    /// Show chat lines in his bubble (otherwise only follows, subs, raids).
    pub show_chat: bool,
    /// Also show what Glitch says in the private desktop chat. Off: chats
    /// with him stay off stream.
    pub mirror_chat: bool,
    /// Listen to Streamer.bot's WebSocket server.
    pub streamerbot: bool,
    pub streamerbot_url: String,
    /// Twitch channel to read chat from anonymously ("" = off).
    pub twitch_channel: String,
}

impl Default for StreamSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            port: 7799,
            token: String::new(),
            mode: "mirror".into(),
            size: 1.0,
            position: "right".into(),
            react: true,
            show_chat: true,
            mirror_chat: false,
            streamerbot: false,
            streamerbot_url: crate::stream::streamerbot::DEFAULT_URL.into(),
            twitch_channel: String::new(),
        }
    }
}

/// Auto-update (tauri-plugin-updater). On by default: a check is one small
/// HTTPS request to GitHub; nothing installs without the user's click.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct UpdateSettings {
    /// Check on start and once a day.
    pub auto_check: bool,
    /// "Later" on this version: no bubble for it until a day has passed.
    pub snoozed_version: Option<String>,
    /// Unix seconds of the "Later" click.
    pub snoozed_at: u64,
}

impl Default for UpdateSettings {
    fn default() -> Self {
        Self { auto_check: true, snoozed_version: None, snoozed_at: 0 }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct VoiceSettings {
    /// Mic button + hotkey. On by default, but nothing is loaded or
    /// downloaded until the first time the user talks.
    pub enabled: bool,
    /// Speech model id ("tiny", "base", "small"); `None` = pick by RAM.
    pub model: Option<String>,
    /// "auto" or a language code from `voice::LANGUAGES`.
    pub language: String,
    /// Read short replies aloud with the system voice.
    pub speak_replies: bool,
}

impl Default for VoiceSettings {
    fn default() -> Self {
        Self { enabled: true, model: None, language: "auto".into(), speak_replies: false }
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            model: None,
            movement_enabled: true,
            chaos_enabled: true,
            onboarding_done: false,
            ollama_url: ollama::DEFAULT_URL.to_string(),
            keep_alive: ollama::DEFAULT_KEEP_ALIVE.to_string(),
            memory_enabled: true,
            screen_enabled: true,
            notes_trusted: false,
            voice: VoiceSettings::default(),
            stream: StreamSettings::default(),
            updates: UpdateSettings::default(),
        }
    }
}

impl Settings {
    /// Load settings; a missing or unreadable file gives defaults rather than
    /// an error, so a corrupted file can never stop Glitch from starting.
    pub fn load(path: &Path) -> Self {
        match std::fs::read_to_string(path) {
            Err(_) => Self::default(),
            Ok(s) => serde_json::from_str(&s).unwrap_or_else(|_| {
                // Keep the broken file for inspection instead of overwriting it.
                let _ = std::fs::rename(path, path.with_extension("corrupt.json"));
                Self::default()
            }),
        }
    }

    /// Write atomically (temp file + rename) so a crash can't leave half a file.
    pub fn save(&self, path: &Path) -> io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(&tmp, path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_gives_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let s = Settings::load(&dir.path().join("nope.json"));
        assert_eq!(s, Settings::default());
        assert!(s.movement_enabled);
        assert!(s.chaos_enabled);
        assert!(s.screen_enabled && !s.notes_trusted);
        assert_eq!(s.keep_alive, "2m");
    }

    #[test]
    fn round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub/settings.json");
        let s = Settings {
            model: Some("qwen3.5:2b".into()),
            movement_enabled: false,
            onboarding_done: true,
            ..Default::default()
        };
        s.save(&path).unwrap();
        assert_eq!(Settings::load(&path), s);
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn corrupted_file_gives_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(Settings::load(&path), Settings::default());
    }

    #[test]
    fn unknown_and_missing_fields_are_tolerated() {
        // Older/newer versions of Glitch may write different fields.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{"model":"llama3.2:3b","future_option":42}"#).unwrap();
        let s = Settings::load(&path);
        assert_eq!(s.model.as_deref(), Some("llama3.2:3b"));
        assert!(s.movement_enabled);
    }

    #[test]
    fn voice_defaults_and_old_files() {
        let v = Settings::default().voice;
        assert!(v.enabled);
        assert_eq!(v.model, None);
        assert_eq!(v.language, "auto");
        assert!(!v.speak_replies);
        // A settings file from before voice existed.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{"model":"qwen3.5:2b","onboarding_done":true,"memory_enabled":false}"#).unwrap();
        let s = Settings::load(&path);
        assert!(s.onboarding_done && !s.memory_enabled);
        assert_eq!(s.voice, VoiceSettings::default());
        // Partial voice section: the rest falls back to defaults.
        std::fs::write(&path, r#"{"voice":{"model":"tiny","future":1}}"#).unwrap();
        let s = Settings::load(&path);
        assert_eq!(s.voice.model.as_deref(), Some("tiny"));
        assert!(s.voice.enabled);
        assert_eq!(s.voice.language, "auto");
        // Round trip.
        let s = Settings {
            voice: VoiceSettings {
                enabled: false,
                model: Some("small".into()),
                language: "de".into(),
                speak_replies: true,
            },
            ..Default::default()
        };
        s.save(&path).unwrap();
        assert_eq!(Settings::load(&path), s);
    }

    #[test]
    fn stream_and_updates_default_for_old_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{"model":"qwen3.5:2b"}"#).unwrap();
        let s = Settings::load(&path);
        assert!(!s.stream.enabled, "the overlay is off until turned on");
        assert_eq!(s.stream.port, 7799);
        assert_eq!(s.stream.mode, "mirror");
        assert!(!s.stream.mirror_chat, "private chats stay off stream");
        assert!(s.stream.token.is_empty());
        assert!(s.updates.auto_check);
        std::fs::write(&path, r#"{"stream":{"enabled":true,"twitch_channel":"x"},"updates":{"auto_check":false}}"#)
            .unwrap();
        let s = Settings::load(&path);
        assert!(s.stream.enabled && s.stream.react);
        assert_eq!(s.stream.twitch_channel, "x");
        assert!(!s.updates.auto_check);
        s.save(&path).unwrap();
        assert_eq!(Settings::load(&path), s);
    }
}
