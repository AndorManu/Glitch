//! Where to put the chat panel relative to Glitch. Pure math, unit-tested.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    fn right(&self) -> i32 {
        self.x + self.w
    }
    fn bottom(&self) -> i32 {
        self.y + self.h
    }
}

/// Prefer the left side of the mascot (bottom edges aligned); use the right
/// side if there is no room; always stay inside the monitor's work area
/// (i.e. not under the taskbar / menu bar). All values in physical pixels.
pub fn panel_position(mascot: Rect, panel_w: i32, panel_h: i32, area: Rect, gap: i32) -> (i32, i32) {
    let left = mascot.x - gap - panel_w;
    let x = if left >= area.x { left } else { mascot.right() + gap };
    let x = x.min(area.right() - panel_w).max(area.x);
    let y = (mascot.bottom() - panel_h).min(area.bottom() - panel_h).max(area.y);
    (x, y)
}

/// Where the chat bubble goes: centred above Glitch with its tail pointing
/// down at it; below Glitch (tail up) if there's no room above. `tail_x` is
/// the tail's distance from the bubble's left edge, so it still points at
/// Glitch when the bubble is pushed sideways by a screen edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BubblePlacement {
    pub x: i32,
    pub y: i32,
    pub tail_up: bool,
    pub tail_x: i32,
}

pub fn bubble_position(mascot: Rect, w: i32, h: i32, area: Rect, overlap: i32) -> BubblePlacement {
    let center = mascot.x + mascot.w / 2;
    let x = (center - w / 2).min(area.right() - w).max(area.x);
    let above = mascot.y - h + overlap;
    let (y, tail_up) = if above >= area.y {
        (above, false)
    } else {
        ((mascot.bottom() - overlap).min(area.bottom() - h).max(area.y), true)
    };
    let tail_x = (center - x).clamp(16.min(w / 2), (w - 16).max(w / 2));
    BubblePlacement { x, y, tail_up, tail_x }
}

/// Bottom-right corner of the work area, where Glitch appears on first start.
pub fn mascot_home(area: Rect, w: i32, h: i32, margin: i32) -> (i32, i32) {
    (area.right() - w - margin, area.bottom() - h - margin)
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: Rect = Rect { x: 0, y: 0, w: 1920, h: 1040 };

    #[test]
    fn left_of_mascot_when_room() {
        let m = Rect { x: 1800, y: 900, w: 96, h: 96 };
        assert_eq!(panel_position(m, 360, 520, AREA, 8), (1800 - 8 - 360, 996 - 520));
    }

    #[test]
    fn right_of_mascot_near_left_edge() {
        let m = Rect { x: 10, y: 900, w: 96, h: 96 };
        assert_eq!(panel_position(m, 360, 520, AREA, 8).0, 10 + 96 + 8);
    }

    #[test]
    fn clamped_inside_work_area() {
        let m = Rect { x: 50, y: 10, w: 96, h: 96 }; // near the top
        let (x, y) = panel_position(m, 360, 520, AREA, 8);
        assert!(x >= 0 && x + 360 <= 1920);
        assert_eq!(y, 0);
        // Panel bigger than the screen: pinned to the top-left of the area.
        let tiny = Rect { x: 100, y: 50, w: 300, h: 300 };
        assert_eq!(panel_position(m, 360, 520, tiny, 8), (100, 50));
    }

    #[test]
    fn second_monitor_with_negative_coordinates() {
        let area = Rect { x: -1920, y: 0, w: 1920, h: 1080 };
        let m = Rect { x: -200, y: 900, w: 96, h: 96 };
        let (x, _) = panel_position(m, 360, 520, area, 8);
        assert_eq!(x, -200 - 8 - 360);
    }

    #[test]
    fn bubble_sits_above_glitch_pointing_down() {
        let m = Rect { x: 1000, y: 900, w: 160, h: 110 };
        let b = bubble_position(m, 300, 120, AREA, 10);
        assert_eq!(b, BubblePlacement { x: 1080 - 150, y: 900 - 120 + 10, tail_up: false, tail_x: 150 });
    }

    #[test]
    fn bubble_goes_below_near_the_top_and_tail_follows_glitch_at_edges() {
        let m = Rect { x: 1800, y: 20, w: 110, h: 110 };
        let b = bubble_position(m, 300, 120, AREA, 10);
        assert!(b.tail_up);
        assert_eq!(b.y, 130 - 10);
        assert_eq!(b.x, 1920 - 300); // pushed left by the screen edge
        assert_eq!(b.tail_x, 1855 - (1920 - 300)); // still points at Glitch
        let left = bubble_position(Rect { x: 0, y: 900, w: 110, h: 110 }, 300, 120, AREA, 10);
        assert_eq!(left.x, 0);
        assert_eq!(left.tail_x, 55);
    }

    #[test]
    fn home_is_bottom_right() {
        assert_eq!(mascot_home(AREA, 160, 110, 24), (1920 - 184, 1040 - 134));
    }
}
