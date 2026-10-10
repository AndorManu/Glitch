//! Chaos mode 2 ("old virus style"): the pure rules behind the new acts.
//! Everything that decides *whether*, *how long*, *where to* and *when to
//! stop* lives here, so it is unit-tested on every OS. The OS calls are in
//! `src-tauri/src/chaos_native.rs`, the runtime that drives them in
//! `src-tauri/src/chaos2.rs`.
//!
//! Everything here is harmless and fake: Glitch's own pixel art, his own
//! overlay, his own popups. The hard limits (each one has a test):
//!
//! * user input always wins: real mouse movement, a mouse button, Esc, the
//!   panic hotkey or "Stop chaos" end any cursor/window act on the very next
//!   tick (8 ms), far inside the 100 ms budget ([`ABORT_BUDGET_MS`]);
//! * no act runs longer than [`MAX_ACT`] (20 s), every act has a cooldown and
//!   there is a global rate limit ([`GlobalLimit`]);
//! * nothing flashes faster than 3 Hz ([`flash_rate_ok`], [`FlashBudget`]);
//! * a window Glitch minimised is always restored within [`YOINK_MAX`], and
//!   only ever one Glitch himself minimised ([`MinimizeBook`]).

use std::collections::VecDeque;
use std::f64::consts::TAU;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::chaos::{limit_offset, Candidate, Refusal, MAX_WINDOW_TRAVEL, MIN_H, MIN_IDLE_MS, MIN_W};
use crate::world::ScreenRect;

// ------------------------------------------------------------------ levels

/// Settings > Features > Chaos mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChaosLevel {
    Off,
    /// Today's behaviour (windows nudged, cursor chased, paw prints, notes).
    #[default]
    Gentle,
    Mischief,
    FullVirus,
}

/// The new acts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Fx {
    /// The fishing line that hooks the real cursor and drags it.
    Hook,
    /// The cursor circles slowly around a point.
    Orbit,
    /// A tiny shake of the cursor.
    Jitter,
    /// Little cursor hops of 10-40 px with a spark.
    Hops,
    /// Fading copies of the arrow behind the real one (overlay only).
    Trail,
    /// Magenta matrix rain (overlay only).
    Matrix,
    /// A CRT scanline sweep (overlay only).
    Scanlines,
    /// The screen melts: a screenshot in RAM drawn as sliding columns (overlay only).
    Melt,
    /// Tiny screen bugs crawl along window tops, Glitch squashes them (overlay only).
    Bugs,
    /// Mini clones run around the work area, then pop.
    Swarm,
    /// A fake pixel popup in his own style.
    Popup,
    /// Minimise one window (only ones he minimised are ever restored), pop it back.
    Yoink,
    /// A window dance: wobble, slide to the edge and back, earthquake, running away.
    Dance,
}

impl Fx {
    pub const ALL: [Fx; 13] = [
        Fx::Hook,
        Fx::Orbit,
        Fx::Jitter,
        Fx::Hops,
        Fx::Trail,
        Fx::Matrix,
        Fx::Scanlines,
        Fx::Melt,
        Fx::Bugs,
        Fx::Swarm,
        Fx::Popup,
        Fx::Yoink,
        Fx::Dance,
    ];

    /// Effects that only draw on Glitch's own overlay (switched off by "Reduce effects").
    pub fn overlay_only(self) -> bool {
        matches!(self, Fx::Trail | Fx::Matrix | Fx::Scanlines | Fx::Melt | Fx::Bugs | Fx::Swarm)
    }

    /// Needs the real cursor.
    pub fn moves_cursor(self) -> bool {
        matches!(self, Fx::Hook | Fx::Orbit | Fx::Jitter | Fx::Hops)
    }

    pub fn min_level(self) -> ChaosLevel {
        match self {
            Fx::Hops | Fx::Matrix | Fx::Melt | Fx::Swarm => ChaosLevel::FullVirus,
            _ => ChaosLevel::Mischief,
        }
    }

    /// Longest this act may run (hard cap, enforced by the runtime).
    pub fn max_duration(self) -> Duration {
        Duration::from_millis(match self {
            Fx::Hook => 10_000,
            Fx::Orbit => 7_000,
            Fx::Jitter => 2_000,
            Fx::Hops => 6_000,
            Fx::Trail => 6_500,
            Fx::Matrix => 5_000,
            Fx::Scanlines => 4_000,
            Fx::Melt => 6_000,
            Fx::Bugs => 10_000,
            Fx::Swarm => 9_000,
            Fx::Popup => 20_000,
            Fx::Yoink => 15_000,
            Fx::Dance => 10_000,
        })
    }

    /// Own cooldown: the same act at most this often.
    pub fn cooldown(self, level: ChaosLevel) -> Duration {
        let base = match self {
            Fx::Yoink => 180,
            Fx::Hook | Fx::Dance | Fx::Melt | Fx::Swarm => 150,
            Fx::Popup | Fx::Bugs | Fx::Matrix => 120,
            _ => 90,
        };
        let secs = match (level, self) {
            (ChaosLevel::FullVirus, Fx::Yoink) => 120,
            (ChaosLevel::FullVirus, _) => base / 2,
            _ => base,
        };
        Duration::from_secs(secs)
    }
}

/// Never longer than this, whatever the act (the spec's 20 s).
pub const MAX_ACT: Duration = Duration::from_secs(20);

impl ChaosLevel {
    pub fn rank(self) -> u8 {
        self as u8
    }

    /// Switched on at all (the old `chaos_enabled`).
    pub fn is_on(self) -> bool {
        self != ChaosLevel::Off
    }

    /// May this level do that act?
    pub fn allows(self, fx: Fx) -> bool {
        self.is_on() && self.rank() >= fx.min_level().rank()
    }

    /// Time between two acts (a random point in the range).
    pub fn gap(self) -> Option<(Duration, Duration)> {
        let s = Duration::from_secs;
        match self {
            ChaosLevel::Off => None,
            ChaosLevel::Gentle => Some((s(45), s(120))),
            ChaosLevel::Mischief => Some((s(90), s(180))),
            ChaosLevel::FullVirus => Some((s(30), s(60))),
        }
    }

    /// Global rate limit: new acts per [`GlobalLimit::WINDOW`].
    pub fn max_acts_per_window(self) -> usize {
        match self {
            ChaosLevel::Off => 0,
            ChaosLevel::Gentle => 8,
            ChaosLevel::Mischief => 6,
            ChaosLevel::FullVirus => 16,
        }
    }

    /// The least time between two new acts, whatever they are.
    pub fn min_spacing(self) -> Duration {
        Duration::from_secs(match self {
            ChaosLevel::Off | ChaosLevel::Gentle => 20,
            ChaosLevel::Mischief => 45,
            ChaosLevel::FullVirus => 25,
        })
    }

    /// How hard the hook may pull: (longest, furthest in CSS px).
    pub fn hook_limits(self) -> (Duration, f64) {
        match self {
            ChaosLevel::FullVirus => (Duration::from_millis(8_000), 400.0),
            _ => (Duration::from_millis(5_000), 250.0),
        }
    }

    /// How many windows he may have minimised at once.
    pub fn max_yoinked(self) -> usize {
        match self {
            ChaosLevel::FullVirus => 2,
            ChaosLevel::Mischief => 1,
            _ => 0,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ChaosLevel::Off => "Chaos: Off",
            ChaosLevel::Gentle => "Chaos: Gentle",
            ChaosLevel::Mischief => "Chaos: Mischief",
            ChaosLevel::FullVirus => "Chaos: Full Virus",
        }
    }

    /// Full Virus needs the one-time confirmation; without it the level is Mischief.
    pub fn confirmed(self, full_virus_confirmed: bool) -> ChaosLevel {
        if self == ChaosLevel::FullVirus && !full_virus_confirmed {
            ChaosLevel::Mischief
        } else {
            self
        }
    }
}

/// Global rate limit over all new acts: a spacing and a count per window.
#[derive(Debug, Default, Clone)]
pub struct GlobalLimit {
    starts: VecDeque<Duration>,
}

impl GlobalLimit {
    pub const WINDOW: Duration = Duration::from_secs(10 * 60);

    /// May an act start at `now` (any monotonic clock)?
    pub fn allows(&mut self, now: Duration, level: ChaosLevel) -> bool {
        while self.starts.front().is_some_and(|s| now.saturating_sub(*s) >= Self::WINDOW) {
            self.starts.pop_front();
        }
        if self.starts.len() >= level.max_acts_per_window() {
            return false;
        }
        self.starts.back().is_none_or(|l| now.saturating_sub(*l) >= level.min_spacing())
    }

    pub fn record(&mut self, now: Duration) {
        self.starts.push_back(now);
    }
}

// ------------------------------------------------------------------ flashes

/// WCAG 2.3.1: no more than three flashes in any one second.
pub const MAX_FLASHES_PER_SEC: usize = 3;

/// Do these flash times (ms, ascending) keep to [`MAX_FLASHES_PER_SEC`] in every 1 s window?
pub fn flash_rate_ok(times_ms: &[u64]) -> bool {
    times_ms.iter().enumerate().all(|(i, t)| times_ms[i..].iter().take_while(|u| **u < t + 1000).count() <= MAX_FLASHES_PER_SEC)
}

/// Lets sparks and glitch flashes through only while they stay under the limit.
#[derive(Debug, Default, Clone)]
pub struct FlashBudget {
    recent: VecDeque<u64>,
}

impl FlashBudget {
    pub fn try_flash(&mut self, now_ms: u64) -> bool {
        while self.recent.front().is_some_and(|t| now_ms.saturating_sub(*t) >= 1000) {
            self.recent.pop_front();
        }
        if self.recent.len() >= MAX_FLASHES_PER_SEC {
            return false;
        }
        self.recent.push_back(now_ms);
        true
    }
}

// ---------------------------------------------------------- cursor scripts

/// One tick of a cursor script: 8 ms, so an abort is felt within one tick.
pub const TICK_MS: u32 = 8;
/// What the spec asks: user input stops it within this long.
pub const ABORT_BUDGET_MS: u32 = 100;
/// The cursor ends up further than this from where Glitch put it: the user pulls (physical px).
pub const FIGHT_PX: i32 = 8;
/// The cursor never jumps further than this per tick while being pulled (CSS px).
pub const MAX_STEP: f64 = 26.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HookStyle {
    /// Reeled in towards him.
    Pull,
    /// A lazy circle.
    Circle,
    /// A figure-eight.
    Figure8,
    /// Bouncing like a fish on the line.
    Bounce,
}

pub const HOOK_STYLES: [HookStyle; 4] = [HookStyle::Pull, HookStyle::Circle, HookStyle::Figure8, HookStyle::Bounce];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "style", rename_all = "snake_case")]
pub enum CursorAct {
    Hook(HookStyle),
    Orbit,
    Jitter,
    Hops,
}

impl CursorAct {
    pub fn fx(self) -> Fx {
        match self {
            CursorAct::Hook(_) => Fx::Hook,
            CursorAct::Orbit => Fx::Orbit,
            CursorAct::Jitter => Fx::Jitter,
            CursorAct::Hops => Fx::Hops,
        }
    }
}

/// What the runtime reads before every tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sample {
    /// Milliseconds since the script started.
    pub t_ms: u32,
    pub cursor: (i32, i32),
    /// Real keyboard/mouse input since the script started (GetLastInputInfo:
    /// `SetCursorPos` does not count, a real mouse move does).
    pub input_since_start: bool,
    /// Any mouse button down.
    pub button: bool,
    pub esc: bool,
    /// Panic hotkey, tray "Stop chaos", settings change, chat opened...
    pub stop: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AbortReason {
    Stopped,
    Esc,
    Button,
    UserInput,
    UserMoved,
    /// The cursor could not be read or set.
    Lost,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tick {
    /// Put the cursor here.
    Move(i32, i32),
    /// Finished normally.
    Done,
    /// Let go now.
    Abort(AbortReason),
}

fn smooth(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn unit(dx: f64, dy: f64) -> (f64, f64) {
    let l = (dx * dx + dy * dy).sqrt();
    if l < 1e-6 {
        (0.0, -1.0)
    } else {
        (dx / l, dy / l)
    }
}

/// A tiny deterministic hash -> [0, 1).
pub fn hash01(a: u64, b: u64) -> f64 {
    let mut x = a.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ b.wrapping_mul(0xC2B2_AE3D_27D4_EB4F);
    x ^= x >> 29;
    x = x.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x ^= x >> 32;
    (x % 1_000_003) as f64 / 1_000_003.0
}

/// The hop times of the hop act (ms): spaced 700+ ms so sparks stay far under 3 per second.
pub const HOP_TIMES: [u32; 5] = [500, 1300, 2200, 3000, 3900];
pub const HOP_MIN: f64 = 10.0;
pub const HOP_MAX: f64 = 40.0;

/// A cursor act in progress. Pure: feed it samples, it says what to do.
#[derive(Debug, Clone)]
pub struct CursorScript {
    pub act: CursorAct,
    pub start: (i32, i32),
    /// Where Glitch's rod tip is (physical px): the hook pulls towards it.
    pub rod: (i32, i32),
    pub area: ScreenRect,
    pub scale: f64,
    pub seed: u64,
    max_ms: u32,
    max_travel: f64,
    last_set: (i32, i32),
}

impl CursorScript {
    pub fn new(act: CursorAct, level: ChaosLevel, start: (i32, i32), rod: (i32, i32), area: ScreenRect, scale: f64, seed: u64) -> Self {
        let (max_ms, max_travel) = match act {
            CursorAct::Hook(_) => {
                let (d, t) = level.hook_limits();
                (d.as_millis() as u32, t)
            }
            CursorAct::Orbit => (6_500, 160.0),
            CursorAct::Jitter => (1_800, 6.0),
            CursorAct::Hops => (4_800, 120.0),
        };
        CursorScript { act, start, rod, area, scale: scale.max(0.5), seed, max_ms, max_travel, last_set: start }
    }

    pub fn duration_ms(&self) -> u32 {
        self.max_ms
    }

    /// Furthest from the start the cursor may ever be (physical px).
    pub fn max_travel_px(&self) -> f64 {
        self.max_travel * self.scale
    }

    /// Where the act wants the cursor at `t_ms`, before clamping (physical px, absolute).
    pub fn wanted(&self, t_ms: u32) -> (f64, f64) {
        let u = self.scale;
        let (sx, sy) = (self.start.0 as f64, self.start.1 as f64);
        let t = t_ms as f64 / 1000.0;
        let total = self.max_ms as f64 / 1000.0;
        let (ux, uy) = unit(self.rod.0 as f64 - sx, self.rod.1 as f64 - sy);
        // Glitch is somewhere above (or beside) the cursor: perpendicular for the wobble.
        let (px, py) = (-uy, ux);
        let ramp = smooth(t / 0.7);
        let fade = smooth((total - t) / 0.5);
        match self.act {
            CursorAct::Hook(HookStyle::Pull) => {
                let dist = ((self.rod.0 as f64 - sx).powi(2) + (self.rod.1 as f64 - sy).powi(2)).sqrt();
                let reach = (dist * 0.8).clamp(0.0, self.max_travel * u).max(60.0 * u).min(self.max_travel * u);
                let s = reach * smooth(t / (total * 0.85));
                let wob = 12.0 * u * (TAU * t / 1.3).sin() * ramp * fade;
                (sx + ux * s + px * wob, sy + uy * s + py * wob)
            }
            CursorAct::Hook(HookStyle::Circle) | CursorAct::Orbit => {
                let (r, period) = if matches!(self.act, CursorAct::Orbit) { (70.0 * u, 4.0) } else { (85.0 * u, 3.2) };
                // The circle's centre is `r` away from the start, towards the rod (orbit: to the right):
                // the cursor starts on the circle, so there is no jump.
                let (dx, dy) = if matches!(self.act, CursorAct::Orbit) { (1.0, 0.0) } else { (ux, uy) };
                let (cx, cy) = (sx + dx * r, sy + dy * r);
                let phi0 = (-dy).atan2(-dx);
                let a = phi0 + TAU * t / period;
                let k = fade;
                // Fading out: drift back onto the start so it ends where it began.
                let (x, y) = (cx + r * a.cos(), cy + r * a.sin());
                (sx + (x - sx) * k, sy + (y - sy) * k)
            }
            CursorAct::Hook(HookStyle::Figure8) => {
                let a = 105.0 * u;
                let w = TAU * t / 3.6;
                let (ox, oy) = (a * w.sin(), 0.5 * a * (2.0 * w).sin());
                // Rotated so the long side points at the rod.
                let (rx, ry) = (ox * ux - oy * uy, ox * uy + oy * ux);
                (sx + ux * a * 0.9 * ramp * fade + rx * ramp * fade, sy + uy * a * 0.9 * ramp * fade + ry * ramp * fade)
            }
            CursorAct::Hook(HookStyle::Bounce) => {
                let dist = ((self.rod.0 as f64 - sx).powi(2) + (self.rod.1 as f64 - sy).powi(2)).sqrt();
                let reach = (dist * 0.7).clamp(70.0 * u, self.max_travel * u).min(self.max_travel * u);
                let along = reach * smooth(t / (total * 0.9));
                // A fish on the line: arcs that get lower as it tires.
                let beat = 0.85;
                let phase = (t / beat).fract();
                let height = 70.0 * u * (1.0 - 0.6 * (t / total).clamp(0.0, 1.0));
                let hop = height * (std::f64::consts::PI * phase).sin();
                let side = ((t / beat).floor() as i64 % 2 * 2 - 1) as f64;
                (sx + ux * along + px * side * 14.0 * u * phase - 0.0 * uy, sy + uy * along + py * side * 14.0 * u * phase - hop * 0.6)
            }
            CursorAct::Jitter => {
                // A new tiny offset every 50 ms, at most 3 px.
                let step = (t_ms / 50) as u64;
                let amp = 3.0 * u.min(2.0);
                let env = ramp * fade;
                (sx + (hash01(self.seed, step * 2) * 2.0 - 1.0) * amp * env, sy + (hash01(self.seed, step * 2 + 1) * 2.0 - 1.0) * amp * env)
            }
            CursorAct::Hops => {
                let (mut x, mut y) = (sx, sy);
                for (i, at) in HOP_TIMES.iter().enumerate() {
                    if t_ms < *at {
                        break;
                    }
                    let len = (HOP_MIN + hash01(self.seed, i as u64 * 7 + 1) * (HOP_MAX - HOP_MIN)) * u;
                    let ang = hash01(self.seed, i as u64 * 7 + 2) * TAU;
                    x += len * ang.cos();
                    y += len * ang.sin();
                }
                (x, y)
            }
        }
    }

    /// The position for `t_ms` on screen: limited to the travel limit and the work area.
    pub fn target(&self, t_ms: u32) -> (i32, i32) {
        let (wx, wy) = self.wanted(t_ms);
        let (dx, dy) = limit_offset(wx - self.start.0 as f64, wy - self.start.1 as f64, self.max_travel_px());
        let a = self.area;
        (
            (self.start.0 as f64 + dx).round().clamp(a.x as f64, (a.right() - 1) as f64) as i32,
            (self.start.1 as f64 + dy).round().clamp(a.y as f64, (a.bottom() - 1) as f64) as i32,
        )
    }

    /// Does this tick show the user taking the mouse back? (Public for tests.)
    pub fn user_fights(&self, now: (i32, i32)) -> bool {
        (now.0 - self.last_set.0).abs() > FIGHT_PX || (now.1 - self.last_set.1).abs() > FIGHT_PX
    }

    /// One 8 ms tick. Abort checks first, in order of how much the user means it.
    pub fn tick(&mut self, s: &Sample) -> Tick {
        if s.stop {
            return Tick::Abort(AbortReason::Stopped);
        }
        if s.esc {
            return Tick::Abort(AbortReason::Esc);
        }
        if s.button {
            return Tick::Abort(AbortReason::Button);
        }
        if s.input_since_start {
            return Tick::Abort(AbortReason::UserInput);
        }
        if self.user_fights(s.cursor) {
            return Tick::Abort(AbortReason::UserMoved);
        }
        if s.t_ms >= self.max_ms {
            return Tick::Done;
        }
        let want = self.target(s.t_ms);
        // Never a big leap (hops are the one act that jumps, by design).
        let to = if matches!(self.act, CursorAct::Hops) { want } else { step_towards(self.last_set, want, MAX_STEP * self.scale) };
        self.last_set = to;
        Tick::Move(to.0, to.1)
    }
}

/// Move from `from` towards `to` by at most `max` px.
pub fn step_towards(from: (i32, i32), to: (i32, i32), max: f64) -> (i32, i32) {
    let (dx, dy) = ((to.0 - from.0) as f64, (to.1 - from.1) as f64);
    let (dx, dy) = limit_offset(dx, dy, max);
    (from.0 + dx.round() as i32, from.1 + dy.round() as i32)
}

// -------------------------------------------------------- window dances

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DanceKind {
    /// Slow wobble in a little ellipse.
    Wobble,
    /// Slides slowly to the screen edge and back.
    EdgeSlide,
    /// +-6 px earthquake for 2 s.
    Quake,
    /// Runs away when the cursor comes near.
    RunAway,
}

pub const DANCE_KINDS: [DanceKind; 4] = [DanceKind::Wobble, DanceKind::EdgeSlide, DanceKind::Quake, DanceKind::RunAway];
/// Earthquake amplitude (CSS px) and length. Frequency 2.5 Hz: well under 3 Hz.
pub const QUAKE_AMP: f64 = 6.0;
pub const QUAKE_MS: u32 = 2_000;
pub const QUAKE_HZ: f64 = 2.5;
/// The carry back to the window's original place.
pub const RETURN_MS: u32 = 700;

impl DanceKind {
    /// Length of the dance itself (the carry back comes after).
    pub fn main_ms(self) -> u32 {
        match self {
            DanceKind::Wobble => 5_000,
            DanceKind::EdgeSlide => 7_600,
            DanceKind::Quake => QUAKE_MS,
            DanceKind::RunAway => 8_000,
        }
    }
    pub fn total_ms(self) -> u32 {
        self.main_ms() + RETURN_MS
    }
}

/// A window dance in progress (offsets are from where the window started).
#[derive(Debug, Clone)]
pub struct DanceScript {
    pub kind: DanceKind,
    pub home: ScreenRect,
    pub area: ScreenRect,
    pub scale: f64,
    /// +1: slide to the right edge, -1: to the left.
    dir: f64,
    cur: (f64, f64),
    at_main_end: Option<(f64, f64)>,
}

impl DanceScript {
    pub fn new(kind: DanceKind, home: ScreenRect, area: ScreenRect, scale: f64) -> Self {
        let room_l = (home.x - area.x) as f64;
        let room_r = (area.right() - home.right()) as f64;
        DanceScript { kind, home, area, scale: scale.max(0.5), dir: if room_r >= room_l { 1.0 } else { -1.0 }, cur: (0.0, 0.0), at_main_end: None }
    }

    pub fn total_ms(&self) -> u32 {
        self.kind.total_ms()
    }

    fn envelope(t: f64, total: f64) -> f64 {
        smooth(t / 0.5) * smooth((total - t) / 0.5)
    }

    /// Offset (physical px) from the home position at `t_ms`. `cursor`: only RunAway looks at it.
    /// Call with increasing `t_ms`.
    pub fn offset(&mut self, t_ms: u32, dt_ms: u32, cursor: (i32, i32)) -> (f64, f64) {
        let u = self.scale;
        let main = self.kind.main_ms();
        if t_ms >= main {
            let from = *self.at_main_end.get_or_insert(self.cur);
            let k = 1.0 - smooth((t_ms - main) as f64 / RETURN_MS as f64);
            self.cur = (from.0 * k, from.1 * k);
            return self.cur;
        }
        let t = t_ms as f64 / 1000.0;
        let total = main as f64 / 1000.0;
        let env = Self::envelope(t, total);
        self.cur = match self.kind {
            DanceKind::Wobble => (18.0 * u * (TAU * t / 1.4).sin() * env, 10.0 * u * (TAU * t / 0.9).sin() * env),
            DanceKind::EdgeSlide => {
                let room = if self.dir > 0.0 { (self.area.right() - self.home.right()) as f64 } else { (self.home.x - self.area.x) as f64 };
                let reach = room.clamp(0.0, MAX_WINDOW_TRAVEL * u);
                // 3.4 s out, a short breather at the edge, 3.4 s back.
                let p = if t < 3.4 {
                    smooth(t / 3.4)
                } else if t < 4.2 {
                    1.0
                } else {
                    1.0 - smooth((t - 4.2) / 3.4)
                };
                (self.dir * reach * p, 0.0)
            }
            DanceKind::Quake => {
                let decay = 1.0 - 0.6 * (t / total);
                let a = QUAKE_AMP * u * decay;
                let w = TAU * QUAKE_HZ * t;
                (a * w.sin() * smooth(t / 0.15) * smooth((total - t) / 0.2), 0.5 * a * (w + 1.0).sin() * smooth(t / 0.15) * smooth((total - t) / 0.2))
            }
            DanceKind::RunAway => run_away_step(self.cur, self.home, cursor, self.area, u, dt_ms),
        };
        // A dance never leaves the work area and never goes further than the travel limit.
        let (dx, dy) = limit_offset(self.cur.0, self.cur.1, MAX_WINDOW_TRAVEL * u);
        let f = self.home;
        let nx = (f.x as f64 + dx).clamp(self.area.x as f64, ((self.area.right() - f.w).max(self.area.x)) as f64);
        let ny = (f.y as f64 + dy).clamp(self.area.y as f64, ((self.area.bottom() - f.h).max(self.area.y)) as f64);
        self.cur = (nx - f.x as f64, ny - f.y as f64);
        self.cur
    }
}

/// One step of "running away": the window slides away from a cursor that comes
/// near, and drifts back home when it is left alone.
pub fn run_away_step(cur: (f64, f64), home: ScreenRect, cursor: (i32, i32), area: ScreenRect, scale: f64, dt_ms: u32) -> (f64, f64) {
    let dt = dt_ms as f64 / 1000.0;
    let frame = ScreenRect { x: home.x + cur.0.round() as i32, y: home.y + cur.1.round() as i32, ..home };
    // Distance from the cursor to the frame (0 inside it).
    let dx = (frame.x - cursor.0).max(0).max(cursor.0 - frame.right()) as f64;
    let dy = (frame.y - cursor.1).max(0).max(cursor.1 - frame.bottom()) as f64;
    let dist = (dx * dx + dy * dy).sqrt();
    let near = 170.0 * scale;
    let centre = (frame.x as f64 + frame.w as f64 / 2.0, frame.y as f64 + frame.h as f64 / 2.0);
    let (ax, ay) = unit(centre.0 - cursor.0 as f64, centre.1 - cursor.1 as f64);
    let (mut x, mut y) = cur;
    if dist < near {
        let speed = (200.0 + 420.0 * (1.0 - dist / near)) * scale;
        x += ax * speed * dt;
        y += ay * speed * dt * 0.5;
        // Cornered at a screen edge: slip sideways instead of sticking.
        let at_l = frame.x <= area.x + 2 && ax < 0.0;
        let at_r = frame.right() >= area.right() - 2 && ax > 0.0;
        if at_l || at_r {
            y += if cursor.1 as f64 > centre.1 { -1.0 } else { 1.0 } * speed * dt * 0.8;
        }
    } else {
        let back = 160.0 * scale * dt;
        let (bx, by) = unit(-x, -y);
        let len = (x * x + y * y).sqrt();
        if len <= back {
            x = 0.0;
            y = 0.0;
        } else {
            x += bx * back;
            y += by * back;
        }
    }
    (x, y)
}

/// What to do with the window when a dance ends early.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AfterAbort {
    /// Carry it back home (quickly).
    GlideHome,
    /// Don't touch it: the user may be dragging it right now.
    Leave,
}

pub fn after_abort(reason: AbortReason) -> AfterAbort {
    match reason {
        AbortReason::Button | AbortReason::UserMoved | AbortReason::UserInput | AbortReason::Lost => AfterAbort::Leave,
        AbortReason::Esc | AbortReason::Stopped => AfterAbort::GlideHome,
    }
}

/// During a dance the user may move the mouse (that is what RunAway is about);
/// keyboard input or a click is what ends it. The OS side only knows "some
/// input happened": it is the mouse if the cursor moved too.
pub fn dance_input_is_user(input_since_start: bool, cursor_moved: bool, kind: DanceKind) -> bool {
    if !input_since_start {
        return false;
    }
    match kind {
        // Mouse movement is part of the game for RunAway only.
        DanceKind::RunAway => !cursor_moved,
        _ => true,
    }
}

// -------------------------------------------------------------- minimise

pub const YOINK_MIN: Duration = Duration::from_secs(8);
pub const YOINK_MAX: Duration = Duration::from_secs(15);
/// A window the user had in front within this long is left alone.
pub const RECENT_USE_MS: u64 = 30_000;
/// The foreground sampler must have watched this long before anything is minimised.
pub const SAMPLER_WARMUP_MS: u64 = 30_000;

/// Programs (executable names without `.exe`, lower case) that are never minimised.
const BLOCKED_PROCESSES: &[&str] = &[
    // terminals and consoles
    "windowsterminal", "wt", "cmd", "powershell", "powershell_ise", "pwsh", "conhost", "openconsole", "bash", "wsl", "wslhost", "mintty",
    "alacritty", "wezterm", "wezterm-gui", "kitty", "hyper", "tabby", "putty", "kitty64",
    // password managers and authenticators
    "1password", "bitwarden", "keepass", "keepassxc", "lastpass", "dashlane", "enpass", "nordpass", "roboform", "protonpass", "authy", "keeper",
    "winauth", "yubioauthenticator",
    // system and admin tools
    "taskmgr", "explorer", "mmc", "regedit", "services", "procexp", "procexp64", "procmon", "perfmon", "eventvwr", "msconfig", "taskhostw",
    "lockapp", "logonui", "consent", "credentialuibroker", "securityhealthsystray", "msmpeng", "mpcmdrun", "systemsettings", "control",
    "applicationframehost", "searchhost", "startmenuexperiencehost", "shellexperiencehost", "textinputhost", "sihost", "dwm", "winlogon",
    "wlrmdr", "msiexec", "setup", "installer", "wusa",
    // remote control and screen sharing / recording
    "mstsc", "teamviewer", "anydesk", "rustdesk", "obs64", "obs32", "obs", "streamlabs", "xsplit", "snippingtool", "screenclippinghost",
    // virtual machines and security tools
    "vmware", "virtualbox", "vboxsvc", "wireshark",
];

/// Title words that mean "banking, passwords, sign-in, private browsing": hands off.
const BLOCKED_TITLE_WORDS: &[&str] = &[
    "bank", "banking", "paypal", "wallet", "crypto", "bitcoin", "iban", "password", "passwort", "passwords", "sign in", "log in", "login",
    "sign-in", "log-in", "inprivate", "incognito", "private browsing", "private window", "1password", "bitwarden", "keepass", "credit card",
    "checkout", "payment", "tax return", "steuer", "vpn", "two-factor", "2fa", "verification code", "recovery key", "seed phrase",
    "uac", "user account control", "windows security", "administrator", "task manager",
];

/// Window classes that are system UI.
const BLOCKED_CLASSES: &[&str] =
    &["Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Progman", "WorkerW", "TaskManagerWindow", "#32770", "ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS", "Credential Dialog Xaml Host"];

/// Is this a program (or page) Glitch must never minimise?
pub fn blocked_app(process: &str, title: &str, class: &str) -> bool {
    let p = process.trim().to_lowercase();
    let p = p.strip_suffix(".exe").unwrap_or(&p);
    if p.is_empty() || BLOCKED_PROCESSES.contains(&p) {
        return true;
    }
    if BLOCKED_CLASSES.contains(&class) {
        return true;
    }
    let t = title.to_lowercase();
    BLOCKED_TITLE_WORDS.iter().any(|w| t.contains(w))
}

/// Do these window titles say a screen share / recording is going on?
pub fn screen_share_hint<'a>(titles: impl IntoIterator<Item = &'a str>) -> bool {
    titles.into_iter().any(|t| {
        let t = t.to_lowercase();
        ["is sharing your screen", "you are sharing", "you're sharing", "you are screen sharing", "screen sharing", "stop sharing", "recording...", "now recording", "obs studio"]
            .iter()
            .any(|w| t.contains(w))
    })
}

/// A window Glitch might minimise, as the OS side describes it.
#[derive(Debug, Clone)]
pub struct YoinkWin {
    pub cand: Candidate,
    /// Lower-case executable name (may be empty if unknown, which blocks).
    pub process: String,
    pub title: String,
    pub class: String,
    /// How long ago it was last in front (None: not seen in front while we watched).
    pub last_front_ms_ago: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum YoinkRefusal {
    Level,
    Busy,
    CoolingDown,
    UserActive,
    NotWatchedLongEnough,
    Foreground,
    RecentlyUsed,
    Unsaved,
    Blocked,
    Fullscreen,
    TooSmall,
    System,
    Elevated,
}

/// May Glitch minimise this window right now?
pub fn yoink_eligible(w: &YoinkWin, area: ScreenRect, idle_ms: u32, sampler_uptime_ms: u64, level: ChaosLevel) -> Result<(), YoinkRefusal> {
    // Unsaved work comes first, always.
    if w.cand.unsaved.is_some() {
        return Err(YoinkRefusal::Unsaved);
    }
    if !level.allows(Fx::Yoink) {
        return Err(YoinkRefusal::Level);
    }
    if idle_ms < MIN_IDLE_MS {
        return Err(YoinkRefusal::UserActive);
    }
    if sampler_uptime_ms < SAMPLER_WARMUP_MS {
        return Err(YoinkRefusal::NotWatchedLongEnough);
    }
    if w.cand.fullscreen {
        return Err(YoinkRefusal::Fullscreen);
    }
    if w.cand.system {
        return Err(YoinkRefusal::System);
    }
    if w.cand.elevated {
        return Err(YoinkRefusal::Elevated);
    }
    if blocked_app(&w.process, &w.title, &w.class) {
        return Err(YoinkRefusal::Blocked);
    }
    if w.cand.foreground {
        return Err(YoinkRefusal::Foreground);
    }
    if w.last_front_ms_ago.is_some_and(|ago| ago < RECENT_USE_MS) {
        return Err(YoinkRefusal::RecentlyUsed);
    }
    let f = w.cand.frame;
    if f.w < MIN_W || f.h < MIN_H {
        return Err(YoinkRefusal::TooSmall);
    }
    // On this work area at all.
    let (cx, cy) = (f.x + f.w / 2, f.y + f.h / 2);
    if cx < area.x || cx >= area.right() || cy < area.y || cy >= area.bottom() {
        return Err(YoinkRefusal::System);
    }
    Ok(())
}

/// Pick the window to minimise: the one that was in front longest ago (or never).
pub fn pick_yoink(wins: &[YoinkWin], area: ScreenRect, idle_ms: u32, uptime_ms: u64, level: ChaosLevel, pick: f64) -> Option<usize> {
    let ok: Vec<usize> = (0..wins.len()).filter(|i| yoink_eligible(&wins[*i], area, idle_ms, uptime_ms, level).is_ok()).collect();
    if ok.is_empty() {
        return None;
    }
    Some(ok[((pick.clamp(0.0, 0.999_999)) * ok.len() as f64) as usize])
}

/// A window Glitch minimised: remembered until it is back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Yoinked {
    pub id: u64,
    pub pid: u32,
    pub class: String,
    pub title: String,
    pub process: String,
    pub at: Duration,
    /// Restore at the latest then.
    pub deadline: Duration,
}

/// Everything Glitch has minimised right now. Only windows in here are ever
/// restored by him, and every entry carries a deadline at most
/// [`YOINK_MAX`] after it was minimised.
#[derive(Debug, Default, Clone)]
pub struct MinimizeBook {
    items: Vec<Yoinked>,
}

impl MinimizeBook {
    pub fn len(&self) -> usize {
        self.items.len()
    }
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
    pub fn items(&self) -> &[Yoinked] {
        &self.items
    }
    pub fn contains(&self, id: u64) -> bool {
        self.items.iter().any(|y| y.id == id)
    }
    pub fn get(&self, id: u64) -> Option<&Yoinked> {
        self.items.iter().find(|y| y.id == id)
    }

    pub fn has_room(&self, level: ChaosLevel) -> bool {
        self.items.len() < level.max_yoinked()
    }

    /// Record a minimised window; `pick` in [0, 1) chooses the delay in [YOINK_MIN, YOINK_MAX].
    pub fn add(&mut self, mut y: Yoinked, now: Duration, pick: f64) -> &Yoinked {
        let span = YOINK_MAX - YOINK_MIN;
        y.at = now;
        y.deadline = now + YOINK_MIN + span.mul_f64(pick.clamp(0.0, 1.0));
        self.items.retain(|o| o.id != y.id);
        self.items.push(y);
        self.items.last().unwrap()
    }

    /// Ids whose time is up.
    pub fn due(&self, now: Duration) -> Vec<u64> {
        self.items.iter().filter(|y| now >= y.deadline).map(|y| y.id).collect()
    }

    pub fn remove(&mut self, id: u64) -> Option<Yoinked> {
        let i = self.items.iter().position(|y| y.id == id)?;
        Some(self.items.remove(i))
    }

    /// Everything must come back now (Esc, panic, stop, exit): hands them all over.
    pub fn drain(&mut self) -> Vec<Yoinked> {
        std::mem::take(&mut self.items)
    }

    /// The invariant: nothing waits longer than [`YOINK_MAX`] from when it was minimised.
    pub fn invariant_holds(&self) -> bool {
        self.items.iter().all(|y| y.deadline >= y.at + YOINK_MIN && y.deadline <= y.at + YOINK_MAX)
    }
}

/// What Glitch does about a minimised window when he looks at it again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestoreCheck {
    /// Still ours and still minimised: restore when due.
    Wait,
    /// Time is up (or a stop): restore it.
    Restore,
    /// The user restored it, closed it, or it isn't the same window any more: do nothing.
    Forget,
}

/// `still_same`: the handle is a window of the same process and class;
/// `minimized`: it is still minimised; `due`: deadline reached or a stop was asked.
pub fn restore_check(still_same: bool, minimized: bool, due: bool) -> RestoreCheck {
    if !still_same || !minimized {
        RestoreCheck::Forget
    } else if due {
        RestoreCheck::Restore
    } else {
        RestoreCheck::Wait
    }
}

/// Which window was in front when: tells "used in the last 30 s".
#[derive(Debug, Default, Clone)]
pub struct FrontHistory {
    last: Vec<(u64, u64)>,
    first_seen_ms: Option<u64>,
}

impl FrontHistory {
    pub fn record(&mut self, id: u64, now_ms: u64) {
        self.first_seen_ms.get_or_insert(now_ms);
        match self.last.iter_mut().find(|(i, _)| *i == id) {
            Some(e) => e.1 = now_ms,
            None => self.last.push((id, now_ms)),
        }
        // Forget windows not in front for a long time.
        self.last.retain(|(_, t)| now_ms.saturating_sub(*t) < 10 * 60_000);
    }

    pub fn ago(&self, id: u64, now_ms: u64) -> Option<u64> {
        self.last.iter().find(|(i, _)| *i == id).map(|(_, t)| now_ms.saturating_sub(*t))
    }

    pub fn uptime(&self, now_ms: u64) -> u64 {
        self.first_seen_ms.map_or(0, |f| now_ms.saturating_sub(f))
    }
}

// ----------------------------------------------------------- other guards

/// May new effects start right now? One place for the checks that don't
/// depend on the act: it never runs while any of these hold.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Gate {
    pub paused: bool,
    pub chat_open: bool,
    pub voice_listening: bool,
    pub hands_active: bool,
    pub quiet_or_fullscreen: bool,
    pub focus_mode: bool,
    pub stream_overlay_running: bool,
    pub stream_opt_in: bool,
    pub screen_sharing: bool,
    pub user_busy: bool,
    pub idle_ms: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Blocked {
    Level,
    Paused,
    Chat,
    Voice,
    Hands,
    Quiet,
    Focus,
    Stream,
    ScreenShare,
    UserBusy,
    UserActive,
    ReduceEffects,
    RateLimit,
    CoolingDown,
    Unsafe,
}

/// Can `fx` start now at all? (Per-act checks come on top.)
pub fn may_start(level: ChaosLevel, fx: Fx, gate: &Gate, reduce_effects: bool) -> Result<(), Blocked> {
    if !level.allows(fx) {
        return Err(Blocked::Level);
    }
    if gate.paused {
        return Err(Blocked::Paused);
    }
    if gate.chat_open {
        return Err(Blocked::Chat);
    }
    if gate.voice_listening {
        return Err(Blocked::Voice);
    }
    if gate.hands_active {
        return Err(Blocked::Hands);
    }
    if gate.quiet_or_fullscreen {
        return Err(Blocked::Quiet);
    }
    if gate.focus_mode {
        return Err(Blocked::Focus);
    }
    if gate.stream_overlay_running && !gate.stream_opt_in {
        return Err(Blocked::Stream);
    }
    if gate.screen_sharing {
        return Err(Blocked::ScreenShare);
    }
    if gate.user_busy {
        return Err(Blocked::UserBusy);
    }
    if gate.idle_ms < MIN_IDLE_MS {
        return Err(Blocked::UserActive);
    }
    if reduce_effects && fx.overlay_only() {
        return Err(Blocked::ReduceEffects);
    }
    Ok(())
}

/// Maps the old per-window refusal to the new one (for logging).
pub fn blocked_from(r: Refusal) -> Blocked {
    match r {
        Refusal::Disabled => Blocked::Level,
        Refusal::UserActive => Blocked::UserActive,
        Refusal::Fullscreen => Blocked::Quiet,
        Refusal::CoolingDown => Blocked::CoolingDown,
        Refusal::Busy => Blocked::Chat,
        _ => Blocked::Unsafe,
    }
}

/// Screen melt: how many columns slide down and when (pure so it is testable).
/// Returns, per column, the delay and the distance (fraction of the screen height).
pub fn melt_columns(n: usize, seed: u64) -> Vec<(u32, f64)> {
    (0..n).map(|i| ((hash01(seed, i as u64) * 900.0) as u32, 0.12 + hash01(seed ^ 0xAB, i as u64) * 0.5)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: ScreenRect = ScreenRect { x: 0, y: 0, w: 1920, h: 1040 };

    fn script(act: CursorAct, level: ChaosLevel) -> CursorScript {
        CursorScript::new(act, level, (900, 500), (500, 300), AREA, 1.0, 42)
    }

    fn quiet(t_ms: u32, cursor: (i32, i32)) -> Sample {
        Sample { t_ms, cursor, input_since_start: false, button: false, esc: false, stop: false }
    }

    /// Run a script to its end with a perfectly obedient cursor.
    fn run(mut s: CursorScript) -> Vec<(u32, (i32, i32))> {
        let mut at = s.start;
        let mut out = vec![(0, at)];
        let mut t = 0;
        loop {
            match s.tick(&quiet(t, at)) {
                Tick::Move(x, y) => {
                    at = (x, y);
                    out.push((t, at));
                }
                Tick::Done => return out,
                Tick::Abort(r) => panic!("aborted by itself at {t} ms: {r:?}"),
            }
            t += TICK_MS;
            assert!(t < 30_000, "never ends");
        }
    }

    // ------------------------------------------------------------- levels

    #[test]
    fn each_level_enables_more_acts_and_shorter_gaps() {
        let n = |l: ChaosLevel| Fx::ALL.iter().filter(|f| l.allows(**f)).count();
        assert_eq!(n(ChaosLevel::Off), 0);
        assert_eq!(n(ChaosLevel::Gentle), 0, "Gentle is today's behaviour: none of the new acts");
        assert!(n(ChaosLevel::Mischief) > 0 && n(ChaosLevel::FullVirus) > n(ChaosLevel::Mischief));
        assert_eq!(n(ChaosLevel::FullVirus), Fx::ALL.len());
        let (gl, gh) = ChaosLevel::Gentle.gap().unwrap();
        let (ml, mh) = ChaosLevel::Mischief.gap().unwrap();
        let (fl, fh) = ChaosLevel::FullVirus.gap().unwrap();
        assert_eq!((ml.as_secs(), mh.as_secs()), (90, 180));
        assert_eq!((fl.as_secs(), fh.as_secs()), (30, 60));
        assert!(fh <= ml && mh >= gl && fl < ml && gh < mh + gh);
        assert!(ChaosLevel::Off.gap().is_none());
        // The star and the minimise prank are in Mischief too.
        assert!(ChaosLevel::Mischief.allows(Fx::Hook) && ChaosLevel::Mischief.allows(Fx::Yoink));
        assert!(!ChaosLevel::Mischief.allows(Fx::Melt) && ChaosLevel::FullVirus.allows(Fx::Melt));
    }

    #[test]
    fn full_virus_needs_its_confirmation() {
        assert_eq!(ChaosLevel::FullVirus.confirmed(false), ChaosLevel::Mischief);
        assert_eq!(ChaosLevel::FullVirus.confirmed(true), ChaosLevel::FullVirus);
        assert_eq!(ChaosLevel::Gentle.confirmed(false), ChaosLevel::Gentle);
    }

    #[test]
    fn level_round_trips_through_settings_json() {
        for l in [ChaosLevel::Off, ChaosLevel::Gentle, ChaosLevel::Mischief, ChaosLevel::FullVirus] {
            let j = serde_json::to_string(&l).unwrap();
            assert_eq!(serde_json::from_str::<ChaosLevel>(&j).unwrap(), l);
        }
        assert_eq!(serde_json::to_string(&ChaosLevel::FullVirus).unwrap(), "\"full_virus\"");
        assert_eq!(ChaosLevel::default(), ChaosLevel::Gentle);
    }

    #[test]
    fn no_act_runs_longer_than_twenty_seconds_and_cooldowns_exist() {
        for fx in Fx::ALL {
            assert!(fx.max_duration() <= MAX_ACT, "{fx:?}");
            for l in [ChaosLevel::Mischief, ChaosLevel::FullVirus] {
                assert!(fx.cooldown(l) >= Duration::from_secs(45), "{fx:?} {l:?}");
            }
            assert!(fx.cooldown(ChaosLevel::FullVirus) <= fx.cooldown(ChaosLevel::Mischief));
        }
        let yoink = Fx::Yoink.cooldown(ChaosLevel::Mischief).as_secs();
        assert!((120..=180).contains(&yoink) && Fx::Yoink.cooldown(ChaosLevel::FullVirus).as_secs() >= 120, "minimise: 2-3 min");
        // Cursor scripts and dances respect the cap too.
        for act in [CursorAct::Hook(HookStyle::Pull), CursorAct::Orbit, CursorAct::Jitter, CursorAct::Hops] {
            for l in [ChaosLevel::Mischief, ChaosLevel::FullVirus] {
                let s = script(act, l);
                assert!(Duration::from_millis(s.duration_ms() as u64) <= act.fx().max_duration(), "{act:?}");
            }
        }
        for k in DANCE_KINDS {
            assert!(Duration::from_millis(k.total_ms() as u64) <= Fx::Dance.max_duration(), "{k:?}");
        }
    }

    #[test]
    fn global_rate_limit_spaces_and_counts_acts() {
        let mut g = GlobalLimit::default();
        let lvl = ChaosLevel::FullVirus;
        let mut now = Duration::ZERO;
        let mut started = 0;
        // Try every 5 s for an hour: never more than the budget per 10 minutes, never closer than the spacing.
        let mut starts: Vec<Duration> = vec![];
        for _ in 0..720 {
            if g.allows(now, lvl) {
                g.record(now);
                started += 1;
                starts.push(now);
            }
            now += Duration::from_secs(5);
        }
        assert!(started > 20, "it does let acts through ({started})");
        for w in starts.windows(2) {
            assert!(w[1] - w[0] >= lvl.min_spacing());
        }
        for (i, s) in starts.iter().enumerate() {
            let in_window = starts[i..].iter().take_while(|t| **t - *s < GlobalLimit::WINDOW).count();
            assert!(in_window <= lvl.max_acts_per_window(), "{in_window} acts within 10 minutes");
        }
        assert!(!GlobalLimit::default().allows(Duration::ZERO, ChaosLevel::Off));
    }

    // ------------------------------------------------------------ flashes

    #[test]
    fn flash_rate_limit() {
        assert!(flash_rate_ok(&[0, 333, 666]));
        assert!(!flash_rate_ok(&[0, 200, 400, 600]), "4 in a second");
        assert!(flash_rate_ok(&[0, 300, 600, 1000, 1300]));
        assert!(flash_rate_ok(&[]));
        let mut b = FlashBudget::default();
        let mut passed = vec![];
        for t in (0..5000).step_by(50) {
            if b.try_flash(t) {
                passed.push(t);
            }
        }
        assert!(flash_rate_ok(&passed), "{passed:?}");
        assert!(passed.len() >= 12, "it still lets 3 per second through");
    }

    #[test]
    fn hop_sparks_stay_under_three_per_second() {
        assert!(flash_rate_ok(&HOP_TIMES.map(u64::from)));
    }

    // ----------------------------------------------------- cursor scripts

    #[test]
    fn every_cursor_act_starts_at_the_cursor_and_never_leaves_its_limits() {
        for act in [
            CursorAct::Hook(HookStyle::Pull),
            CursorAct::Hook(HookStyle::Circle),
            CursorAct::Hook(HookStyle::Figure8),
            CursorAct::Hook(HookStyle::Bounce),
            CursorAct::Orbit,
            CursorAct::Jitter,
            CursorAct::Hops,
        ] {
            for level in [ChaosLevel::Mischief, ChaosLevel::FullVirus] {
                for scale in [1.0, 1.5, 2.0] {
                    let s = CursorScript::new(act, level, (900, 500), (500, 300), AREA, scale, 7);
                    assert_eq!(s.target(0), (900, 500), "{act:?}: begins where the cursor is");
                    let path = run(s.clone());
                    let max = s.max_travel_px();
                    for (t, p) in &path {
                        let d = (((p.0 - 900) as f64).powi(2) + ((p.1 - 500) as f64).powi(2)).sqrt();
                        assert!(d <= max + 1.5, "{act:?} {level:?}: {d} px from the start at {t} ms (limit {max})");
                        assert!(p.0 >= AREA.x && p.0 < AREA.right() && p.1 >= AREA.y && p.1 < AREA.bottom());
                    }
                    if !matches!(act, CursorAct::Hops) {
                        for w in path.windows(2) {
                            let d = (((w[1].1 .0 - w[0].1 .0) as f64).powi(2) + ((w[1].1 .1 - w[0].1 .1) as f64).powi(2)).sqrt();
                            assert!(d <= MAX_STEP * scale + 1.5, "{act:?}: leaps {d} px in one tick");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn the_hook_reaches_at_most_400px_in_full_virus_and_250_in_mischief() {
        let far = |lvl| {
            let s = CursorScript::new(CursorAct::Hook(HookStyle::Pull), lvl, (1500, 900), (100, 100), AREA, 1.0, 1);
            run(s).iter().map(|(_, p)| (((p.0 - 1500) as f64).powi(2) + ((p.1 - 900) as f64).powi(2)).sqrt()).fold(0.0, f64::max)
        };
        assert!(far(ChaosLevel::FullVirus) <= 401.0 && far(ChaosLevel::FullVirus) > 300.0, "{}", far(ChaosLevel::FullVirus));
        assert!(far(ChaosLevel::Mischief) <= 251.0 && far(ChaosLevel::Mischief) > 180.0);
        let s = script(CursorAct::Hook(HookStyle::Pull), ChaosLevel::FullVirus);
        assert!(s.duration_ms() <= 8_000);
    }

    #[test]
    fn hook_pull_moves_towards_the_rod() {
        let s = CursorScript::new(CursorAct::Hook(HookStyle::Pull), ChaosLevel::FullVirus, (900, 700), (500, 300), AREA, 1.0, 1);
        let end = s.target(7_000);
        let d0 = (((900 - 500) as f64).powi(2) + ((700 - 300) as f64).powi(2)).sqrt();
        let d1 = (((end.0 - 500) as f64).powi(2) + ((end.1 - 300) as f64).powi(2)).sqrt();
        assert!(d1 < d0 - 150.0, "{d1} vs {d0}");
    }

    #[test]
    fn jitter_is_tiny_and_hops_are_10_to_40px() {
        let s = script(CursorAct::Jitter, ChaosLevel::Mischief);
        for (_, p) in run(s) {
            assert!((p.0 - 900).abs() <= 3 && (p.1 - 500).abs() <= 3, "{p:?}");
        }
        let s = script(CursorAct::Hops, ChaosLevel::FullVirus);
        let mut prev = (900, 500);
        let mut hops = 0;
        for (_, p) in run(s) {
            if p != prev {
                let d = (((p.0 - prev.0) as f64).powi(2) + ((p.1 - prev.1) as f64).powi(2)).sqrt();
                assert!((9.0..=41.0).contains(&d), "hop of {d}");
                hops += 1;
                prev = p;
            }
        }
        assert_eq!(hops, HOP_TIMES.len());
    }

    #[test]
    fn user_input_aborts_on_the_very_next_tick_for_every_reason() {
        // Eight ms per tick: the abort is felt long inside the 100 ms budget.
        assert!(TICK_MS * 2 <= ABORT_BUDGET_MS / 5);
        let base = || script(CursorAct::Hook(HookStyle::Circle), ChaosLevel::FullVirus);
        let cases: [(Sample, AbortReason); 6] = [
            (Sample { stop: true, ..quiet(1000, (900, 500)) }, AbortReason::Stopped),
            (Sample { esc: true, ..quiet(1000, (900, 500)) }, AbortReason::Esc),
            (Sample { button: true, ..quiet(1000, (900, 500)) }, AbortReason::Button),
            (Sample { input_since_start: true, ..quiet(1000, (900, 500)) }, AbortReason::UserInput),
            (quiet(1000, (900 + FIGHT_PX + 1, 500)), AbortReason::UserMoved),
            (quiet(1000, (900, 500 - FIGHT_PX - 1)), AbortReason::UserMoved),
        ];
        for (sample, why) in cases {
            let mut s = base();
            assert_eq!(s.tick(&sample), Tick::Abort(why));
        }
        // A bit of drift under the threshold is fine.
        let mut s = base();
        assert!(matches!(s.tick(&quiet(0, (900 + FIGHT_PX, 500))), Tick::Move(..)));
        // Stop beats everything else.
        let mut s = base();
        let all = Sample { stop: true, esc: true, button: true, input_since_start: true, ..quiet(0, (0, 0)) };
        assert_eq!(s.tick(&all), Tick::Abort(AbortReason::Stopped));
    }

    #[test]
    fn user_pulling_against_the_script_is_noticed_mid_act() {
        let mut s = script(CursorAct::Hook(HookStyle::Pull), ChaosLevel::FullVirus);
        let mut at = s.start;
        let mut t = 0;
        let mut aborted_at = None;
        while t < 8_000 {
            // From 2 s on, the "user" drags the mouse 15 px against the pull.
            let seen = if t >= 2000 { (at.0 + 15, at.1) } else { at };
            match s.tick(&quiet(t, seen)) {
                Tick::Move(x, y) => at = (x, y),
                Tick::Abort(r) => {
                    aborted_at = Some((t, r));
                    break;
                }
                Tick::Done => break,
            }
            t += TICK_MS;
        }
        let (t, r) = aborted_at.expect("aborted");
        assert_eq!(r, AbortReason::UserMoved);
        assert!(t - 2000 <= TICK_MS, "noticed within one tick ({t})");
    }

    #[test]
    fn a_script_ends_by_itself_after_its_duration() {
        let mut s = script(CursorAct::Orbit, ChaosLevel::Mischief);
        let end = s.duration_ms();
        assert_eq!(s.tick(&quiet(end, s.start)), Tick::Done);
    }

    // ------------------------------------------------------------ dances

    fn home() -> ScreenRect {
        ScreenRect { x: 600, y: 300, w: 600, h: 400 }
    }

    fn dance(kind: DanceKind, scale: f64, cursor: impl Fn(u32) -> (i32, i32)) -> Vec<(u32, (f64, f64))> {
        let mut d = DanceScript::new(kind, home(), AREA, scale);
        let mut out = vec![];
        let mut t = 0;
        let dt = 16;
        while t <= d.total_ms() {
            out.push((t, d.offset(t, dt, cursor(t))));
            t += dt;
        }
        out
    }

    #[test]
    fn dances_stay_on_screen_within_the_travel_limit_and_end_back_home() {
        for kind in DANCE_KINDS {
            for scale in [1.0, 1.5] {
                // The cursor sweeps across the window (for RunAway).
                let path = dance(kind, scale, |t| (700 + (t as i32 % 1500) / 3, 450));
                for (t, (dx, dy)) in &path {
                    let f = ScreenRect { x: home().x + dx.round() as i32, y: home().y + dy.round() as i32, ..home() };
                    assert!(f.x >= AREA.x && f.y >= AREA.y && f.right() <= AREA.right() && f.bottom() <= AREA.bottom(), "{kind:?} {t}: {f:?}");
                    assert!((dx * dx + dy * dy).sqrt() <= MAX_WINDOW_TRAVEL * scale + 1.0, "{kind:?} {t}: too far ({dx},{dy})");
                }
                let (_, (ex, ey)) = path.last().unwrap();
                assert!(ex.abs() < 1.0 && ey.abs() < 1.0, "{kind:?}: carried back home, ends at ({ex},{ey})");
            }
        }
    }

    #[test]
    fn the_earthquake_is_six_px_for_two_seconds_and_under_three_hertz() {
        let path = dance(DanceKind::Quake, 1.0, |_| (0, 0));
        let main: Vec<_> = path.iter().filter(|(t, _)| *t < QUAKE_MS).collect();
        let peak = main.iter().map(|(_, (x, y))| x.abs().max(y.abs())).fold(0.0, f64::max);
        assert!(peak <= QUAKE_AMP + 0.01, "{peak}");
        assert!(peak > 3.0, "it does shake ({peak})");
        // Direction reversals per second (each full cycle has two).
        let xs: Vec<f64> = main.iter().map(|(_, (x, _))| *x).collect();
        let mut turns = vec![];
        for i in 1..xs.len() - 1 {
            if (xs[i] - xs[i - 1]) * (xs[i + 1] - xs[i]) < 0.0 {
                turns.push(main[i].0 as u64);
            }
        }
        assert!(flash_rate_ok(&turns.iter().step_by(2).copied().collect::<Vec<_>>()), "no more than 3 cycles per second: {turns:?}");
        assert_eq!(DanceKind::Quake.main_ms(), 2000);
    }

    #[test]
    fn edge_slide_goes_to_the_nearer_roomier_edge_and_back() {
        let path = dance(DanceKind::EdgeSlide, 1.0, |_| (0, 0));
        let max = path.iter().map(|(_, (x, _))| x.abs()).fold(0.0, f64::max);
        // Room to the right: 1920 - 1200 = 720, capped by the travel limit.
        assert!((max - MAX_WINDOW_TRAVEL).abs() < 2.0, "{max}");
        assert!(path.iter().all(|(_, (x, _))| *x >= -0.01), "slides right (more room there)");
    }

    #[test]
    fn running_away_moves_away_from_the_cursor_and_comes_back() {
        // Cursor parked just left of the window: it slides right.
        let mut cur = (0.0, 0.0);
        for _ in 0..40 {
            cur = run_away_step(cur, home(), (560, 500), AREA, 1.0, 16);
        }
        assert!(cur.0 > 60.0, "{cur:?}");
        // Cursor gone far away: it drifts home.
        for _ in 0..200 {
            cur = run_away_step(cur, home(), (50, 1000), AREA, 1.0, 16);
        }
        assert!(cur.0.abs() < 1.0 && cur.1.abs() < 1.0, "{cur:?}");
    }

    #[test]
    fn dance_abort_policy_never_moves_a_window_the_user_may_be_holding() {
        assert_eq!(after_abort(AbortReason::Button), AfterAbort::Leave);
        assert_eq!(after_abort(AbortReason::UserMoved), AfterAbort::Leave);
        assert_eq!(after_abort(AbortReason::Esc), AfterAbort::GlideHome);
        assert_eq!(after_abort(AbortReason::Stopped), AfterAbort::GlideHome);
        // RunAway lives off mouse movement; typing still ends it.
        assert!(!dance_input_is_user(true, true, DanceKind::RunAway));
        assert!(dance_input_is_user(true, false, DanceKind::RunAway));
        assert!(dance_input_is_user(true, true, DanceKind::Quake));
        assert!(!dance_input_is_user(false, false, DanceKind::Quake));
    }

    // ----------------------------------------------------------- minimise

    fn win(process: &str, title: &str) -> YoinkWin {
        YoinkWin {
            cand: Candidate {
                id: 1,
                frame: ScreenRect { x: 100, y: 100, w: 700, h: 500 },
                foreground: false,
                maximized: false,
                elevated: false,
                fullscreen: false,
                system: false,
                unsaved: None,
            },
            process: process.into(),
            title: title.into(),
            class: "Chrome_WidgetWin_1".into(),
            last_front_ms_ago: Some(5 * 60_000),
        }
    }

    const UPTIME: u64 = 10 * 60_000;

    #[test]
    fn a_calm_background_window_may_be_yoinked() {
        let w = win("notepad", "notes - Notepad");
        assert_eq!(yoink_eligible(&w, AREA, 9000, UPTIME, ChaosLevel::Mischief), Ok(()));
        assert_eq!(yoink_eligible(&w, AREA, 9000, UPTIME, ChaosLevel::FullVirus), Ok(()));
    }

    #[test]
    fn yoink_refusals_each_have_their_own_reason() {
        let ok = win("notepad", "notes - Notepad");
        let chk = |w: &YoinkWin, idle: u32, up: u64, l: ChaosLevel| yoink_eligible(w, AREA, idle, up, l);
        assert_eq!(chk(&ok, 9000, UPTIME, ChaosLevel::Gentle), Err(YoinkRefusal::Level));
        assert_eq!(chk(&ok, 9000, UPTIME, ChaosLevel::Off), Err(YoinkRefusal::Level));
        assert_eq!(chk(&ok, 1000, UPTIME, ChaosLevel::Mischief), Err(YoinkRefusal::UserActive), "typing / mousing: idle < 4 s");
        assert_eq!(chk(&ok, 9000, 5_000, ChaosLevel::Mischief), Err(YoinkRefusal::NotWatchedLongEnough));
        let mut w = ok.clone();
        w.cand.foreground = true;
        assert_eq!(chk(&w, 9000, UPTIME, ChaosLevel::Mischief), Err(YoinkRefusal::Foreground));
        let mut w = ok.clone();
        w.last_front_ms_ago = Some(29_000);
        assert_eq!(chk(&w, 9000, UPTIME, ChaosLevel::Mischief), Err(YoinkRefusal::RecentlyUsed));
        w.last_front_ms_ago = Some(31_000);
        assert_eq!(chk(&w, 9000, UPTIME, ChaosLevel::Mischief), Ok(()));
        let mut w = ok.clone();
        w.cand.unsaved = Some(crate::unsaved::Unsaved::Star);
        assert_eq!(chk(&w, 9000, UPTIME, ChaosLevel::Mischief), Err(YoinkRefusal::Unsaved));
        // Unsaved is reported even when everything else is wrong too.
        assert_eq!(chk(&w, 0, 0, ChaosLevel::Off), Err(YoinkRefusal::Unsaved));
        let mut w = ok.clone();
        w.cand.fullscreen = true;
        assert_eq!(chk(&w, 9000, UPTIME, ChaosLevel::Mischief), Err(YoinkRefusal::Fullscreen));
        let mut w = ok.clone();
        w.cand.elevated = true;
        assert_eq!(chk(&w, 9000, UPTIME, ChaosLevel::Mischief), Err(YoinkRefusal::Elevated));
        let mut w = ok.clone();
        w.cand.system = true;
        assert_eq!(chk(&w, 9000, UPTIME, ChaosLevel::Mischief), Err(YoinkRefusal::System));
        let mut w = ok.clone();
        w.cand.frame.w = 100;
        assert_eq!(chk(&w, 9000, UPTIME, ChaosLevel::Mischief), Err(YoinkRefusal::TooSmall));
        let mut w = ok.clone();
        w.last_front_ms_ago = None; // never seen in front while we watched: fine
        assert_eq!(chk(&w, 9000, UPTIME, ChaosLevel::Mischief), Ok(()));
    }

    #[test]
    fn terminals_password_managers_banks_and_admin_tools_are_blocked() {
        for p in ["WindowsTerminal.exe", "cmd", "powershell", "pwsh", "conhost", "1Password", "Bitwarden", "KeePassXC", "taskmgr", "explorer", "mmc", "regedit", "obs64", "mstsc", "TeamViewer", ""] {
            assert!(blocked_app(p, "Anything", "Chrome_WidgetWin_1"), "{p}");
        }
        for t in [
            "My Bank - Account overview - Google Chrome",
            "PayPal: Send money",
            "Sign in to your account - Edge",
            "Password reset",
            "New Incognito tab - Chrome",
            "InPrivate - Microsoft Edge",
            "Task Manager",
            "Checkout - Shop",
        ] {
            assert!(blocked_app("chrome", t, "Chrome_WidgetWin_1"), "{t}");
        }
        assert!(blocked_app("notepad", "x", "#32770"), "system dialog class");
        for (p, t) in [("notepad", "notes - Notepad"), ("chrome", "Cute cats - Google Chrome"), ("code", "main.rs - Visual Studio Code"), ("spotify", "Spotify")] {
            assert!(!blocked_app(p, t, "Chrome_WidgetWin_1"), "{p} {t}");
        }
    }

    #[test]
    fn screen_share_titles_are_recognised() {
        assert!(screen_share_hint(["Zoom", "Meeting is sharing your screen"]));
        assert!(screen_share_hint(["OBS Studio 30.0 - Profile: Untitled"]));
        assert!(!screen_share_hint(["Cute cats - Google Chrome", "notes - Notepad"]));
    }

    #[test]
    fn pick_yoink_chooses_only_among_eligible_windows() {
        let a = win("notepad", "a - Notepad");
        let mut b = win("notepad", "b - Notepad");
        b.cand.id = 2;
        b.cand.frame.x = 300;
        let mut bad = win("cmd", "cmd");
        bad.cand.id = 3;
        let wins = [bad, a, b];
        for pick in [0.0, 0.4, 0.99] {
            let i = pick_yoink(&wins, AREA, 9000, UPTIME, ChaosLevel::Mischief, pick).unwrap();
            assert_ne!(wins[i].cand.id, 3);
        }
        assert!(pick_yoink(&wins[..1], AREA, 9000, UPTIME, ChaosLevel::Mischief, 0.5).is_none());
    }

    fn yoinked(id: u64) -> Yoinked {
        Yoinked { id, pid: 100 + id as u32, class: "Notepad".into(), title: "t".into(), process: "notepad".into(), at: Duration::ZERO, deadline: Duration::ZERO }
    }

    #[test]
    fn every_minimise_has_a_deadline_between_8_and_15_seconds() {
        let mut b = MinimizeBook::default();
        for (i, pick) in [0.0, 0.5, 1.0, 0.123].into_iter().enumerate() {
            let now = Duration::from_secs(100 * i as u64);
            let y = b.add(yoinked(i as u64), now, pick).clone();
            assert!(y.deadline >= now + YOINK_MIN && y.deadline <= now + YOINK_MAX, "{y:?}");
        }
        assert!(b.invariant_holds());
        assert_eq!(b.add(yoinked(0), Duration::from_secs(900), 0.0).deadline, Duration::from_secs(908));
        assert_eq!(b.len(), 4, "re-adding the same window replaces its entry");
    }

    #[test]
    fn at_most_one_window_at_a_time_two_in_full_virus() {
        let mut b = MinimizeBook::default();
        assert!(b.has_room(ChaosLevel::Mischief) && b.has_room(ChaosLevel::FullVirus));
        b.add(yoinked(1), Duration::ZERO, 0.5);
        assert!(!b.has_room(ChaosLevel::Mischief));
        assert!(b.has_room(ChaosLevel::FullVirus));
        b.add(yoinked(2), Duration::ZERO, 0.5);
        assert!(!b.has_room(ChaosLevel::FullVirus));
        assert!(!MinimizeBook::default().has_room(ChaosLevel::Gentle) && !MinimizeBook::default().has_room(ChaosLevel::Off));
    }

    #[test]
    fn restore_check_only_restores_windows_that_are_still_ours_and_minimised() {
        assert_eq!(restore_check(true, true, false), RestoreCheck::Wait);
        assert_eq!(restore_check(true, true, true), RestoreCheck::Restore);
        assert_eq!(restore_check(true, false, true), RestoreCheck::Forget, "the user restored it: do nothing");
        assert_eq!(restore_check(false, true, true), RestoreCheck::Forget, "the handle belongs to another window now");
        assert_eq!(restore_check(false, false, false), RestoreCheck::Forget);
    }

    /// Property-style: a model of the desktop and random events. Whatever the user
    /// does and whenever Glitch is stopped, no window he minimised stays minimised
    /// longer than 15 s, and he never restores a window he did not minimise.
    #[test]
    fn restore_always_invariant() {
        #[derive(Clone, Copy, PartialEq, Debug)]
        enum Win {
            Open,
            MinByGlitch,
            MinByUser,
            Closed,
        }
        for seed in 0..300u64 {
            let mut rnd = |n: u64| -> u64 { (hash01(seed, n) * 1_000_000.0) as u64 };
            let mut book = MinimizeBook::default();
            let mut wins = [Win::Open; 5];
            // The user minimised window 4 himself before Glitch started: it stays that way.
            wins[4] = Win::MinByUser;
            let mut restored_by_glitch: Vec<u64> = vec![];
            let mut now = Duration::ZERO;
            let mut minimised_since = [None::<Duration>; 5];
            for step in 0..400u64 {
                let r = rnd(step * 3);
                now += Duration::from_millis(100 + (r % 900));
                match rnd(step * 3 + 1) % 9 {
                    0 | 1 => {
                        // Glitch minimises a random open window if there is room.
                        let id = rnd(step * 3 + 2) % 4;
                        if wins[id as usize] == Win::Open && book.has_room(ChaosLevel::FullVirus) {
                            wins[id as usize] = Win::MinByGlitch;
                            minimised_since[id as usize] = Some(now);
                            book.add(yoinked(id), now, (rnd(step) % 100) as f64 / 100.0);
                        }
                    }
                    2 => {
                        // The user restores one by clicking its taskbar button.
                        let id = (rnd(step + 7) % 5) as usize;
                        if wins[id] == Win::MinByGlitch {
                            wins[id] = Win::Open;
                            minimised_since[id] = None;
                        }
                    }
                    3 => {
                        // The user closes one.
                        let id = (rnd(step + 9) % 4) as usize;
                        if wins[id] != Win::Closed {
                            wins[id] = Win::Closed;
                            minimised_since[id] = None;
                        }
                    }
                    4 => {
                        // Esc / panic / tray Stop / exit: everything back now.
                        for y in book.drain() {
                            if restore_check(true, wins[y.id as usize] == Win::MinByGlitch, true) == RestoreCheck::Restore {
                                wins[y.id as usize] = Win::Open;
                                minimised_since[y.id as usize] = None;
                                restored_by_glitch.push(y.id);
                            }
                        }
                    }
                    _ => {}
                }
                // The watcher: restore what is due, forget what the user changed.
                for id in book.due(now) {
                    let y = book.remove(id).unwrap();
                    match restore_check(true, wins[y.id as usize] == Win::MinByGlitch, true) {
                        RestoreCheck::Restore => {
                            wins[y.id as usize] = Win::Open;
                            minimised_since[y.id as usize] = None;
                            restored_by_glitch.push(y.id);
                        }
                        _ => {}
                    }
                }
                for y in book.items().to_vec() {
                    if restore_check(true, wins[y.id as usize] == Win::MinByGlitch, false) == RestoreCheck::Forget {
                        book.remove(y.id);
                    }
                }
                assert!(book.invariant_holds(), "seed {seed} step {step}");
                // The invariant: nothing minimised by Glitch outlives 15 s (plus one watcher tick).
                for (id, since) in minimised_since.iter().enumerate() {
                    if let Some(s) = since {
                        assert!(now - *s <= YOINK_MAX + Duration::from_secs(1), "seed {seed}: window {id} still minimised after {:?}", now - *s);
                        assert!(book.contains(id as u64), "seed {seed}: window {id} minimised by Glitch but not tracked");
                    }
                }
                // He never touched the one the user minimised himself.
                assert_eq!(wins[4], Win::MinByUser);
                assert!(!restored_by_glitch.contains(&4));
            }
        }
    }

    // ------------------------------------------------------------- guards

    #[test]
    fn nothing_starts_while_anything_says_not_now() {
        let ok = Gate { idle_ms: 10_000, ..Default::default() };
        let lvl = ChaosLevel::FullVirus;
        assert_eq!(may_start(lvl, Fx::Hook, &ok, false), Ok(()));
        let bad: [(Gate, Blocked); 9] = [
            (Gate { paused: true, ..ok }, Blocked::Paused),
            (Gate { chat_open: true, ..ok }, Blocked::Chat),
            (Gate { voice_listening: true, ..ok }, Blocked::Voice),
            (Gate { hands_active: true, ..ok }, Blocked::Hands),
            (Gate { quiet_or_fullscreen: true, ..ok }, Blocked::Quiet),
            (Gate { focus_mode: true, ..ok }, Blocked::Focus),
            (Gate { stream_overlay_running: true, ..ok }, Blocked::Stream),
            (Gate { screen_sharing: true, ..ok }, Blocked::ScreenShare),
            (Gate { idle_ms: 3_999, ..ok }, Blocked::UserActive),
        ];
        for (g, why) in bad {
            for fx in Fx::ALL {
                assert_eq!(may_start(lvl, fx, &g, false), Err(why), "{fx:?}");
            }
        }
        // The stream overlay only blocks if the user didn't opt in.
        let streaming = Gate { stream_overlay_running: true, stream_opt_in: true, ..ok };
        assert_eq!(may_start(lvl, Fx::Hook, &streaming, false), Ok(()));
        assert_eq!(may_start(lvl, Fx::Hook, &Gate { user_busy: true, ..ok }, false), Err(Blocked::UserBusy));
        assert_eq!(may_start(ChaosLevel::Gentle, Fx::Hook, &ok, false), Err(Blocked::Level));
    }

    #[test]
    fn reduce_effects_switches_off_the_screen_effects_only() {
        let ok = Gate { idle_ms: 10_000, ..Default::default() };
        for fx in Fx::ALL {
            let r = may_start(ChaosLevel::FullVirus, fx, &ok, true);
            if fx.overlay_only() {
                assert_eq!(r, Err(Blocked::ReduceEffects), "{fx:?}");
            } else {
                assert_eq!(r, Ok(()), "{fx:?}");
            }
        }
        for fx in [Fx::Trail, Fx::Matrix, Fx::Scanlines, Fx::Melt, Fx::Bugs, Fx::Swarm] {
            assert!(fx.overlay_only());
        }
    }

    #[test]
    fn front_history_tells_recent_use() {
        let mut h = FrontHistory::default();
        assert_eq!(h.uptime(1000), 0);
        h.record(7, 1_000);
        h.record(8, 5_000);
        assert_eq!(h.ago(7, 31_000), Some(30_000));
        assert_eq!(h.ago(9, 31_000), None);
        assert_eq!(h.uptime(41_000), 40_000);
        h.record(7, 40_000);
        assert_eq!(h.ago(7, 41_000), Some(1_000));
    }

    #[test]
    fn melt_columns_are_in_range_and_staggered() {
        let c = melt_columns(64, 5);
        assert_eq!(c.len(), 64);
        assert!(c.iter().all(|(d, f)| *d < 900 && *f >= 0.12 && *f <= 0.62));
        assert!(c.iter().map(|(d, _)| d).collect::<std::collections::HashSet<_>>().len() > 30);
    }
}
