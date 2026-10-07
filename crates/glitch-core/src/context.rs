//! "He reacts to what you're doing": the pure rules behind Glitch's context
//! reactions (music, coding, games, videos, late nights, battery, CPU) and
//! the focus timer (Pomodoro buddy). The OS readings come from
//! `src-tauri/src/context_native.rs` as a [`Snapshot`] every few seconds;
//! everything that decides *whether* and *when* he reacts lives here, so it
//! is unit-tested on every OS.
//!
//! Privacy: a snapshot holds only classifications (an app *kind*, booleans,
//! numbers). Window titles and track names are looked at on the spot by the
//! native side and never stored or logged; the track title is only read when
//! the user asks for it (the `now_playing` tool).
//!
//! No spam: every reaction has a cooldown and a per-poll chance, there is a
//! global gap between any two reactions, nothing fires while the caller says
//! it's blocked (chat open), while the user is away, while he is quiet
//! (fullscreen/game) or while a focus session runs.

use std::time::Duration;

use serde::{Deserialize, Serialize};

// ------------------------------------------------------------ settings

/// Settings for the feature (part of `Settings`, `context` key). Missing in
/// older files: everything on except the focus auto-suggest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ContextSettings {
    /// Master switch for the whole feature.
    pub enabled: bool,
    /// Something is playing: he dances now and then.
    pub music: bool,
    /// Code editor / terminal in front: tiny glasses, typing beside you.
    pub coding: bool,
    /// Fullscreen / game launcher: quiet in a corner, no chaos, no pop-ups.
    pub quiet_fullscreen: bool,
    /// A video playing in the window in front: he sits on it and watches.
    pub video: bool,
    /// Late night: yawns, a gentle "go to sleep" at most once an hour.
    pub late_night: bool,
    /// "HH:MM" local time, start of the late-night window.
    pub night_start: String,
    /// "HH:MM" local time, end of the late-night window.
    pub night_end: String,
    /// A morning stretch, once a day.
    pub morning: bool,
    /// Battery under 15 % and not charging: worried, once per drop.
    pub battery: bool,
    /// CPU above 85 % for 30 s: sweats and fans himself.
    pub cpu: bool,
    /// Focus mode (tray / chat) is available.
    pub focus: bool,
    /// Suggest a focus session after a long coding stretch. Off by default.
    pub focus_suggest: bool,
    /// Default focus session length (minutes).
    pub focus_minutes: u32,
    /// Break after a session (minutes).
    pub break_minutes: u32,
}

impl Default for ContextSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            music: true,
            coding: true,
            quiet_fullscreen: true,
            video: true,
            late_night: true,
            night_start: "00:30".into(),
            night_end: "05:00".into(),
            morning: true,
            battery: true,
            cpu: true,
            focus: true,
            focus_suggest: false,
            focus_minutes: 25,
            break_minutes: 5,
        }
    }
}

/// "HH:MM" -> minutes after midnight.
pub fn parse_hhmm(s: &str) -> Option<u32> {
    let (h, m) = s.trim().split_once(':')?;
    let (h, m): (u32, u32) = (h.trim().parse().ok()?, m.trim().parse().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

/// Local time now: (minutes after midnight, a day number that changes at midnight).
pub fn local_clock() -> (u32, i64) {
    use chrono::{Datelike, Timelike};
    let now = chrono::Local::now();
    (now.hour() * 60 + now.minute(), i64::from(now.num_days_from_ce()))
}

/// Is `minute` (after midnight) inside [start, end)? Wraps past midnight.
pub fn in_window(minute: u32, start: u32, end: u32) -> bool {
    if start == end {
        return false;
    }
    if start < end {
        minute >= start && minute < end
    } else {
        minute >= start || minute < end
    }
}

// ------------------------------------------------------------ classifying apps

/// What kind of app is in front (or plays the media).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AppKind {
    Coding,
    Browser,
    VideoPlayer,
    GameLauncher,
    Other,
}

const CODING: &[&str] = &[
    "code",
    "code - insiders",
    "codium",
    "vscodium",
    "cursor",
    "windsurf",
    "devenv",
    "idea",
    "idea64",
    "pycharm",
    "pycharm64",
    "webstorm",
    "webstorm64",
    "clion",
    "clion64",
    "rider",
    "rider64",
    "goland",
    "goland64",
    "phpstorm",
    "phpstorm64",
    "rubymine",
    "rubymine64",
    "datagrip",
    "datagrip64",
    "rustrover",
    "rustrover64",
    "studio",
    "studio64",
    "fleet",
    "zed",
    "sublime_text",
    "nvim-qt",
    "neovide",
    "windowsterminal",
    "wt",
    "cmd",
    "powershell",
    "pwsh",
    "wezterm-gui",
    "alacritty",
    "mintty",
    "conemu64",
    "hyper",
    "tabby",
    "warp",
    "kitty",
    "terminal",
    "iterm2",
    "ghostty",
    "xcode",
];

const BROWSERS: &[&str] = &[
    "chrome",
    "msedge",
    "firefox",
    "brave",
    "opera",
    "opera_gx",
    "vivaldi",
    "arc",
    "safari",
    "librewolf",
    "waterfox",
    "zen",
    "chromium",
    "google chrome",
    "microsoft edge",
];

const VIDEO_PLAYERS: &[&str] = &[
    "vlc",
    "mpc-hc",
    "mpc-hc64",
    "mpc-be",
    "mpc-be64",
    "potplayer",
    "potplayermini",
    "potplayermini64",
    "mpv",
    "wmplayer",
    "video.ui",
    "microsoft.media.player",
    "iina",
    "quicktime player",
    "plex",
    "netflix",
    "kodi",
];

const GAME_LAUNCHERS: &[&str] = &[
    "steam",
    "steamwebhelper",
    "epicgameslauncher",
    "battle.net",
    "riotclientservices",
    "riotclientux",
    "leagueclientux",
    "galaxyclient",
    "eadesktop",
    "origin",
    "upc",
    "ubisoftconnect",
    "xboxpcapp",
    "playnite.desktopapp",
    "playnite.fullscreenapp",
    "heroic",
    "itch",
    "minecraftlauncher",
    "robloxplayerbeta",
];

/// Classify a process by its executable name ("Code.exe", "C:\\...\\chrome.exe",
/// "Visual Studio Code"). Case and the ".exe"/".app" suffix don't matter.
pub fn classify_app(exe: &str) -> AppKind {
    let name = exe.rsplit(['\\', '/']).next().unwrap_or(exe).trim().to_lowercase();
    let stem = name.strip_suffix(".exe").or_else(|| name.strip_suffix(".app")).unwrap_or(&name);
    let is = |list: &[&str]| list.contains(&stem);
    if is(CODING) {
        AppKind::Coding
    } else if is(BROWSERS) {
        AppKind::Browser
    } else if is(VIDEO_PLAYERS) {
        AppKind::VideoPlayer
    } else if is(GAME_LAUNCHERS) {
        AppKind::GameLauncher
    } else {
        AppKind::Other
    }
}

/// Window title of a browser tab that's a video site. Only looked at, never kept.
pub fn is_video_site_title(title: &str) -> bool {
    const SITES: &[&str] = &[
        "youtube",
        "netflix",
        "twitch",
        "prime video",
        "disney+",
        "hulu",
        "vimeo",
        "crunchyroll",
        "dailymotion",
        "jellyfin",
        "plex",
        "hbo max",
    ];
    let t = title.to_lowercase();
    SITES.iter().any(|s| t.contains(s))
}

/// Does a media session's app id (Windows AUMID, e.g. "Chrome", "Spotify.exe",
/// "308046B0AF4A39CB" for Firefox, "Microsoft.ZuneVideo_8wekyb3d8bbwe!...")
/// belong to the foreground process `exe`?
pub fn same_app(session_app: &str, exe: &str) -> bool {
    let exe = exe.rsplit(['\\', '/']).next().unwrap_or(exe).to_lowercase();
    let stem = exe.strip_suffix(".exe").unwrap_or(&exe);
    let app = session_app.to_lowercase();
    if stem.is_empty() || app.is_empty() {
        return false;
    }
    app.contains(stem)
        || (stem == "msedge" && app.contains("edge"))
        || (stem == "firefox" && app == "308046b0af4a39cb")
        || (stem == "video.ui" && app.contains("zunevideo"))
}

// ------------------------------------------------------------ snapshots

/// What the native side saw this poll. No titles, no track names.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Snapshot {
    /// The app in front (None: the desktop / Glitch himself / unknown).
    pub fg: Option<Foreground>,
    /// The system media session, if any.
    pub media: Option<Media>,
    pub battery: Option<Battery>,
    /// Whole-system CPU use, 0-100.
    pub cpu: Option<f32>,
    /// Windows says "busy" (D3D fullscreen, presentation mode, do not disturb).
    pub os_busy: bool,
    /// ms since the last keyboard/mouse input (None: unknown).
    pub idle_ms: Option<u32>,
    /// Local time: minutes after midnight, and a day number (changes at midnight).
    pub minute: u32,
    pub day: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Foreground {
    /// Window id (HWND), same as its ledge id.
    pub id: u64,
    pub kind: AppKind,
    /// Covers its whole monitor (and isn't just maximised).
    pub fullscreen: bool,
    /// A browser tab whose title is a video site (checked on the spot).
    pub video_site: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Media {
    pub playing: bool,
    /// The session says it's a video.
    pub video: bool,
    /// The session belongs to the app in front.
    pub fg_app: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Battery {
    pub percent: u8,
    pub charging: bool,
}

// ------------------------------------------------------------ reactions

/// What the mascot should do. Sent to the page as the "context" event.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Reaction {
    /// Music is playing: dance a little ("dance_beat").
    Dance { bpm: u32 },
    /// Coding: glasses on, typing ("glasses_type").
    GlassesType,
    /// A video plays in window `window`: sit on its top and watch ("watch_tv").
    WatchTv { window: u64 },
    /// Late night: yawn; `say`: also the gentle "go to sleep" (the shell shows it).
    LateNight { say: bool },
    /// Morning stretch.
    Morning,
    /// Battery low and draining ("worried_battery").
    BatteryLow { percent: u8 },
    /// CPU busy for a while ("sweat_fan").
    CpuHot,
    /// Fullscreen / game / presentation started (true) or ended (false).
    Quiet { on: bool },
    /// Coded for a long stretch: suggest a focus session (the shell says it).
    SuggestFocus,
}

impl Reaction {
    /// Debug trigger names (`GLITCH_CONTEXT_DEBUG`, `__glitch.react`).
    pub const DEBUG_NAMES: [&'static str; 10] =
        ["dance", "glasses", "watch", "night", "morning", "battery", "cpu", "quiet", "unquiet", "suggest"];

    /// The reaction a debug trigger name stands for.
    pub fn debug(name: &str, window: u64) -> Option<Self> {
        Some(match name {
            "dance" => Reaction::Dance { bpm: GROOVE_BPM },
            "glasses" => Reaction::GlassesType,
            "watch" => Reaction::WatchTv { window },
            "night" => Reaction::LateNight { say: true },
            "morning" => Reaction::Morning,
            "battery" => Reaction::BatteryLow { percent: 12 },
            "cpu" => Reaction::CpuHot,
            "quiet" => Reaction::Quiet { on: true },
            "unquiet" => Reaction::Quiet { on: false },
            "suggest" => Reaction::SuggestFocus,
            _ => return None,
        })
    }
}

/// The OS gives no tempo, so he keeps a fixed, friendly groove.
pub const GROOVE_BPM: u32 = 112;
/// At least this long between any two reactions.
pub const MIN_GAP: Duration = Duration::from_secs(45);
/// User away longer than this: nobody to react for.
pub const AWAY_MS: u32 = 3 * 60_000;
pub const BATTERY_LOW: u8 = 15;
/// Battery must climb back to this (or charge) before he worries again.
pub const BATTERY_REARM: u8 = 20;
pub const CPU_HOT: f32 = 85.0;
pub const CPU_COOL: f32 = 70.0;
pub const CPU_SUSTAIN: Duration = Duration::from_secs(30);
/// Quiet ends only after this many calm polls in a row (alt-tab flicker).
pub const QUIET_OFF_POLLS: u32 = 2;
pub const NIGHT_SAY_EVERY: Duration = Duration::from_secs(60 * 60);
/// Coding this long without a break before he suggests a focus session.
pub const SUGGEST_AFTER: Duration = Duration::from_secs(20 * 60);
/// Morning stretch window, local minutes.
pub const MORNING: (u32, u32) = (6 * 60, 10 * 60 + 30);

/// Cooldown and per-poll chance (the poll is every few seconds).
#[derive(Debug, Clone, Copy)]
struct Rule {
    cooldown: Duration,
    chance: f64,
}

const DANCE: Rule = Rule { cooldown: Duration::from_secs(4 * 60), chance: 0.08 };
const GLASSES: Rule = Rule { cooldown: Duration::from_secs(6 * 60), chance: 0.06 };
const WATCH: Rule = Rule { cooldown: Duration::from_secs(5 * 60), chance: 0.15 };
const NIGHT: Rule = Rule { cooldown: Duration::from_secs(20 * 60), chance: 0.1 };
const CPU: Rule = Rule { cooldown: Duration::from_secs(10 * 60), chance: 1.0 };
const SUGGEST: Rule = Rule { cooldown: Duration::from_secs(2 * 60 * 60), chance: 1.0 };

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Slot {
    Dance,
    Glasses,
    Watch,
    Night,
    Cpu,
    Suggest,
}

/// What the caller knows that the snapshot doesn't.
#[derive(Debug, Clone, Copy, Default)]
pub struct Gate {
    /// The chat is open (or something else says "not now"): no reactions,
    /// but state (quiet, battery, CPU timers) still follows the snapshot.
    pub blocked: bool,
    /// A focus session runs: he guards quietly, no reactions.
    pub focusing: bool,
}

/// The state machine. `tick` once per poll.
#[derive(Debug, Default)]
pub struct Sensor {
    last: std::collections::HashMap<Slot, Duration>,
    last_any: Option<Duration>,
    quiet: bool,
    calm_polls: u32,
    cpu_since: Option<Duration>,
    cpu_fired: bool,
    battery_fired: bool,
    night_said: Option<Duration>,
    morning_day: Option<i64>,
    coding_since: Option<Duration>,
}

impl Sensor {
    pub fn quiet(&self) -> bool {
        self.quiet
    }

    /// Debug triggers: act as if a fullscreen app just started (the next
    /// calm polls end it again).
    pub fn force_quiet(&mut self) {
        self.quiet = true;
        self.calm_polls = 0;
    }

    /// Forget the quiet state (feature switched off): returns whether it was on.
    pub fn reset_quiet(&mut self) -> bool {
        std::mem::take(&mut self.quiet)
    }

    fn ready(&self, slot: Slot, rule: Rule, now: Duration) -> bool {
        self.last.get(&slot).is_none_or(|t| now.saturating_sub(*t) >= rule.cooldown)
    }

    fn fire(&mut self, slot: Slot, now: Duration) {
        self.last.insert(slot, now);
        self.last_any = Some(now);
    }

    /// One poll. `roll` gives uniform random numbers in [0, 1).
    pub fn tick(
        &mut self,
        snap: &Snapshot,
        now: Duration,
        cfg: &ContextSettings,
        gate: Gate,
        roll: &mut dyn FnMut() -> f64,
    ) -> Vec<Reaction> {
        let mut out = Vec::new();
        if !cfg.enabled {
            if self.reset_quiet() {
                out.push(Reaction::Quiet { on: false });
            }
            return out;
        }

        // Quiet: fullscreen, a game launcher in front, or Windows says busy.
        let fg = snap.fg.as_ref();
        let loud = cfg.quiet_fullscreen
            && (snap.os_busy || fg.is_some_and(|f| f.fullscreen || f.kind == AppKind::GameLauncher));
        if loud {
            self.calm_polls = 0;
            if !self.quiet {
                self.quiet = true;
                out.push(Reaction::Quiet { on: true });
            }
        } else if self.quiet {
            self.calm_polls += 1;
            if self.calm_polls >= QUIET_OFF_POLLS || !cfg.quiet_fullscreen {
                self.quiet = false;
                out.push(Reaction::Quiet { on: false });
                // Just back from a game: give him a moment.
                self.last_any = Some(now);
            }
        }

        // State that follows the snapshot even when he can't react.
        let cpu_hot = snap.cpu.is_some_and(|c| c >= CPU_HOT);
        if cpu_hot {
            self.cpu_since.get_or_insert(now);
        } else if snap.cpu.is_none_or(|c| c < CPU_COOL) {
            self.cpu_since = None;
            self.cpu_fired = false;
        }
        let battery_low = snap.battery.is_some_and(|b| !b.charging && b.percent < BATTERY_LOW);
        if snap.battery.is_some_and(|b| b.charging || b.percent >= BATTERY_REARM) {
            self.battery_fired = false;
        }
        let coding = fg.is_some_and(|f| f.kind == AppKind::Coding);
        if coding && !gate.focusing {
            self.coding_since.get_or_insert(now);
        } else if !coding {
            self.coding_since = None;
        }

        let away = snap.idle_ms.is_some_and(|i| i >= AWAY_MS);
        if self.quiet || gate.blocked || gate.focusing || away {
            return out;
        }
        if self.last_any.is_some_and(|t| now.saturating_sub(t) < MIN_GAP) {
            return out;
        }
        let r = roll();

        // Most important first; one reaction per poll.
        if cfg.battery && battery_low && !self.battery_fired {
            self.battery_fired = true;
            self.last_any = Some(now);
            out.push(Reaction::BatteryLow { percent: snap.battery.map_or(0, |b| b.percent) });
            return out;
        }
        if cfg.cpu
            && !self.cpu_fired
            && self.cpu_since.is_some_and(|t| now.saturating_sub(t) >= CPU_SUSTAIN)
            && self.ready(Slot::Cpu, CPU, now)
        {
            self.cpu_fired = true;
            self.fire(Slot::Cpu, now);
            out.push(Reaction::CpuHot);
            return out;
        }
        if cfg.morning && in_window(snap.minute, MORNING.0, MORNING.1) && self.morning_day != Some(snap.day) {
            self.morning_day = Some(snap.day);
            self.last_any = Some(now);
            out.push(Reaction::Morning);
            return out;
        }
        if cfg.late_night {
            let start = parse_hhmm(&cfg.night_start).unwrap_or(30);
            let end = parse_hhmm(&cfg.night_end).unwrap_or(300);
            if in_window(snap.minute, start, end) && self.ready(Slot::Night, NIGHT, now) && r < NIGHT.chance {
                let say = self.night_said.is_none_or(|t| now.saturating_sub(t) >= NIGHT_SAY_EVERY);
                if say {
                    self.night_said = Some(now);
                }
                self.fire(Slot::Night, now);
                out.push(Reaction::LateNight { say });
                return out;
            }
        }
        if cfg.focus
            && cfg.focus_suggest
            && self.coding_since.is_some_and(|t| now.saturating_sub(t) >= SUGGEST_AFTER)
            && self.ready(Slot::Suggest, SUGGEST, now)
        {
            self.fire(Slot::Suggest, now);
            out.push(Reaction::SuggestFocus);
            return out;
        }
        let media = snap.media.filter(|m| m.playing);
        let video_in_front = media.is_some_and(|m| {
            m.fg_app
                && fg.is_some_and(|f| {
                    !f.fullscreen
                        && (m.video || f.kind == AppKind::VideoPlayer || (f.kind == AppKind::Browser && f.video_site))
                })
        });
        if cfg.video && video_in_front && self.ready(Slot::Watch, WATCH, now) && r < WATCH.chance {
            self.fire(Slot::Watch, now);
            out.push(Reaction::WatchTv { window: fg.map_or(0, |f| f.id) });
            return out;
        }
        if cfg.music && media.is_some() && !video_in_front && self.ready(Slot::Dance, DANCE, now) && r < DANCE.chance {
            self.fire(Slot::Dance, now);
            out.push(Reaction::Dance { bpm: GROOVE_BPM });
            return out;
        }
        if cfg.coding && coding && self.ready(Slot::Glasses, GLASSES, now) && r < GLASSES.chance {
            self.fire(Slot::Glasses, now);
            out.push(Reaction::GlassesType);
        }
        out
    }
}

// ------------------------------------------------------------ focus timer

pub const MIN_FOCUS_MINUTES: u32 = 1;
pub const MAX_FOCUS_MINUTES: u32 = 180;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum FocusPhase {
    Off,
    Focus { minutes: u32 },
    Break { minutes: u32 },
}

/// What happened when the clock ran out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FocusEvent {
    /// The session is over: celebrate, start the break.
    Done { minutes: u32, break_minutes: u32 },
    /// The break is over.
    BreakOver,
}

/// A Pomodoro timer on a monotonic clock (`now` = time since some start).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Focus {
    pub phase: FocusPhase,
    ends: Duration,
    break_minutes: u32,
}

impl Default for Focus {
    fn default() -> Self {
        Self { phase: FocusPhase::Off, ends: Duration::ZERO, break_minutes: 5 }
    }
}

impl Focus {
    /// Start (or restart) a session. Minutes are clamped to 1..=180.
    pub fn start(&mut self, now: Duration, minutes: u32, break_minutes: u32) -> u32 {
        let minutes = minutes.clamp(MIN_FOCUS_MINUTES, MAX_FOCUS_MINUTES);
        self.phase = FocusPhase::Focus { minutes };
        self.ends = now + Duration::from_secs(u64::from(minutes) * 60);
        self.break_minutes = break_minutes.clamp(1, 60);
        minutes
    }

    pub fn stop(&mut self) {
        self.phase = FocusPhase::Off;
    }

    pub fn focusing(&self) -> bool {
        matches!(self.phase, FocusPhase::Focus { .. })
    }

    /// Time left in the current phase.
    pub fn remaining(&self, now: Duration) -> Option<Duration> {
        match self.phase {
            FocusPhase::Off => None,
            _ => Some(self.ends.saturating_sub(now)),
        }
    }

    pub fn tick(&mut self, now: Duration) -> Option<FocusEvent> {
        if now < self.ends {
            return None;
        }
        match self.phase {
            FocusPhase::Off => None,
            FocusPhase::Focus { minutes } => {
                let b = self.break_minutes;
                self.phase = FocusPhase::Break { minutes: b };
                self.ends = now + Duration::from_secs(u64::from(b) * 60);
                Some(FocusEvent::Done { minutes, break_minutes: b })
            }
            FocusPhase::Break { .. } => {
                self.phase = FocusPhase::Off;
                Some(FocusEvent::BreakOver)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(s: u64) -> Duration {
        Duration::from_secs(s)
    }

    fn snap() -> Snapshot {
        Snapshot { idle_ms: Some(0), minute: 14 * 60, day: 1, ..Default::default() }
    }

    fn fg(kind: AppKind) -> Option<Foreground> {
        Some(Foreground { id: 7, kind, fullscreen: false, video_site: false })
    }

    /// Run polls every 4 s from `from` for `polls` polls with a fixed roll.
    fn run(s: &mut Sensor, snap: &Snapshot, from: u64, polls: u64, roll: f64, gate: Gate) -> Vec<(u64, Reaction)> {
        let cfg = ContextSettings::default();
        let mut out = Vec::new();
        for i in 0..polls {
            let t = from + i * 4;
            for r in s.tick(snap, secs(t), &cfg, gate, &mut || roll) {
                out.push((t, r));
            }
        }
        out
    }

    #[test]
    fn defaults() {
        let c = ContextSettings::default();
        assert!(c.enabled && c.music && c.coding && c.quiet_fullscreen && c.video && c.late_night);
        assert!(c.morning && c.battery && c.cpu && c.focus);
        assert!(!c.focus_suggest, "focus auto-suggest is off by default");
        assert_eq!((c.night_start.as_str(), c.night_end.as_str()), ("00:30", "05:00"));
        assert_eq!((c.focus_minutes, c.break_minutes), (25, 5));
        // Partial / old settings files.
        let c: ContextSettings = serde_json::from_str(r#"{"music":false,"future":1}"#).unwrap();
        assert!(!c.music && c.coding);
    }

    #[test]
    fn time_windows() {
        assert_eq!(parse_hhmm("00:30"), Some(30));
        assert_eq!(parse_hhmm(" 5:00 "), Some(300));
        assert_eq!(parse_hhmm("24:00"), None);
        assert_eq!(parse_hhmm("x"), None);
        assert!(in_window(60, 30, 300));
        assert!(!in_window(301, 30, 300));
        // Wrapping past midnight.
        assert!(in_window(23 * 60 + 30, 22 * 60, 300));
        assert!(in_window(10, 22 * 60, 300));
        assert!(!in_window(12 * 60, 22 * 60, 300));
        assert!(!in_window(10, 10, 10));
    }

    #[test]
    fn classifies_apps() {
        assert_eq!(classify_app("Code.exe"), AppKind::Coding);
        assert_eq!(classify_app(r"C:\Program Files\JetBrains\bin\idea64.exe"), AppKind::Coding);
        assert_eq!(classify_app("WindowsTerminal.exe"), AppKind::Coding);
        assert_eq!(classify_app("devenv.exe"), AppKind::Coding);
        assert_eq!(classify_app("chrome.exe"), AppKind::Browser);
        assert_eq!(classify_app("vlc.exe"), AppKind::VideoPlayer);
        assert_eq!(classify_app("steamwebhelper.exe"), AppKind::GameLauncher);
        assert_eq!(classify_app("EpicGamesLauncher.exe"), AppKind::GameLauncher);
        assert_eq!(classify_app("notepad.exe"), AppKind::Other);
        assert_eq!(classify_app(""), AppKind::Other);
        assert!(is_video_site_title("Never Gonna Give You Up - YouTube - Google Chrome"));
        assert!(!is_video_site_title("Inbox - Gmail"));
        assert!(same_app("Chrome", "chrome.exe"));
        assert!(same_app("MSEdge", "msedge.exe"));
        assert!(same_app("308046B0AF4A39CB", "firefox.exe"));
        assert!(same_app("Spotify.exe", "Spotify.exe"));
        assert!(!same_app("Spotify.exe", "chrome.exe"));
        assert!(!same_app("", "chrome.exe"));
    }

    #[test]
    fn quiet_on_fullscreen_and_launchers_with_hysteresis() {
        let mut s = Sensor::default();
        let mut game = snap();
        game.fg = Some(Foreground { id: 1, kind: AppKind::Other, fullscreen: true, video_site: false });
        let r = run(&mut s, &game, 0, 3, 0.0, Gate::default());
        assert_eq!(r, vec![(0, Reaction::Quiet { on: true })], "one transition, nothing else while quiet");
        // One calm poll (alt-tab) isn't enough.
        let calm = snap();
        assert!(run(&mut s, &calm, 20, 1, 0.9, Gate::default()).is_empty());
        assert!(s.quiet());
        assert_eq!(run(&mut s, &calm, 24, 1, 0.9, Gate::default()), vec![(24, Reaction::Quiet { on: false })]);
        // Launcher and OS busy also count.
        let mut launcher = snap();
        launcher.fg = fg(AppKind::GameLauncher);
        assert_eq!(run(&mut s, &launcher, 40, 1, 0.9, Gate::default()), vec![(40, Reaction::Quiet { on: true })]);
        let mut s = Sensor::default();
        let busy = Snapshot { os_busy: true, ..snap() };
        assert_eq!(run(&mut s, &busy, 0, 1, 0.9, Gate::default()), vec![(0, Reaction::Quiet { on: true })]);
        // Switched off: quiet ends.
        let cfg = ContextSettings { enabled: false, ..Default::default() };
        assert_eq!(s.tick(&busy, secs(8), &cfg, Gate::default(), &mut || 0.0), vec![Reaction::Quiet { on: false }]);
    }

    #[test]
    fn music_dances_now_and_then_never_spams() {
        let mut s = Sensor::default();
        let mut music = snap();
        music.media = Some(Media { playing: true, video: false, fg_app: false });
        // An hour of music with lucky rolls: at most one dance per cooldown.
        let r = run(&mut s, &music, 0, 900, 0.0, Gate::default());
        assert!(r.iter().all(|(_, x)| matches!(x, Reaction::Dance { bpm: GROOVE_BPM })));
        assert_eq!(r.len(), 15, "every 4 min over an hour: {r:?}");
        for w in r.windows(2) {
            assert!(w[1].0 - w[0].0 >= DANCE.cooldown.as_secs());
        }
        // Unlucky rolls: never.
        let mut s = Sensor::default();
        assert!(run(&mut s, &music, 0, 100, 0.99, Gate::default()).is_empty());
        // Paused: never.
        let mut s = Sensor::default();
        music.media = Some(Media { playing: false, video: false, fg_app: false });
        assert!(run(&mut s, &music, 0, 100, 0.0, Gate::default()).is_empty());
    }

    #[test]
    fn blocked_focusing_or_away_means_no_reactions() {
        let mut music = snap();
        music.media = Some(Media { playing: true, video: false, fg_app: false });
        for gate in [Gate { blocked: true, focusing: false }, Gate { blocked: false, focusing: true }] {
            let mut s = Sensor::default();
            assert!(run(&mut s, &music, 0, 100, 0.0, gate).is_empty());
        }
        let mut s = Sensor::default();
        let away = Snapshot { idle_ms: Some(AWAY_MS), ..music.clone() };
        assert!(run(&mut s, &away, 0, 100, 0.0, Gate::default()).is_empty());
        // Cooldowns aren't spent while blocked: the first free poll can react.
        let mut s = Sensor::default();
        run(&mut s, &music, 0, 10, 0.0, Gate { blocked: true, focusing: false });
        assert_eq!(run(&mut s, &music, 40, 1, 0.0, Gate::default()).len(), 1);
    }

    #[test]
    fn coding_and_video() {
        let mut s = Sensor::default();
        let mut code = snap();
        code.fg = fg(AppKind::Coding);
        assert_eq!(run(&mut s, &code, 0, 1, 0.0, Gate::default()), vec![(0, Reaction::GlassesType)]);
        // Video in the browser in front: watch, not dance.
        let mut s = Sensor::default();
        let mut tv = snap();
        tv.fg = Some(Foreground { id: 42, kind: AppKind::Browser, fullscreen: false, video_site: true });
        tv.media = Some(Media { playing: true, video: false, fg_app: true });
        assert_eq!(run(&mut s, &tv, 0, 1, 0.1, Gate::default()), vec![(0, Reaction::WatchTv { window: 42 })]);
        // Music from a browser tab that isn't a video site: dance.
        let mut s = Sensor::default();
        tv.fg = Some(Foreground { id: 42, kind: AppKind::Browser, fullscreen: false, video_site: false });
        assert_eq!(run(&mut s, &tv, 0, 1, 0.01, Gate::default()), vec![(0, Reaction::Dance { bpm: GROOVE_BPM })]);
        // A video player playing a video it reports as such.
        let mut s = Sensor::default();
        tv.fg = fg(AppKind::VideoPlayer);
        assert_eq!(run(&mut s, &tv, 0, 1, 0.1, Gate::default()), vec![(0, Reaction::WatchTv { window: 7 })]);
    }

    #[test]
    fn global_gap_between_reactions() {
        let mut s = Sensor::default();
        let mut both = snap();
        both.fg = fg(AppKind::Coding);
        both.media = Some(Media { playing: true, video: false, fg_app: false });
        let r = run(&mut s, &both, 0, 30, 0.0, Gate::default());
        for w in r.windows(2) {
            assert!(w[1].0 - w[0].0 >= MIN_GAP.as_secs(), "{r:?}");
        }
        assert_eq!(r.len(), 2, "dance, then glasses after the gap: {r:?}");
    }

    #[test]
    fn late_night_says_at_most_once_an_hour() {
        let mut s = Sensor::default();
        let night = Snapshot { minute: 60, ..snap() };
        let r = run(&mut s, &night, 0, 1800, 0.0, Gate::default()); // 2 hours
        let says = r.iter().filter(|(_, x)| *x == Reaction::LateNight { say: true }).count();
        let yawns = r.iter().filter(|(_, x)| matches!(x, Reaction::LateNight { .. })).count();
        assert_eq!(says, 2, "{r:?}");
        assert_eq!(yawns, 6);
        // Daytime: nothing.
        let mut s = Sensor::default();
        assert!(run(&mut s, &snap(), 0, 100, 0.0, Gate::default()).is_empty());
        // Configurable window.
        let mut s = Sensor::default();
        let cfg = ContextSettings { night_start: "13:00".into(), night_end: "15:00".into(), ..Default::default() };
        assert_eq!(
            s.tick(&snap(), secs(0), &cfg, Gate::default(), &mut || 0.0),
            vec![Reaction::LateNight { say: true }]
        );
    }

    #[test]
    fn morning_once_a_day() {
        let mut s = Sensor::default();
        let morning = Snapshot { minute: 8 * 60, ..snap() };
        assert_eq!(run(&mut s, &morning, 0, 100, 0.99, Gate::default()), vec![(0, Reaction::Morning)]);
        let next = Snapshot { day: 2, ..morning };
        assert_eq!(run(&mut s, &next, 1000, 10, 0.99, Gate::default()), vec![(1000, Reaction::Morning)]);
    }

    #[test]
    fn battery_once_per_drop() {
        let mut s = Sensor::default();
        let low = Snapshot { battery: Some(Battery { percent: 14, charging: false }), ..snap() };
        assert_eq!(run(&mut s, &low, 0, 100, 0.99, Gate::default()), vec![(0, Reaction::BatteryLow { percent: 14 })]);
        // Charging re-arms it.
        let charging = Snapshot { battery: Some(Battery { percent: 14, charging: true }), ..snap() };
        assert!(run(&mut s, &charging, 400, 2, 0.99, Gate::default()).is_empty());
        assert_eq!(run(&mut s, &low, 500, 2, 0.99, Gate::default()).len(), 1);
        // Plugged-in low battery: no worry.
        let mut s = Sensor::default();
        assert!(run(&mut s, &charging, 0, 10, 0.99, Gate::default()).is_empty());
    }

    #[test]
    fn cpu_hot_after_30_seconds() {
        let mut s = Sensor::default();
        let hot = Snapshot { cpu: Some(95.0), ..snap() };
        let r = run(&mut s, &hot, 0, 50, 0.99, Gate::default());
        assert_eq!(r, vec![(32, Reaction::CpuHot)], "once, after 30 s");
        // A short spike doesn't count.
        let mut s = Sensor::default();
        run(&mut s, &hot, 0, 5, 0.99, Gate::default());
        let cool = Snapshot { cpu: Some(20.0), ..snap() };
        run(&mut s, &cool, 20, 1, 0.99, Gate::default());
        assert!(run(&mut s, &hot, 24, 6, 0.99, Gate::default()).is_empty());
    }

    #[test]
    fn suggest_focus_only_when_enabled() {
        let mut code = snap();
        code.fg = fg(AppKind::Coding);
        let mut s = Sensor::default();
        let r = run(&mut s, &code, 0, 400, 0.99, Gate::default());
        assert!(r.is_empty(), "off by default: {r:?}");
        let cfg = ContextSettings { focus_suggest: true, ..Default::default() };
        let mut s = Sensor::default();
        let mut got = Vec::new();
        for i in 0..400 {
            got.extend(s.tick(&code, secs(i * 4), &cfg, Gate::default(), &mut || 0.99));
        }
        assert_eq!(got, vec![Reaction::SuggestFocus]);
    }

    #[test]
    fn focus_timer() {
        let mut f = Focus::default();
        assert_eq!(f.remaining(secs(0)), None);
        assert_eq!(f.start(secs(10), 25, 5), 25);
        assert!(f.focusing());
        assert_eq!(f.remaining(secs(70)), Some(secs(24 * 60)));
        assert_eq!(f.tick(secs(100)), None);
        assert_eq!(f.tick(secs(10 + 25 * 60)), Some(FocusEvent::Done { minutes: 25, break_minutes: 5 }));
        assert_eq!(f.phase, FocusPhase::Break { minutes: 5 });
        assert!(!f.focusing());
        assert_eq!(f.tick(secs(10 + 30 * 60)), Some(FocusEvent::BreakOver));
        assert_eq!(f.phase, FocusPhase::Off);
        assert_eq!(f.tick(secs(99_999)), None);
        assert_eq!(f.start(secs(0), 0, 5), 1);
        assert_eq!(f.start(secs(0), 999, 5), 180);
        f.stop();
        assert_eq!(f.remaining(secs(0)), None);
    }

    #[test]
    fn debug_names_all_map() {
        for n in Reaction::DEBUG_NAMES {
            assert!(Reaction::debug(n, 1).is_some(), "{n}");
        }
        assert!(Reaction::debug("nope", 1).is_none());
        let json = serde_json::to_value(Reaction::WatchTv { window: 5 }).unwrap();
        assert_eq!(json, serde_json::json!({"kind": "watch_tv", "window": 5}));
    }
}
