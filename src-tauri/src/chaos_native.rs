//! The OS side of chaos mode: small safe wrappers around the few calls
//! Glitch needs to tease the user. All decisions (which window, how far,
//! when) are pure functions in `glitch_core::chaos`; this file only reads
//! state and moves things.
//!
//! What is deliberately NOT here: closing, resizing, focusing or sending input
//! to other apps, or touching files. The only write calls are `SetWindowPos`
//! with `SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE`, `SetCursorPos`, and the
//! one audited minimise/restore function `yoink_show` (chaos mode 2's
//! "yoink": `SW_SHOWMINNOACTIVE` / `SW_SHOWNOACTIVATE`, nothing else).
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

/// What the audited function in `imp` does to a window.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum YoinkCmd {
    Minimize,
    Restore,
}

pub use imp::*;

#[cfg(target_os = "windows")]
mod imp {
    use super::{Target, YoinkCmd};
    use glitch_core::chaos::Candidate;
    use glitch_core::world::ScreenRect;
    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, POINT, RECT};
    use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows_sys::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, GetLastInputInfo, LASTINPUTINFO, VK_ESCAPE, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON, VK_XBUTTON1, VK_XBUTTON2,
    };
    use windows_sys::Win32::UI::Shell::{
        SHQueryUserNotificationState, QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetCursorPos, GetForegroundWindow, GetWindowLongW, GetWindowRect,
        GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, IsZoomed,
        SetCursorPos, SetWindowPos, ShowWindow, GWL_EXSTYLE, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOSIZE,
        SWP_NOZORDER, SW_SHOWMINNOACTIVE, SW_SHOWNOACTIVATE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
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

    fn window_title(hwnd: HWND) -> String {
        let n = unsafe { GetWindowTextLengthW(hwnd) }.clamp(0, 1024) as usize;
        let mut buf = vec![0u16; n + 1];
        let got = unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        String::from_utf16_lossy(&buf[..got.max(0) as usize])
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
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED as u32,
                (&mut c as *mut u32).cast(),
                std::mem::size_of::<u32>() as u32,
            )
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
            frame: ScreenRect { x: frame.left, y: frame.top, w: frame.right - frame.left, h: frame.bottom - frame.top },
            foreground: hwnd == fg,
            maximized: unsafe { IsZoomed(hwnd) } != 0,
            elevated: !system && elevated(hwnd),
            fullscreen: is_fullscreen(hwnd),
            system,
            // The title is only read to decide "hands off"; never stored or sent.
            unsaved: glitch_core::unsaved::title_unsaved(&window_title(hwnd)),
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

    /// Does this window's title say it holds unsaved work? (Glitch won't even stand on those.)
    pub fn looks_unsaved(id: u64) -> bool {
        let hwnd = id as usize as HWND;
        (unsafe { IsWindow(hwnd) } != 0) && glitch_core::unsaved::title_unsaved(&window_title(hwnd)).is_some()
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

    /// A window's visible frame, or None if it's gone, hidden, minimised or cloaked.
    pub fn visible_frame(id: u64) -> Option<ScreenRect> {
        let hwnd = id as usize as HWND;
        if unsafe { IsWindow(hwnd) } == 0
            || unsafe { IsWindowVisible(hwnd) } == 0
            || unsafe { IsIconic(hwnd) } != 0
            || cloaked(hwnd)
        {
            return None;
        }
        let f = frame_of(hwnd)?;
        Some(ScreenRect { x: f.left, y: f.top, w: f.right - f.left, h: f.bottom - f.top })
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

    // ---------------------------------------------------- chaos mode 2

    /// Any mouse button is down right now (reads the key state, sends nothing).
    pub fn button_down() -> bool {
        [VK_LBUTTON, VK_RBUTTON, VK_MBUTTON, VK_XBUTTON1, VK_XBUTTON2]
            .iter()
            .any(|vk| (unsafe { GetAsyncKeyState(*vk as i32) } as u16) & 0x8000 != 0)
    }

    /// Esc is held right now (reads the key state, sends nothing): it stops every chaos act.
    pub fn esc_down() -> bool {
        (unsafe { GetAsyncKeyState(VK_ESCAPE as i32) } as u16) & 0x8000 != 0
    }

    /// The window the user is working in.
    pub fn foreground_id() -> Option<u64> {
        let fg = unsafe { GetForegroundWindow() };
        (!fg.is_null()).then_some(fg as usize as u64)
    }

    fn pid_of(hwnd: HWND) -> u32 {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        pid
    }

    /// Lower-case executable name without `.exe` ("" if it can't be read).
    fn process_stem(pid: u32) -> String {
        let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if h.is_null() {
            return String::new();
        }
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        let ok = unsafe { QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len) };
        unsafe { CloseHandle(h) };
        if ok == 0 {
            return String::new();
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        let file = path.rsplit(['\\', '/']).next().unwrap_or("").to_lowercase();
        file.strip_suffix(".exe").unwrap_or(&file).to_string()
    }

    /// Everything the minimise prank needs to decide about one window.
    fn yoink_describe(t: Target) -> glitch_core::chaos2::YoinkWin {
        let hwnd = t.cand.id as usize as HWND;
        glitch_core::chaos2::YoinkWin {
            cand: t.cand,
            process: process_stem(pid_of(hwnd)),
            title: window_title(hwnd),
            class: class_name(hwnd),
            last_front_ms_ago: None,
        }
    }

    /// Visible windows of other apps, described for the minimise prank (titles and
    /// program names are only read to decide "hands off", never stored beyond the prank).
    pub fn yoink_candidates() -> Vec<glitch_core::chaos2::YoinkWin> {
        candidates().into_iter().map(yoink_describe).collect()
    }

    pub fn yoink_win(id: u64) -> Option<glitch_core::chaos2::YoinkWin> {
        target(id).map(yoink_describe)
    }

    /// The identity of a window: its process id and class (a recycled handle differs).
    pub fn identity(id: u64) -> Option<(u32, String)> {
        let hwnd = id as usize as HWND;
        (unsafe { IsWindow(hwnd) } != 0).then(|| (pid_of(hwnd), class_name(hwnd)))
    }

    /// Is the window minimised right now? (`None`: it is gone.)
    pub fn is_minimized(id: u64) -> Option<bool> {
        let hwnd = id as usize as HWND;
        (unsafe { IsWindow(hwnd) } != 0).then(|| unsafe { IsIconic(hwnd) } != 0)
    }

    /// Is the window maximised (or was, before it was minimised)?
    pub fn is_maximized(id: u64) -> bool {
        let hwnd = id as usize as HWND;
        unsafe { IsWindow(hwnd) } != 0 && unsafe { IsZoomed(hwnd) } != 0
    }

    /// Titles and program names of every visible top-level window (for screen-share detection).
    pub fn visible_titles() -> Vec<String> {
        struct Acc(Vec<String>);
        unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let acc = &mut *(lparam as *mut Acc);
            if IsWindowVisible(hwnd) != 0 && !is_own(hwnd) {
                let t = window_title(hwnd);
                if !t.is_empty() {
                    acc.0.push(t);
                }
                let p = process_stem(pid_of(hwnd));
                if matches!(p.as_str(), "obs64" | "obs32" | "streamlabs") {
                    acc.0.push("OBS Studio".to_string());
                }
            }
            1
        }
        let mut acc = Acc(Vec::new());
        // SAFETY: acc outlives the synchronous enumeration.
        unsafe { EnumWindows(Some(collect), &mut acc as *mut Acc as LPARAM) };
        acc.0
    }

    // BEGIN AUDITED MINIMIZE/RESTORE
    /// The ONLY place chaos mode minimises or restores another app's window.
    /// Minimise: `SW_SHOWMINNOACTIVE` (the window goes to the taskbar and nothing
    /// is activated). Restore: `SW_SHOWNOACTIVATE` (back in its place, without
    /// taking the keyboard focus). Never Glitch's own windows, never anything
    /// the caller hasn't checked against the minimise book.
    pub fn yoink_show(id: u64, cmd: YoinkCmd) -> bool {
        let hwnd = id as usize as HWND;
        if unsafe { IsWindow(hwnd) } == 0 || is_own(hwnd) {
            return false;
        }
        let how = if cmd == YoinkCmd::Minimize { SW_SHOWMINNOACTIVE } else { SW_SHOWNOACTIVATE };
        unsafe { ShowWindow(hwnd, how) };
        true
    }
    // END AUDITED MINIMIZE/RESTORE

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
    pub fn looks_unsaved(_id: u64) -> bool {
        false
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
    pub fn button_down() -> bool {
        false
    }
    pub fn esc_down() -> bool {
        false
    }
    pub fn foreground_id() -> Option<u64> {
        None
    }
    pub fn yoink_candidates() -> Vec<glitch_core::chaos2::YoinkWin> {
        Vec::new()
    }
    pub fn yoink_win(_id: u64) -> Option<glitch_core::chaos2::YoinkWin> {
        None
    }
    pub fn identity(_id: u64) -> Option<(u32, String)> {
        None
    }
    pub fn is_minimized(_id: u64) -> Option<bool> {
        None
    }
    pub fn is_maximized(_id: u64) -> bool {
        false
    }
    pub fn visible_titles() -> Vec<String> {
        Vec::new()
    }
    pub fn yoink_show(_id: u64, _cmd: super::YoinkCmd) -> bool {
        false
    }
    pub const AVAILABLE: bool = false;
}
