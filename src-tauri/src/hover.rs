//! Click-through for the mascot window: only Glitch's body catches the mouse.
//!
//! The 160x160 mascot window is mostly transparent. The page tells us where
//! the body is (`set_hitbox`); a tiny background thread checks the cursor 10
//! times a second and makes the window ignore the mouse whenever the cursor
//! isn't over the body, so clicks reach whatever is underneath. It also tells
//! the page when the cursor arrives/leaves ("mascot-hover").

use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::windows::MASCOT;

/// Window-local CSS px.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct LocalRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// `None` = the whole window catches the mouse (e.g. while dragging).
#[derive(Default)]
pub struct Hitbox(pub Mutex<Option<LocalRect>>);

const POLL: Duration = Duration::from_millis(100);
/// Grace margin around the body so the edges aren't fiddly to grab.
const MARGIN_CSS: f64 = 4.0;

/// Is the cursor over the clickable part of the mascot window?
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

pub fn start(app: AppHandle) {
    thread::spawn(move || {
        let mut last: Option<bool> = None;
        loop {
            thread::sleep(POLL);
            let Some(win) = app.get_webview_window(MASCOT) else { continue };
            if !win.is_visible().unwrap_or(false) {
                continue;
            }
            let (Ok(cursor), Ok(pos), Ok(size), Ok(scale)) =
                (app.cursor_position(), win.outer_position(), win.outer_size(), win.scale_factor())
            else {
                continue;
            };
            let body = *app.state::<Hitbox>().0.lock().unwrap();
            let window = (pos.x as f64, pos.y as f64, size.width as f64, size.height as f64);
            let over = hit((cursor.x, cursor.y), window, body, scale);
            if last != Some(over) {
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
    let win = app.get_webview_window(MASCOT)?;
    let body = (*app.state::<Hitbox>().0.lock().unwrap())?;
    let pos = win.outer_position().ok()?;
    let s = win.scale_factor().ok()?;
    Some(crate::layout::Rect {
        x: pos.x + (body.x * s) as i32,
        y: pos.y + (body.y * s) as i32,
        w: (body.w * s) as i32,
        h: (body.h * s) as i32,
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
}
