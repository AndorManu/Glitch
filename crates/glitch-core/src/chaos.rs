//! Chaos mode: the pure rules behind Glitch's mischief with other apps'
//! windows and the mouse cursor. The OS calls live in
//! `src-tauri/src/chaos_native.rs`; everything that decides *whether* and
//! *how far* lives here so it is unit-tested on every OS.
//!
//! Hard limits (enforced in Rust, the page can't skip them):
//! * other apps' windows are only ever **moved**: never resized, closed,
//!   minimised, focused or typed into, and always kept fully on screen;
//! * at most one window grab every [`WINDOW_COOLDOWN`], one cursor grab
//!   every [`CURSOR_COOLDOWN`];
//! * never while the user is using the computer: a grab needs
//!   [`MIN_IDLE_MS`] without keyboard/mouse input, and any new input ends it;
//! * never the foreground window if the user touched the computer in the
//!   last [`FOREGROUND_IDLE_MS`]; never fullscreen, maximised, elevated,
//!   cloaked or tool windows, never Glitch's own windows;
//! * a window moves at most [`MAX_WINDOW_TRAVEL`] CSS px per grab, for at
//!   most [`MAX_WINDOW_GRAB`]; the cursor at most [`MAX_CURSOR_TRAVEL`] for
//!   at most [`MAX_CURSOR_GRAB`].

use std::time::Duration;

use serde::Serialize;

use crate::world::ScreenRect;

pub const WINDOW_COOLDOWN: Duration = Duration::from_secs(4 * 60);
pub const CURSOR_COOLDOWN: Duration = Duration::from_secs(2 * 60);
pub const MAX_WINDOW_GRAB: Duration = Duration::from_secs(9);
pub const MAX_CURSOR_GRAB: Duration = Duration::from_millis(1500);
/// CSS px (multiplied by the monitor scale).
pub const MAX_WINDOW_TRAVEL: f64 = 420.0;
pub const MAX_CURSOR_TRAVEL: f64 = 260.0;
/// No mischief with other apps until the user has left the computer alone this long.
pub const MIN_IDLE_MS: u32 = 4000;
/// The window the user works in is off limits unless they've been away this long.
pub const FOREGROUND_IDLE_MS: u32 = 60_000;
/// Windows smaller than this aren't worth dragging (popups, tooltips).
pub const MIN_W: i32 = 200;
pub const MIN_H: i32 = 120;
/// Windows covering more than this share of the work area are too big to drag around.
pub const MAX_AREA_SHARE: f64 = 0.7;
/// The user moved the cursor away from where Glitch put it (physical px).
pub const CURSOR_FIGHT_PX: i32 = 6;

/// What the OS tells us about another app's window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Candidate {
    pub id: u64,
    /// Visible frame (what the user sees), physical px.
    pub frame: ScreenRect,
    /// Is it the window the user is working in?
    pub foreground: bool,
    pub maximized: bool,
    /// Runs elevated (admin) while Glitch doesn't, or we couldn't tell.
    pub elevated: bool,
    /// Covers its whole monitor (games, videos, presentations).
    pub fullscreen: bool,
    /// Tool windows, cloaked windows, shell windows...
    pub system: bool,
}

/// Why a window can't be grabbed (also returned to the page for logging).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Refusal {
    Disabled,
    CoolingDown,
    UserActive,
    Fullscreen,
    NotFound,
    Ineligible,
    InUse,
    Busy,
}

/// May Glitch touch this window at all, given how long the user has been idle?
pub fn eligible(c: &Candidate, area: ScreenRect, idle_ms: u32) -> Result<(), Refusal> {
    if c.system || c.elevated || c.maximized || c.fullscreen {
        return Err(Refusal::Ineligible);
    }
    let f = c.frame;
    if f.w < MIN_W || f.h < MIN_H {
        return Err(Refusal::Ineligible);
    }
    // Too big to fit, or most of the screen: dragging it would only look broken.
    if f.w > area.w || f.h > area.h || (f.w as f64 * f.h as f64) > MAX_AREA_SHARE * area.w as f64 * area.h as f64 {
        return Err(Refusal::Ineligible);
    }
    // Must be (mostly) on this work area.
    let cx = f.x + f.w / 2;
    let cy = f.y + f.h / 2;
    if cx < area.x || cx >= area.right() || cy < area.y || cy >= area.bottom() {
        return Err(Refusal::Ineligible);
    }
    if c.foreground && idle_ms < FOREGROUND_IDLE_MS {
        return Err(Refusal::InUse);
    }
    Ok(())
}

/// Pick the eligible window nearest to `near` (Glitch), or `None`.
pub fn pick_target(cands: &[Candidate], area: ScreenRect, idle_ms: u32, near: (i32, i32)) -> Option<Candidate> {
    cands
        .iter()
        .filter(|c| eligible(c, area, idle_ms).is_ok())
        .min_by_key(|c| {
            let f = c.frame;
            let dx = (f.x + f.w / 2 - near.0) as i64;
            let dy = (f.y - near.1) as i64;
            dx * dx + dy * dy
        })
        .copied()
}

/// Where a window frame may go so it stays fully inside `area`.
/// Returns the clamped top-left of the frame.
pub fn clamp_frame(frame: ScreenRect, x: i32, y: i32, area: ScreenRect) -> (i32, i32) {
    let max_x = (area.right() - frame.w).max(area.x);
    let max_y = (area.bottom() - frame.h).max(area.y);
    (x.clamp(area.x, max_x), y.clamp(area.y, max_y))
}

/// Limit a requested offset from the grab point to `max` (euclidean).
pub fn limit_offset(dx: f64, dy: f64, max: f64) -> (f64, f64) {
    let len = (dx * dx + dy * dy).sqrt();
    if len <= max || len == 0.0 {
        (dx, dy)
    } else {
        (dx * max / len, dy * max / len)
    }
}

/// A window grab in progress: where it started and how far it may go.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowGrab {
    pub id: u64,
    /// The visible frame when grabbed.
    pub start: ScreenRect,
    /// Offset of the real window rect (with the invisible resize border) from the frame.
    pub border: (i32, i32),
    pub area: ScreenRect,
    /// Physical px per CSS px.
    pub scale: f64,
}

impl WindowGrab {
    /// Where to put the window (its real top-left, for `SetWindowPos`) for a
    /// requested frame offset from the grab point. Always fully on screen,
    /// never further than the travel limit.
    pub fn target(&self, dx: f64, dy: f64) -> (i32, i32) {
        let (dx, dy) = limit_offset(dx, dy, MAX_WINDOW_TRAVEL * self.scale);
        let (fx, fy) = clamp_frame(
            self.start,
            self.start.x + dx.round() as i32,
            self.start.y + dy.round() as i32,
            self.area,
        );
        (fx - self.border.0, fy - self.border.1)
    }
}

/// Smooth path for a window from `from` to `to` (top-left points) in steps of
/// at most `max_step` px; the last point is exactly `to`. Used when Rust
/// moves a window on its own (the debug trigger), the page normally walks it.
pub fn path(from: (i32, i32), to: (i32, i32), max_step: i32) -> Vec<(i32, i32)> {
    let (dx, dy) = ((to.0 - from.0) as f64, (to.1 - from.1) as f64);
    let len = (dx * dx + dy * dy).sqrt();
    let n = (len / max_step.max(1) as f64).ceil().max(1.0) as i32;
    (1..=n)
        .map(|i| {
            let t = i as f64 / n as f64;
            // Ease in/out so the window doesn't jerk.
            let e = t * t * (3.0 - 2.0 * t);
            (from.0 + (dx * e).round() as i32, from.1 + (dy * e).round() as i32)
        })
        .collect()
}

/// A cursor grab in progress.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CursorGrab {
    pub start: (i32, i32),
    /// Where Glitch last put the cursor.
    pub last: (i32, i32),
    pub area: ScreenRect,
    pub scale: f64,
}

impl CursorGrab {
    /// Did the user move the mouse away from where Glitch put it?
    pub fn user_fights(&self, now: (i32, i32)) -> bool {
        (now.0 - self.last.0).abs() > CURSOR_FIGHT_PX || (now.1 - self.last.1).abs() > CURSOR_FIGHT_PX
    }

    /// Where the cursor may go for a requested point: near the start, on screen.
    pub fn target(&self, x: f64, y: f64) -> (i32, i32) {
        let (dx, dy) = limit_offset(x - self.start.0 as f64, y - self.start.1 as f64, MAX_CURSOR_TRAVEL * self.scale);
        let a = self.area;
        (
            (self.start.0 + dx.round() as i32).clamp(a.x, a.right() - 1),
            (self.start.1 + dy.round() as i32).clamp(a.y, a.bottom() - 1),
        )
    }
}

/// Simple "once every N" gate.
#[derive(Debug, Default, Clone, Copy)]
pub struct Cooldown {
    last: Option<Duration>,
}

impl Cooldown {
    /// `now`: any monotonic clock (time since app start).
    pub fn ready(&self, now: Duration, every: Duration) -> bool {
        self.last.is_none_or(|l| now.saturating_sub(l) >= every)
    }
    pub fn mark(&mut self, now: Duration) {
        self.last = Some(now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: ScreenRect = ScreenRect { x: 0, y: 0, w: 1920, h: 1040 };

    fn cand(id: u64, x: i32, y: i32, w: i32, h: i32) -> Candidate {
        Candidate {
            id,
            frame: ScreenRect { x, y, w, h },
            foreground: false,
            maximized: false,
            elevated: false,
            fullscreen: false,
            system: false,
        }
    }

    #[test]
    fn only_normal_windows_are_eligible() {
        let ok = cand(1, 100, 100, 600, 400);
        assert_eq!(eligible(&ok, AREA, 10_000), Ok(()));
        for bad in [
            Candidate { maximized: true, ..ok },
            Candidate { elevated: true, ..ok },
            Candidate { fullscreen: true, ..ok },
            Candidate { system: true, ..ok },
            cand(2, 100, 100, 150, 400),         // too narrow
            cand(3, 0, 0, 1900, 1000),           // most of the screen
            cand(4, 2500, 100, 600, 400),        // another monitor
        ] {
            assert_eq!(eligible(&bad, AREA, 10_000), Err(Refusal::Ineligible), "{bad:?}");
        }
    }

    #[test]
    fn the_window_in_use_is_left_alone() {
        let fg = Candidate { foreground: true, ..cand(1, 100, 100, 600, 400) };
        assert_eq!(eligible(&fg, AREA, 5_000), Err(Refusal::InUse));
        assert_eq!(eligible(&fg, AREA, FOREGROUND_IDLE_MS + 1), Ok(()));
    }

    #[test]
    fn picks_the_nearest_eligible_window() {
        let far = cand(1, 1200, 100, 600, 400);
        let near = cand(2, 100, 500, 600, 400);
        let bad = Candidate { maximized: true, ..cand(3, 0, 600, 600, 400) };
        let pick = pick_target(&[far, near, bad], AREA, 10_000, (300, 900)).unwrap();
        assert_eq!(pick.id, 2);
        assert!(pick_target(&[bad], AREA, 10_000, (0, 0)).is_none());
    }

    #[test]
    fn windows_stay_fully_on_screen() {
        let g = WindowGrab { id: 1, start: ScreenRect { x: 100, y: 100, w: 600, h: 400 }, border: (7, 0), area: AREA, scale: 1.0 };
        // Way off to the left: clamped at the edge (frame x = 0, real rect x = -7).
        assert_eq!(g.target(-5000.0, 0.0), (-7, 100));
        // Right: limited by the travel cap first.
        let (x, _) = g.target(5000.0, 0.0);
        assert_eq!(x + 7, 100 + MAX_WINDOW_TRAVEL as i32);
        // Near the right edge the screen wins.
        let g2 = WindowGrab { start: ScreenRect { x: 1200, y: 600, w: 600, h: 400 }, ..g };
        let (x, y) = g2.target(400.0, 400.0);
        assert_eq!((x + 7, y), (1920 - 600, 1040 - 400));
    }

    #[test]
    fn travel_is_limited() {
        let (dx, dy) = limit_offset(300.0, 400.0, 100.0);
        assert!(((dx * dx + dy * dy).sqrt() - 100.0).abs() < 1e-9);
        assert_eq!(limit_offset(3.0, 4.0, 100.0), (3.0, 4.0));
        assert_eq!(limit_offset(0.0, 0.0, 100.0), (0.0, 0.0));
    }

    #[test]
    fn paths_are_small_smooth_steps() {
        let p = path((0, 0), (100, 0), 12);
        assert_eq!(*p.last().unwrap(), (100, 0));
        let mut prev = 0;
        for &(x, y) in &p {
            assert_eq!(y, 0);
            assert!(x >= prev && x - prev <= 20, "{prev} -> {x}");
            prev = x;
        }
        assert_eq!(path((5, 5), (5, 5), 10), vec![(5, 5)]);
    }

    #[test]
    fn cursor_grab_notices_the_user_and_stays_close() {
        let g = CursorGrab { start: (500, 500), last: (520, 500), area: AREA, scale: 1.0 };
        assert!(!g.user_fights((522, 501)));
        assert!(g.user_fights((540, 500)));
        let (x, _) = g.target(5000.0, 500.0);
        assert_eq!(x, 500 + MAX_CURSOR_TRAVEL as i32);
        let edge = CursorGrab { start: (5, 5), last: (5, 5), area: AREA, scale: 1.0 };
        assert_eq!(edge.target(-100.0, -100.0), (0, 0));
    }

    #[test]
    fn cooldown() {
        let mut c = Cooldown::default();
        assert!(c.ready(Duration::from_secs(1), WINDOW_COOLDOWN));
        c.mark(Duration::from_secs(10));
        assert!(!c.ready(Duration::from_secs(60), WINDOW_COOLDOWN));
        assert!(c.ready(Duration::from_secs(10) + WINDOW_COOLDOWN, WINDOW_COOLDOWN));
    }
}
