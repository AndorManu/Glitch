//! Chaos mode 2 ("old virus style"), the Rust side: the runtime behind the
//! new acts. The mascot page decides *when* and animates Glitch; everything
//! that touches the cursor, other apps' windows or the screen goes through
//! here and is checked again (level, Gate, cooldowns, global rate limit).
//!
//! 100% harmless and fake: Glitch's own overlay (`chaosfx`, click-through),
//! his own popup window (`virus`), the real cursor moved only with
//! `SetCursorPos` in small steps, other apps' windows only moved or (one at a
//! time, always put back within 15 s) minimised through the one audited
//! function. Nothing is clicked, typed, closed, resized, saved or sent.
//!
//! Pure rules: `glitch_core::chaos2`. OS calls: `chaos_native`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use glitch_core::chaos::{self, Candidate};
use glitch_core::chaos2::{
    self, after_abort, dance_input_is_user, may_start, pick_yoink, restore_check, AbortReason, AfterAbort, Blocked,
    ChaosLevel, CursorAct, CursorScript, DanceKind, DanceScript, FlashBudget, Fx, Gate, GlobalLimit, MinimizeBook,
    RestoreCheck, Sample, Tick, YoinkWin, Yoinked, TICK_MS,
};
use glitch_core::world::ScreenRect;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

use crate::chaos_native::{self as native, YoinkCmd};
use crate::state::AppState;
use crate::windows::MASCOT;

pub const FX: &str = "chaosfx";
pub const POPUP: &str = "virus";
/// CSS px, must match virus.html.
const POPUP_W: f64 = 372.0;
const POPUP_H: f64 = 244.0;
/// The line flies from the rod to the cursor this long before the pull starts.
const CAST_MS: u32 = 900;

// ------------------------------------------------------------------ state

/// Bumped by every "stop everything": a running act notices on its next tick.
static STOP_GEN: AtomicU64 = AtomicU64::new(0);
static CURSOR_BUSY: AtomicBool = AtomicBool::new(false);
static DANCE_BUSY: AtomicBool = AtomicBool::new(false);
static POPUP_GEN: AtomicU64 = AtomicU64::new(0);

struct Inner {
    born: Instant,
    limit: GlobalLimit,
    last: HashMap<Fx, Duration>,
    flash: FlashBudget,
    book: MinimizeBook,
    front: chaos2::FrontHistory,
    /// The screen for the melt, until the overlay has fetched it.
    melt: Option<Vec<u8>>,
    /// Debug builds: GLITCH_CHAOS_FAST=1 shortens cooldowns and spacing.
    fast: bool,
    sampler: bool,
}

static INNER: LazyLock<Mutex<Inner>> = LazyLock::new(|| {
    Mutex::new(Inner {
        born: Instant::now(),
        limit: GlobalLimit::default(),
        last: HashMap::new(),
        flash: FlashBudget::default(),
        book: MinimizeBook::default(),
        front: chaos2::FrontHistory::default(),
        melt: None,
        fast: cfg!(debug_assertions) && std::env::var_os("GLITCH_CHAOS_FAST").is_some(),
        sampler: false,
    })
});

fn inner() -> std::sync::MutexGuard<'static, Inner> {
    INNER.lock().unwrap_or_else(|e| e.into_inner())
}

impl Inner {
    fn now(&self) -> Duration {
        self.born.elapsed()
    }
    fn now_ms(&self) -> u64 {
        self.born.elapsed().as_millis() as u64
    }
}

fn dlog(what: std::fmt::Arguments) {
    if cfg!(debug_assertions) {
        eprintln!("glitch chaos2: {what}");
    }
}

fn level_of(app: &AppHandle) -> ChaosLevel {
    app.state::<AppState>().settings().chaos_effective()
}

/// "Reduce effects": the setting, or (default) the OS animation switch.
pub fn reduce_effects(app: &AppHandle) -> bool {
    app.state::<AppState>().settings().reduce_effects.unwrap_or_else(native::os_reduce_motion)
}

fn area_scale(app: &AppHandle) -> Option<(ScreenRect, f64)> {
    crate::chaos::area_and_scale(app)
}

// ------------------------------------------------------------------ gating

fn gate_of(app: &AppHandle, idle_ms: u32, test: bool) -> Gate {
    let s = app.state::<AppState>().settings();
    Gate {
        paused: crate::pause::is_paused(),
        chat_open: !test && crate::windows::chat_open(app),
        voice_listening: crate::voice::busy(app),
        hands_active: app.get_webview_window("hands-banner").is_some_and(|w| w.is_visible().unwrap_or(false)),
        quiet_or_fullscreen: native::user_busy() || crate::context::blocks_chaos(app),
        focus_mode: false,
        stream_overlay_running: crate::stream::status(app).running,
        stream_opt_in: s.chaos_during_stream,
        screen_sharing: chaos2::screen_share_hint(native::visible_titles().iter().map(String::as_str)),
        user_busy: false,
        idle_ms: if test { u32::MAX } else { idle_ms },
    }
}

/// Everything that must be true before an act starts: level, Gate, reduce
/// effects, the act's own cooldown and the global rate limit. Records the
/// start on success. `test`: the Settings "Test" button (no level, cooldowns
/// or idle wait; the safety checks that matter still apply).
fn begin(app: &AppHandle, fx: Fx, test: bool) -> Result<ChaosLevel, Blocked> {
    let level = if test { ChaosLevel::FullVirus } else { level_of(app) };
    let idle = native::idle_ms();
    let gate = gate_of(app, idle, test);
    let reduce = reduce_effects(app);
    may_start(level, fx, &gate, reduce && !test).inspect_err(|b| dlog(format_args!("{fx:?} refused: {b:?}")))?;
    if !test {
        let mut i = inner();
        let now = i.now();
        let every = if i.fast { Duration::from_secs(5) } else { fx.cooldown(level) };
        if i.last.get(&fx).is_some_and(|l| now.saturating_sub(*l) < every) {
            return Err(Blocked::CoolingDown);
        }
        if !i.fast && !i.limit.allows(now, level) {
            return Err(Blocked::RateLimit);
        }
        i.limit.record(now);
        i.last.insert(fx, now);
    }
    Ok(level)
}

// ------------------------------------------------------------------ status

#[derive(Serialize)]
pub struct Chaos2Status {
    level: ChaosLevel,
    label: &'static str,
    reduce_effects: bool,
    /// Acts that could start right now (level, gate, cooldown, rate limit all fine).
    ready: Vec<Fx>,
    /// Why nothing can start (None = something can).
    blocked: Option<Blocked>,
    idle_ms: u32,
    /// Gap range to the next act, ms.
    gap_ms: Option<[u64; 2]>,
}

/// Cheap: what the mascot may try right now. Reads only, records nothing.
#[tauri::command]
pub fn chaos2_status(app: AppHandle) -> Chaos2Status {
    let level = level_of(&app);
    let idle = native::idle_ms();
    let gate = gate_of(&app, idle, false);
    let reduce = reduce_effects(&app);
    let (ready, blocked) = {
        let mut i = inner();
        let now = i.now();
        let fast = i.fast;
        let spaced = fast || i.limit.allows(now, level);
        let mut ready = vec![];
        let mut blocked = None;
        for fx in Fx::ALL {
            match may_start(level, fx, &gate, reduce) {
                Err(b) => {
                    if blocked.is_none() && level.is_on() && b != Blocked::Level && b != Blocked::ReduceEffects {
                        blocked = Some(b);
                    }
                }
                Ok(()) => {
                    let every = if fast { Duration::from_secs(5) } else { fx.cooldown(level) };
                    let cooled = i.last.get(&fx).is_none_or(|l| now.saturating_sub(*l) >= every);
                    if cooled && spaced && (fx != Fx::Yoink || i.book.has_room(level)) {
                        ready.push(fx);
                    }
                }
            }
        }
        if ready.is_empty() && blocked.is_none() && !spaced {
            blocked = Some(Blocked::RateLimit);
        }
        (ready, blocked)
    };
    Chaos2Status {
        level,
        label: level.label(),
        reduce_effects: reduce,
        ready,
        blocked,
        idle_ms: idle,
        gap_ms: level.gap().map(|(a, b)| [a.as_millis() as u64, b.as_millis() as u64]),
    }
}

// ------------------------------------------------------------ the overlay

/// The click-through overlay over the work area (rain, hook line, melt...).
fn ensure_fx(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    let (area, _) = area_scale(app)?;
    let win = match app.get_webview_window(FX) {
        Some(w) => w,
        None => {
            let built = WebviewWindowBuilder::new(app, FX, WebviewUrl::App("chaosfx.html".into()))
                .title("Glitch screen effects")
                .transparent(true)
                .decorations(false)
                .shadow(false)
                .resizable(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .focused(false)
                .focusable(false)
                .visible(false)
                .build();
            match built {
                Ok(w) => {
                    crate::windows::hide_from_switcher(&w);
                    w
                }
                Err(e) => {
                    eprintln!("glitch: effects overlay failed: {e}");
                    return None;
                }
            }
        }
    };
    let _ = win.set_position(PhysicalPosition::new(area.x, area.y));
    let _ = win.set_size(PhysicalSize::new(area.w as u32, area.h as u32));
    let _ = win.set_ignore_cursor_events(true);
    if !win.is_visible().unwrap_or(false) {
        crate::chaos::show_quietly(&win);
        let _ = win.set_ignore_cursor_events(true);
        // Keep Glitch above his own effects.
        if let Some(m) = app.get_webview_window(MASCOT) {
            let _ = m.set_always_on_top(true);
        }
    }
    Some(win)
}

fn fx_emit(app: &AppHandle, payload: serde_json::Value) {
    if let Some(w) = app.get_webview_window(FX) {
        let _ = w.emit("chaos2-fx", payload);
    }
}

/// Overlay -> nothing left to show: hide it.
#[tauri::command]
pub fn chaos2_fx_idle(app: AppHandle) {
    if let Some(w) = app.get_webview_window(FX) {
        let _ = w.hide();
    }
    inner().melt = None;
}

/// A safety net: whatever the page does, the overlay is hidden after `ms`.
fn hide_fx_later(app: &AppHandle, ms: u64) {
    let app = app.clone();
    let gen = STOP_GEN.load(Ordering::SeqCst);
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(ms));
        // Only if nothing newer was started meanwhile (a newer effect hides it itself).
        if STOP_GEN.load(Ordering::SeqCst) == gen && !CURSOR_BUSY.load(Ordering::SeqCst) {
            if let Some(w) = app.get_webview_window(FX) {
                let _ = w.emit("chaos2-fx", serde_json::json!({ "kind": "stop" }));
            }
        }
    });
}

fn local(p: (i32, i32), area: ScreenRect, scale: f64) -> [f64; 2] {
    [(p.0 - area.x) as f64 / scale, (p.1 - area.y) as f64 / scale]
}

// ------------------------------------------------------------ cursor acts

#[derive(Serialize)]
pub struct CursorOutcome {
    /// None = it ran to the end; else why it let go.
    aborted: Option<AbortReason>,
    /// How far from where it started the cursor got (physical px).
    travel: f64,
    ms: u32,
}

fn dist(a: (i32, i32), b: (i32, i32)) -> f64 {
    (((a.0 - b.0) as f64).powi(2) + ((a.1 - b.1) as f64).powi(2)).sqrt()
}

/// Run one cursor act to its end (or abort). Blocking: 8 ms ticks.
fn run_cursor_act(
    app: &AppHandle,
    act: CursorAct,
    level: ChaosLevel,
    rod: (i32, i32),
    area: ScreenRect,
    scale: f64,
) -> Result<CursorOutcome, Blocked> {
    let Some(start) = native::cursor() else { return Err(Blocked::Unsafe) };
    if native::button_down() || native::esc_down() {
        return Err(Blocked::UserBusy);
    }
    let seed = start.0 as u64 * 31 + start.1 as u64 + inner().now_ms();
    let mut script = CursorScript::new(act, level, start, rod, area, scale, seed);
    let gen = STOP_GEN.load(Ordering::SeqCst);
    let hook = matches!(act, CursorAct::Hook(_));
    let cast = if hook { CAST_MS } else { 0 };
    let idle0 = native::idle_ms();
    let t0 = Instant::now();
    if ensure_fx(app).is_some() {
        fx_emit(
            app,
            serde_json::json!({
                "kind": if hook { "hook" } else { "cursor-act" },
                "act": act,
                "phase": "cast",
                "rod": local(rod, area, scale),
                "cursor": local(start, area, scale),
                "cast_ms": cast,
                "origin": [area.x, area.y],
                "scale": scale,
                "reduce": reduce_effects(app),
            }),
        );
    }
    let mut last_emit = 0u32;
    let mut reeling = false;
    let mut at = start;
    let (aborted, ms) = loop {
        std::thread::sleep(Duration::from_millis(TICK_MS as u64));
        let el = t0.elapsed().as_millis() as u32;
        let Some(cur) = native::cursor() else { break (Some(AbortReason::Lost), el) };
        let sample = Sample {
            t_ms: el.saturating_sub(cast),
            cursor: cur,
            // GetLastInputInfo ticks in ~16 ms steps: a little slack, still far inside 100 ms.
            input_since_start: native::idle_ms().saturating_add(40) < idle0.saturating_add(el),
            button: native::button_down(),
            esc: native::esc_down(),
            stop: STOP_GEN.load(Ordering::SeqCst) != gen,
        };
        match script.tick(&sample) {
            Tick::Move(x, y) => {
                if (x, y) != cur && !native::set_cursor(x, y) {
                    break (Some(AbortReason::Lost), el);
                }
                at = (x, y);
                if hook && el >= cast && !reeling {
                    reeling = true;
                    fx_emit(
                        app,
                        serde_json::json!({ "kind": "hook", "phase": "reel", "cursor": local(at, area, scale) }),
                    );
                }
                if el >= last_emit + 24 {
                    last_emit = el;
                    fx_emit(
                        app,
                        serde_json::json!({ "kind": "cursor", "cursor": local(at, area, scale), "rod": local(rod, area, scale) }),
                    );
                }
                // A hop gets a spark, as long as sparks stay under 3 a second.
                if matches!(act, CursorAct::Hops)
                    && chaos2::HOP_TIMES.iter().any(|h| el >= *h && el < *h + TICK_MS + 4)
                    && inner().flash.try_flash(el as u64 + gen)
                {
                    fx_emit(app, serde_json::json!({ "kind": "spark", "at": local(at, area, scale) }));
                }
            }
            Tick::Done => break (None, el),
            Tick::Abort(r) => break (Some(r), el),
        }
    };
    let travel = dist(start, at);
    dlog(format_args!("{act:?} ended after {ms} ms: {aborted:?}, travelled {travel:.0}px"));
    let cur = native::cursor().unwrap_or(at);
    match aborted {
        None => fx_emit(
            app,
            serde_json::json!({ "kind": "hook", "phase": "release", "cursor": local(cur, area, scale), "rod": local(rod, area, scale) }),
        ),
        Some(r) => fx_emit(
            app,
            serde_json::json!({ "kind": "hook", "phase": "snap", "why": r, "cursor": local(cur, area, scale), "rod": local(rod, area, scale) }),
        ),
    }
    hide_fx_later(app, 2500);
    Ok(CursorOutcome { aborted, travel, ms })
}

/// Hook the cursor (or orbit / jitter / hop it): runs until it ends or the user
/// takes the mouse back. `rod`: where his rod tip is (physical px).
#[tauri::command]
pub async fn chaos2_cursor_act(
    app: AppHandle,
    act: CursorAct,
    rod_x: i32,
    rod_y: i32,
) -> Result<CursorOutcome, Blocked> {
    let level = begin(&app, act.fx(), false)?;
    if CURSOR_BUSY.swap(true, Ordering::SeqCst) {
        return Err(Blocked::CoolingDown);
    }
    // The old cursor grab must not be running too.
    let (area, scale) = area_scale(&app).ok_or(Blocked::Unsafe)?;
    let a = app.clone();
    let r =
        tauri::async_runtime::spawn_blocking(move || run_cursor_act(&a, act, level, (rod_x, rod_y), area, scale)).await;
    CURSOR_BUSY.store(false, Ordering::SeqCst);
    r.unwrap_or(Err(Blocked::Unsafe))
}

// ------------------------------------------------------- overlay effects

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FxKind {
    Trail,
    Matrix,
    Scanlines,
    Melt,
    Bugs,
    Swarm,
}

impl FxKind {
    fn fx(self) -> Fx {
        match self {
            FxKind::Trail => Fx::Trail,
            FxKind::Matrix => Fx::Matrix,
            FxKind::Scanlines => Fx::Scanlines,
            FxKind::Melt => Fx::Melt,
            FxKind::Bugs => Fx::Bugs,
            FxKind::Swarm => Fx::Swarm,
        }
    }
}

#[derive(Serialize)]
pub struct BugTop {
    /// The window (same id as its ledge).
    id: u64,
    /// Physical px, screen coordinates.
    x0: i32,
    x1: i32,
    y: i32,
}

#[derive(Serialize, Default)]
pub struct FxStarted {
    ms: u32,
    /// Window tops the bugs crawl along (bugs only).
    tops: Vec<BugTop>,
}

/// Windows whose top Glitch may stand on / bugs may crawl along.
fn eligible_windows(area: ScreenRect) -> Vec<Candidate> {
    let idle = native::idle_ms();
    native::candidates().into_iter().map(|t| t.cand).filter(|c| chaos::eligible(c, area, idle).is_ok()).collect()
}

/// Trail: stream the cursor position to the overlay for `ms`.
fn stream_cursor(app: &AppHandle, ms: u32, area: ScreenRect, scale: f64) {
    let app = app.clone();
    let gen = STOP_GEN.load(Ordering::SeqCst);
    std::thread::spawn(move || {
        let t0 = Instant::now();
        while (t0.elapsed().as_millis() as u32) < ms {
            if STOP_GEN.load(Ordering::SeqCst) != gen || native::esc_down() {
                break;
            }
            if let Some(c) = native::cursor() {
                fx_emit(&app, serde_json::json!({ "kind": "cursor", "cursor": local(c, area, scale) }));
            }
            std::thread::sleep(Duration::from_millis(16));
        }
    });
}

/// Start a screen effect on the overlay. Rust checks level, the Gate, reduce
/// effects, cooldowns; the melt also checks what is in front.
#[tauri::command]
pub async fn chaos2_fx_start(app: AppHandle, kind: FxKind) -> Result<FxStarted, Blocked> {
    let fx = kind.fx();
    let level = begin(&app, fx, false)?;
    let _ = level;
    let (area, scale) = area_scale(&app).ok_or(Blocked::Unsafe)?;
    let ms = fx.max_duration().as_millis() as u32 - 500;
    let mut started = FxStarted { ms, tops: vec![] };
    match kind {
        FxKind::Melt => {
            let a = app.clone();
            let ok = tauri::async_runtime::spawn_blocking(move || prepare_melt(&a, area)).await.unwrap_or(false);
            if !ok {
                // Refused after all: give the cooldown back, nothing was shown.
                inner().last.remove(&fx);
                return Err(Blocked::Unsafe);
            }
        }
        FxKind::Bugs => {
            let wins = tauri::async_runtime::spawn_blocking(move || eligible_windows(area)).await.unwrap_or_default();
            started.tops = wins
                .iter()
                .filter(|c| c.frame.w >= 260 && c.frame.y > area.y + 4)
                .take(4)
                .map(|c| BugTop { id: c.id, x0: c.frame.x + 6, x1: c.frame.right() - 6, y: c.frame.y })
                .collect();
            if started.tops.is_empty() {
                inner().last.remove(&fx);
                return Err(Blocked::Unsafe);
            }
        }
        _ => {}
    }
    ensure_fx(&app).ok_or(Blocked::Unsafe)?;
    let tops: Vec<_> = started.tops.iter().map(|t| serde_json::json!({ "id": t.id, "x0": (t.x0 - area.x) as f64 / scale, "x1": (t.x1 - area.x) as f64 / scale, "y": (t.y - area.y) as f64 / scale })).collect();
    fx_emit(
        &app,
        serde_json::json!({ "kind": kind, "ms": ms, "w": area.w as f64 / scale, "h": area.h as f64 / scale, "tops": tops, "seed": inner().now_ms() }),
    );
    if kind == FxKind::Trail {
        stream_cursor(&app, ms, area, scale);
    }
    hide_fx_later(&app, ms as u64 + 3500);
    dlog(format_args!("{kind:?} started for {ms} ms"));
    Ok(started)
}

/// Is it safe to draw a copy of the screen? Captures it (RAM only) and keeps
/// it for the overlay to fetch. Refuses on password fields, banking, blocked apps.
fn prepare_melt(app: &AppHandle, area: ScreenRect) -> bool {
    // What is in front must be a calm app.
    if let Some(w) = native::foreground_id().and_then(native::yoink_win) {
        if chaos2::blocked_app(&w.process, &w.title, &w.class) {
            dlog(format_args!("melt skipped: the foreground app is blocked"));
            return false;
        }
    }
    let Ok(cap) = crate::desktop::capture_screen_ram() else {
        dlog(format_args!("melt skipped: the capture failed"));
        return false;
    };
    if !cap.redact.is_empty() {
        dlog(format_args!("melt skipped: a password field is on screen"));
        return false;
    }
    if let Some(w) = &cap.window {
        if chaos2::blocked_app("x", &w.title, "") {
            dlog(format_args!("melt skipped: the window in front looks private"));
            return false;
        }
    }
    // The capture is the monitor under the cursor; the overlay covers the mascot's work area.
    let mon = app
        .get_webview_window(MASCOT)
        .and_then(|m| m.current_monitor().ok().flatten())
        .map(|m| (m.position().x, m.position().y));
    let (mx, my) = mon.unwrap_or((0, 0));
    let (ox, oy) = ((area.x - mx).max(0) as u32, (area.y - my).max(0) as u32);
    if ox + area.w as u32 > cap.width || oy + area.h as u32 > cap.height {
        return false;
    }
    let (w, h) = (area.w as u32, area.h as u32);
    let mut out = Vec::with_capacity(8 + (w * h * 4) as usize);
    out.extend_from_slice(&w.to_le_bytes());
    out.extend_from_slice(&h.to_le_bytes());
    for row in 0..h {
        let s = (((oy + row) * cap.width + ox) * 4) as usize;
        out.extend_from_slice(&cap.rgba[s..s + (w * 4) as usize]);
    }
    drop(cap);
    inner().melt = Some(out);
    // Forget it even if the overlay never asks.
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(10));
        inner().melt = None;
    });
    true
}

/// The overlay fetches the screenshot once: 8 bytes (w, h as u32 LE) + RGBA. It is gone from RAM after.
#[tauri::command]
pub fn chaos2_melt_frame() -> tauri::ipc::Response {
    tauri::ipc::Response::new(inner().melt.take().unwrap_or_default())
}

/// Glitch stamps on the bugs at this x (physical px): the overlay squashes them.
#[tauri::command]
pub fn chaos2_fx_squash(app: AppHandle, x: i32, y: i32) {
    if let Some((area, scale)) = area_scale(&app) {
        fx_emit(&app, serde_json::json!({ "kind": "squash", "at": local((x, y), area, scale) }));
    }
}

// ------------------------------------------------------------------ popups

/// Open Glitch's fake popup (always one at a time). `kind`: "ram", "raccoons", "adopted".
#[tauri::command]
pub async fn chaos2_popup(app: AppHandle, kind: String) -> Result<(), Blocked> {
    begin(&app, Fx::Popup, false)?;
    open_popup(&app, &kind).then_some(()).ok_or(Blocked::Unsafe)
}

fn open_popup(app: &AppHandle, kind: &str) -> bool {
    if !matches!(kind, "ram" | "raccoons" | "adopted") {
        return false;
    }
    let Some((area, scale)) = area_scale(app) else { return false };
    if let Some(old) = app.get_webview_window(POPUP) {
        let _ = old.destroy();
    }
    let built = WebviewWindowBuilder::new(app, POPUP, WebviewUrl::App(format!("virus.html#{kind}").into()))
        .title("Glitch is only playing")
        .inner_size(POPUP_W, POPUP_H)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        // Never steals the keyboard; the Close button still works with the mouse.
        .focusable(false)
        .visible(false)
        .build();
    let Ok(win) = built else { return false };
    crate::windows::hide_from_switcher(&win);
    let (w, h) = ((POPUP_W * scale) as i32, (POPUP_H * scale) as i32);
    // Bottom-right of the work area, a little off the corner, never covering the middle.
    let x = area.right() - w - (24.0 * scale) as i32;
    let y = area.bottom() - h - (24.0 * scale) as i32;
    let _ = win.set_position(PhysicalPosition::new(x, y));
    crate::chaos::show_quietly(&win);
    let _ = win.set_position(PhysicalPosition::new(x, y));
    // Esc closes it (it has no keyboard focus, so Rust watches the key), and so does time.
    let gen = POPUP_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let app2 = app.clone();
    std::thread::spawn(move || {
        let t0 = Instant::now();
        while POPUP_GEN.load(Ordering::SeqCst) == gen && t0.elapsed() < Fx::Popup.max_duration() {
            if native::esc_down() {
                dlog(format_args!("Esc: closing the popup"));
                abort_all(&app2);
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        if POPUP_GEN.load(Ordering::SeqCst) == gen {
            close_popup(&app2);
        }
    });
    true
}

fn close_popup(app: &AppHandle) {
    POPUP_GEN.fetch_add(1, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window(POPUP) {
        let _ = w.destroy();
    }
}

/// The popup's Close button (or its own timer).
#[tauri::command]
pub fn chaos2_popup_close(app: AppHandle) {
    close_popup(&app);
}

// ------------------------------------------------------------ window dance

#[derive(Serialize)]
pub struct DanceOutcome {
    aborted: Option<AbortReason>,
    ms: u32,
}

fn move_to(id: u64, frame: ScreenRect, border: (i32, i32), off: (f64, f64)) -> bool {
    native::move_window(id, frame.x + off.0.round() as i32 - border.0, frame.y + off.1.round() as i32 - border.1)
}

fn run_dance(app: &AppHandle, id: u64, kind: DanceKind, area: ScreenRect, scale: f64) -> Result<DanceOutcome, Blocked> {
    let t = native::target(id).ok_or(Blocked::Unsafe)?;
    chaos::eligible(&t.cand, area, native::idle_ms()).map_err(chaos2::blocked_from)?;
    if crate::hands::save_prompt_open(id) {
        return Err(Blocked::Unsafe);
    }
    if native::button_down() || native::esc_down() {
        return Err(Blocked::UserBusy);
    }
    let home = t.cand.frame;
    let mut script = DanceScript::new(kind, home, area, scale);
    let gen = STOP_GEN.load(Ordering::SeqCst);
    let idle0 = native::idle_ms();
    let t0 = Instant::now();
    let mut last_cursor = native::cursor().unwrap_or((0, 0));
    let mut last_el = 0u32;
    let mut off = (0.0, 0.0);
    let mut last_check = 0u32;
    let total = script.total_ms();
    let (aborted, ms) = loop {
        std::thread::sleep(Duration::from_millis(16));
        let el = t0.elapsed().as_millis() as u32;
        let cur = native::cursor().unwrap_or(last_cursor);
        let moved = (cur.0 - last_cursor.0).abs() + (cur.1 - last_cursor.1).abs() > 2;
        let input = native::idle_ms().saturating_add(40) < idle0.saturating_add(el);
        let why = if STOP_GEN.load(Ordering::SeqCst) != gen {
            Some(AbortReason::Stopped)
        } else if native::esc_down() {
            Some(AbortReason::Esc)
        } else if native::button_down() {
            Some(AbortReason::Button)
        } else if dance_input_is_user(input, moved, kind) {
            Some(AbortReason::UserInput)
        } else {
            None
        };
        // Re-check the window now and then: maximised, fullscreen, gone, a Save prompt: stop at once.
        if why.is_none() && el >= last_check + 300 {
            last_check = el;
            let still =
                native::target(id).is_some_and(|t| !t.cand.maximized && !t.cand.fullscreen && t.cand.unsaved.is_none());
            if !still {
                break (Some(AbortReason::Lost), el);
            }
        }
        if let Some(r) = why {
            break (Some(r), el);
        }
        last_cursor = cur;
        off = script.offset(el, el - last_el, cur);
        last_el = el;
        if !move_to(id, home, t.border, off) {
            break (Some(AbortReason::Lost), el);
        }
        if el >= total {
            break (None, el);
        }
    };
    // Carry it back unless the user may be holding it.
    if aborted.is_some_and(|r| after_abort(r) == AfterAbort::GlideHome) {
        for i in 1..=12 {
            let k = 1.0 - i as f64 / 12.0;
            move_to(id, home, t.border, (off.0 * k, off.1 * k));
            std::thread::sleep(Duration::from_millis(20));
        }
    } else if aborted.is_none() {
        move_to(id, home, t.border, (0.0, 0.0));
    }
    dlog(format_args!("{kind:?} dance on {id:#x} ended after {ms} ms: {aborted:?}"));
    let _ = app;
    Ok(DanceOutcome { aborted, ms })
}

/// Dance window `id` (one of `chaos_windows`): wobble, slide to the edge and
/// back, earthquake or run away from the cursor. Always put back where it was.
#[tauri::command]
pub async fn chaos2_dance(app: AppHandle, id: u64, kind: DanceKind) -> Result<DanceOutcome, Blocked> {
    begin(&app, Fx::Dance, false)?;
    if DANCE_BUSY.swap(true, Ordering::SeqCst) {
        return Err(Blocked::CoolingDown);
    }
    let (area, scale) = area_scale(&app).ok_or(Blocked::Unsafe)?;
    // Not while the old window grab holds one.
    if app.try_state::<crate::chaos::ChaosState>().is_some_and(|c| c.lock().unwrap().window_grabbed()) {
        DANCE_BUSY.store(false, Ordering::SeqCst);
        return Err(Blocked::CoolingDown);
    }
    let a = app.clone();
    let r = tauri::async_runtime::spawn_blocking(move || run_dance(&a, id, kind, area, scale)).await;
    DANCE_BUSY.store(false, Ordering::SeqCst);
    r.unwrap_or(Err(Blocked::Unsafe))
}

// -------------------------------------------------------------- the yoink

#[derive(Serialize)]
pub struct YoinkInfo {
    id: u64,
    /// Where the window was (physical px).
    frame: ScreenRect,
    /// Restored by then at the latest.
    deadline_ms: u64,
}

/// The foreground sampler and the minimise watcher: one small thread.
/// 2 s ticks while nothing is going on, 100 ms while a window is minimised.
pub fn start_sampler(app: &AppHandle) {
    {
        let mut i = inner();
        if i.sampler {
            return;
        }
        i.sampler = true;
    }
    let app = app.clone();
    let _ = std::thread::Builder::new().name("glitch-chaos2".into()).spawn(move || {
        let mut slow = 0u32;
        loop {
            let watching = !inner().book.is_empty();
            std::thread::sleep(Duration::from_millis(if watching { 100 } else { 500 }));
            if watching {
                watch_book(&app);
            }
            slow += 1;
            // Remember what is in front (needs a level that can minimise), every second.
            if (watching && slow % 10 == 0) || (!watching && slow % 2 == 0) {
                if level_of(&app) >= ChaosLevel::Mischief {
                    if let Some(id) = native::foreground_id() {
                        let mut i = inner();
                        let now = i.now_ms();
                        i.front.record(id, now);
                    }
                }
            }
        }
    });
}

/// Restore what is due, forget what the user already restored or closed.
fn watch_book(app: &AppHandle) {
    let esc = native::esc_down();
    let (due, items) = {
        let i = inner();
        (i.book.due(i.now()), i.book.items().to_vec())
    };
    for y in items {
        let same = native::identity(y.id).is_some_and(|(pid, class)| pid == y.pid && class == y.class);
        let minimized = native::is_minimized(y.id) == Some(true);
        let stop = esc || due.contains(&y.id);
        match restore_check(same, minimized, stop) {
            RestoreCheck::Wait => {}
            RestoreCheck::Forget => {
                // The user brought it back (or closed it): not ours to touch any more.
                inner().book.remove(y.id);
                dlog(format_args!("window {:#x} was restored/closed by the user: leaving it alone", y.id));
                let _ = app.emit("chaos2-restored", serde_json::json!({ "id": y.id, "by": "user" }));
            }
            RestoreCheck::Restore => {
                restore_one(Some(app), &y, if esc { "esc" } else { "timer" });
                inner().book.remove(y.id);
            }
        }
    }
    if esc {
        abort_all(app);
    }
}

/// Put one window back (no focus change) and say so. Only ever called with an
/// entry from the minimise book.
fn restore_one(app: Option<&AppHandle>, y: &Yoinked, why: &str) {
    let same = native::identity(y.id).is_some_and(|(pid, class)| pid == y.pid && class == y.class);
    let minimized = native::is_minimized(y.id) == Some(true);
    if restore_check(same, minimized, true) != RestoreCheck::Restore {
        return;
    }
    let frame = native::visible_frame(y.id);
    native::yoink_show(y.id, YoinkCmd::Restore);
    // A window that ignores the first request gets one more try.
    for _ in 0..3 {
        std::thread::sleep(Duration::from_millis(80));
        if native::is_minimized(y.id) != Some(true) {
            break;
        }
        native::yoink_show(y.id, YoinkCmd::Restore);
    }
    dlog(format_args!("restored window {:#x} ({why})", y.id));
    if let Some(app) = app {
        let _ = app.emit("chaos2-restored", serde_json::json!({ "id": y.id, "by": why }));
        if let (Some((area, scale)), Some(f)) = (area_scale(app), native::visible_frame(y.id).or(frame)) {
            if ensure_fx(app).is_some() {
                fx_emit(
                    app,
                    serde_json::json!({ "kind": "pop", "rect": [(f.x - area.x) as f64 / scale, (f.y - area.y) as f64 / scale, f.w as f64 / scale, f.h as f64 / scale] }),
                );
                hide_fx_later(app, 2500);
            }
        }
    }
}

/// Everything Glitch minimised comes back now (Esc, panic, Stop chaos, exit).
/// Needs no `AppHandle`: the exit and panic hooks call it too.
pub fn restore_all(app: Option<&AppHandle>, why: &str) {
    let items = inner().book.drain();
    for y in items {
        restore_one(app, &y, why);
    }
}

/// Best effort when Glitch exits or crashes: put every window back.
pub fn install_exit_guards() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore_all(None, "panic");
        prev(info);
    }));
}

/// Minimise one window (picked here, never by the page), pop it back in 8-15 s.
#[tauri::command]
pub async fn chaos2_yoink(app: AppHandle) -> Result<YoinkInfo, Blocked> {
    let level = begin(&app, Fx::Yoink, false)?;
    let fail = |b: Blocked| {
        inner().last.remove(&Fx::Yoink);
        Err(b)
    };
    if !inner().book.has_room(level) {
        return fail(Blocked::CoolingDown);
    }
    let (area, _) = area_scale(&app).ok_or(Blocked::Unsafe)?;
    let idle = native::idle_ms();
    let (uptime, front_ago): (u64, Vec<(u64, Option<u64>)>) = {
        let i = inner();
        let now = i.now_ms();
        (i.front.uptime(now), vec![])
    };
    let _ = front_ago;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut wins: Vec<YoinkWin> = native::yoink_candidates();
        {
            let i = inner();
            let now = i.now_ms();
            for w in wins.iter_mut() {
                w.last_front_ms_ago = i.front.ago(w.cand.id, now);
            }
        }
        // Windows the user maximised come back normal-sized: leave them out. (Measured in the live test.)
        wins.retain(|w| !w.cand.maximized);
        let pick = (inner().now_ms() % 997) as f64 / 997.0;
        let i = pick_yoink(&wins, area, idle, uptime, level, pick)?;
        let w = wins.swap_remove(i);
        // An open Save prompt anywhere in that app: hands off.
        if crate::hands::save_prompt_open(w.cand.id) {
            return None;
        }
        Some(w)
    })
    .await
    .unwrap_or(None);
    let Some(w) = picked else { return fail(Blocked::Unsafe) };
    let id = w.cand.id;
    let Some((pid, class)) = native::identity(id) else { return fail(Blocked::Unsafe) };
    if !native::yoink_show(id, YoinkCmd::Minimize) {
        return fail(Blocked::Unsafe);
    }
    // Did it go? (Some apps ignore it.) If not, it is not ours.
    let mut gone = false;
    for _ in 0..8 {
        tokio::time::sleep(Duration::from_millis(60)).await;
        if native::is_minimized(id) == Some(true) {
            gone = true;
            break;
        }
    }
    if !gone {
        return fail(Blocked::Unsafe);
    }
    let pick = (inner().now_ms() % 101) as f64 / 100.0;
    let deadline = {
        let mut i = inner();
        let now = i.now();
        let y = Yoinked { id, pid, class, title: w.title.clone(), process: w.process.clone(), at: now, deadline: now };
        let added = i.book.add(y, now, pick).clone();
        added.deadline.saturating_sub(now).as_millis() as u64
    };
    dlog(format_args!("yoinked window {id:#x} ({}), back in {deadline} ms", w.process));
    Ok(YoinkInfo { id, frame: w.cand.frame, deadline_ms: deadline })
}

/// Is a window Glitch minimised still out? (The page waits for the restore.)
#[tauri::command]
pub fn chaos2_yoinked_count() -> usize {
    inner().book.len()
}

// ------------------------------------------------------------ stop / test

/// Stop everything chaos mode 2 is doing: cursor acts, dances, effects,
/// popups, and put every window Glitch minimised back. Called by the panic
/// button, the tray's "Stop chaos", settings changes and the chat opening.
pub fn abort_all(app: &AppHandle) {
    STOP_GEN.fetch_add(1, Ordering::SeqCst);
    close_popup(app);
    if let Some(w) = app.get_webview_window(FX) {
        let _ = w.emit("chaos2-fx", serde_json::json!({ "kind": "stop" }));
        let _ = w.hide();
    }
    inner().melt = None;
    restore_all(Some(app), "stop");
    let _ = app.emit("chaos2-stopped", ());
}

/// The mascot page lets go of a running act (he was grabbed, chaos switched off...).
#[tauri::command]
pub fn chaos2_abort(app: AppHandle) {
    abort_all(&app);
}

/// Settings > Stop button.
#[tauri::command]
pub fn chaos2_stop(app: AppHandle) {
    abort_all(&app);
}

/// Settings > Test button: one harmless sample (a popup and a few seconds of
/// ghost cursor trail). No cursor control, no windows touched.
#[tauri::command]
pub async fn chaos2_test(app: AppHandle) -> Result<(), Blocked> {
    begin(&app, Fx::Popup, true)?;
    if !open_popup(&app, "adopted") {
        return Err(Blocked::Unsafe);
    }
    if !reduce_effects(&app) {
        if let (Some((area, scale)), Some(_)) = (area_scale(&app), ensure_fx(&app)) {
            fx_emit(
                &app,
                serde_json::json!({ "kind": "trail", "ms": 4000, "w": area.w as f64 / scale, "h": area.h as f64 / scale, "tops": [], "seed": 1 }),
            );
            stream_cursor(&app, 4000, area, scale);
            hide_fx_later(&app, 7000);
        }
    }
    Ok(())
}

/// The panic button / chaos off: also close the new extra windows.
pub fn close_extras(app: &AppHandle) {
    close_popup(app);
    if let Some(w) = app.get_webview_window(FX) {
        let _ = w.hide();
    }
}

/// Debug builds only, `GLITCH_CHAOS_DEBUG=hook,...` goes through the mascot
/// page (chaos.rs debug_trigger); this lets tests also open a popup directly.
pub fn debug_popup(app: &AppHandle) {
    if !cfg!(debug_assertions) {
        return;
    }
    let Ok(kind) = std::env::var("GLITCH_CHAOS_POPUP") else { return };
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(6));
        let _ = open_popup(&app, &kind);
    });
}
