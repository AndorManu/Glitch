//! User settings, stored as a small JSON file in the OS's app-config folder
//! (the Tauri shell decides the folder; this module only needs a path).

use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::ai::ollama;
use crate::context::ContextSettings;
use crate::safety::SafetySettings;

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
    /// How wild chaos mode is (Off / Gentle / Mischief / Full Virus). Gentle is
    /// the old behaviour and the default; `chaos_enabled == false` is "Off".
    pub chaos_level: crate::chaos2::ChaosLevel,
    /// The one-time "are you sure?" for Full Virus was confirmed in Settings.
    pub chaos_full_confirmed: bool,
    /// "Reduce effects": no screen effects (rain, melt, scanlines, clones...).
    /// `None` follows the OS animation setting.
    pub reduce_effects: Option<bool>,
    /// Chaos mode may also run while the stream overlay is on (off by default).
    pub chaos_during_stream: bool,
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
    /// Games, play and growth + the wardrobe (see play.rs). Missing in older files -> defaults.
    pub play: crate::play::PlaySettings,
    /// Streaming overlay (OBS browser source). Off by default.
    pub stream_overlay: StreamSettings,
    /// Update checks against GitHub Releases.
    pub auto_update: UpdateSettings,
    /// Feature "Let Glitch control apps" (multi-step app tasks: click, type,
    /// play). Off by default; missing in older files → off.
    pub hands_enabled: bool,
    /// "Smarter brain for app control": a bigger model used only for app
    /// tasks (`None`: the normal brain).
    pub hands_model: Option<String>,
    /// "He reacts to what you're doing" (music, coding, games, focus...).
    /// Missing in older files -> defaults (all on except focus auto-suggest).
    pub context: ContextSettings,
    /// "Update me": the local event endpoint, Claude Code buddy, the
    /// notification reader, reminders and the daily briefing.
    pub update_me: UpdateMeSettings,
    /// Panic button and "Start with Windows" (see `crate::safety`).
    pub safety: SafetySettings,
}

/// "Update me" features. Each one has its own switch in Settings → Features.
/// Connected or privacy-sensitive ones (Claude Code, notifications) start off.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct UpdateMeSettings {
    /// Local event endpoint (127.0.0.1 + per-install token) for scripts,
    /// builds and the Claude Code hook.
    pub endpoint_enabled: bool,
    /// React to Claude Code hook events (needs "Connect Claude Code" too).
    pub claude_code_enabled: bool,
    /// Read Windows' notification feed and offer a digest.
    pub notifications_enabled: bool,
    /// Quiet mode: collect the digest, but don't walk over with a sign.
    pub notifications_quiet: bool,
    /// Extra app names (case-insensitive substrings) never read, on top of
    /// the built-in banking / authenticator list.
    pub notifications_blocklist: Vec<String>,
    /// "Remind me to X at 5": saved reminders that survive restarts.
    pub reminders_enabled: bool,
    /// A short briefing on the first chat of the day.
    pub briefing_enabled: bool,
    /// Where the briefing's weather is for (`None`: no weather).
    pub location: Option<Location>,
}

/// A place picked in Settings (from Open-Meteo's geocoder).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Location {
    pub name: String,
    pub latitude: f64,
    pub longitude: f64,
}

impl Default for UpdateMeSettings {
    fn default() -> Self {
        Self {
            endpoint_enabled: true,
            claude_code_enabled: false,
            notifications_enabled: false,
            notifications_quiet: false,
            notifications_blocklist: Vec::new(),
            reminders_enabled: true,
            briefing_enabled: true,
            location: None,
        }
    }
}

/// The OBS overlay (src-tauri/src/stream/). Missing in older files: off.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct StreamSettings {
    pub enabled: bool,
    /// Port on 127.0.0.1 for the overlay page and the event webhook.
    pub port: u16,
    /// Secret in the OBS URL: only *reads* (page, config, events). Made on
    /// first start; "New link" replaces it.
    pub view_token: String,
    /// Secret for `POST /stream-event` (header only, never in a URL).
    pub write_token: String,
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
            view_token: String::new(),
            write_token: String::new(),
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

/// Secrets stay out of logs and panic messages.
impl std::fmt::Debug for StreamSettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let redact = |t: &str| if t.is_empty() { "" } else { "<redacted>" };
        f.debug_struct("StreamSettings")
            .field("enabled", &self.enabled)
            .field("port", &self.port)
            .field("view_token", &redact(&self.view_token))
            .field("write_token", &redact(&self.write_token))
            .field("mode", &self.mode)
            .field("size", &self.size)
            .field("position", &self.position)
            .field("react", &self.react)
            .field("show_chat", &self.show_chat)
            .field("mirror_chat", &self.mirror_chat)
            .field("streamerbot", &self.streamerbot)
            .field("streamerbot_url", &self.streamerbot_url)
            .field("twitch_channel", &self.twitch_channel)
            .finish()
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
    /// Read short replies aloud.
    pub speak_replies: bool,
    /// Listen for "Hey Glitch" all the time (the mic stays open while
    /// armed). Off unless the user turns it on.
    pub wake_word: bool,
    /// Voice for reading aloud: "system" (the OS voice) or "glitch" (the
    /// downloaded character voice; falls back to "system" if missing).
    pub read_aloud_voice: String,
}

impl Default for VoiceSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            model: None,
            language: "auto".into(),
            speak_replies: false,
            wake_word: false,
            read_aloud_voice: "system".into(),
        }
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            model: None,
            movement_enabled: true,
            chaos_enabled: true,
            chaos_level: crate::chaos2::ChaosLevel::Gentle,
            chaos_full_confirmed: false,
            reduce_effects: None,
            chaos_during_stream: false,
            onboarding_done: false,
            ollama_url: ollama::DEFAULT_URL.to_string(),
            keep_alive: ollama::DEFAULT_KEEP_ALIVE.to_string(),
            memory_enabled: true,
            screen_enabled: true,
            notes_trusted: false,
            voice: VoiceSettings::default(),
            play: crate::play::PlaySettings::default(),
            stream_overlay: StreamSettings::default(),
            auto_update: UpdateSettings::default(),
            hands_enabled: false,
            hands_model: None,
            context: ContextSettings::default(),
            update_me: UpdateMeSettings::default(),
            safety: SafetySettings::default(),
        }
    }
}

impl Settings {
    /// The level chaos mode actually runs at: Off if switched off (or if
    /// Glitch may not move), Full Virus only once confirmed.
    pub fn chaos_effective(&self) -> crate::chaos2::ChaosLevel {
        if !self.chaos_enabled || !self.movement_enabled {
            return crate::chaos2::ChaosLevel::Off;
        }
        self.chaos_level.confirmed(self.chaos_full_confirmed)
    }
}

/// What loading found wrong with a settings file (nothing to report: the
/// file was fine or did not exist).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Recovery {
    /// The original file was copied or moved here before it can be overwritten.
    pub backup: Option<PathBuf>,
    /// Fields that could not be read and fell back to their defaults
    /// ("voice.language"); everything else was kept. Empty when the whole
    /// file was unreadable.
    pub dropped: Vec<String>,
    /// The file was not JSON at all (or not an object): all defaults.
    pub unreadable: bool,
}

/// `settings.json` -> `settings.json.bak`, or the first free `.bak2` .. `.bak9`
/// (an earlier backup of an earlier problem is never overwritten while there
/// is room; after that the plain `.bak` is replaced).
fn backup_path(path: &Path) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "settings.json".into());
    let candidate = |n: u32| path.with_file_name(if n == 1 { format!("{name}.bak") } else { format!("{name}.bak{n}") });
    (1..=9).map(candidate).find(|p| !p.exists()).unwrap_or_else(|| candidate(1))
}

/// Follow `path` down from `root`.
fn slot_at<'a>(root: &'a mut serde_json::Value, path: &[String]) -> Option<&'a mut serde_json::Value> {
    let mut slot = root;
    for part in path {
        slot = slot.get_mut(part)?;
    }
    Some(slot)
}

/// Walk the fields of `file` into `root` (a full default settings value),
/// keeping each one only if the whole thing still parses as [`Settings`]; a
/// section that fails as a whole is retried field by field.
fn merge_valid(
    root: &mut serde_json::Value,
    path: &mut Vec<String>,
    file: &serde_json::Value,
    dropped: &mut Vec<String>,
) {
    let Some(file) = file.as_object() else { return };
    for (key, value) in file {
        path.push(key.clone());
        // Unknown keys (newer versions, old experiments) are ignored.
        if let Some(slot) = slot_at(root, path) {
            let old = std::mem::replace(slot, value.clone());
            if serde_json::from_value::<Settings>(root.clone()).is_err() {
                if let Some(slot) = slot_at(root, path) {
                    *slot = old.clone();
                }
                if old.is_object() && value.is_object() {
                    merge_valid(root, path, value, dropped);
                } else {
                    dropped.push(path.join("."));
                }
            }
        }
        path.pop();
    }
}

impl Settings {
    /// Load settings; a missing or unreadable file gives defaults rather than
    /// an error, so a corrupted file can never stop Glitch from starting.
    /// See [`Settings::load_with_report`] for what was repaired.
    pub fn load(path: &Path) -> Self {
        Self::load_with_report(path).0
    }

    /// Like [`Settings::load`], and says what had to be repaired:
    ///
    /// * missing or empty file: defaults, nothing to report;
    /// * valid file: used as is (missing fields take their defaults, unknown
    ///   fields are ignored, a UTF-8 byte-order mark is fine);
    /// * valid JSON where some field has the wrong type or an impossible value
    ///   (hand edit, other version): that field falls back to its default and
    ///   every other field is kept; the original is copied to `settings.json.bak`;
    /// * not JSON (or not an object): defaults, the file is moved to
    ///   `settings.json.bak` so nothing is lost.
    pub fn load_with_report(path: &Path) -> (Self, Recovery) {
        let Ok(bytes) = std::fs::read(path) else { return (Self::default(), Recovery::default()) };
        let text = String::from_utf8_lossy(&bytes);
        let text = text.trim_start_matches('\u{feff}');
        if text.trim().is_empty() {
            return (Self::default(), Recovery::default());
        }
        let fix = |s: Settings| Settings { safety: s.safety.sanitized(), ..s };
        let value: serde_json::Value = match serde_json::from_str(text) {
            Ok(v @ serde_json::Value::Object(_)) => v,
            _ => {
                let backup = backup_path(path);
                let kept = std::fs::rename(path, &backup).is_ok().then_some(backup);
                return (Self::default(), Recovery { backup: kept, dropped: Vec::new(), unreadable: true });
            }
        };
        if let Ok(s) = serde_json::from_value::<Settings>(value.clone()) {
            return (fix(s), Recovery::default());
        }
        let mut root = serde_json::to_value(Self::default()).expect("settings serialize");
        let mut dropped = Vec::new();
        merge_valid(&mut root, &mut Vec::new(), &value, &mut dropped);
        let settings = serde_json::from_value::<Settings>(root).unwrap_or_default();
        let backup = backup_path(path);
        let kept = std::fs::copy(path, &backup).is_ok().then_some(backup);
        (fix(settings), Recovery { backup: kept, dropped, unreadable: false })
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
        assert!(!s.hands_enabled && s.hands_model.is_none(), "app control is off by default");
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
        // Kept for inspection, not deleted.
        assert_eq!(std::fs::read_to_string(path.with_file_name("settings.json.bak")).unwrap(), "{ not json");
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
    fn update_defaults_and_old_files() {
        let u = Settings::default().update_me;
        // Connected / privacy-sensitive: off. Local and harmless: on.
        assert!(!u.claude_code_enabled && !u.notifications_enabled && !u.notifications_quiet);
        assert!(u.endpoint_enabled && u.reminders_enabled && u.briefing_enabled);
        assert_eq!(u.location, None);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{"model":"qwen3.5:4b","update_me":{"notifications_enabled":true}}"#).unwrap();
        let s = Settings::load(&path);
        assert!(s.update_me.notifications_enabled && s.update_me.reminders_enabled);
    }

    #[test]
    fn voice_defaults_and_old_files() {
        let v = Settings::default().voice;
        assert!(v.enabled);
        assert_eq!(v.model, None);
        assert_eq!(v.language, "auto");
        assert!(!v.speak_replies);
        assert!(!v.wake_word, "the always-on mic is opt-in");
        assert_eq!(v.read_aloud_voice, "system");
        // A settings file from before voice existed.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{"model":"qwen3.5:2b","onboarding_done":true,"memory_enabled":false}"#).unwrap();
        let s = Settings::load(&path);
        assert!(s.onboarding_done && !s.memory_enabled);
        assert_eq!(s.voice, VoiceSettings::default());
        assert_eq!(s.context, ContextSettings::default());
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
                wake_word: true,
                read_aloud_voice: "glitch".into(),
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
        assert!(!s.stream_overlay.enabled, "the overlay is off until turned on");
        assert_eq!(s.stream_overlay.port, 7799);
        assert_eq!(s.stream_overlay.mode, "mirror");
        assert!(!s.stream_overlay.mirror_chat, "private chats stay off stream");
        assert!(s.stream_overlay.view_token.is_empty() && s.stream_overlay.write_token.is_empty());
        assert!(s.auto_update.auto_check);
        let json = r#"{"stream_overlay":{"enabled":true,"twitch_channel":"x"},"auto_update":{"auto_check":false}}"#;
        std::fs::write(&path, json).unwrap();
        let s = Settings::load(&path);
        assert!(s.stream_overlay.enabled && s.stream_overlay.react);
        assert_eq!(s.stream_overlay.twitch_channel, "x");
        assert!(!s.auto_update.auto_check);
        s.save(&path).unwrap();
        assert_eq!(Settings::load(&path), s);
    }

    #[test]
    fn tokens_never_show_in_debug_output() {
        let mut s = Settings::default();
        s.stream_overlay.view_token = "viewsecret123".into();
        s.stream_overlay.write_token = "writesecret456".into();
        let d = format!("{s:?}");
        assert!(!d.contains("viewsecret123") && !d.contains("writesecret456"));
        assert!(d.contains("<redacted>"));
    }
}
