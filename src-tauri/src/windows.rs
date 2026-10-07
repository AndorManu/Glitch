//! The mascot window (declared in tauri.conf.json) and the chat panel window
//! (created lazily the first time it's needed, then hidden instead of closed).

use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

use crate::layout::{self, Rect};

pub const MASCOT: &str = "mascot";
pub const PANEL: &str = "panel";
/// Must match the mascot size in tauri.conf.json.
const MASCOT_SIZE: f64 = 96.0;
const PANEL_W: f64 = 360.0;
const PANEL_H: f64 = 540.0;

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

/// Put Glitch in the bottom-right corner on start-up. The page shows the
/// window itself once its first frame is drawn (avoids a blank flash).
pub fn place_mascot(app: &AppHandle) {
    let Some(m) = app.get_webview_window(MASCOT) else { return };
    let (Some(area), Ok(scale)) = (work_area(&m), m.scale_factor()) else { return };
    // Not `outer_size()`: a window that hasn't been shown yet may report 0x0.
    let size = (MASCOT_SIZE * scale).round() as i32;
    let (x, y) = layout::mascot_home(area, size, (24.0 * scale) as i32);
    let _ = m.set_position(PhysicalPosition::new(x, y));
}

fn create_panel(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let panel = WebviewWindowBuilder::new(app, PANEL, WebviewUrl::App("panel.html".into()))
        .title("Glitch")
        .inner_size(PANEL_W, PANEL_H)
        .min_inner_size(300.0, 380.0)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .build()?;
    let handle = app.clone();
    panel.on_window_event(move |e| {
        if let WindowEvent::CloseRequested { api, .. } = e {
            // Keep the page (and chat) alive; just hide it.
            api.prevent_close();
            hide_panel(&handle);
        }
    });
    Ok(panel)
}

pub fn show_panel(app: &AppHandle) {
    let panel = match app.get_webview_window(PANEL) {
        Some(p) => p,
        None => match create_panel(app) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("glitch: could not open the chat panel: {e}");
                return;
            }
        },
    };
    let position = app.get_webview_window(MASCOT).and_then(|mascot| {
        let area = work_area(&mascot)?;
        let m = window_rect(&mascot, (MASCOT_SIZE, MASCOT_SIZE))?;
        let p = window_rect(&panel, (PANEL_W, PANEL_H))?;
        let gap = (8.0 * mascot.scale_factor().unwrap_or(1.0)) as i32;
        let (x, y) = layout::panel_position(m, p.w, p.h, area, gap);
        Some(PhysicalPosition::new(x, y))
    });
    if let Some(pos) = position {
        let _ = panel.set_position(pos);
    }
    let _ = panel.show();
    // Some window managers ignore positions set before the first show.
    if let Some(pos) = position {
        let _ = panel.set_position(pos);
    }
    let _ = panel.set_focus();
    let _ = app.emit("panel-visibility", true);
}

pub fn hide_panel(app: &AppHandle) {
    if let Some(p) = app.get_webview_window(PANEL) {
        let _ = p.hide();
    }
    let _ = app.emit("panel-visibility", false);
}

pub fn toggle_panel(app: &AppHandle) {
    let visible = app.get_webview_window(PANEL).and_then(|p| p.is_visible().ok()).unwrap_or(false);
    if visible {
        hide_panel(app);
    } else {
        show_panel(app);
    }
}
