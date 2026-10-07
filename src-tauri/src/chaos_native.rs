//! The OS side of chaos mode: small safe wrappers around the few calls
//! Glitch needs to tease the user. All decisions (which window, how far,
//! when) are pure functions in `glitch_core::chaos`; this file only reads
//! state and moves things.
//!
//! What is deliberately NOT here: closing, resizing, minimising, focusing or
//! sending input to other apps, or touching files. The only write calls are
//! `SetWindowPos` with `SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE` and
//! `SetCursorPos`.
//!
//! Windows only for now. macOS / Linux: everything reports "not available"
//! (no candidates, no cursor control), so chaos mode there is limited to
//! Glitch's own windows (footprints, notes, peeking, chasing the cursor).

use glitch_core::chaos::Candidate;

/// Another app's window plus the offset of its real rect (incl. the
/// invisible resize border) from its visible frame.
#[derive(Debug, Clone, Copy)]
pub struct Target {
    pub cand: Candidate,
    pub border: (i32, i32),
}

pub use imp::*;

#[cfg(target_os = "windows")]
mod imp {
    use super::Target;
    use glitch_core::chaos::Candidate;
    use glitch_core::world::ScreenRect;
    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, POINT, RECT};
    use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
    use windows_sys::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows_sys::Win32::UI::Shell::{
        SHQueryUserNotificationState, QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetCursorPos, GetForegroundWindow, GetWindowLongW, GetWindowRect,
        GetWindowTextLengthW, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, IsZoomed, SetCursorPos,
        SetWindowPos, ShowWindow, GWL_EXSTYLE, SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOSIZE, SWP_NOZORDER, WS_EX_NOACTIVATE,
        WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
    };

    const SKIP_CLASSES: &[&str] = &[
        "Progman",
        "WorkerW",
        "Shell_TrayWnd",
        "Shell_SecondaryTrayWnd",
        "Windows.UI.Core.CoreWindow",
        "XamlExplorerHostIslandWindow",
        "TaskManagerWindow",
        "#32770", // system dialogs (UAC-ish prompts, message boxes): leave them alone
    ];

    /// Milliseconds since the last keyboard/mouse input anywhere.
    pub fn idle_ms() -> u32 {
        let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        // SAFETY: plain out-struct with its size set.
        if unsafe { GetLastInputInfo(&mut info) } == 0 {
            return 0; // unknown: assume the user is active
        }
        unsafe { GetTickCount() }.wrapping_sub(info.dwTime)
    }

    /// Fullscreen game / video / presentation, or "do not disturb".
    pub fn user_busy() -> bool {
        let mut state = 0;
        // SAFETY: out-parameter.
        let hr = unsafe { SHQueryUserNotificationState(&mut state) };
        if hr == 0 && matches!(state, QUNS_BUSY | QUNS_RUNNING_D3D_FULL_SCREEN | QUNS_PRESENTATION_MODE) {
            return true;
        }
        let fg = unsafe { GetForegroundWindow() };
        !fg.is_null() && is_fullscreen(fg) && !is_own(fg)
    }

    fn is_own(hwnd: HWND) -> bool {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        pid == unsafe { GetCurrentProcessId() }
    }

    fn class_name(hwnd: HWND) -> String {
        let mut buf = [0u16; 64];
        let n = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    fn rect_of(hwnd: HWND) -> Option<RECT> {
        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        (unsafe { GetWindowRect(hwnd, &mut r) } != 0).then_some(r)
    }

    fn frame_of(hwnd: HWND) -> Option<RECT> {
        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        let hr = unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS as u32,
                (&mut r as *mut RECT).cast(),
                std::mem::size_of::<RECT>() as u32,
            )
        };
        if hr == 0 {
            Some(r)
        } else {
            rect_of(hwnd)
        }
    }

    fn cloaked(hwnd: HWND) -> bool {
        let mut c = 0u32;
        let hr = unsafe {
            DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED as u32, (&mut c as *mut u32).cast(), std::mem::size_of::<u32>() as u32)
        };
        hr == 0 && c != 0
    }

    fn is_fullscreen(hwnd: HWND) -> bool {
        let Some(r) = rect_of(hwnd) else { return false };
        let mon = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
        let mut mi: MONITORINFO = unsafe { std::mem::zeroed() };
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if unsafe { GetMonitorInfoW(mon, &mut mi) } == 0 {
            return false;
        }
        let m = mi.rcMonitor;
        r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom
    }

    fn token_elevated(process: HANDLE) -> Option<bool> {
        let mut token: HANDLE = std::ptr::null_mut();
        if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
            return None;
        }
        let mut e = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut len = 0u32;
        let ok = unsafe {
            GetTokenInformation(
                token,
                TokenElevation,
                (&mut e as *mut TOKEN_ELEVATION).cast(),
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut len,
            )
        };
        unsafe { CloseHandle(token) };
        (ok != 0).then_some(e.TokenIsElevated != 0)
    }

    /// Runs with more rights than Glitch (or we can't tell): hands off.
    fn elevated(hwnd: HWND) -> bool {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        let own = token_elevated(unsafe { GetCurrentProcess() }).unwrap_or(false);
        let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if h.is_null() {
            return true;
        }
        let theirs = token_elevated(h);
        unsafe { CloseHandle(h) };
        match theirs {
            Some(t) => t && !own,
            None => true,
        }
    }

    fn describe(hwnd: HWND, fg: HWND) -> Option<Target> {
        if unsafe { IsWindow(hwnd) } == 0
            || unsafe { IsWindowVisible(hwnd) } == 0
            || unsafe { IsIconic(hwnd) } != 0
            || unsafe { GetWindowTextLengthW(hwnd) } == 0
            || is_own(hwnd)
        {
            return None;
        }
        let ex = unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) } as u32;
        let system = ex & (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST) != 0
            || cloaked(hwnd)
            || SKIP_CLASSES.contains(&class_name(hwnd).as_str());
        let frame = frame_of(hwnd)?;
        let real = rect_of(hwnd)?;
        let cand = Candidate {
            id: hwnd as usize as u64,
            frame: ScreenRect {
                x: frame.left,
                y: frame.top,
                w: frame.right - frame.left,
                h: frame.bottom - frame.top,
            },
            foreground: hwnd == fg,
            maximized: unsafe { IsZoomed(hwnd) } != 0,
            elevated: !system && elevated(hwnd),
            fullscreen: is_fullscreen(hwnd),
            system,
        };
        Some(Target { cand, border: (frame.left - real.left, frame.top - real.top) })
    }

    struct Ctx {
        fg: HWND,
        out: Vec<Target>,
    }

    unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam as *mut Ctx);
        if let Some(t) = describe(hwnd, ctx.fg) {
            ctx.out.push(t);
        }
        1
    }

    /// Visible top-level windows of other apps, front to back.
    pub fn candidates() -> Vec<Target> {
        let mut ctx = Ctx { fg: unsafe { GetForegroundWindow() }, out: Vec::new() };
        // SAFETY: ctx outlives the synchronous enumeration.
        unsafe { EnumWindows(Some(visit), &mut ctx as *mut Ctx as LPARAM) };
        ctx.out
    }

    /// Re-check one window right now (it may have closed, maximised, got focus...).
    pub fn target(id: u64) -> Option<Target> {
        describe(id as usize as HWND, unsafe { GetForegroundWindow() })
    }

    /// Move (never resize, raise or focus) a window. `x, y`: its real top-left.
    pub fn move_window(id: u64, x: i32, y: i32) -> bool {
        let hwnd = id as usize as HWND;
        if unsafe { IsWindow(hwnd) } == 0 || is_own(hwnd) {
            return false;
        }
        let flags = SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER;
        unsafe { SetWindowPos(hwnd, std::ptr::null_mut(), x, y, 0, 0, flags) != 0 }
    }

    pub fn cursor() -> Option<(i32, i32)> {
        let mut p = POINT { x: 0, y: 0 };
        (unsafe { GetCursorPos(&mut p) } != 0).then_some((p.x, p.y))
    }

    pub fn set_cursor(x: i32, y: i32) -> bool {
        unsafe { SetCursorPos(x, y) != 0 }
    }

    /// Show one of Glitch's own windows without activating it.
    pub fn show_no_activate(id: u64) -> bool {
        let hwnd = id as usize as HWND;
        if unsafe { IsWindow(hwnd) } == 0 || !is_own(hwnd) {
            return false;
        }
        unsafe { ShowWindow(hwnd, SW_SHOWNOACTIVATE) };
        true
    }

    pub const AVAILABLE: bool = true;
}

#[cfg(not(target_os = "windows"))]
mod imp {
    //! macOS (and Linux): not implemented yet. Moving other apps' windows on
    //! macOS needs the Accessibility permission (AXUIElement), which Glitch
    //! doesn't ask for; so other windows and the cursor are never touched.
    use super::Target;

    pub fn idle_ms() -> u32 {
        0
    }
    pub fn user_busy() -> bool {
        false
    }
    pub fn candidates() -> Vec<Target> {
        Vec::new()
    }
    pub fn target(_id: u64) -> Option<Target> {
        None
    }
    pub fn move_window(_id: u64, _x: i32, _y: i32) -> bool {
        false
    }
    pub fn cursor() -> Option<(i32, i32)> {
        None
    }
    pub fn set_cursor(_x: i32, _y: i32) -> bool {
        false
    }
    pub const AVAILABLE: bool = false;
}
