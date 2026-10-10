//! The pointer overlay: a ring, a ghost cursor and a little paw that appear
//! at the spot Glitch is about to click (or pick up, or drop on), 400 ms
//! BEFORE the pointer sets off, so the user sees what is about to happen.
//!
//! One transparent, click-through, never-focused window (`pointer.html`),
//! made hidden when Glitch starts driving, moved to each spot, destroyed when
//! he stops. It is one of Glitch's own windows, so it is left out of every
//! screenshot the model gets, and it is not in Alt+Tab. Drawn by the page;
//! this file only positions it and tells it what to play.

use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const LABEL: &str = "hands-pointer";
/// Logical size of the window (the ring is drawn inside it).
const SIZE: f64 = 240.0;

static READY: AtomicBool = AtomicBool::new(false);
/// Native handle, so the hit test can hide the ring for a moment.
static HWND_BITS: AtomicIsize = AtomicIsize::new(0);
/// Bumped on every ping, so an old "hide in a moment" doesn't hide a new ring.
static GENERATION: AtomicU64 = AtomicU64::new(0);

fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

/// Create the (hidden) window. Call from an async task, not from an event
/// handler (window creation hops to the main thread).
pub fn prepare(app: &AppHandle) {
    if window(app).is_some() {
        return;
    }
    READY.store(false, Ordering::SeqCst);
    let built = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("pointer.html".into()))
        .title("Glitch's pointer")
        .inner_size(SIZE, SIZE)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .visible(false)
        .on_page_load(|_, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                READY.store(true, Ordering::SeqCst);
            }
        })
        .build();
    let Ok(win) = built.map_err(|e| eprintln!("glitch: pointer overlay failed: {e}")) else { return };
    crate::windows::hide_from_switcher(&win);
    let _ = win.set_ignore_cursor_events(true);
    #[cfg(target_os = "windows")]
    if let Ok(h) = win.hwnd() {
        HWND_BITS.store(h.0 as isize, Ordering::SeqCst);
    }
}

/// The window, once it exists and its page has loaded (up to ~3 s).
fn ready(app: &AppHandle) -> Option<WebviewWindow> {
    let t0 = Instant::now();
    loop {
        if let Some(w) = window(app) {
            if READY.load(Ordering::SeqCst) {
                return Some(w);
            }
        }
        if t0.elapsed() > Duration::from_secs(3) {
            return None;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn play(w: &WebviewWindow, call: &str) {
    let _ = w.eval(format!("window.{call}"));
}

/// Show the ring at `p` (screen px) and play the intro for `kind`:
/// "click", "right", "double", "move", "pickup", "drop", "scroll_up", "scroll_down".
pub fn ping(app: &AppHandle, p: (i32, i32), kind: &str) {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    let Some(w) = ready(app) else { return };
    if let Ok(size) = w.outer_size() {
        let _ = w.set_position(PhysicalPosition::new(p.0 - size.width as i32 / 2, p.1 - size.height as i32 / 2));
    }
    let _ = w.set_size(LogicalSize::new(SIZE, SIZE));
    play(&w, &format!("__ping({kind:?})"));
    #[cfg(target_os = "windows")]
    if let Ok(h) = w.hwnd() {
        crate::chaos_native::show_no_activate(h.0 as usize as u64);
        return;
    }
    let _ = w.show();
}

/// The click lands: the ring bursts.
pub fn pop(app: &AppHandle) {
    if let Some(w) = window(app) {
        play(&w, "__pop()");
    }
}

/// The action is over: fade the ring out a moment later (unless a new one
/// has started by then).
pub fn finish(app: &AppHandle) {
    let gen = GENERATION.load(Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(420));
        if GENERATION.load(Ordering::SeqCst) != gen {
            return;
        }
        if let Some(w) = window(&app) {
            play(&w, "__hide()");
            std::thread::sleep(Duration::from_millis(220));
            if GENERATION.load(Ordering::SeqCst) == gen {
                let _ = w.hide();
            }
        }
    });
}

pub fn destroy(app: &AppHandle) {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    READY.store(false, Ordering::SeqCst);
    HWND_BITS.store(0, Ordering::SeqCst);
    if let Some(w) = window(app) {
        let _ = w.destroy();
    }
}

/// While the pointer checks what is under a spot: hide the ring if it is in
/// the way. Returns whether it was visible.
#[cfg(target_os = "windows")]
pub fn hide_for_hit_test() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{IsWindowVisible, ShowWindow, SW_HIDE};
    let h = HWND_BITS.load(Ordering::SeqCst) as usize as windows_sys::Win32::Foundation::HWND;
    if h.is_null() || unsafe { IsWindowVisible(h) } == 0 {
        return false;
    }
    unsafe { ShowWindow(h, SW_HIDE) };
    true
}

#[cfg(target_os = "windows")]
pub fn restore_after_hit_test(was_visible: bool) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNOACTIVATE};
    if was_visible {
        let h = HWND_BITS.load(Ordering::SeqCst) as usize as windows_sys::Win32::Foundation::HWND;
        if !h.is_null() {
            unsafe { ShowWindow(h, SW_SHOWNOACTIVATE) };
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn hide_for_hit_test() -> bool {
    false
}
#[cfg(not(target_os = "windows"))]
pub fn restore_after_hit_test(_: bool) {}
