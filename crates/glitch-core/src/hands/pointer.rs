//! The mouse pointer, as plans: what the real pointer should do and how it
//! gets there. The native side (`src-tauri/src/hands_desktop.rs`) plays the
//! plan with `SendInput`, in small eased steps so it looks like Glitch is
//! moving the cursor himself; this file is the pure part, tested here.

use serde::Serialize;

pub type Point = (i32, i32);

/// The ring and paw appear at the target this long BEFORE the pointer sets
/// off, so the user sees what is about to happen.
pub const PREVIEW_MS: u64 = 400;
/// A step of the eased path is checked for the user's own input this often.
pub const STEP_MS: u64 = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClickKind {
    Left,
    Right,
    Double,
}

impl ClickKind {
    pub const NAMES: [&'static str; 3] = ["left", "right", "double"];

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s.trim().to_lowercase().replace([' ', '-', '_'], "").as_str() {
            "left" | "click" | "single" | "primary" => Self::Left,
            "right" | "context" | "rightclick" | "secondary" => Self::Right,
            "double" | "doubleclick" | "open" | "2" => Self::Double,
            _ => return None,
        })
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Left => "Click",
            Self::Right => "Right-click",
            Self::Double => "Double-click",
        }
    }
}

/// One pointer action, at screen pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PointerOp {
    Move {
        to: Point,
    },
    Click {
        at: Point,
        kind: ClickKind,
    },
    Drag {
        from: Point,
        to: Point,
    },
    /// `notches` wheel clicks: positive scrolls up, negative down.
    Scroll {
        at: Point,
        notches: i32,
    },
}

impl PointerOp {
    /// The spots the user is shown a ring on, in order.
    pub fn spots(&self) -> Vec<Point> {
        match *self {
            Self::Move { to } => vec![to],
            Self::Click { at, .. } | Self::Scroll { at, .. } => vec![at],
            Self::Drag { from, to } => vec![from, to],
        }
    }
}

/// Smootherstep: slow start, slow stop.
pub fn ease(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

fn dist(a: Point, b: Point) -> f64 {
    (((a.0 - b.0) as f64).powi(2) + ((a.1 - b.1) as f64).powi(2)).sqrt()
}

/// How long the trip takes: short hops are quick, a cross-screen trip about
/// two thirds of a second. Never slower, so a task doesn't drag.
pub fn travel_ms(from: Point, to: Point) -> u64 {
    (180.0 + dist(from, to) * 0.35).clamp(180.0, 650.0) as u64
}

/// The cursor's positions from `from` to exactly `to`: eased along a very
/// slight curve (a straight machine line looks robotic), one position per
/// [`STEP_MS`].
pub fn path(from: Point, to: Point) -> Vec<Point> {
    let d = dist(from, to);
    if d < 1.0 {
        return vec![to];
    }
    let steps = (travel_ms(from, to) / STEP_MS).max(4) as usize;
    // A bend of at most 4% of the distance, sideways.
    let (nx, ny) = (-(to.1 - from.1) as f64 / d, (to.0 - from.0) as f64 / d);
    let bend = (d * 0.04).min(24.0);
    (1..=steps)
        .map(|i| {
            let t = i as f64 / steps as f64;
            let e = ease(t);
            let arc = (std::f64::consts::PI * t).sin() * bend;
            if i == steps {
                return to;
            }
            (
                (from.0 as f64 + (to.0 - from.0) as f64 * e + nx * arc).round() as i32,
                (from.1 as f64 + (to.1 - from.1) as f64 * e + ny * arc).round() as i32,
            )
        })
        .collect()
}

/// A drag: press, then a slower path (apps need the move events to start a
/// drag), then release. Returns the path to walk while the button is down.
pub fn drag_path(from: Point, to: Point) -> Vec<Point> {
    let mut p = path(from, to);
    // Hover over the target a moment before dropping: apps highlight the
    // drop spot only after a few move events there.
    p.extend(std::iter::repeat_n(to, 6));
    p
}

/// Wheel notches for "scroll down a bit" / "a lot".
pub fn notches(down: bool, amount: Option<i32>) -> i32 {
    let n = amount.unwrap_or(3).clamp(1, 15);
    if down {
        -n
    } else {
        n
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn click_kinds_parse_leniently() {
        assert_eq!(ClickKind::parse("Left"), Some(ClickKind::Left));
        assert_eq!(ClickKind::parse("right-click"), Some(ClickKind::Right));
        assert_eq!(ClickKind::parse("double click"), Some(ClickKind::Double));
        assert_eq!(ClickKind::parse("middle"), None, "no middle clicks");
        assert_eq!(ClickKind::parse("drag"), None);
    }

    #[test]
    fn the_path_starts_near_and_ends_exactly_on_the_target() {
        let (a, b) = ((100, 100), (900, 500));
        let p = path(a, b);
        assert_eq!(*p.last().unwrap(), b);
        assert!(dist(p[0], a) < 40.0, "first step is small: {:?}", p[0]);
        assert!(p.len() >= 18 && p.len() <= 70, "{} steps", p.len());
    }

    #[test]
    fn the_path_is_eased_slow_at_both_ends_fast_in_the_middle() {
        let p = path((0, 0), (1000, 0));
        let steps: Vec<f64> = std::iter::once((0, 0))
            .chain(p.iter().copied())
            .collect::<Vec<_>>()
            .windows(2)
            .map(|w| dist(w[0], w[1]))
            .collect();
        let mid = steps[steps.len() / 2];
        assert!(steps[0] < mid / 3.0 && *steps.last().unwrap() < mid / 3.0, "{:?} vs {mid}", &steps[..3]);
    }

    #[test]
    fn no_step_jumps_far_and_the_trip_stays_quick() {
        for (a, b) in [((0, 0), (1900, 1000)), ((500, 500), (520, 505)), ((10, 10), (10, 900))] {
            let p = path(a, b);
            let mut prev = a;
            let mut longest: f64 = 0.0;
            for q in &p {
                longest = longest.max(dist(prev, *q));
                prev = *q;
            }
            assert!(longest < 120.0, "{a:?}->{b:?}: step of {longest}");
            assert!(travel_ms(a, b) <= 650);
            assert!(p.len() as u64 * STEP_MS <= 700);
        }
    }

    #[test]
    fn staying_put_is_one_step() {
        assert_eq!(path((5, 5), (5, 5)), vec![(5, 5)]);
    }

    #[test]
    fn the_curve_is_slight_and_bounded() {
        let p = path((0, 0), (1000, 0));
        let off = p.iter().map(|q| q.1.abs()).max().unwrap();
        assert!((1..=25).contains(&off), "sideways bend {off}");
    }

    #[test]
    fn drags_hover_on_the_target_before_letting_go() {
        let p = drag_path((10, 10), (300, 200));
        assert_eq!(&p[p.len() - 6..], &[(300, 200); 6]);
        assert_eq!(PointerOp::Drag { from: (1, 2), to: (3, 4) }.spots(), vec![(1, 2), (3, 4)]);
    }

    #[test]
    fn scroll_notches_are_signed_and_capped() {
        assert_eq!(notches(true, None), -3);
        assert_eq!(notches(false, Some(5)), 5);
        assert_eq!(notches(true, Some(500)), -15);
        assert_eq!(notches(true, Some(0)), -1);
    }
}
