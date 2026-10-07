//! Glitch's playground: which parts of the screen he can stand on.
//!
//! The OS code (src-tauri/src/world_native.rs) lists the other apps' windows
//! front-to-back; this module turns them into **ledges**: the visible parts
//! of their top edges, where Glitch can walk, sit and land. Pure, so it is
//! unit-tested everywhere.

use serde::Serialize;

/// Physical-pixel rectangle, screen coordinates (y grows downwards).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ScreenRect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl ScreenRect {
    pub fn right(&self) -> i32 {
        self.x + self.w
    }
    pub fn bottom(&self) -> i32 {
        self.y + self.h
    }
}

/// Another app's window, as reported by the OS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AppWindow {
    /// HWND on Windows, CGWindowID on macOS.
    pub id: u64,
    pub rect: ScreenRect,
}

/// A walkable segment: the visible part of a window's top edge.
/// One window can give several segments (same `id`) if something in front
/// of it covers the middle of its top edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Ledge {
    pub id: u64,
    pub x: i32,
    pub y: i32,
    pub w: i32,
}

/// Windows smaller than this aren't real app windows (tooltips, popups).
pub const MIN_WINDOW_W: i32 = 160;
pub const MIN_WINDOW_H: i32 = 100;

/// `windows` must be ordered front-to-back (as both OS APIs return them).
/// `headroom`: space needed above an edge for Glitch to stand there.
/// `min_width`: shorter visible segments are dropped.
pub fn ledges(windows: &[AppWindow], area: ScreenRect, headroom: i32, min_width: i32) -> Vec<Ledge> {
    let mut out = Vec::new();
    for (i, win) in windows.iter().enumerate() {
        let r = win.rect;
        if r.w < MIN_WINDOW_W || r.h < MIN_WINDOW_H {
            continue;
        }
        let y = r.y;
        // Needs room above it, and must be on this monitor's work area.
        if y - headroom < area.y || y >= area.bottom() {
            continue;
        }
        let mut segments = vec![(r.x.max(area.x), r.right().min(area.right()))];
        // Windows in front that cover the edge line hide that part of it.
        for front in &windows[..i] {
            let f = front.rect;
            if f.w < MIN_WINDOW_W || f.h < MIN_WINDOW_H || !(f.y <= y && y < f.bottom()) {
                continue;
            }
            segments = segments.into_iter().flat_map(|(a, b)| subtract((a, b), (f.x, f.right()))).collect();
        }
        out.extend(segments.into_iter().filter(|(a, b)| b - a >= min_width).map(|(a, b)| Ledge {
            id: win.id,
            x: a,
            y,
            w: b - a,
        }));
    }
    out
}

/// `[a, b)` minus `[c, d)`: zero, one or two intervals.
fn subtract((a, b): (i32, i32), (c, d): (i32, i32)) -> Vec<(i32, i32)> {
    if d <= a || c >= b {
        return vec![(a, b)];
    }
    let mut v = Vec::new();
    if c > a {
        v.push((a, c));
    }
    if d < b {
        v.push((d, b));
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: ScreenRect = ScreenRect { x: 0, y: 0, w: 1920, h: 1040 };

    fn win(id: u64, x: i32, y: i32, w: i32, h: i32) -> AppWindow {
        AppWindow { id, rect: ScreenRect { x, y, w, h } }
    }

    #[test]
    fn a_lone_window_gives_its_whole_top_edge() {
        assert_eq!(ledges(&[win(1, 300, 400, 800, 500)], AREA, 200, 60), [Ledge { id: 1, x: 300, y: 400, w: 800 }]);
    }

    #[test]
    fn windows_in_front_hide_part_of_an_edge() {
        let front = win(1, 500, 300, 300, 400); // covers y=400 between x 500..800
        let back = win(2, 300, 400, 800, 500);
        let l = ledges(&[front, back], AREA, 200, 60);
        assert_eq!(
            l,
            [
                Ledge { id: 1, x: 500, y: 300, w: 300 },
                Ledge { id: 2, x: 300, y: 400, w: 200 },
                Ledge { id: 2, x: 800, y: 400, w: 300 },
            ]
        );
        // A window *behind* never hides one in front.
        let l = ledges(&[back, front], AREA, 200, 60);
        assert!(l.contains(&Ledge { id: 2, x: 300, y: 400, w: 800 }));
    }

    #[test]
    fn no_headroom_offscreen_tiny_or_slivers() {
        // Maximised window: its top is the top of the work area.
        assert!(ledges(&[win(1, 0, 0, 1920, 1040)], AREA, 200, 60).is_empty());
        // Below the work area (other monitor / taskbar).
        assert!(ledges(&[win(1, 0, 1100, 800, 500)], AREA, 200, 60).is_empty());
        // Tooltip-sized.
        assert!(ledges(&[win(1, 100, 500, 120, 40)], AREA, 200, 60).is_empty());
        // Only a 40 px sliver stays visible.
        let l = ledges(&[win(1, 0, 300, 1880, 500), win(2, 0, 400, 1920, 500)], AREA, 200, 60);
        assert!(l.iter().all(|l| l.id != 2));
    }

    #[test]
    fn edges_are_clipped_to_the_work_area() {
        let l = ledges(&[win(1, -300, 500, 800, 400)], AREA, 200, 60);
        assert_eq!(l, [Ledge { id: 1, x: 0, y: 500, w: 500 }]);
    }

    #[test]
    fn other_monitors_with_negative_coordinates() {
        let left = ScreenRect { x: -1920, y: 0, w: 1920, h: 1080 };
        let l = ledges(&[win(7, -1500, 600, 700, 300)], left, 200, 60);
        assert_eq!(l, [Ledge { id: 7, x: -1500, y: 600, w: 700 }]);
    }
}
