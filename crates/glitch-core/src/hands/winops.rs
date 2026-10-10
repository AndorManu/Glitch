//! Window geometry for desktop control: where a window is, the snap
//! positions, and keeping a moved window on screen. Pure maths; the native
//! side applies it with `SetWindowPos` / `ShowWindow`.

use serde::{Deserialize, Serialize};

/// Left, top, right, bottom in screen px (like a Win32 RECT).
pub type Edges = (i32, i32, i32, i32);

/// Smallest a window may be made.
pub const MIN_SIZE: (i32, i32) = (240, 160);
/// How much of a moved window's title bar must stay on screen.
const KEEP_VISIBLE: i32 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WinState {
    Normal,
    Maximized,
    Minimized,
}

/// A window's place: enough to put it back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WinGeom {
    /// Where it sits when not maximized or minimized.
    pub rect: Edges,
    pub state: WinState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Snap {
    Left,
    Right,
    Maximize,
    /// Undo a snap / maximize: back to the normal size.
    Restore,
}

impl Snap {
    pub const NAMES: [&'static str; 4] = ["left", "right", "maximize", "restore"];

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s.trim().to_lowercase().replace([' ', '-', '_'], "").as_str() {
            "left" | "lefthalf" | "snapleft" => Self::Left,
            "right" | "righthalf" | "snapright" => Self::Right,
            "maximize" | "maximise" | "max" | "full" | "fullscreen" | "up" => Self::Maximize,
            "restore" | "normal" | "unmaximize" | "unmaximise" | "unsnap" | "back" | "down" => Self::Restore,
            _ => return None,
        })
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Left => "the left half",
            Self::Right => "the right half",
            Self::Maximize => "full screen",
            Self::Restore => "its normal size",
        }
    }
}

/// What can be done to a window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowOp {
    /// Top-left corner to this screen position.
    Move {
        x: i32,
        y: i32,
    },
    Resize {
        w: i32,
        h: i32,
    },
    Snap(Snap),
    Minimize,
    Restore,
    /// Put it back exactly as it was (undo).
    Set(WinGeom),
}

pub fn width(e: Edges) -> i32 {
    e.2 - e.0
}
pub fn height(e: Edges) -> i32 {
    e.3 - e.1
}

/// The rectangle a snap fills, inside the monitor's work area (no taskbar).
/// `Restore` has no rectangle of its own (the caller knows the old size).
pub fn snap_rect(work: Edges, snap: Snap) -> Option<Edges> {
    let mid = work.0 + width(work) / 2;
    match snap {
        Snap::Left => Some((work.0, work.1, mid, work.3)),
        Snap::Right => Some((mid, work.1, work.2, work.3)),
        Snap::Maximize => Some(work),
        Snap::Restore => None,
    }
}

/// A window moved to (x, y) with size kept: never so far that it can't be
/// grabbed again. Returns the rectangle.
pub fn moved(current: Edges, x: i32, y: i32, work: Edges) -> Edges {
    let (w, h) = (width(current), height(current));
    let nx = x.clamp(work.0 - w + KEEP_VISIBLE, work.2 - KEEP_VISIBLE);
    let ny = y.clamp(work.1, work.3 - 40);
    (nx, ny, nx + w, ny + h)
}

/// A window resized to w x h with the top-left corner kept, within the work
/// area and above the minimum.
pub fn resized(current: Edges, w: i32, h: i32, work: Edges) -> Edges {
    let (w, h) = (w.clamp(MIN_SIZE.0, width(work)), h.clamp(MIN_SIZE.1, height(work)));
    let left = current.0.min(work.2 - w).max(work.0 - 8);
    let top = current.1.min(work.3 - h).max(work.1);
    (left, top, left + w, top + h)
}

impl WinGeom {
    /// "800x600 at 100,80" for cards and results.
    pub fn describe(&self) -> String {
        match self.state {
            WinState::Maximized => "maximized".into(),
            WinState::Minimized => "minimized".into(),
            WinState::Normal => {
                format!("{}x{} at {},{}", width(self.rect), height(self.rect), self.rect.0, self.rect.1)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORK: Edges = (0, 0, 1920, 1040);

    #[test]
    fn snaps_fill_the_halves_of_the_work_area() {
        assert_eq!(snap_rect(WORK, Snap::Left), Some((0, 0, 960, 1040)));
        assert_eq!(snap_rect(WORK, Snap::Right), Some((960, 0, 1920, 1040)));
        assert_eq!(snap_rect(WORK, Snap::Maximize), Some(WORK));
        assert_eq!(snap_rect(WORK, Snap::Restore), None);
        // A second monitor to the right keeps its own offset.
        assert_eq!(snap_rect((1920, 0, 3840, 1040), Snap::Left), Some((1920, 0, 2880, 1040)));
    }

    #[test]
    fn snap_words_parse_leniently() {
        assert_eq!(Snap::parse("Left"), Some(Snap::Left));
        assert_eq!(Snap::parse("snap right"), Some(Snap::Right));
        assert_eq!(Snap::parse("maximise"), Some(Snap::Maximize));
        assert_eq!(Snap::parse("un-maximize"), Some(Snap::Restore));
        assert_eq!(Snap::parse("sideways"), None);
        for n in Snap::NAMES {
            assert!(Snap::parse(n).is_some(), "{n}");
        }
    }

    #[test]
    fn a_moved_window_stays_grabbable() {
        let cur = (100, 100, 900, 700);
        assert_eq!(moved(cur, 300, 200, WORK), (300, 200, 1100, 800));
        let far = moved(cur, 5000, 5000, WORK);
        assert!(far.0 <= 1920 - 100 && far.1 <= 1040 - 40, "{far:?}");
        let off = moved(cur, -5000, -5000, WORK);
        assert!(off.2 >= 100 && off.1 >= 0, "{off:?}");
        assert_eq!((width(far), height(far)), (800, 600), "size is kept");
    }

    #[test]
    fn a_resized_window_respects_the_screen_and_a_minimum() {
        let cur = (100, 100, 900, 700);
        assert_eq!(resized(cur, 1000, 500, WORK), (100, 100, 1100, 600));
        let tiny = resized(cur, 10, 10, WORK);
        assert_eq!((width(tiny), height(tiny)), MIN_SIZE);
        let big = resized(cur, 9999, 9999, WORK);
        assert_eq!((width(big), height(big)), (1920, 1040));
        assert!(big.0 >= -8 && big.2 <= 1920 + 8);
        // Growing near the right edge slides left instead of leaving the screen.
        let edge = resized((1500, 100, 1900, 500), 800, 400, WORK);
        assert_eq!(edge.2, 1920);
    }

    #[test]
    fn geometry_describes_itself_and_roundtrips() {
        let g = WinGeom { rect: (100, 80, 900, 680), state: WinState::Normal };
        assert_eq!(g.describe(), "800x600 at 100,80");
        let j = serde_json::to_string(&g).unwrap();
        assert_eq!(serde_json::from_str::<WinGeom>(&j).unwrap(), g);
        assert_eq!(WinGeom { state: WinState::Maximized, ..g }.describe(), "maximized");
    }
}
