//! What Glitch can perceive and touch on the desktop *besides* opening
//! things (that's [`crate::platform::Platform`]): the screen, the clipboard,
//! the active window, selected text, timers and the notes file.
//!
//! The real implementation lives in the Tauri shell (`src-tauri/src/desktop.rs`,
//! it needs native window APIs and knows which windows are Glitch's own).
//! Everything here is plain data so the agent and the tools stay testable.

use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;

/// What `look_at_screen` captures.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureTarget {
    /// The whole monitor the user is on (where the mouse is).
    Screen,
    /// The window the user was working in (not Glitch's own).
    Window,
    /// A region around the mouse pointer.
    Cursor,
    /// One specific app's window, wherever it is on screen (even behind
    /// other windows): `look_at_screen {"target":"app","app":"Spotify"}`.
    App,
}

impl CaptureTarget {
    pub const NAMES: [&'static str; 4] = ["screen", "window", "cursor", "app"];

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_lowercase().as_str() {
            "screen" | "whole screen" | "full" | "desktop" | "monitor" => Some(Self::Screen),
            "window" | "active" | "active window" => Some(Self::Window),
            "app" | "application" | "program" => Some(Self::App),
            "cursor" | "mouse" | "pointer" | "region" => Some(Self::Cursor),
            _ => None,
        }
    }

    /// "your screen", for the bubble's "looking at …" indicator.
    pub fn label(self) -> &'static str {
        match self {
            Self::Screen => "your screen",
            Self::Window => "your window",
            Self::Cursor => "the spot under your mouse",
            Self::App => "that app",
        }
    }
}

/// A window's title and the app it belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WindowInfo {
    pub title: String,
    /// Friendly app name, e.g. "Notepad", "Microsoft Edge".
    pub app: String,
}

/// One visible top-level window of another app, for waiting until an app
/// that was just opened has its window up, and for looking at that app (and
/// not at whatever else is in front).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppWindow {
    /// The OS window handle (opaque; pass it to [`Desktop::capture_window`]).
    pub id: u64,
    pub pid: u32,
    pub title: String,
    /// The program's file name without ".exe", lower case ("spotify",
    /// "applicationframehost" for Microsoft Store apps).
    pub process: String,
    /// Programs that started this one, nearest first (a launcher stub's name
    /// shows up here when it spawned the real app).
    pub ancestors: Vec<String>,
    /// How long the window's program has been running (None: unknown).
    pub age: Option<Duration>,
    pub minimized: bool,
    /// Answers messages (not hung, not still starting up).
    pub responsive: bool,
    /// The window the user is typing in.
    pub foreground: bool,
    pub width: u32,
    pub height: u32,
}

/// What the system media session is playing (read only when the user asks).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    /// The app playing it, e.g. "Spotify.exe", "Chrome".
    pub app: String,
    pub playing: bool,
}

/// Pixel rectangle inside a capture (top-left origin).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PixelRect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

/// A raw screenshot, straight from the OS. Lives only in RAM.
pub struct Capture {
    pub width: u32,
    pub height: u32,
    /// RGBA, row-major, `width * height * 4` bytes.
    pub rgba: Vec<u8>,
    /// The window it shows (for `Window`), or the one in front (for `Screen`).
    pub window: Option<WindowInfo>,
    /// Password fields to cover before the model sees anything.
    pub redact: Vec<PixelRect>,
}

impl std::fmt::Debug for Capture {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Capture({}x{}, {:?}, {} redacted)", self.width, self.height, self.window, self.redact.len())
    }
}

/// Clipboard text, plus whether the copying app marked it as private
/// (password managers do: "ExcludeClipboardContentFromMonitorProcessing").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClipboardText {
    pub text: String,
    pub sensitive: bool,
}

/// Errors are short sentences for the model ("the clipboard is empty").
pub type DesktopResult<T> = Result<T, String>;

pub trait Desktop: Send + Sync {
    fn capture(&self, target: CaptureTarget) -> DesktopResult<Capture>;
    /// The window the user was working in (Glitch's own windows skipped).
    fn active_window(&self) -> Option<WindowInfo>;
    /// Every visible top-level window of other apps, front to back
    /// (minimized ones included; Glitch's own and hidden/cloaked ones left
    /// out). Used to wait for a freshly opened app and to find its window.
    fn app_windows(&self) -> Vec<AppWindow> {
        Vec::new()
    }
    /// `app_windows` really lists windows here (so waiting for one makes sense).
    fn lists_windows(&self) -> bool {
        false
    }
    /// A screenshot of exactly this window (one from `app_windows`), even
    /// when other windows are in front of it. Password fields are covered
    /// like in [`capture`](Self::capture).
    fn capture_window(&self, id: u64) -> DesktopResult<Capture> {
        let _ = id;
        Err("looking at one app's window isn't available on this computer yet".into())
    }
    fn read_clipboard(&self) -> DesktopResult<ClipboardText>;
    fn write_clipboard(&self, text: &str) -> DesktopResult<()>;
    /// Text selected in the window the user was working in (`None`: nothing).
    fn selected_text(&self) -> DesktopResult<Option<String>>;
    /// Pop up the chat with `message` after `after`. In-app only.
    fn set_timer(&self, after: Duration, message: &str) -> DesktopResult<()>;
    /// The notes file `take_note` appends to.
    fn notes_file(&self) -> Option<PathBuf> {
        default_notes_file()
    }
    /// What music/video the system media session has (`None`: nothing).
    fn now_playing(&self) -> DesktopResult<Option<NowPlaying>> {
        Err("Glitch can't see what's playing on this computer".into())
    }
    /// Focus mode: start a session (`Some(0)` stops it, `None` = the default
    /// length). Returns the minutes started (0 = stopped).
    fn focus(&self, _minutes: Option<u32>) -> DesktopResult<u32> {
        Err("focus mode isn't available here".into())
    }
    /// Save a reminder for `due` (unix seconds) that survives restarts
    /// ("Update me" reminders; see `crate::update_me::reminders`).
    fn add_reminder(&self, due: i64, text: &str) -> DesktopResult<()> {
        let _ = (due, text);
        Err("saved reminders are switched off (Settings > Features)".into())
    }
}

/// Documents/Glitch notes/notes.md
pub fn default_notes_file() -> Option<PathBuf> {
    dirs::document_dir().map(|d| d.join("Glitch notes").join("notes.md"))
}

/// A desktop with none of these abilities (tests, unsupported OSes).
pub struct NoDesktop;

impl Desktop for NoDesktop {
    fn capture(&self, _: CaptureTarget) -> DesktopResult<Capture> {
        Err("looking at the screen isn't available on this computer yet".into())
    }
    fn active_window(&self) -> Option<WindowInfo> {
        None
    }
    fn read_clipboard(&self) -> DesktopResult<ClipboardText> {
        Err("the clipboard isn't available here".into())
    }
    fn write_clipboard(&self, _: &str) -> DesktopResult<()> {
        Err("the clipboard isn't available here".into())
    }
    fn selected_text(&self) -> DesktopResult<Option<String>> {
        Err("reading selected text isn't available here".into())
    }
    fn set_timer(&self, _: Duration, _: &str) -> DesktopResult<()> {
        Err("timers aren't available here".into())
    }
    fn notes_file(&self) -> Option<PathBuf> {
        None
    }
}

#[cfg(test)]
pub(crate) mod fake {
    //! A scriptable desktop that records what happened.
    use std::sync::Mutex;

    use super::*;
    use crate::appwait::Clock;

    #[derive(Default)]
    pub struct FakeDesktop {
        pub clipboard: Mutex<Option<ClipboardText>>,
        pub window: Option<WindowInfo>,
        pub selected: Option<String>,
        pub screen: Option<(u32, u32)>,
        pub redact: Vec<PixelRect>,
        pub captures: Mutex<Vec<CaptureTarget>>,
        pub timers: Mutex<Vec<(Duration, String)>>,
        pub reminders: Mutex<Vec<(i64, String)>>,
        pub notes: Option<PathBuf>,
        pub playing: Option<NowPlaying>,
        pub focus: Mutex<Vec<Option<u32>>>,
        /// Scripted windows: `app_windows` returns those whose time (on
        /// `clock`) has come.
        pub scripted: Mutex<Vec<(Duration, AppWindow)>>,
        pub clock: Option<std::sync::Arc<crate::appwait::ManualClock>>,
        /// Per window id: the pictures `capture_window` returns in turn
        /// (a blank loading screen first, the real one later); the last one
        /// stays. Shade 255 = an empty white screen.
        pub window_shots: Mutex<std::collections::HashMap<u64, Vec<u8>>>,
        pub window_captures: Mutex<Vec<u64>>,
    }

    /// A picture that is `shade` with dark stripes, or completely `shade`
    /// when it is 255 (an empty loading screen).
    fn shaded(shade: u8, w: u32, h: u32) -> Vec<u8> {
        let mut px = vec![shade; (w * h * 4) as usize];
        if shade != 255 {
            for y in (0..h).step_by(5) {
                for x in 0..w {
                    let i = ((y * w + x) * 4) as usize;
                    px[i..i + 3].copy_from_slice(&[20, 20, 20]);
                }
            }
        }
        px
    }

    impl Desktop for FakeDesktop {
        fn capture(&self, target: CaptureTarget) -> DesktopResult<Capture> {
            self.captures.lock().unwrap().push(target);
            let (width, height) = self.screen.ok_or("no screen")?;
            Ok(Capture {
                width,
                height,
                rgba: vec![200; (width * height * 4) as usize],
                window: self.window.clone(),
                redact: self.redact.clone(),
            })
        }
        fn active_window(&self) -> Option<WindowInfo> {
            self.window.clone()
        }
        fn lists_windows(&self) -> bool {
            self.clock.is_some()
        }
        fn app_windows(&self) -> Vec<AppWindow> {
            let now = self.clock.as_ref().map(|c| c.elapsed()).unwrap_or_default();
            self.scripted.lock().unwrap().iter().filter(|(at, _)| *at <= now).map(|(_, w)| w.clone()).collect()
        }
        fn capture_window(&self, id: u64) -> DesktopResult<Capture> {
            self.window_captures.lock().unwrap().push(id);
            let Some(w) = self.app_windows().into_iter().find(|w| w.id == id) else {
                return Err("that window has closed".into());
            };
            let mut shots = self.window_shots.lock().unwrap();
            let list = shots.entry(id).or_default();
            let shade = if list.len() > 1 { list.remove(0) } else { list.first().copied().unwrap_or(90) };
            let (width, height) = (400u32, 300u32);
            Ok(Capture {
                width,
                height,
                rgba: shaded(shade, width, height),
                window: Some(WindowInfo { title: w.title, app: w.process }),
                redact: vec![],
            })
        }
        fn read_clipboard(&self) -> DesktopResult<ClipboardText> {
            self.clipboard.lock().unwrap().clone().ok_or_else(|| "the clipboard is empty".into())
        }
        fn write_clipboard(&self, text: &str) -> DesktopResult<()> {
            *self.clipboard.lock().unwrap() = Some(ClipboardText { text: text.into(), sensitive: false });
            Ok(())
        }
        fn selected_text(&self) -> DesktopResult<Option<String>> {
            Ok(self.selected.clone())
        }
        fn set_timer(&self, after: Duration, message: &str) -> DesktopResult<()> {
            self.timers.lock().unwrap().push((after, message.into()));
            Ok(())
        }
        fn notes_file(&self) -> Option<PathBuf> {
            self.notes.clone()
        }
        fn now_playing(&self) -> DesktopResult<Option<NowPlaying>> {
            Ok(self.playing.clone())
        }
        fn focus(&self, minutes: Option<u32>) -> DesktopResult<u32> {
            self.focus.lock().unwrap().push(minutes);
            Ok(minutes.unwrap_or(25))
        }
        fn add_reminder(&self, due: i64, text: &str) -> DesktopResult<()> {
            self.reminders.lock().unwrap().push((due, text.into()));
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets_parse_leniently() {
        assert_eq!(CaptureTarget::parse("Screen"), Some(CaptureTarget::Screen));
        assert_eq!(CaptureTarget::parse(" active window "), Some(CaptureTarget::Window));
        assert_eq!(CaptureTarget::parse("mouse"), Some(CaptureTarget::Cursor));
        assert_eq!(CaptureTarget::parse("webcam"), None);
    }
}
