//! Click-through for the mascot window: only Glitch's body catches the mouse.
//!
//! The 160x160 mascot window is mostly transparent. The page tells us where
//! the body is (`set_hitbox`); a tiny background thread checks the cursor
//! (10 times a second near Glitch, ~3 times a second when the cursor is far
//! away) and makes the window ignore the mouse whenever the cursor isn't over
//! the body, so clicks reach whatever is underneath. It also tells the page
//! when the cursor arrives/leaves ("mascot-hover").
//!
//! The window's position/size/scale are cached from window events, so each
//! tick costs a single cursor query.

use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use crate::windows::MASCOT;

/// Window-local CSS px.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct LocalRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Mascot window geometry in physical px + its scale factor.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Geometry {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub scale: f64,
}

#[derive(Default)]
pub struct Hitbox {
    /// `None` = the whole window catches the mouse (e.g. while dragging).
    pub body: Mutex<Option<LocalRect>>,
    pub geometry: Mutex<Option<Geometry>>,
}

const NEAR_POLL: Duration = Duration::from_millis(100);
const FAR_POLL: Duration = Duration::from_millis(300);
/// Grace margin around the body so the edges aren't fiddly to grab.
const MARGIN_CSS: f64 = 4.0;

/// Is the cursor over the clickable part of the mascot window?
/// Everything in one coordinate space; `scale` converts CSS px into it.
pub fn hit(cursor: (f64, f64), window: (f64, f64, f64, f64), body: Option<LocalRect>, scale: f64) -> bool {
    let (wx, wy, ww, wh) = window;
    let (x, y, w, h) = match body {
        None => (wx, wy, ww, wh),
        Some(r) => {
            let m = MARGIN_CSS * scale;
            (wx + r.x * scale - m, wy + r.y * scale - m, r.w * scale + 2.0 * m, r.h * scale + 2.0 * m)
        }
    };
    cursor.0 >= x && cursor.0 < x + w && cursor.1 >= y && cursor.1 < y + h
}

/// Re-read the mascot window's geometry (call from its window events).
pub fn refresh_geometry(app: &AppHandle, win: &WebviewWindow) {
    if let (Ok(p), Ok(s), Ok(scale)) = (win.outer_position(), win.outer_size(), win.scale_factor()) {
        *app.state::<Hitbox>().geometry.lock().unwrap() =
            Some(Geometry { x: p.x as f64, y: p.y as f64, w: s.width as f64, h: s.height as f64, scale });
    }
}

pub fn start(app: AppHandle) {
    thread::spawn(move || {
        let mut last: Option<bool> = None;
        // macOS reports the cursor scaled by the PRIMARY screen's factor but
        // window positions by the window's own screen; compare in points.
        let primary_scale = if cfg!(target_os = "macos") {
            app.primary_monitor().ok().flatten().map_or(1.0, |m| m.scale_factor())
        } else {
            1.0
        };
        let mut wait = NEAR_POLL;
        loop {
            thread::sleep(wait);
            let state = app.state::<Hitbox>();
            let geo = *state.geometry.lock().unwrap();
            let Some(g) = geo else {
                if let Some(win) = app.get_webview_window(MASCOT) {
                    refresh_geometry(&app, &win);
                }
                continue;
            };
            let Ok(cursor) = app.cursor_position() else { continue };
            let body = *state.body.lock().unwrap();
            let (cursor, window, scale) = if cfg!(target_os = "macos") {
                (
                    (cursor.x / primary_scale, cursor.y / primary_scale),
                    (g.x / g.scale, g.y / g.scale, g.w / g.scale, g.h / g.scale),
                    1.0,
                )
            } else {
                ((cursor.x, cursor.y), (g.x, g.y, g.w, g.h), g.scale)
            };
            let over = hit(cursor, window, body, scale);
            // Poll faster only while the cursor is near Glitch.
            let (cx, cy) = (window.0 + window.2 / 2.0, window.1 + window.3 / 2.0);
            let near = (cursor.0 - cx).abs() < 400.0 * scale && (cursor.1 - cy).abs() < 400.0 * scale;
            wait = if near { NEAR_POLL } else { FAR_POLL };
            if last != Some(over) {
                let Some(win) = app.get_webview_window(MASCOT) else { continue };
                // Not before the window is on screen (GTK has no native
                // window yet and tao would panic on Linux).
                if !win.is_visible().unwrap_or(false) {
                    continue;
                }
                // Ignoring the mouse = clicks go through to the desktop.
                let _ = win.set_ignore_cursor_events(!over);
                let _ = win.emit("mascot-hover", over);
                last = Some(over);
            }
        }
    });
}

/// Body rect in physical screen px, for placing the chat bubble.
pub fn body_rect(app: &AppHandle) -> Option<crate::layout::Rect> {
    let state = app.state::<Hitbox>();
    let body = (*state.body.lock().unwrap())?;
    let g = (*state.geometry.lock().unwrap())?;
    Some(crate::layout::Rect {
        x: (g.x + body.x * g.scale) as i32,
        y: (g.y + body.y * g.scale) as i32,
        w: (body.w * g.scale) as i32,
        h: (body.h * g.scale) as i32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_body_catches_the_mouse() {
        let window = (1000.0, 500.0, 320.0, 320.0); // 160 CSS px at 2x
        let body = Some(LocalRect { x: 20.0, y: 70.0, w: 120.0, h: 90.0 });
        assert!(hit((1000.0 + 80.0, 500.0 + 200.0), window, body, 2.0)); // middle of the body
        assert!(!hit((1000.0 + 10.0, 500.0 + 10.0), window, body, 2.0)); // empty top-left corner
        assert!(hit((1000.0 + 35.0, 500.0 + 135.0), window, body, 2.0)); // inside the 4 px margin
        assert!(hit((1000.0 + 10.0, 500.0 + 10.0), window, None, 2.0)); // whole window while dragging
        assert!(!hit((900.0, 500.0), window, None, 2.0));
    }

    #[test]
    fn mixed_scale_macs_compare_in_points() {
        // Primary screen 2x, Glitch on an external 1x screen at x=2000 pt.
        let (primary, own) = (2.0, 1.0);
        let cursor_physical = (2060.0 * primary, 100.0 * primary); // what the OS reports
        let window_physical = (2000.0 * own, 40.0 * own, 160.0 * own, 160.0 * own);
        let body = Some(LocalRect { x: 20.0, y: 40.0, w: 120.0, h: 90.0 });
        let cursor = (cursor_physical.0 / primary, cursor_physical.1 / primary);
        let window = (window_physical.0 / own, window_physical.1 / own, 160.0, 160.0);
        assert!(hit(cursor, window, body, 1.0));
        // Mixing the spaces (the old bug) misses completely.
        assert!(!hit(cursor_physical, window_physical, body, own));
    }
}
