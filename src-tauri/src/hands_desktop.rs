//! The native side of "Desktop control" (see `glitch_core::hands::control`):
//! the real mouse pointer, window positions, and the picture for the
//! numbered-box vision.
//!
//! * The pointer moves with `SendInput` in small eased steps so it looks like
//!   Glitch is moving the cursor himself. 400 ms BEFORE it sets off, a ring, a
//!   ghost cursor and a little paw appear at the target in a click-through
//!   overlay window ([`overlay`]), so the user sees what is about to happen.
//! * The user's own input (the low-level hook in `hands.rs`), Esc, the panic
//!   button and the tray's Stop are checked every few milliseconds during the
//!   move, the press and the hold: Glitch lets go of the mouse button and
//!   stops well within 100 ms.
//! * Before any click or drop, the window under the spot must still belong to
//!   the program that was approved (checked here as well as in the Driver).
//! * Windows are moved, resized, snapped, minimized and restored. Never
//!   closed: this file contains none of the calls that close or kill
//!   (checked by a test in `hands_guard.rs`).
//!
//! Debug builds with `GLITCH_HANDS_ONLY_PIDS`: only those processes' windows
//! exist for all of this, and "the whole screen" is refused, so the live
//! tests can never touch the owner's own apps.

#[cfg(not(target_os = "windows"))]
use glitch_core::hands::pointer::PointerOp;
#[cfg(not(target_os = "windows"))]
use glitch_core::hands::winops::{self, WinGeom, WindowOp};
#[cfg(not(target_os = "windows"))]
use glitch_core::hands::{HandsResult, MarkShot, WindowRef};

pub mod overlay;

#[cfg(target_os = "windows")]
pub use win::*;

#[cfg(not(target_os = "windows"))]
pub fn capture(_: Option<u64>) -> HandsResult<MarkShot> {
    Err("controlling the desktop only works on Windows so far".into())
}
#[cfg(not(target_os = "windows"))]
pub fn window_at(_: i32, _: i32) -> Option<WindowRef> {
    None
}
#[cfg(not(target_os = "windows"))]
pub fn pointer(_: Option<&tauri::AppHandle>, _: &PointerOp, _: &[u32]) -> HandsResult<String> {
    Err("controlling the desktop only works on Windows so far".into())
}
#[cfg(not(target_os = "windows"))]
pub fn cursor() -> Option<(i32, i32)> {
    None
}
#[cfg(not(target_os = "windows"))]
pub fn geometry(_: u64) -> Option<WinGeom> {
    None
}
#[cfg(not(target_os = "windows"))]
pub fn work_area(_: u64) -> winops::Edges {
    (0, 0, 1920, 1040)
}
#[cfg(not(target_os = "windows"))]
pub fn window_op(_: u64, _: WindowOp) -> HandsResult<WinGeom> {
    Err("controlling the desktop only works on Windows so far".into())
}

#[cfg(target_os = "windows")]
mod win {
    use std::time::{Duration, Instant};

    use glitch_core::hands::pointer::{self, ClickKind, PointerOp};
    use glitch_core::hands::winops::{self, Edges, Snap, WinGeom, WinState, WindowOp};
    use glitch_core::hands::{HandsResult, MarkShot, WindowRef};
    use tauri::AppHandle;
    use windows_sys::Win32::Foundation::{HWND, POINT, RECT};
    use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetCursorPos, GetWindow, GetWindowPlacement, GetWindowRect, IsIconic, SetWindowPos, ShowWindow,
        WindowFromPoint, GA_ROOT, GW_OWNER, SWP_NOACTIVATE, SWP_NOZORDER, SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE,
        SW_SHOWMAXIMIZED, SW_SHOWMINIMIZED, WINDOWPLACEMENT,
    };

    use super::overlay;
    use crate::hands::imp as base;

    type Point = (i32, i32);

    const USER_STOPPED: &str = "the user took over (Esc or their own mouse/keyboard), so I stopped";

    // ------------------------------------------------------------ windows

    fn frame_rect(h: HWND) -> Option<Edges> {
        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        let hr = unsafe {
            DwmGetWindowAttribute(
                h,
                DWMWA_EXTENDED_FRAME_BOUNDS as u32,
                (&mut r as *mut RECT).cast(),
                std::mem::size_of::<RECT>() as u32,
            )
        };
        if hr == 0 && r.right > r.left && r.bottom > r.top {
            return Some((r.left, r.top, r.right, r.bottom));
        }
        window_rect(h)
    }

    fn window_rect(h: HWND) -> Option<Edges> {
        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        (unsafe { GetWindowRect(h, &mut r) } != 0).then_some((r.left, r.top, r.right, r.bottom))
    }

    /// The invisible resize border Windows 10/11 puts around a window:
    /// (left, top, right, bottom) between the visible frame and the window
    /// rectangle `SetWindowPos` uses.
    fn inset(h: HWND) -> Edges {
        match (frame_rect(h), window_rect(h)) {
            (Some(f), Some(w)) => ((f.0 - w.0).max(0), (f.1 - w.1).max(0), (w.2 - f.2).max(0), (w.3 - f.3).max(0)),
            _ => (0, 0, 0, 0),
        }
    }

    fn monitor_work(h: HWND) -> Edges {
        unsafe {
            let m = MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST);
            let mut mi: MONITORINFO = std::mem::zeroed();
            mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
            if GetMonitorInfoW(m, &mut mi) == 0 {
                return (0, 0, 1920, 1040);
            }
            (mi.rcWork.left, mi.rcWork.top, mi.rcWork.right, mi.rcWork.bottom)
        }
    }

    fn monitor_full(h: HWND) -> Edges {
        unsafe {
            let m = MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST);
            let mut mi: MONITORINFO = std::mem::zeroed();
            mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
            GetMonitorInfoW(m, &mut mi);
            (mi.rcMonitor.left, mi.rcMonitor.top, mi.rcMonitor.right, mi.rcMonitor.bottom)
        }
    }

    pub fn work_area(id: u64) -> Edges {
        base::hwnd(id).map(monitor_work).unwrap_or((0, 0, 1920, 1040))
    }

    /// Where the window is, as the visible frame (what the user sees).
    pub fn geometry(id: u64) -> Option<WinGeom> {
        let h = base::hwnd(id).ok()?;
        let mut wp: WINDOWPLACEMENT = unsafe { std::mem::zeroed() };
        wp.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
        if unsafe { GetWindowPlacement(h, &mut wp) } == 0 {
            return None;
        }
        let state = if unsafe { IsIconic(h) } != 0 || wp.showCmd == SW_SHOWMINIMIZED as u32 {
            WinState::Minimized
        } else if wp.showCmd == SW_SHOWMAXIMIZED as u32 {
            WinState::Maximized
        } else {
            WinState::Normal
        };
        let rect = if state == WinState::Normal {
            frame_rect(h)?
        } else {
            // The place it goes back to: workspace coordinates -> screen,
            // minus the invisible border.
            let (work, full) = (monitor_work(h), monitor_full(h));
            let (ox, oy) = (work.0 - full.0, work.1 - full.1);
            let n = wp.rcNormalPosition;
            let i = inset(h);
            (n.left + ox + i.0, n.top + oy + i.1, n.right + ox - i.2, n.bottom + oy - i.3)
        };
        Some(WinGeom { rect, state })
    }

    /// The topmost listed window that has this point inside its frame (the
    /// list is front to back, Glitch's own windows and tool windows are not
    /// in it).
    pub fn window_at(x: i32, y: i32) -> Option<WindowRef> {
        base::windows().into_iter().find(|w| {
            if w.minimized {
                return false;
            }
            let Ok(h) = base::hwnd(w.id) else { return false };
            frame_rect(h).is_some_and(|f| x >= f.0 && y >= f.1 && x < f.2 && y < f.3)
        })
    }

    fn set_rect(h: HWND, visible: Edges) -> bool {
        let i = inset(h);
        let (l, t, r, b) = (visible.0 - i.0, visible.1 - i.1, visible.2 + i.2, visible.3 + i.3);
        unsafe { SetWindowPos(h, std::ptr::null_mut(), l, t, r - l, b - t, SWP_NOZORDER | SWP_NOACTIVATE) != 0 }
    }

    fn lerp(a: Edges, b: Edges, t: f64) -> Edges {
        let m = |x: i32, y: i32| (x as f64 + (y - x) as f64 * t).round() as i32;
        (m(a.0, b.0), m(a.1, b.1), m(a.2, b.2), m(a.3, b.3))
    }

    /// Slide a window to `to` in a dozen eased steps (so the user sees it
    /// move), stopping the moment the user takes over.
    fn glide_window(h: HWND, from: Edges, to: Edges) -> HandsResult<()> {
        const STEPS: u32 = 12;
        for i in 1..=STEPS {
            if base::interrupted() {
                return Err(USER_STOPPED.into());
            }
            let t = pointer::ease(f64::from(i) / f64::from(STEPS));
            set_rect(h, lerp(from, to, t));
            std::thread::sleep(Duration::from_millis(16));
        }
        set_rect(h, to);
        Ok(())
    }

    pub fn window_op(id: u64, op: WindowOp) -> HandsResult<WinGeom> {
        let h = base::hwnd(id)?;
        base::ready_to_act()?;
        if base::elevated(id) {
            return Err("that window runs as administrator, and Glitch never touches those".into());
        }
        let Some(before) = geometry(id) else { return Err("can't tell where that window is".into()) };
        let work = monitor_work(h);
        // Moving or resizing starts from the normal (not maximized or minimized) window.
        let normal = |h: HWND| -> HandsResult<Edges> {
            if before.state != WinState::Normal {
                unsafe { ShowWindow(h, SW_RESTORE) };
                std::thread::sleep(Duration::from_millis(180));
            }
            frame_rect(h).ok_or_else(|| "can't tell where that window is".to_string())
        };
        match op {
            WindowOp::Move { x, y } => {
                let cur = normal(h)?;
                glide_window(h, cur, winops::moved(cur, x, y, work))?;
            }
            WindowOp::Resize { w, h: hh } => {
                let cur = normal(h)?;
                glide_window(h, cur, winops::resized(cur, w, hh, work))?;
            }
            WindowOp::Snap(Snap::Maximize) => unsafe {
                ShowWindow(h, SW_MAXIMIZE);
            },
            WindowOp::Snap(Snap::Restore) | WindowOp::Restore => unsafe {
                ShowWindow(h, SW_RESTORE);
            },
            WindowOp::Snap(s) => {
                let cur = normal(h)?;
                if let Some(to) = winops::snap_rect(work, s) {
                    glide_window(h, cur, to)?;
                }
            }
            WindowOp::Minimize => unsafe {
                ShowWindow(h, SW_MINIMIZE);
            },
            WindowOp::Set(g) => match g.state {
                WinState::Minimized => unsafe {
                    ShowWindow(h, SW_MINIMIZE);
                },
                WinState::Normal | WinState::Maximized => {
                    let cur = normal(h)?;
                    glide_window(h, cur, g.rect)?;
                    if g.state == WinState::Maximized {
                        unsafe { ShowWindow(h, SW_MAXIMIZE) };
                    }
                }
            },
        }
        std::thread::sleep(Duration::from_millis(120));
        geometry(id).ok_or_else(|| "the window vanished".into())
    }

    // ------------------------------------------------------------ the picture

    /// The window (or the screen under the mouse) as a picture for the
    /// numbered boxes, with Glitch's own windows (the ring, the banner) left
    /// out of it and password fields covered. In RAM only.
    pub fn capture(id: Option<u64>) -> HandsResult<MarkShot> {
        base::ready_to_act()?;
        if id.is_none() && base::only_pids().is_some() {
            return Err("looking at the whole screen isn't available in this test run".into());
        }
        let hwnd = match id {
            Some(id) => Some(base::hwnd(id)? as usize),
            None => None,
        };
        let (capture, origin) = crate::desktop::capture_window(hwnd)?;
        Ok(MarkShot { capture, origin })
    }

    // ------------------------------------------------------------ the pointer

    pub fn cursor() -> Option<Point> {
        let mut p = POINT { x: 0, y: 0 };
        (unsafe { GetCursorPos(&mut p) } != 0).then_some((p.x, p.y))
    }

    /// Sleep `total`, checking for the user's own input every few ms.
    fn pause(total: Duration) -> HandsResult<()> {
        let end = Instant::now() + total;
        loop {
            if base::interrupted() {
                return Err(USER_STOPPED.into());
            }
            let left = end.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Ok(());
            }
            std::thread::sleep(left.min(Duration::from_millis(8)));
        }
    }

    fn pid_of_root_at(p: Point) -> Option<(HWND, u32)> {
        let h = unsafe { WindowFromPoint(POINT { x: p.0, y: p.1 }) };
        if h.is_null() {
            return None;
        }
        let root = unsafe { GetAncestor(h, GA_ROOT) };
        let root = if root.is_null() { h } else { root };
        Some((root, base::pid_of(root)))
    }

    /// What is under the spot must be the program that was approved (or a
    /// pop-up / dialog / menu it owns), and never one of Glitch's windows
    /// or a program the test run isn't scoped to.
    fn check_spot(p: Point, expect: Option<u32>) -> HandsResult<()> {
        let own = std::process::id();
        let Some((mut root, mut pid)) = pid_of_root_at(p) else {
            return Err("nothing is at that spot".into());
        };
        // Glitch's own click-through windows (the ring) are not in the way.
        if pid == own {
            let hidden = overlay::hide_for_hit_test();
            let again = pid_of_root_at(p);
            overlay::restore_after_hit_test(hidden);
            match again {
                Some((r, q)) if q != own => {
                    root = r;
                    pid = q;
                }
                _ => return Err("that spot is one of Glitch's own windows".into()),
            }
        }
        if let Some(only) = base::only_pids() {
            let owner = unsafe { GetWindow(root, GW_OWNER) };
            let owner_pid = if owner.is_null() { 0 } else { base::pid_of(owner) };
            if !only.contains(&pid) && !only.contains(&owner_pid) {
                return Err("not allowed in this test run".into());
            }
        }
        if let Some(expect) = expect.filter(|e| *e != 0) {
            let owner = unsafe { GetWindow(root, GW_OWNER) };
            let owner_pid = if owner.is_null() { 0 } else { base::pid_of(owner) };
            if pid != expect && owner_pid != expect {
                return Err("another program covers that spot, so I didn't click".into());
            }
        }
        let id = root as usize as u64;
        if base::hwnd(id).is_ok() && base::elevated(id) {
            return Err("that window runs as administrator, and Glitch never touches those".into());
        }
        Ok(())
    }

    /// Moves to the spot in eased steps, then makes sure it got there.
    fn glide_to(to: Point) -> HandsResult<()> {
        let from = cursor().unwrap_or(to);
        let path = pointer::path(from, to);
        let t0 = Instant::now();
        let mut sent = 0usize;
        loop {
            if base::interrupted() {
                return Err(USER_STOPPED.into());
            }
            let i = ((t0.elapsed().as_millis() as u64 / pointer::STEP_MS) as usize).min(path.len() - 1);
            if i >= sent {
                base::send(&[base::move_to(path[i].0, path[i].1)]);
                sent = i + 1;
            }
            if i == path.len() - 1 {
                break;
            }
            std::thread::sleep(Duration::from_millis(3));
        }
        // Verify and retry: a busy system can swallow a move.
        for _ in 0..2 {
            match cursor() {
                Some(c) if (c.0 - to.0).abs() <= 3 && (c.1 - to.1).abs() <= 3 => return Ok(()),
                _ => {
                    base::send(&[base::move_to(to.0, to.1)]);
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        }
        match cursor() {
            Some(c) if (c.0 - to.0).abs() <= 3 && (c.1 - to.1).abs() <= 3 => Ok(()),
            _ => Err("the pointer wouldn't go there".into()),
        }
    }

    /// Lets go of the left mouse button when dropped, whatever happens in
    /// between (an interruption, an error): a drag can never get stuck.
    struct Held(bool);
    impl Held {
        fn press() -> Held {
            base::send(&[base::mouse_input(MOUSEEVENTF_LEFTDOWN, 0, 0, 0)]);
            Held(true)
        }
        fn release(&mut self) {
            if self.0 {
                base::send(&[base::mouse_input(MOUSEEVENTF_LEFTUP, 0, 0, 0)]);
                self.0 = false;
            }
        }
    }
    impl Drop for Held {
        fn drop(&mut self) {
            self.release();
        }
    }

    fn click(kind: ClickKind) -> HandsResult<()> {
        let (down, up) = match kind {
            ClickKind::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
            _ => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        };
        let once = || -> HandsResult<()> {
            base::send(&[base::mouse_input(down, 0, 0, 0)]);
            std::thread::sleep(Duration::from_millis(35));
            base::send(&[base::mouse_input(up, 0, 0, 0)]);
            Ok(())
        };
        once()?;
        if kind == ClickKind::Double {
            pause(Duration::from_millis(70))?;
            once()?;
        }
        Ok(())
    }

    pub fn pointer(app: Option<&AppHandle>, op: &PointerOp, pids: &[u32]) -> HandsResult<String> {
        base::ready_to_act()?;
        if base::interrupted() {
            return Err(USER_STOPPED.into());
        }
        let spots = op.spots();
        for (i, s) in spots.iter().enumerate() {
            check_spot(*s, pids.get(i).copied())?;
        }
        let result = run_pointer(app, op, &spots, pids);
        if let Some(app) = app {
            overlay::finish(app);
        }
        result
    }

    fn run_pointer(app: Option<&AppHandle>, op: &PointerOp, spots: &[Point], pids: &[u32]) -> HandsResult<String> {
        let show = |p: Point, kind: &str| {
            if let Some(app) = app {
                overlay::ping(app, p, kind);
            }
        };
        let kind = match op {
            PointerOp::Move { .. } => "move",
            PointerOp::Click { kind: ClickKind::Left, .. } => "click",
            PointerOp::Click { kind: ClickKind::Right, .. } => "right",
            PointerOp::Click { kind: ClickKind::Double, .. } => "double",
            PointerOp::Drag { .. } => "pickup",
            PointerOp::Scroll { notches, .. } if *notches < 0 => "scroll_down",
            PointerOp::Scroll { .. } => "scroll_up",
        };
        // The ring, the ghost cursor and the paw appear first, so the user
        // sees what is about to happen.
        show(spots[0], kind);
        pause(Duration::from_millis(pointer::PREVIEW_MS))?;
        glide_to(spots[0])?;
        match *op {
            PointerOp::Move { .. } => Ok("moved the pointer".into()),
            PointerOp::Click { kind, .. } => {
                check_spot(spots[0], pids.first().copied())?;
                if let Some(app) = app {
                    overlay::pop(app);
                }
                click(kind)?;
                pause(Duration::from_millis(60))?;
                Ok(match kind {
                    ClickKind::Left => "real mouse click",
                    ClickKind::Right => "real right click",
                    ClickKind::Double => "real double click",
                }
                .into())
            }
            PointerOp::Scroll { notches, .. } => {
                let step = if notches < 0 { -120 } else { 120 };
                for _ in 0..notches.unsigned_abs() {
                    base::send(&[base::mouse_input(MOUSEEVENTF_WHEEL, 0, 0, step)]);
                    pause(Duration::from_millis(55))?;
                }
                Ok("real mouse wheel".into())
            }
            PointerOp::Drag { from, to } => {
                // Show where it will be dropped, then pick up and carry.
                show(to, "drop");
                pause(Duration::from_millis(250))?;
                check_spot(from, pids.first().copied())?;
                let mut held = Held::press();
                pause(Duration::from_millis(140))?;
                // A first small move starts the drag in apps that wait for it.
                base::send(&[base::move_to(from.0 + 6, from.1 + 4)]);
                pause(Duration::from_millis(40))?;
                for p in pointer::drag_path(from, to) {
                    if base::interrupted() {
                        held.release();
                        return Err(USER_STOPPED.into());
                    }
                    base::send(&[base::move_to(p.0, p.1)]);
                    std::thread::sleep(Duration::from_millis(pointer::STEP_MS));
                }
                check_spot(to, pids.get(1).copied().or_else(|| pids.first().copied()))?;
                pause(Duration::from_millis(160))?;
                held.release();
                if let Some(app) = app {
                    overlay::pop(app);
                }
                pause(Duration::from_millis(80))?;
                Ok("real drag and drop".into())
            }
        }
    }
}
