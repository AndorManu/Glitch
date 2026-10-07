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

/// Bottom-right corner of the work area, where Glitch appears on first start.
pub fn mascot_home(area: Rect, size: i32, margin: i32) -> (i32, i32) {
    (area.right() - size - margin, area.bottom() - size - margin)
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
    fn home_is_bottom_right() {
        assert_eq!(mascot_home(AREA, 96, 24), (1920 - 120, 1040 - 120));
    }
}
