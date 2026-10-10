//! "He reacts to what you're doing", the shell: a low-rate poller (every
//! [`POLL`]) that feeds `context_native` readings through the pure rules in
//! `glitch_core::context` and sends what Glitch should do to the mascot page
//! as "context" events; plus focus mode (Pomodoro buddy: tray, chat tool,
//! "focus" events with the countdown) and the gentle messages (late night,
//! break reminders) shown in the chat bubble.
//!
//! Everything stays on this computer: nothing is logged or stored except
//! the settings. The mascot page checks once more before it reacts (not
//! while picked up, annoyed or busy chatting).

use std::sync::Mutex;
use std::time::{Duration, Instant};

use glitch_core::context::{self, ContextSettings, Focus, FocusEvent, FocusPhase, Gate, Reaction, Sensor};
use glitch_core::settings::Settings;
use serde::Serialize;
use tauri::menu::MenuItem;
use tauri::{AppHandle, Emitter, Manager, State, Wry};

use crate::context_native::{self as native, Want};
use crate::desktop::Reminder;
use crate::state::AppState;
use crate::windows;

/// How often he looks (the CPU cost per look is a few syscalls).
pub const POLL: Duration = Duration::from_secs(4);
/// Switched off: only check now and then whether that changed.
const POLL_OFF: Duration = Duration::from_secs(15);

pub struct Inner {
    born: Instant,
    sensor: Sensor,
    focus: Focus,
    /// Tray "Focus" item (its text follows the focus state).
    tray: Option<MenuItem<Wry>>,
}

impl Default for Inner {
    fn default() -> Self {
        Self { born: Instant::now(), sensor: Sensor::default(), focus: Focus::default(), tray: None }
    }
}

pub type ContextState = Mutex<Inner>;

/// What the mascot shows (quiet corner, focus countdown on hover).
#[derive(Debug, Clone, Serialize)]
pub struct ContextStatus {
    enabled: bool,
    quiet: bool,
    focus: FocusPhase,
    /// Time left in the focus session or break.
    remaining_ms: Option<u64>,
}

fn status_of(inner: &Inner, cfg: &ContextSettings) -> ContextStatus {
    let now = inner.born.elapsed();
    ContextStatus {
        enabled: cfg.enabled,
        quiet: inner.sensor.quiet(),
        focus: inner.focus.phase,
        remaining_ms: inner.focus.remaining(now).map(|d| d.as_millis() as u64),
    }
}

fn cfg(app: &AppHandle) -> ContextSettings {
    app.state::<AppState>().settings().context
}

/// Glitch keeps his paws to himself: a game/fullscreen app or a focus session.
pub fn blocks_chaos(app: &AppHandle) -> bool {
    crate::pause::is_paused()
        || app.try_state::<ContextState>().is_some_and(|c| {
            let c = c.lock().unwrap();
            c.sensor.quiet() || c.focus.focusing()
        })
}

/// Games and presentations, and the panic button: reminders wait.
fn quiet(app: &AppHandle) -> bool {
    crate::pause::is_paused() || app.try_state::<ContextState>().is_some_and(|c| c.lock().unwrap().sensor.quiet())
}

/// Reminders wait while the user games or presents (at most two hours).
pub async fn hold_while_quiet(app: &AppHandle) {
    let start = Instant::now();
    while quiet(app) && start.elapsed() < Duration::from_secs(2 * 60 * 60) {
        tokio::time::sleep(POLL).await;
    }
}

/// A gentle line in the chat bubble (like a timer's reminder).
fn say(app: &AppHandle, message: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        hold_while_quiet(&app).await;
        windows::show_bubble_for_message(&app).await;
        let _ = app.emit("reminder", Reminder { message, ambient: true });
    });
}

fn emit_status(app: &AppHandle) {
    let Some(c) = app.try_state::<ContextState>() else { return };
    let (status, item) = {
        let c = c.lock().unwrap();
        (status_of(&c, &cfg(app)), c.tray.clone())
    };
    if let Some(item) = item {
        let _ = item.set_text(tray_text(status.focus));
    }
    let _ = app.emit("focus", &status);
}

fn tray_text(phase: FocusPhase) -> String {
    match phase {
        FocusPhase::Focus { .. } => "Stop focus mode".into(),
        _ => "Focus mode".into(),
    }
}

// ------------------------------------------------------------ focus

/// Start (`Some(n)`, `None` = default length) or stop (`Some(0)`) focus mode.
/// Returns the minutes started (0 = stopped).
pub fn focus_set(app: &AppHandle, minutes: Option<u32>) -> Result<u32, String> {
    let cfg = cfg(app);
    if !cfg.enabled || !cfg.focus {
        return Err("focus mode is switched off in Glitch's settings".into());
    }
    let c = app.state::<ContextState>();
    let started = {
        let mut c = c.lock().unwrap();
        let now = c.born.elapsed();
        match minutes {
            Some(0) => {
                c.focus.stop();
                0
            }
            m => c.focus.start(now, m.unwrap_or(cfg.focus_minutes), cfg.break_minutes),
        }
    };
    emit_status(app);
    Ok(started)
}

/// The tray's "Focus mode" item: start with the default length, or stop.
pub fn tray_item(app: &AppHandle) -> tauri::Result<MenuItem<Wry>> {
    let item = MenuItem::with_id(app, "focus", tray_text(FocusPhase::Off), true, None::<&str>)?;
    app.state::<ContextState>().lock().unwrap().tray = Some(item.clone());
    Ok(item)
}

pub fn tray_toggle(app: &AppHandle) {
    let focusing = app.state::<ContextState>().lock().unwrap().focus.focusing();
    if let Err(e) = focus_set(app, if focusing { Some(0) } else { None }) {
        say(app, format!("I can't start focus mode: {e}."));
    }
}

fn on_focus_event(app: &AppHandle, e: FocusEvent) {
    match e {
        FocusEvent::Done { minutes, break_minutes } => say(
            app,
            format!(
                "{} of focus, nice work! Take a {break_minutes}-minute break: stretch, sip some water, look out \
                 of the window.",
                glitch_core::tools::duration_text(u64::from(minutes) * 60)
            ),
        ),
        FocusEvent::BreakOver => say(app, "Break's over! Want another round? Pick Focus mode in my tray menu.".into()),
    }
    emit_status(app);
}

// ------------------------------------------------------------ the poller

fn want(cfg: &ContextSettings) -> Want {
    Want { media: cfg.music || cfg.video, battery: cfg.battery, cpu: cfg.cpu }
}

/// One poll: read, decide, send. Returns how long to sleep.
fn poll(app: &AppHandle, cpu: &mut native::CpuMeter) -> Duration {
    // Paused: don't even look at what the user is doing.
    if crate::pause::is_paused() {
        return POLL_OFF;
    }
    let settings: Settings = app.state::<AppState>().settings();
    let cfg = &settings.context;
    let c = app.state::<ContextState>();
    let snap = if cfg.enabled { Some(native::snapshot(want(cfg), cpu)) } else { None };
    let (reactions, focus_event) = {
        let mut c = c.lock().unwrap();
        let now = c.born.elapsed();
        let focus_event = c.focus.tick(now);
        let gate = Gate { blocked: windows::chat_open(app) || !settings.onboarding_done, focusing: c.focus.focusing() };
        let snap = snap.clone().unwrap_or_default();
        let mut roll = rand01;
        (c.sensor.tick(&snap, now, cfg, gate, &mut roll), focus_event)
    };
    if let Some(e) = focus_event {
        on_focus_event(app, e);
    }
    for r in reactions {
        send(app, r);
    }
    if cfg.enabled {
        POLL
    } else {
        POLL_OFF
    }
}

/// Send one reaction to the mascot (and say what goes with it).
fn send(app: &AppHandle, r: Reaction) {
    match &r {
        Reaction::LateNight { say: true } => {
            say(app, "It's getting really late. Maybe time to sleep? I'll guard the desktop.".into())
        }
        Reaction::SuggestFocus => say(
            app,
            "You've been coding for a while. Want a focus session? Say \"focus for 25 minutes\" or pick Focus mode \
             in my tray menu."
                .into(),
        ),
        Reaction::Quiet { on } => {
            if *on {
                crate::chaos::stop_all(app);
            }
            emit_status(app);
        }
        _ => {}
    }
    let _ = app.emit("context", &r);
}

/// Small, good-enough randomness for "now and then" (no extra crate).
fn rand01() -> f64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static STATE: AtomicU64 = AtomicU64::new(0);
    let mut x = STATE.load(Ordering::Relaxed);
    if x == 0 {
        x = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(1, |d| d.as_nanos() as u64) | 1;
    }
    // xorshift64*
    x ^= x >> 12;
    x ^= x << 25;
    x ^= x >> 27;
    STATE.store(x, Ordering::Relaxed);
    (x.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64 / (1u64 << 53) as f64
}

/// Start looking (one thread, sleeping between polls).
pub fn start(app: &AppHandle) {
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("glitch-context".into()).spawn(move || {
        native::init_thread();
        let mut cpu = native::CpuMeter::default();
        // Let the mascot settle first.
        std::thread::sleep(Duration::from_secs(6));
        loop {
            let wait = poll(&app, &mut cpu);
            std::thread::sleep(wait);
        }
    });
    if let Err(e) = spawned {
        eprintln!("glitch: context sensor not started: {e}");
    }
}

// ------------------------------------------------------------ commands

#[tauri::command]
pub fn context_status(app: AppHandle, c: State<'_, ContextState>) -> ContextStatus {
    status_of(&c.lock().unwrap(), &cfg(&app))
}

/// Focus mode from the page: `minutes` None = default length, 0 = stop.
#[tauri::command]
pub fn focus_start(app: AppHandle, minutes: Option<u32>) -> Result<u32, String> {
    focus_set(&app, minutes)
}

/// The whole `context` settings block from the Features card.
#[tauri::command]
pub fn update_context_settings(app: AppHandle, state: State<'_, AppState>, mut patch: ContextSettings) -> Settings {
    // Times must parse; lengths stay sane.
    let defaults = ContextSettings::default();
    if context::parse_hhmm(&patch.night_start).is_none() {
        patch.night_start = defaults.night_start;
    }
    if context::parse_hhmm(&patch.night_end).is_none() {
        patch.night_end = defaults.night_end;
    }
    patch.focus_minutes = patch.focus_minutes.clamp(context::MIN_FOCUS_MINUTES, context::MAX_FOCUS_MINUTES);
    patch.break_minutes = patch.break_minutes.clamp(1, 60);
    let off = !patch.enabled || !patch.focus;
    let new = state.update_settings(|s| s.context = patch);
    if off {
        app.state::<ContextState>().lock().unwrap().focus.stop();
    }
    emit_status(&app);
    let _ = app.emit("settings-changed", &new);
    new
}

/// Debug builds: make a reaction happen now ("dance", "glasses", "watch",
/// "night", "morning", "battery", "cpu", "quiet", "unquiet", "suggest",
/// "focus" (a 1-minute session), "unfocus"). Returns whether it was known.
#[tauri::command]
pub fn context_debug(app: AppHandle, what: String) -> bool {
    if !cfg!(debug_assertions) {
        return false;
    }
    trigger(&app, what.trim())
}

fn trigger(app: &AppHandle, what: &str) -> bool {
    match what {
        "focus" => {
            let c = app.state::<ContextState>();
            {
                let mut c = c.lock().unwrap();
                let now = c.born.elapsed();
                c.focus.start(now, 1, 1);
            }
            emit_status(app);
            true
        }
        "unfocus" => {
            app.state::<ContextState>().lock().unwrap().focus.stop();
            emit_status(app);
            true
        }
        _ => match Reaction::debug(what, native::foreground_id()) {
            Some(r) => {
                if let Reaction::Quiet { on } = r {
                    // Pretend the sensor saw it (so chaos and reminders hush too).
                    let state = app.state::<ContextState>();
                    let mut c = state.lock().unwrap();
                    let _ = c.sensor.reset_quiet();
                    if on {
                        c.sensor.force_quiet();
                    }
                }
                send(app, r);
                true
            }
            None => false,
        },
    }
}

/// Debug builds only: `GLITCH_CONTEXT_DEBUG=dance,glasses,watch,...` plays
/// those reactions a few seconds after start, 6 s apart, then every 25 s.
pub fn debug_trigger(app: &AppHandle) {
    if !cfg!(debug_assertions) {
        return;
    }
    let Ok(what) = std::env::var("GLITCH_CONTEXT_DEBUG") else { return };
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(10));
        loop {
            for one in what.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                eprintln!("glitch: debug context trigger: {one}");
                if !trigger(&app, one) {
                    eprintln!("glitch: unknown context trigger {one:?}");
                }
                std::thread::sleep(Duration::from_secs(6));
            }
            std::thread::sleep(Duration::from_secs(25));
        }
    });
}
