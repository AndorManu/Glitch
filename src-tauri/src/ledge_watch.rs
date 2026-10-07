//! Watches the one window Glitch is standing on, so he reacts the moment it
//! moves, minimises, closes or gets covered (he rides along or falls; the
//! decision is made in the page, src/mascot/creature.ts).
//!
//! * Windows: event-driven. `SetWinEventHook` (out of context, only for that
//!   window's process) for location changes, move/size start/end, minimise,
//!   hide and destroy, plus the global foreground change (a window coming to
//!   the front may now cover his ledge). Location changes are forwarded at
//!   most ~30 times a second, with a trailing update so the final position
//!   always arrives. No hooks at all while he isn't on a window.
//! * macOS / Linux: no hooks; the page polls `ledge_frame` at 30 Hz while he
//!   stands on a window (and only then).
//!
//! Only window positions are read: no titles, no contents.

use glitch_core::world::ScreenRect;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize)]
pub struct LedgeEvent {
    pub id: u64,
    /// "move" (frame = where it is now), "grab" (the user took hold of it),
    /// "gone" (closed / hidden / minimised), "front" (another window came to
    /// the front: check whether it covers the ledge).
    pub kind: &'static str,
    pub frame: Option<ScreenRect>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WatchInfo {
    /// true: "ledge-event" events will arrive; false: poll `ledge_frame`.
    pub events: bool,
    /// The window's visible frame now (None: it's already gone).
    pub frame: Option<ScreenRect>,
}

pub(crate) fn emit(app: &AppHandle, e: LedgeEvent) {
    let _ = app.emit_to(crate::windows::MASCOT, "ledge-event", e);
}

/// Start watching window `id` (None: stop). Returns its frame right now.
#[tauri::command]
pub fn ledge_watch(app: AppHandle, id: Option<u64>) -> WatchInfo {
    imp::watch(&app, id);
    WatchInfo { events: imp::EVENTS, frame: id.and_then(|id| imp::frame(&app, id)) }
}

/// Where window `id` is now (visible frame, physical px), or None if it is
/// gone / minimised / hidden. For platforms without events.
#[tauri::command]
pub async fn ledge_frame(app: AppHandle, id: u64) -> Option<ScreenRect> {
    tauri::async_runtime::spawn_blocking(move || imp::frame(&app, id)).await.ok().flatten()
}

#[cfg(target_os = "windows")]
mod imp {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    use glitch_core::world::ScreenRect;
    use tauri::AppHandle;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowThreadProcessId, EVENT_OBJECT_DESTROY, EVENT_OBJECT_HIDE, EVENT_OBJECT_LOCATIONCHANGE,
        EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MOVESIZEEND, EVENT_SYSTEM_MOVESIZESTART,
        OBJID_WINDOW, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS,
    };

    use super::{emit, LedgeEvent};

    pub const EVENTS: bool = true;
    const MIN_GAP: Duration = Duration::from_millis(30);

    struct Watch {
        app: AppHandle,
        id: u64,
        /// HWINEVENTHOOKs as usize (raw pointers aren't Send).
        hooks: Vec<usize>,
        last: Instant,
        /// A location change was held back by the rate limit.
        dirty: bool,
        generation: u64,
    }

    static WATCH: Mutex<Option<Watch>> = Mutex::new(None);
    static GENERATION: Mutex<u64> = Mutex::new(0);

    pub fn frame(_app: &AppHandle, id: u64) -> Option<ScreenRect> {
        crate::chaos_native::visible_frame(id)
    }

    pub fn watch(app: &AppHandle, id: Option<u64>) {
        if WATCH.lock().unwrap().as_ref().map(|w| w.id) == id {
            return;
        }
        let generation = {
            let mut g = GENERATION.lock().unwrap();
            *g += 1;
            *g
        };
        let app2 = app.clone();
        // Hooks belong to a thread with a message loop: the main thread.
        let _ = app.run_on_main_thread(move || install(app2, id, generation));
    }

    fn install(app: AppHandle, id: Option<u64>, generation: u64) {
        // A newer request may have been queued after this one.
        if *GENERATION.lock().unwrap() != generation {
            return;
        }
        let old = WATCH.lock().unwrap().take();
        if let Some(old) = old {
            for h in old.hooks {
                unsafe { UnhookWinEvent(h as HWINEVENTHOOK) };
            }
        }
        let Some(id) = id else { return };
        let hwnd = id as usize as HWND;
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        if pid == 0 {
            // Already gone.
            emit(&app, LedgeEvent { id, kind: "gone", frame: None });
            return;
        }
        let flags = WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS;
        let mut hooks = Vec::new();
        for (lo, hi, process) in [
            (EVENT_OBJECT_DESTROY, EVENT_OBJECT_HIDE, pid),
            (EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE, pid),
            (EVENT_SYSTEM_MOVESIZESTART, EVENT_SYSTEM_MINIMIZESTART, pid),
            (EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, 0),
        ] {
            // SAFETY: plain registration; the callback only reads our statics.
            let h = unsafe { SetWinEventHook(lo, hi, std::ptr::null_mut(), Some(on_event), process, 0, flags) };
            if !h.is_null() {
                hooks.push(h as usize);
            }
        }
        *WATCH.lock().unwrap() =
            Some(Watch { app: app.clone(), id, hooks, last: Instant::now() - MIN_GAP, dirty: false, generation });
        // Trailing updates: what the rate limit held back arrives within 50 ms.
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(50));
            let mut g = WATCH.lock().unwrap();
            let Some(w) = g.as_mut() else { return };
            if w.generation != generation {
                return;
            }
            if w.dirty && w.last.elapsed() >= MIN_GAP {
                w.dirty = false;
                w.last = Instant::now();
                let (app, id) = (w.app.clone(), w.id);
                drop(g);
                send_frame(&app, id);
            }
        });
    }

    fn send_frame(app: &AppHandle, id: u64) {
        match crate::chaos_native::visible_frame(id) {
            Some(f) => emit(app, LedgeEvent { id, kind: "move", frame: Some(f) }),
            None => emit(app, LedgeEvent { id, kind: "gone", frame: None }),
        }
    }

    unsafe extern "system" fn on_event(
        _hook: HWINEVENTHOOK,
        event: u32,
        hwnd: HWND,
        idobject: i32,
        idchild: i32,
        _thread: u32,
        _time: u32,
    ) {
        let mut g = WATCH.lock().unwrap();
        let Some(w) = g.as_mut() else { return };
        let (app, id) = (w.app.clone(), w.id);
        if event == EVENT_SYSTEM_FOREGROUND {
            if hwnd as usize as u64 != id {
                drop(g);
                emit(&app, LedgeEvent { id, kind: "front", frame: None });
            }
            return;
        }
        if hwnd as usize as u64 != id || idobject != OBJID_WINDOW || idchild != 0 {
            return;
        }
        match event {
            EVENT_OBJECT_LOCATIONCHANGE => {
                if w.last.elapsed() < MIN_GAP {
                    w.dirty = true;
                    return;
                }
                w.last = Instant::now();
                w.dirty = false;
                drop(g);
                send_frame(&app, id);
            }
            EVENT_SYSTEM_MOVESIZESTART => {
                drop(g);
                emit(&app, LedgeEvent { id, kind: "grab", frame: None });
            }
            EVENT_SYSTEM_MOVESIZEEND => {
                w.dirty = false;
                w.last = Instant::now();
                drop(g);
                send_frame(&app, id);
            }
            EVENT_OBJECT_DESTROY | EVENT_OBJECT_HIDE | EVENT_SYSTEM_MINIMIZESTART => {
                drop(g);
                emit(&app, LedgeEvent { id, kind: "gone", frame: None });
            }
            _ => {}
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use glitch_core::world::ScreenRect;
    use tauri::{AppHandle, Manager};

    pub const EVENTS: bool = false;

    pub fn watch(_app: &AppHandle, _id: Option<u64>) {}

    /// The window's frame from the regular window list (the page polls this
    /// at 30 Hz only while Glitch stands on a window).
    pub fn frame(app: &AppHandle, id: u64) -> Option<ScreenRect> {
        let scale = app
            .get_webview_window(crate::windows::MASCOT)
            .and_then(|w| w.scale_factor().ok())
            .unwrap_or(1.0);
        crate::world_native::app_windows(scale).into_iter().find(|w| w.id == id).map(|w| w.rect)
    }
}
