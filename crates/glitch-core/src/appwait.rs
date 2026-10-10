//! Waiting for an app that was just opened, and finding its window.
//!
//! `open_app` only starts the program. Before Glitch says anything about it
//! (or looks at it), this polls the desktop's window list until a visible,
//! responsive window of that app exists. Matching is deliberately layered,
//! because launchers hand over to other processes (Spotify, Discord, Steam)
//! and Microsoft Store apps live inside `ApplicationFrameHost`:
//!
//! 1. the program's file name matches the app name (strongest),
//! 2. a Store window whose title has the app name,
//! 3. a window that did not exist before the launch, from a program that
//!    started after it, whose parent programs match the app name (a stub),
//! 4. a window that did not exist before the launch with the app name in its
//!    title (weakest: windows that were already open never match this way,
//!    and neither does a look at an app that was not just launched, so a
//!    code editor with "spotify" in its title is not "Spotify").
//!
//! Time goes through [`Clock`] so tests run instantly.

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::desktop::{AppWindow, Desktop};
use crate::platform::normalise_name;

/// How long `open_app` waits for the window.
pub const WAIT_TIMEOUT: Duration = Duration::from_secs(20);
/// How often the window list is checked.
pub const POLL: Duration = Duration::from_millis(250);
/// The window must be seen this many polls in a row (splash flashes).
const STABLE_POLLS: u32 = 2;
/// A program counts as "started by the launch" if it is at most this much
/// older than the launch.
const AGE_SLACK: Duration = Duration::from_secs(3);

pub trait Clock: Send + Sync {
    /// Time since the clock was made.
    fn elapsed(&self) -> Duration;
    fn sleep(&self, d: Duration);
}

pub struct RealClock(Instant);

impl RealClock {
    pub fn new() -> Self {
        Self(Instant::now())
    }
}

impl Default for RealClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for RealClock {
    fn elapsed(&self) -> Duration {
        self.0.elapsed()
    }
    fn sleep(&self, d: Duration) {
        std::thread::sleep(d)
    }
}

/// A clock that only moves when somebody sleeps on it (tests, evals).
#[derive(Default)]
pub struct ManualClock(Mutex<Duration>);

impl ManualClock {
    pub fn advance(&self, d: Duration) {
        *self.0.lock().unwrap() += d;
    }
}

impl Clock for ManualClock {
    fn elapsed(&self) -> Duration {
        *self.0.lock().unwrap()
    }
    fn sleep(&self, d: Duration) {
        self.advance(d)
    }
}

/// How a window was recognised as the app's (stronger is bigger).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum MatchKind {
    Title,
    Launcher,
    Store,
    Process,
}

/// Programs whose name says nothing about the app inside them.
const GENERIC_PROCESSES: &[&str] = &[
    "applicationframehost",
    "explorer",
    "textinputhost",
    "searchhost",
    "startmenuexperiencehost",
    "shellexperiencehost",
];

fn names_match(process: &str, key: &str) -> bool {
    process.len() >= 3
        && key.len() >= 3
        && (process == key
            || (process.len() >= 4 && key.contains(process))
            || (key.len() >= 4 && process.contains(key)))
}

#[derive(Debug, Clone)]
pub struct AppMatcher {
    key: String,
    /// Window ids that existed before the launch (None: no launch context).
    baseline: Option<HashSet<u64>>,
}

impl AppMatcher {
    /// For an app that was just launched; `before` is the window list taken
    /// right before the launch.
    pub fn launched(app: &str, before: &[AppWindow]) -> Self {
        Self { key: normalise_name(app), baseline: Some(before.iter().map(|w| w.id).collect()) }
    }

    /// For "look at the Spotify app" with no launch involved.
    pub fn named(app: &str) -> Self {
        Self { key: normalise_name(app), baseline: None }
    }

    pub fn classify(&self, w: &AppWindow, since_launch: Duration) -> Option<MatchKind> {
        if self.key.len() < 2 {
            return None;
        }
        let process = normalise_name(&w.process);
        let title = normalise_name(&w.title);
        let is_new = self.baseline.as_ref().is_none_or(|b| !b.contains(&w.id));
        let generic = GENERIC_PROCESSES.contains(&process.as_str());
        if !generic && names_match(&process, &self.key) {
            return Some(MatchKind::Process);
        }
        if process == "applicationframehost" && title.contains(&self.key) {
            return Some(MatchKind::Store);
        }
        if self.baseline.is_some()
            && is_new
            && w.age.is_some_and(|a| a <= since_launch + AGE_SLACK)
            && w.ancestors.iter().any(|a| names_match(&normalise_name(a), &self.key))
        {
            return Some(MatchKind::Launcher);
        }
        // Only for a window that appeared after a launch: without one, any
        // window with the name in its title (an editor, a browser tab) would match.
        if self.baseline.is_some() && is_new && !generic && self.key.len() >= 3 && title.contains(&self.key) {
            return Some(MatchKind::Title);
        }
        None
    }

    /// The best matching window: strongest match, then the one in front,
    /// then the biggest.
    pub fn best(&self, windows: &[AppWindow], since_launch: Duration) -> Option<(AppWindow, MatchKind)> {
        windows
            .iter()
            .filter_map(|w| self.classify(w, since_launch).map(|k| (w, k)))
            .max_by_key(|(w, k)| (*k, w.foreground, u64::from(w.width) * u64::from(w.height)))
            .map(|(w, k)| (w.clone(), k))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stuck {
    Minimized,
    NotResponding,
}

#[derive(Debug, Clone, PartialEq)]
pub enum WaitOutcome {
    Ready {
        window: AppWindow,
        kind: MatchKind,
        waited: Duration,
    },
    /// A window exists but never became usable.
    Stuck {
        window: AppWindow,
        why: Stuck,
        waited: Duration,
    },
    NoWindow {
        waited: Duration,
    },
}

/// Poll until the app's window is up. `on_tick` gets the elapsed time about
/// once a second (the bubble shows "Waiting for Spotify... 4 s").
pub fn wait_for_window(
    desktop: &dyn Desktop,
    clock: &dyn Clock,
    matcher: &AppMatcher,
    timeout: Duration,
    poll: Duration,
    on_tick: &mut dyn FnMut(Duration),
) -> WaitOutcome {
    let t0 = clock.elapsed();
    let mut stable_id: Option<u64> = None;
    let mut stable = 0u32;
    let mut stuck: Option<(AppWindow, Stuck)>;
    let mut last_tick = u64::MAX;
    loop {
        let since = clock.elapsed().saturating_sub(t0);
        if since.as_secs() != last_tick {
            last_tick = since.as_secs();
            on_tick(since);
        }
        match matcher.best(&desktop.app_windows(), since) {
            Some((w, kind)) if !w.minimized && w.responsive => {
                stuck = None;
                if stable_id == Some(w.id) {
                    stable += 1;
                } else {
                    stable_id = Some(w.id);
                    stable = 1;
                }
                if stable >= STABLE_POLLS {
                    return WaitOutcome::Ready { window: w, kind, waited: since };
                }
            }
            Some((w, _)) => {
                stable_id = None;
                let why = if w.minimized { Stuck::Minimized } else { Stuck::NotResponding };
                stuck = Some((w, why));
            }
            None => {
                stable_id = None;
                stuck = None;
            }
        }
        if since >= timeout {
            return match stuck {
                Some((window, why)) => WaitOutcome::Stuck { window, why, waited: since },
                None => WaitOutcome::NoWindow { waited: since },
            };
        }
        clock.sleep(poll);
    }
}

/// A window of the app, captured.
pub struct AppShot {
    pub capture: crate::desktop::Capture,
    pub window: AppWindow,
    /// Still one flat colour after the extra look (a loading screen).
    pub still_blank: bool,
}

/// Pause before looking again at a window that was not there / still blank.
pub const LOOK_RETRY: Duration = Duration::from_secs(2);
/// Looks again at a window that is only one flat colour (a loading screen):
/// real apps take several seconds to paint, so two more tries, 2 s apart.
pub const BLANK_RETRIES: u32 = 2;
/// Extra tries when the window isn't there yet.
pub const LOOK_RETRIES: u32 = 3;

/// Take a screenshot of the app's window. If the window isn't there yet
/// (or only minimized) wait 2 s and try again, up to 3 more times; if it is
/// there but blank (a loading screen) wait 2 s and look again, twice at most.
/// `preferred`: the window the wait already found.
pub fn capture_app(
    desktop: &dyn Desktop,
    clock: &dyn Clock,
    matcher: &AppMatcher,
    preferred: Option<u64>,
    name: &str,
) -> Result<AppShot, String> {
    let mut missing = 0u32;
    let mut blank_retries = 0u32;
    let mut minimized_title: Option<String> = None;
    loop {
        let windows = desktop.app_windows();
        let found = preferred
            .and_then(|id| windows.iter().find(|w| w.id == id).cloned())
            .or_else(|| matcher.best(&windows, Duration::from_secs(60)).map(|(w, _)| w));
        match found {
            Some(w) if !w.minimized => {
                let capture = desktop.capture_window(w.id)?;
                let blank = crate::vision::mostly_blank(&capture);
                if blank && blank_retries < BLANK_RETRIES {
                    blank_retries += 1;
                    clock.sleep(LOOK_RETRY);
                    continue;
                }
                return Ok(AppShot { capture, window: w, still_blank: blank });
            }
            other => {
                minimized_title = other.map(|w| w.title).or(minimized_title);
            }
        }
        if missing >= LOOK_RETRIES {
            let waited = u64::from(LOOK_RETRIES) * LOOK_RETRY.as_secs();
            return Err(match minimized_title {
                Some(t) => format!(
                    "{name}'s window (\"{t}\") is minimized, so there is nothing to see. Tell the user honestly; \
                     don't guess what it shows."
                ),
                None => format!(
                    "{name} has no visible window (I looked for {waited} s). It may still be starting, be closed or \
                     sit in the tray. Tell the user honestly; don't guess what it shows."
                ),
            });
        }
        missing += 1;
        clock.sleep(LOOK_RETRY);
    }
}

/// Tools-facing summary of the wait for the model (no `"ok":false` in it:
/// the app did start).
pub fn outcome_json(app: &str, o: &WaitOutcome) -> serde_json::Value {
    use serde_json::json;
    match o {
        WaitOutcome::Ready { window, waited, .. } => json!({
            "ready": true,
            "window_title": window.title,
            "waited_s": (waited.as_secs_f64() * 10.0).round() / 10.0,
            "note": format!("{app}'s window is up. To see it, call look_at_screen with target \"app\" and app \"{app}\"."),
        }),
        WaitOutcome::Stuck { window, why, waited } => json!({
            "ready": false,
            "window_title": window.title,
            "waited_s": waited.as_secs(),
            "note": match why {
                Stuck::Minimized => format!("{app} started but its window is minimized (maybe in the tray). Tell the user honestly."),
                Stuck::NotResponding => format!("{app} started but its window is not answering yet (still loading). Tell the user honestly."),
            },
        }),
        WaitOutcome::NoWindow { waited } => json!({
            "ready": false,
            "waited_s": waited.as_secs(),
            "note": format!("{app} was started but no window appeared after {} seconds. Say exactly that; don't claim it is open or that it isn't.", waited.as_secs()),
        }),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::desktop::fake::FakeDesktop;

    fn win(id: u64, title: &str, process: &str) -> AppWindow {
        AppWindow {
            id,
            pid: id as u32,
            title: title.into(),
            process: process.into(),
            ancestors: vec![],
            age: Some(Duration::from_secs(1)),
            minimized: false,
            responsive: true,
            foreground: false,
            width: 1000,
            height: 700,
        }
    }

    fn world(windows: Vec<(u64, AppWindow)>) -> (FakeDesktop, Arc<ManualClock>) {
        let clock = Arc::new(ManualClock::default());
        let d = FakeDesktop {
            clock: Some(clock.clone()),
            scripted: Mutex::new(windows.into_iter().map(|(s, w)| (Duration::from_secs(s), w)).collect()),
            ..Default::default()
        };
        (d, clock)
    }

    fn run(d: &FakeDesktop, clock: &ManualClock, m: &AppMatcher) -> WaitOutcome {
        wait_for_window(d, clock, m, WAIT_TIMEOUT, POLL, &mut |_| {})
    }

    #[test]
    fn window_that_appears_after_three_seconds() {
        let dev = AppWindow { foreground: true, ..win(1, "glitch - spotify fix - Visual Studio Code", "code") };
        let (d, clock) = world(vec![(0, dev.clone()), (3, win(2, "Spotify Free", "spotify"))]);
        let m = AppMatcher::launched("Spotify", &[dev]);
        let WaitOutcome::Ready { window, kind, waited } = run(&d, &clock, &m) else { panic!("not ready") };
        assert_eq!((window.id, kind), (2, MatchKind::Process));
        assert!(waited >= Duration::from_secs(3) && waited < Duration::from_secs(4), "{waited:?}");
    }

    #[test]
    fn a_window_that_never_appears_is_reported_after_the_timeout() {
        let (d, clock) = world(vec![(0, win(1, "Notes", "notepad"))]);
        let m = AppMatcher::launched("Spotify", &[]);
        let o = run(&d, &clock, &m);
        assert!(matches!(o, WaitOutcome::NoWindow { waited } if waited >= WAIT_TIMEOUT), "{o:?}");
        assert!(outcome_json("Spotify", &o)["note"].as_str().unwrap().contains("no window appeared after 20"));
    }

    #[test]
    fn the_dev_window_with_the_app_name_in_its_title_is_not_the_app() {
        let dev = win(1, "spotify playlist bug - Visual Studio Code", "code");
        let (d, clock) = world(vec![(0, dev.clone())]);
        let m = AppMatcher::launched("Spotify", &[dev]);
        assert!(matches!(run(&d, &clock, &m), WaitOutcome::NoWindow { .. }));
    }

    #[test]
    fn appears_behind_other_windows() {
        let front = AppWindow { foreground: true, ..win(1, "Editor", "code") };
        let (d, clock) = world(vec![(0, front), (2, AppWindow { foreground: false, ..win(2, "Spotify", "spotify") })]);
        let m = AppMatcher::launched("Spotify", &[]);
        let WaitOutcome::Ready { window, .. } = run(&d, &clock, &m) else { panic!() };
        assert!(!window.foreground, "it is ready even when it is not in front");
        assert_eq!(window.id, 2);
    }

    #[test]
    fn a_launcher_stub_that_starts_a_different_program() {
        // "Discord" starts Update.exe, which starts app-1.0.exe: the window's
        // program name says nothing, but its parent is Discord's stub.
        let mut real = win(5, "Friends", "app-1.0");
        real.ancestors = vec!["discord".into(), "explorer".into()];
        real.age = Some(Duration::from_secs(2));
        let (d, clock) = world(vec![(4, real)]);
        let m = AppMatcher::launched("Discord", &[]);
        let WaitOutcome::Ready { window, kind, .. } = run(&d, &clock, &m) else { panic!() };
        assert_eq!((window.id, kind), (5, MatchKind::Launcher));
    }

    #[test]
    fn a_launcher_match_needs_a_program_that_started_after_the_launch() {
        let mut old = win(5, "Friends", "app-1.0");
        old.ancestors = vec!["discord".into()];
        old.age = Some(Duration::from_secs(900));
        let (d, clock) = world(vec![(0, old)]);
        let m = AppMatcher::launched("Discord", &[]);
        assert!(matches!(run(&d, &clock, &m), WaitOutcome::NoWindow { .. }));
    }

    #[test]
    fn a_store_app_is_found_by_its_title_inside_the_frame_host() {
        let (d, clock) = world(vec![(1, win(7, "Calculator", "applicationframehost"))]);
        let m = AppMatcher::launched("Calculator", &[]);
        let WaitOutcome::Ready { kind, .. } = run(&d, &clock, &m) else { panic!() };
        assert_eq!(kind, MatchKind::Store);
        // Another Store app's frame is not Calculator.
        let (d, clock) = world(vec![(0, win(8, "Photos", "applicationframehost"))]);
        assert!(matches!(run(&d, &clock, &m), WaitOutcome::NoWindow { .. }));
    }

    #[test]
    fn an_explorer_folder_with_the_name_is_not_the_app() {
        let (d, clock) = world(vec![(0, win(9, "Spotify downloads", "explorer"))]);
        let m = AppMatcher::launched("Spotify", &[]);
        assert!(matches!(run(&d, &clock, &m), WaitOutcome::NoWindow { .. }));
    }

    #[test]
    fn a_hung_or_minimized_window_is_not_ready() {
        let hung = AppWindow { responsive: false, ..win(2, "Spotify", "spotify") };
        let (d, clock) = world(vec![(0, hung)]);
        let m = AppMatcher::launched("Spotify", &[]);
        assert!(matches!(run(&d, &clock, &m), WaitOutcome::Stuck { why: Stuck::NotResponding, .. }));
        let min = AppWindow { minimized: true, ..win(2, "Spotify", "spotify") };
        let (d, clock) = world(vec![(0, min)]);
        assert!(matches!(run(&d, &clock, &m), WaitOutcome::Stuck { why: Stuck::Minimized, .. }));
    }

    #[test]
    fn a_window_that_becomes_responsive_later_is_waited_for() {
        let loading = AppWindow { responsive: false, ..win(2, "Spotify", "spotify") };
        let (d, clock) = world(vec![(1, loading)]);
        let m = AppMatcher::launched("Spotify", &[]);
        // Hung until second 5, then it answers (same window id).
        let clock2 = clock.clone();
        let o = wait_for_window(&d, &*clock, &m, WAIT_TIMEOUT, POLL, &mut |t| {
            if t.as_secs() == 5 {
                let mut w = d.scripted.lock().unwrap();
                w[0].1.responsive = true;
                let _ = &clock2;
            }
        });
        let WaitOutcome::Ready { waited, .. } = o else { panic!("{o:?}") };
        assert!(waited >= Duration::from_secs(5) && waited < Duration::from_secs(6), "{waited:?}");
    }

    #[test]
    fn ticks_come_about_once_a_second() {
        let (d, clock) = world(vec![(6, win(2, "Spotify", "spotify"))]);
        let m = AppMatcher::launched("Spotify", &[]);
        let mut ticks = vec![];
        wait_for_window(&d, &*clock, &m, WAIT_TIMEOUT, POLL, &mut |t| ticks.push(t.as_secs()));
        assert_eq!(ticks, vec![0, 1, 2, 3, 4, 5, 6]);
    }

    #[test]
    fn a_flash_of_a_window_that_vanishes_is_not_ready() {
        // Seen for one poll only (a splash that closes): stable needs two.
        let (d, clock) = world(vec![]);
        d.scripted.lock().unwrap().push((Duration::from_millis(0), win(3, "Spotify", "spotify")));
        let m = AppMatcher::launched("Spotify", &[]);
        let mut n = 0;
        let o = {
            // Remove the window after the first poll.
            let mut tick = |_: Duration| {
                n += 1;
            };
            let first = m.best(&d.app_windows(), Duration::ZERO);
            assert!(first.is_some());
            d.scripted.lock().unwrap().clear();
            wait_for_window(&d, &*clock, &m, Duration::from_secs(2), POLL, &mut tick)
        };
        assert!(matches!(o, WaitOutcome::NoWindow { .. }));
    }
}
