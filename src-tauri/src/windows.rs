//! The three windows:
//! * `mascot` (declared in tauri.conf.json): Glitch himself.
//! * `bubble`: the small speech-bubble chat that pops up above Glitch.
//! * `panel`: setup wizard + settings only.
//!
//! Bubble and panel are created lazily the first time they're needed, then
//! hidden instead of closed (keeps their state, avoids re-creating webviews).

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};

use crate::layout::{self, Rect};

pub const MASCOT: &str = "mascot";
pub const BUBBLE: &str = "bubble";
pub const PANEL: &str = "panel";
/// Must match the mascot size in tauri.conf.json and src/mascot/main.ts.
const MASCOT_W: f64 = 160.0;
const MASCOT_H: f64 = 160.0;
/// Bubble width is fixed; its height follows its content (see `resize_bubble`).
pub const BUBBLE_W: f64 = 300.0;
const BUBBLE_MIN_H: f64 = 56.0;
const BUBBLE_MAX_H: f64 = 420.0;
/// How far the bubble's tail reaches down over the top of the mascot window
/// (the art has empty space above Glitch's ears).
const BUBBLE_OVERLAP: f64 = 14.0;
const PANEL_W: f64 = 380.0;
const PANEL_H: f64 = 560.0;

pub fn work_area_of(win: &WebviewWindow) -> Option<Rect> {
    work_area(win)
}

fn work_area(win: &WebviewWindow) -> Option<Rect> {
    let monitor = win.current_monitor().ok().flatten().or_else(|| win.primary_monitor().ok().flatten())?;
    let wa = monitor.work_area();
    Some(Rect { x: wa.position.x, y: wa.position.y, w: wa.size.width as i32, h: wa.size.height as i32 })
}

fn window_rect(win: &WebviewWindow, fallback_logical: (f64, f64)) -> Option<Rect> {
    let pos = win.outer_position().ok()?;
    let size = win.outer_size().ok()?;
    // A window that hasn't been shown yet may report 0x0.
    let scale = win.scale_factor().unwrap_or(1.0);
    let w = if size.width > 0 { size.width as i32 } else { (fallback_logical.0 * scale) as i32 };
    let h = if size.height > 0 { size.height as i32 } else { (fallback_logical.1 * scale) as i32 };
    Some(Rect { x: pos.x, y: pos.y, w, h })
}

fn is_visible(app: &AppHandle, label: &str) -> bool {
    app.get_webview_window(label).and_then(|w| w.is_visible().ok()).unwrap_or(false)
}

/// Tell the mascot whether any chat UI is open (it stops wandering then).
/// Event name kept from milestone 1: "panel-visibility" = bubble or panel open.
fn emit_chat_visibility(app: &AppHandle) {
    let open = is_visible(app, BUBBLE) || is_visible(app, PANEL);
    let _ = app.emit("panel-visibility", open);
}

/// Put Glitch in the bottom-right corner on start-up. The page shows the
/// window itself once its first frame is drawn (avoids a blank flash).
pub fn place_mascot(app: &AppHandle) {
    let Some(m) = app.get_webview_window(MASCOT) else { return };
    let (Some(area), Ok(scale)) = (work_area(&m), m.scale_factor()) else { return };
    // Not `outer_size()`: a window that hasn't been shown yet may report 0x0.
    let (w, h) = ((MASCOT_W * scale).round() as i32, (MASCOT_H * scale).round() as i32);
    let (x, y) = layout::mascot_home(area, w, h, (24.0 * scale) as i32);
    let _ = m.set_position(PhysicalPosition::new(x, y));
    // Keep the bubble attached when Glitch is dragged around.
    let handle = app.clone();
    let win = m.clone();
    m.on_window_event(move |e| match e {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
            crate::hover::refresh_geometry(&handle, &win);
            if is_visible(&handle, BUBBLE) {
                place_bubble(&handle);
            }
        }
        // Alt+F4 on Glitch must not kill him (quit lives in the tray/settings).
        WindowEvent::CloseRequested { api, .. } => api.prevent_close(),
        _ => {}
    });
}

// ------------------------------------------------------------------ bubble

/// Sent to the bubble page so it can draw its tail on the correct side.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct BubbleLayout {
    /// true: the bubble is below Glitch and the tail points up.
    pub tail_up: bool,
    /// Tail position from the bubble's left edge, in CSS (logical) pixels.
    pub tail_x: f64,
}

fn create_bubble(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let bubble = WebviewWindowBuilder::new(app, BUBBLE, WebviewUrl::App("bubble.html".into()))
        .title("Glitch")
        .inner_size(BUBBLE_W, 120.0)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .accept_first_mouse(true)
        .visible(false)
        .build()?;
    let handle = app.clone();
    bubble.on_window_event(move |e| {
        if let WindowEvent::CloseRequested { api, .. } = e {
            // Alt+F4 hides it like Esc does (keeps state, updates the mascot).
            api.prevent_close();
            hide_bubble(&handle);
        }
    });
    Ok(bubble)
}

/// Position the bubble next to Glitch and tell the page where its tail goes.
pub fn place_bubble(app: &AppHandle) -> Option<BubbleLayout> {
    let bubble = app.get_webview_window(BUBBLE)?;
    let mascot = app.get_webview_window(MASCOT)?;
    let area = work_area(&mascot)?;
    // Point at Glitch's body if the page told us where it is in his window.
    let m = crate::hover::body_rect(app).or_else(|| window_rect(&mascot, (MASCOT_W, MASCOT_H)))?;
    let b = window_rect(&bubble, (BUBBLE_W, 120.0))?;
    let scale = bubble.scale_factor().unwrap_or(1.0);
    let p = layout::bubble_position(m, b.w, b.h, area, (BUBBLE_OVERLAP * scale) as i32);
    let _ = bubble.set_position(PhysicalPosition::new(p.x, p.y));
    let layout = BubbleLayout { tail_up: p.tail_up, tail_x: p.tail_x as f64 / scale };
    let _ = bubble.emit("bubble-layout", layout);
    Some(layout)
}

pub fn show_bubble(app: &AppHandle) {
    let bubble = match app.get_webview_window(BUBBLE) {
        Some(b) => b,
        None => match create_bubble(app) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("glitch: could not open the chat bubble: {e}");
                return;
            }
        },
    };
    place_bubble(app);
    let _ = bubble.show();
    // Some window managers ignore positions set before the first show.
    place_bubble(app);
    let _ = bubble.set_focus();
    let _ = bubble.emit("bubble-shown", ());
    emit_chat_visibility(app);
}

pub fn hide_bubble(app: &AppHandle) {
    if let Some(b) = app.get_webview_window(BUBBLE) {
        let _ = b.hide();
        let _ = b.emit("bubble-hidden", ());
    }
    emit_chat_visibility(app);
}

pub fn toggle_bubble(app: &AppHandle) {
    if is_visible(app, BUBBLE) {
        hide_bubble(app);
    } else {
        show_bubble(app);
    }
}

/// The bubble page measured its content: fit the window to it (logical px).
pub fn resize_bubble(app: &AppHandle, height: f64) -> Option<BubbleLayout> {
    let bubble = app.get_webview_window(BUBBLE)?;
    let h = height.clamp(BUBBLE_MIN_H, BUBBLE_MAX_H).round();
    let _ = bubble.set_size(LogicalSize::new(BUBBLE_W, h));
    place_bubble(app)
}

// ------------------------------------------------------------------- panel

fn create_panel(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let panel = WebviewWindowBuilder::new(app, PANEL, WebviewUrl::App("panel.html".into()))
        .title("Glitch")
        .inner_size(PANEL_W, PANEL_H)
        .min_inner_size(320.0, 420.0)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .build()?;
    let handle = app.clone();
    panel.on_window_event(move |e| {
        if let WindowEvent::CloseRequested { api, .. } = e {
            // Keep the page alive; just hide it.
            api.prevent_close();
            hide_panel(&handle);
        }
    });
    Ok(panel)
}

/// Open the panel on `view` ("setup" or "settings"), next to Glitch.
pub fn show_panel(app: &AppHandle, view: &str) {
    let panel = match app.get_webview_window(PANEL) {
        Some(p) => p,
        None => match create_panel(app) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("glitch: could not open the panel: {e}");
                return;
            }
        },
    };
    let position = app.get_webview_window(MASCOT).and_then(|mascot| {
        let area = work_area(&mascot)?;
        let m = window_rect(&mascot, (MASCOT_W, MASCOT_H))?;
        let p = window_rect(&panel, (PANEL_W, PANEL_H))?;
        let gap = (8.0 * mascot.scale_factor().unwrap_or(1.0)) as i32;
        let (x, y) = layout::panel_position(m, p.w, p.h, area, gap);
        Some(PhysicalPosition::new(x, y))
    });
    if let Some(pos) = position {
        let _ = panel.set_position(pos);
    }
    // A freshly created page may not be listening yet; it also asks for its
    // view on load (`panel_view` falls back to settings/setup by state).
    let _ = panel.emit("panel-view", view);
    let _ = panel.show();
    if let Some(pos) = position {
        let _ = panel.set_position(pos);
    }
    let _ = panel.set_focus();
    hide_bubble(app);
    emit_chat_visibility(app);
}

pub fn hide_panel(app: &AppHandle) {
    if let Some(p) = app.get_webview_window(PANEL) {
        let _ = p.hide();
    }
    emit_chat_visibility(app);
}
