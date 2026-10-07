//! Chaos mode, the Rust side: the gatekeeper for everything Glitch does to
//! things that aren't his own (other apps' windows, the mouse cursor), plus
//! his own two extra windows (the paw-print overlay and the sticky note).
//!
//! The mascot page decides *when* to be naughty and animates Glitch; every
//! call that touches another app goes through here and is checked again:
//! chaos + movement switched on, chat closed, the user not busy (fullscreen,
//! presentation, typing/mousing), rate limits, travel limits, on-screen
//! clamping. Pure rules: `glitch_core::chaos`. OS calls: `chaos_native`.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use glitch_core::chaos::{self, Cooldown, CursorGrab, Refusal, WindowGrab};
use glitch_core::world::ScreenRect;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindowBuilder};

use crate::chaos_native as native;
use crate::state::AppState;
use crate::windows::{self, MASCOT};

pub const NOTE: &str = "note";
pub const PAWS: &str = "pawprints";
/// CSS px, must match note.html.
const NOTE_W: f64 = 210.0;
const NOTE_H: f64 = 150.0;
/// The note page shows line `#n` of src/chaos/lines.ts (it wraps around).
const NOTE_LINES: u32 = 1000;

struct Session<T> {
    grab: T,
    at: Instant,
}

pub struct Chaos {
    born: Instant,
    window_cd: Cooldown,
    cursor_cd: Cooldown,
    window: Option<Session<WindowGrab>>,
    cursor: Option<Session<CursorGrab>>,
    /// Debug builds: GLITCH_CHAOS_FAST=1 shortens the rate limits to seconds.
    fast: bool,
}

impl Default for Chaos {
    fn default() -> Self {
        Self {
            born: Instant::now(),
            window_cd: Cooldown::default(),
            cursor_cd: Cooldown::default(),
            window: None,
            cursor: None,
            fast: cfg!(debug_assertions) && std::env::var_os("GLITCH_CHAOS_FAST").is_some(),
        }
    }
}

impl Chaos {
    fn now(&self) -> Duration {
        self.born.elapsed()
    }
    fn every(&self, d: Duration) -> Duration {
        if self.fast {
            Duration::from_secs(5)
        } else {
            d
        }
    }
}

pub type ChaosState = Mutex<Chaos>;

/// Debug builds: say what chaos mode does (on the console).
fn dlog(what: std::fmt::Arguments) {
    if cfg!(debug_assertions) {
        eprintln!("glitch chaos: {what}");
    }
}

/// Chaos is allowed at all right now (settings + chat closed + user not busy).
fn allowed(app: &AppHandle) -> Result<(), Refusal> {
    let s = app.state::<AppState>().settings();
    if !s.chaos_enabled || !s.movement_enabled {
        return Err(Refusal::Disabled);
    }
    if windows::chat_open(app) {
        return Err(Refusal::Busy);
    }
    if native::user_busy() {
        return Err(Refusal::Fullscreen);
    }
    Ok(())
}

fn area_and_scale(app: &AppHandle) -> Option<(ScreenRect, f64)> {
    let m = app.get_webview_window(MASCOT)?;
    let a = windows::work_area_of(&m)?;
    Some((ScreenRect { x: a.x, y: a.y, w: a.w, h: a.h }, m.scale_factor().unwrap_or(1.0)))
}

#[derive(Serialize)]
pub struct ChaosStatus {
    /// Other apps' windows / the cursor can be touched on this OS.
    available: bool,
    enabled: bool,
    /// Why not right now (None = go ahead).
    blocked: Option<Refusal>,
    idle_ms: u32,
    window_ready: bool,
    cursor_ready: bool,
}

/// Cheap: what the mascot may try right now.
#[tauri::command]
pub fn chaos_status(app: AppHandle, chaos: State<'_, ChaosState>) -> ChaosStatus {
    let c = chaos.lock().unwrap();
    let s = app.state::<AppState>().settings();
    let idle_ms = native::idle_ms();
    ChaosStatus {
        available: native::AVAILABLE,
        enabled: s.chaos_enabled && s.movement_enabled,
        blocked: allowed(&app).err(),
        idle_ms,
        window_ready: c.window_cd.ready(c.now(), c.every(chaos::WINDOW_COOLDOWN)) && idle_ms >= chaos::MIN_IDLE_MS,
        cursor_ready: c.cursor_cd.ready(c.now(), c.every(chaos::CURSOR_COOLDOWN)),
    }
}

#[derive(Serialize)]
pub struct ChaosWindow {
    id: u64,
    frame: ScreenRect,
}

/// Other apps' windows Glitch may drag right now (empty if not allowed).
#[tauri::command]
pub async fn chaos_windows(app: AppHandle) -> Vec<ChaosWindow> {
    if allowed(&app).is_err() {
        return Vec::new();
    }
    let Some((area, _)) = area_and_scale(&app) else { return Vec::new() };
    let idle = native::idle_ms();
    if idle < chaos::MIN_IDLE_MS {
        return Vec::new();
    }
    let list = tauri::async_runtime::spawn_blocking(move || {
        native::candidates()
            .into_iter()
            .filter(|t| chaos::eligible(&t.cand, area, idle).is_ok())
            .map(|t| ChaosWindow { id: t.cand.id, frame: t.cand.frame })
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default();
    dlog(format_args!("{} window(s) eligible", list.len()));
    list
}

/// Start dragging window `id`. Returns its visible frame.
#[tauri::command]
pub fn chaos_grab_window(app: AppHandle, chaos: State<'_, ChaosState>, id: u64) -> Result<ScreenRect, Refusal> {
    allowed(&app)?;
    let mut c = chaos.lock().unwrap();
    // A grab the page forgot about expires with its time limit.
    if c.window.as_ref().is_some_and(|s| s.at.elapsed() >= chaos::MAX_WINDOW_GRAB) {
        c.window = None;
    }
    if c.cursor.as_ref().is_some_and(|s| s.at.elapsed() >= chaos::MAX_CURSOR_GRAB) {
        c.cursor = None;
    }
    if c.window.is_some() {
        return Err(Refusal::Busy);
    }
    if !c.window_cd.ready(c.now(), c.every(chaos::WINDOW_COOLDOWN)) {
        return Err(Refusal::CoolingDown);
    }
    let idle = native::idle_ms();
    if idle < chaos::MIN_IDLE_MS {
        return Err(Refusal::UserActive);
    }
    let (area, scale) = area_and_scale(&app).ok_or(Refusal::NotFound)?;
    let t = native::target(id).ok_or(Refusal::NotFound)?;
    chaos::eligible(&t.cand, area, idle).inspect_err(|e| dlog(format_args!("grab {id:#x} refused: {e:?}")))?;
    dlog(format_args!("grabbed window {id:#x} at {:?}", t.cand.frame));
    let now = c.now();
    c.window_cd.mark(now);
    c.window = Some(Session { grab: WindowGrab { id, start: t.cand.frame, border: t.border, area, scale }, at: Instant::now() });
    Ok(t.cand.frame)
}

/// Move the grabbed window to its grab position + (dx, dy) physical px.
/// Returns the frame offset actually applied (clamped to the screen and the
/// travel limit), or `None` = the grab is over (user input, window gone, time
/// up, chaos off): let go.
#[tauri::command]
pub fn chaos_drag_window(app: AppHandle, chaos: State<'_, ChaosState>, dx: f64, dy: f64) -> Option<[i32; 2]> {
    let mut c = chaos.lock().unwrap();
    let Some((grab, at)) = c.window.as_ref().map(|s| (s.grab, s.at)) else { return None };
    let elapsed = at.elapsed();
    // Any keyboard/mouse input since the grab: the user is back, hands off.
    let user_touched = (native::idle_ms() as u128) < elapsed.as_millis();
    let ok = allowed(&app).is_ok()
        && elapsed < chaos::MAX_WINDOW_GRAB
        && !user_touched
        && native::target(grab.id).is_some_and(|t| !t.cand.maximized && !t.cand.fullscreen);
    let (x, y) = grab.target(dx, dy);
    if !ok || !native::move_window(grab.id, x, y) {
        dlog(format_args!("window drag ended (ok={ok}, user_touched={user_touched}, {elapsed:?})"));
        c.window = None;
        return None;
    }
    Some([x + grab.border.0 - grab.start.x, y + grab.border.1 - grab.start.y])
}

#[tauri::command]
pub fn chaos_release_window(chaos: State<'_, ChaosState>) {
    chaos.lock().unwrap().window = None;
}

/// Glitch caught the cursor: returns where it is (physical px), or None.
#[tauri::command]
pub fn chaos_grab_cursor(app: AppHandle, chaos: State<'_, ChaosState>) -> Option<(i32, i32)> {
    allowed(&app).ok()?;
    let mut c = chaos.lock().unwrap();
    if c.cursor.as_ref().is_some_and(|s| s.at.elapsed() >= chaos::MAX_CURSOR_GRAB) {
        c.cursor = None;
    }
    if c.cursor.is_some() || !c.cursor_cd.ready(c.now(), c.every(chaos::CURSOR_COOLDOWN)) {
        return None;
    }
    // Only a resting mouse: never yank it out of the user's hand.
    if native::idle_ms() < 1200 {
        return None;
    }
    let (area, scale) = area_and_scale(&app)?;
    let p = native::cursor()?;
    let now = c.now();
    c.cursor_cd.mark(now);
    c.cursor = Some(Session { grab: CursorGrab { start: p, last: p, area, scale }, at: Instant::now() });
    Some(p)
}

/// Carry the cursor towards (x, y). `false` = let go (the user pulled, time up).
#[tauri::command]
pub fn chaos_drag_cursor(app: AppHandle, chaos: State<'_, ChaosState>, x: f64, y: f64) -> bool {
    let mut c = chaos.lock().unwrap();
    let Some((grab, at)) = c.cursor.as_ref().map(|s| (s.grab, s.at)) else { return false };
    let ok = allowed(&app).is_ok()
        && at.elapsed() < chaos::MAX_CURSOR_GRAB
        && native::cursor().is_some_and(|p| !grab.user_fights(p));
    let to = grab.target(x, y);
    if !ok || !native::set_cursor(to.0, to.1) {
        c.cursor = None;
        return false;
    }
    if let Some(s) = c.cursor.as_mut() {
        s.grab.last = to;
    }
    true
}

#[tauri::command]
pub fn chaos_release_cursor(chaos: State<'_, ChaosState>) {
    chaos.lock().unwrap().cursor = None;
}

/// Chaos switched off / chat opened / movement off: drop every grab now.
pub fn stop_all(app: &AppHandle) {
    if let Some(c) = app.try_state::<ChaosState>() {
        let mut c = c.lock().unwrap();
        c.window = None;
        c.cursor = None;
    }
}

/// Show one of Glitch's extra windows without taking the keyboard focus
/// from whatever the user is doing.
fn show_quietly(win: &tauri::WebviewWindow) {
    #[cfg(target_os = "windows")]
    if let Ok(h) = win.hwnd() {
        if native::show_no_activate(h.0 as usize as u64) {
            return;
        }
    }
    let _ = win.show();
}

// ------------------------------------------------------------ paw prints

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub struct Paw {
    /// Physical screen px in, overlay CSS px out.
    x: f64,
    y: f64,
    /// Degrees (0 = upright on the floor).
    angle: f64,
    left: bool,
}

/// Leave paw prints (screen physical px). The overlay window is created on
/// first use, sits over the work area, never takes the mouse, and hides
/// itself when the last print has faded.
#[tauri::command]
pub async fn chaos_paws(app: AppHandle, paws: Vec<Paw>) {
    if paws.is_empty() || paws.len() > 32 || allowed(&app).is_err() {
        return;
    }
    let Some((area, scale)) = area_and_scale(&app) else { return };
    let win = match app.get_webview_window(PAWS) {
        Some(w) => w,
        None => {
            let built = WebviewWindowBuilder::new(&app, PAWS, WebviewUrl::App("pawprints.html".into()))
                .title("Glitch paw prints")
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
                Ok(w) => w,
                Err(e) => {
                    eprintln!("glitch: paw-print overlay failed: {e}");
                    return;
                }
            }
        }
    };
    let _ = win.set_position(PhysicalPosition::new(area.x, area.y));
    let _ = win.set_size(PhysicalSize::new(area.w as u32, area.h as u32));
    let _ = win.set_ignore_cursor_events(true);
    if !win.is_visible().unwrap_or(false) {
        show_quietly(&win);
        let _ = win.set_ignore_cursor_events(true);
        // Keep Glitch above his own footprints.
        if let Some(m) = app.get_webview_window(MASCOT) {
            let _ = m.set_always_on_top(true);
        }
    }
    let local: Vec<Paw> = paws
        .into_iter()
        .map(|p| Paw { x: (p.x - area.x as f64) / scale, y: (p.y - area.y as f64) / scale, ..p })
        .collect();
    let _ = win.emit("paws", local);
}

/// The overlay has nothing left to show.
#[tauri::command]
pub fn chaos_paws_idle(app: AppHandle) {
    if let Some(w) = app.get_webview_window(PAWS) {
        let _ = w.hide();
    }
}

// ------------------------------------------------------------ sticky note

#[derive(Serialize)]
pub struct NoteInfo {
    /// Physical px.
    w: i32,
    h: i32,
}

/// Open the sticky note showing line `line` at (x, y) (physical px; may be
/// partly off screen, Glitch drags it in). One note at a time: an open note
/// is replaced.
#[tauri::command]
pub async fn chaos_note_open(app: AppHandle, line: u32, x: i32, y: i32) -> Option<NoteInfo> {
    allowed(&app).ok()?;
    if let Some(old) = app.get_webview_window(NOTE) {
        let _ = old.destroy();
    }
    let line = line % NOTE_LINES;
    let win = WebviewWindowBuilder::new(&app, NOTE, WebviewUrl::App(format!("note.html#{line}").into()))
        .title("A note from Glitch")
        .inner_size(NOTE_W, NOTE_H)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        // Never steals the keyboard from what the user is doing (× still works).
        .focusable(false)
        .visible(false)
        .build()
        .map_err(|e| eprintln!("glitch: note failed: {e}"))
        .ok()?;
    let scale = win.scale_factor().unwrap_or(1.0);
    let _ = win.set_position(PhysicalPosition::new(x, y));
    show_quietly(&win);
    let _ = win.set_position(PhysicalPosition::new(x, y));
    Some(NoteInfo { w: (NOTE_W * scale).round() as i32, h: (NOTE_H * scale).round() as i32 })
}

/// Glitch drags the note (physical px, kept within the work area's height).
#[tauri::command]
pub fn chaos_note_move(app: AppHandle, x: i32, y: i32) -> bool {
    let Some(w) = app.get_webview_window(NOTE) else { return false };
    w.set_position(PhysicalPosition::new(x, y)).is_ok()
}

/// The user (× on the note) or Glitch closes the note.
#[tauri::command]
pub fn chaos_note_close(app: AppHandle) {
    if let Some(w) = app.get_webview_window(NOTE) {
        let _ = w.destroy();
    }
}

/// Is a note on screen?
#[tauri::command]
pub fn chaos_note_open_now(app: AppHandle) -> bool {
    app.get_webview_window(NOTE).is_some()
}

// ------------------------------------------------------------- debugging

/// Debug builds: the mascot page's creature events, on the console.
#[tauri::command]
pub fn chaos_debug_log(what: String) {
    dlog(format_args!("page: {}", what.chars().take(200).collect::<String>()));
}

/// Debug builds only: `GLITCH_CHAOS_DEBUG=window|chase|note|paws|peek|knock|push|perch:<hwnd>`
/// or any behaviour (copter, hangOn, slideDown, trampoline, fish, wallJump...),
/// comma-separated for a sequence,
/// makes Glitch do that a few seconds after start (and every 25 s after),
/// so the behaviours can be checked on a real desktop.
pub fn debug_trigger(app: &AppHandle) {
    if !cfg!(debug_assertions) {
        return;
    }
    let Ok(what) = std::env::var("GLITCH_CHAOS_DEBUG") else { return };
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(8));
        loop {
            // "perch:123,hangOn": several in a row, 6 s apart.
            for one in what.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                eprintln!("glitch: debug chaos trigger: {one}");
                let _ = app.emit("mascot-action", format!("chaos:{one}"));
                std::thread::sleep(Duration::from_secs(6));
            }
            std::thread::sleep(Duration::from_secs(25));
        }
    });
}
