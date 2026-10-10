//! The real [`Desktop`] for the agent: screenshots, the clipboard, the
//! active window, selected text and timers.
//!
//! Privacy rules, enforced here:
//! * Screenshots are taken only when the agent asks (the user's request needs
//!   it), only with "Let Glitch see the screen" on (checked in the agent),
//!   never include Glitch's own windows, stay in RAM, and are handed straight
//!   to the local model. Nothing is written to disk.
//! * Password fields the OS can see (UI Automation `IsPassword`) in the
//!   captured window are covered with grey boxes before the model sees the
//!   image (see `glitch_core::vision`).
//! * Clipboard text a password manager marked private
//!   ("ExcludeClipboardContentFromMonitorProcessing") is never read.
//!
//! Screen capture, the active window and selected text are Windows-only for
//! now; on macOS the agent gets a friendly "not available yet".

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use glitch_core::desktop::{
    AppWindow, Capture, CaptureTarget, ClipboardText, Desktop, DesktopResult, NowPlaying, WindowInfo,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Timers waiting at once (a model loop can't flood the user).
const MAX_TIMERS: usize = 10;

pub struct NativeDesktop {
    app: AppHandle,
    timers: Arc<AtomicUsize>,
    /// Automated runs (GLITCH_DRY_RUN_ACTIONS=1): writing the clipboard is
    /// only logged and notes go to a temp folder.
    dry_run: bool,
}

impl NativeDesktop {
    pub fn new(app: AppHandle, dry_run: bool) -> Self {
        Self { app, timers: Arc::new(AtomicUsize::new(0)), dry_run }
    }
}

/// Sent as the "reminder" event when a timer rings.
#[derive(Clone, Serialize)]
pub struct Reminder {
    pub message: String,
    /// A passing remark (a context nudge): the bubble hides again by itself if nobody answers.
    pub ambient: bool,
}

impl Desktop for NativeDesktop {
    fn capture(&self, target: CaptureTarget) -> DesktopResult<Capture> {
        let t0 = std::time::Instant::now();
        let c = imp::capture(target)?;
        eprintln!(
            "glitch: captured {target:?} {}x{} in {} ms ({} field(s) covered)",
            c.width,
            c.height,
            t0.elapsed().as_millis(),
            c.redact.len()
        );
        // Debug builds only, for dev/screen-live-check.mjs: let a test check
        // that Glitch's own windows are not in the picture. Release builds
        // never write a screenshot anywhere.
        #[cfg(debug_assertions)]
        if let Some(path) = std::env::var_os("GLITCH_DEBUG_SAVE_CAPTURE") {
            let _ = image::save_buffer(&path, &c.rgba, c.width, c.height, image::ExtendedColorType::Rgba8);
        }
        Ok(c)
    }

    fn active_window(&self) -> Option<WindowInfo> {
        imp::active_window()
    }

    fn lists_windows(&self) -> bool {
        cfg!(target_os = "windows")
    }

    fn app_windows(&self) -> Vec<AppWindow> {
        imp::app_windows()
    }

    fn capture_window(&self, id: u64) -> DesktopResult<Capture> {
        let t0 = std::time::Instant::now();
        let c = imp::capture_window(id)?;
        eprintln!(
            "glitch: captured window {id} {}x{} in {} ms ({} field(s) covered)",
            c.width,
            c.height,
            t0.elapsed().as_millis(),
            c.redact.len()
        );
        #[cfg(debug_assertions)]
        if let Some(path) = std::env::var_os("GLITCH_DEBUG_SAVE_CAPTURE") {
            let _ = image::save_buffer(&path, &c.rgba, c.width, c.height, image::ExtendedColorType::Rgba8);
        }
        Ok(c)
    }

    fn read_clipboard(&self) -> DesktopResult<ClipboardText> {
        let sensitive = imp::clipboard_is_private();
        if sensitive {
            // Don't even read it.
            return Ok(ClipboardText { text: String::new(), sensitive: true });
        }
        let mut cb = arboard::Clipboard::new().map_err(|e| format!("couldn't open the clipboard: {e}"))?;
        match cb.get_text() {
            Ok(text) => Ok(ClipboardText { text, sensitive: false }),
            Err(arboard::Error::ContentNotAvailable) => Err("the clipboard has no text in it".into()),
            Err(e) => Err(format!("couldn't read the clipboard: {e}")),
        }
    }

    fn write_clipboard(&self, text: &str) -> DesktopResult<()> {
        if self.dry_run {
            eprintln!("glitch (dry run): would copy {} characters to the clipboard", text.chars().count());
            return Ok(());
        }
        let mut cb = arboard::Clipboard::new().map_err(|e| format!("couldn't open the clipboard: {e}"))?;
        cb.set_text(text.to_string()).map_err(|e| format!("couldn't write the clipboard: {e}"))
    }

    fn selected_text(&self) -> DesktopResult<Option<String>> {
        imp::selected_text()
    }

    fn notes_file(&self) -> Option<std::path::PathBuf> {
        if self.dry_run {
            return Some(std::env::temp_dir().join("glitch-dry-run-notes.md"));
        }
        glitch_core::desktop::default_notes_file()
    }

    fn add_reminder(&self, due: i64, text: &str) -> DesktopResult<()> {
        crate::update_me::add_reminder(&self.app, due, text)
    }

    fn set_timer(&self, after: Duration, message: &str) -> DesktopResult<()> {
        if self.timers.fetch_add(1, Ordering::SeqCst) >= MAX_TIMERS {
            self.timers.fetch_sub(1, Ordering::SeqCst);
            return Err(format!("there are already {MAX_TIMERS} timers running"));
        }
        let (app, timers, message) = (self.app.clone(), self.timers.clone(), message.to_string());
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(after).await;
            timers.fetch_sub(1, Ordering::SeqCst);
            // Not in the middle of a game or a presentation.
            crate::context::hold_while_quiet(&app).await;
            // Pop up the chat with the reminder (window creation must happen
            // off the main thread's event handler, which this is).
            crate::windows::show_bubble_for_message(&app).await;
            let _ = app.emit("reminder", Reminder { message, ambient: false });
            let _ = app.emit("mood", "happy");
        });
        Ok(())
    }

    fn now_playing(&self) -> DesktopResult<Option<NowPlaying>> {
        use tauri::Manager;
        if !self.app.state::<crate::state::AppState>().settings().context.enabled {
            return Err("reacting to what the user does is switched off in Glitch's settings".into());
        }
        crate::context_native::now_playing()
    }

    fn focus(&self, minutes: Option<u32>) -> DesktopResult<u32> {
        crate::context::focus_set(&self.app, minutes)
    }
}

#[cfg(target_os = "windows")]
pub use imp::friendly_app;

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::*;

    pub fn capture(_: CaptureTarget) -> DesktopResult<Capture> {
        Err("looking at the screen only works on Windows so far".into())
    }
    pub fn active_window() -> Option<WindowInfo> {
        None
    }
    pub fn app_windows() -> Vec<AppWindow> {
        Vec::new()
    }
    pub fn capture_window(_: u64) -> DesktopResult<Capture> {
        Err("looking at one app's window only works on Windows so far".into())
    }
    pub fn clipboard_is_private() -> bool {
        false
    }
    pub fn selected_text() -> DesktopResult<Option<String>> {
        Err("reading selected text only works on Windows so far; ask the user to copy it instead".into())
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use std::sync::mpsc;
    use std::time::Duration;

    use glitch_core::desktop::{AppWindow, Capture, CaptureTarget, DesktopResult, PixelRect, WindowInfo};
    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT};
    use windows_sys::Win32::Graphics::Dwm::{
        DwmFlush, DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
    };
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, GetMonitorInfoW, MonitorFromPoint,
        MonitorFromWindow, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS,
        MONITORINFO, MONITOR_DEFAULTTONEAREST, SRCCOPY,
    };
    use windows_sys::Win32::System::DataExchange::{IsClipboardFormatAvailable, RegisterClipboardFormatW};
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetCursorPos, GetWindowLongW, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetWindowDisplayAffinity, GWL_EXSTYLE, WDA_NONE,
        WS_EX_TOOLWINDOW,
    };

    /// Windows 10 2004+: the window is left out of every screen capture.
    const WDA_EXCLUDEFROMCAPTURE: u32 = 0x11;
    /// The "cursor" target: this much around the mouse pointer (physical px).
    const CURSOR_BOX: (i32, i32) = (1100, 700);
    /// UI Automation (password fields, selection) gets this long; browsers
    /// with huge pages can be slow, and Glitch must not hang on them.
    const UIA_TIMEOUT: Duration = Duration::from_millis(1500);

    const SKIP_CLASSES: &[&str] = &["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"];

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe fn class_name(hwnd: HWND) -> String {
        let mut buf = [0u16; 64];
        let n = GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    unsafe fn title(hwnd: HWND) -> String {
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; len as usize + 1];
        let n = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    unsafe fn frame(hwnd: HWND) -> Option<RECT> {
        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        let hr = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS as u32,
            (&mut r as *mut RECT).cast(),
            std::mem::size_of::<RECT>() as u32,
        );
        (hr == 0 && r.right > r.left && r.bottom > r.top).then_some(r)
    }

    struct Windows {
        own_pid: u32,
        /// Other apps' normal windows, front to back.
        others: Vec<HWND>,
        /// Glitch's own visible top-level windows.
        own: Vec<HWND>,
    }

    unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam as *mut Windows);
        if IsWindowVisible(hwnd) == 0 {
            return 1;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == ctx.own_pid {
            ctx.own.push(hwnd);
            return 1;
        }
        if IsIconic(hwnd) != 0 || GetWindowTextLengthW(hwnd) == 0 {
            return 1;
        }
        if (GetWindowLongW(hwnd, GWL_EXSTYLE) as u32) & WS_EX_TOOLWINDOW != 0 {
            return 1;
        }
        let mut cloaked = 0u32;
        let hr = DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED as u32,
            (&mut cloaked as *mut u32).cast(),
            std::mem::size_of::<u32>() as u32,
        );
        if (hr == 0 && cloaked != 0) || SKIP_CLASSES.contains(&class_name(hwnd).as_str()) {
            return 1;
        }
        if let Some(r) = frame(hwnd) {
            if r.right - r.left >= 120 && r.bottom - r.top >= 80 {
                ctx.others.push(hwnd);
            }
        }
        1
    }

    fn windows() -> Windows {
        let mut ctx = Windows { own_pid: unsafe { GetCurrentProcessId() }, others: Vec::new(), own: Vec::new() };
        // EnumWindows walks top-level windows in z-order, topmost first.
        unsafe { EnumWindows(Some(visit), &mut ctx as *mut Windows as LPARAM) };
        ctx
    }

    /// The window the user was working in: the front-most app window that
    /// isn't Glitch's (while the chat bubble has focus, the user's window is
    /// the next one down).
    fn user_window(w: &Windows) -> Option<HWND> {
        w.others.first().copied()
    }

    /// "notepad" → "Notepad", "msedge" → "Microsoft Edge".
    pub fn friendly_app(exe_stem: &str) -> String {
        let known = [
            ("msedge", "Microsoft Edge"),
            ("chrome", "Google Chrome"),
            ("firefox", "Firefox"),
            ("brave", "Brave"),
            ("opera", "Opera"),
            ("code", "Visual Studio Code"),
            ("devenv", "Visual Studio"),
            ("explorer", "File Explorer"),
            ("notepad", "Notepad"),
            ("winword", "Microsoft Word"),
            ("excel", "Microsoft Excel"),
            ("powerpnt", "Microsoft PowerPoint"),
            ("outlook", "Outlook"),
            ("olk", "Outlook"),
            ("windowsterminal", "Windows Terminal"),
            ("powershell", "PowerShell"),
            ("cmd", "Command Prompt"),
            ("spotify", "Spotify"),
            ("discord", "Discord"),
            ("slack", "Slack"),
            ("teams", "Microsoft Teams"),
            ("ms-teams", "Microsoft Teams"),
            ("acrobat", "Adobe Acrobat"),
            ("photoshop", "Photoshop"),
            ("applicationframehost", "a Windows app"),
        ];
        let lower = exe_stem.to_lowercase();
        known.iter().find(|(k, _)| *k == lower).map(|(_, v)| v.to_string()).unwrap_or_else(|| exe_stem.to_string())
    }

    unsafe fn app_name(hwnd: HWND) -> String {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return String::new();
        }
        let mut buf = [0u16; 512];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(h);
        if ok == 0 {
            return String::new();
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        let stem =
            std::path::Path::new(&path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        friendly_app(&stem)
    }

    fn info(hwnd: HWND) -> WindowInfo {
        unsafe { WindowInfo { title: title(hwnd), app: app_name(hwnd) } }
    }

    pub fn active_window() -> Option<WindowInfo> {
        user_window(&windows()).map(info)
    }

    // ------------------------------------------------ one app's window

    /// Debug builds: only these processes (QA runs with their own fake apps).
    fn only_pids() -> Option<Vec<u32>> {
        if !cfg!(debug_assertions) {
            return None;
        }
        let v = std::env::var("GLITCH_HANDS_ONLY_PIDS").ok()?;
        Some(v.split(',').filter_map(|p| p.trim().parse().ok()).collect())
    }

    /// (pid -> (parent pid, exe stem lower case)) of every running program.
    fn process_table() -> std::collections::HashMap<u32, (u32, String)> {
        use windows_sys::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
        };
        let mut out = std::collections::HashMap::new();
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap.is_null() || snap as isize == -1 {
                return out;
            }
            let mut e: PROCESSENTRY32W = std::mem::zeroed();
            e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut ok = Process32FirstW(snap, &mut e);
            while ok != 0 {
                let n = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                let name = String::from_utf16_lossy(&e.szExeFile[..n]).to_lowercase();
                let stem = name.strip_suffix(".exe").unwrap_or(&name).to_string();
                out.insert(e.th32ProcessID, (e.th32ParentProcessID, stem));
                ok = Process32NextW(snap, &mut e);
            }
            CloseHandle(snap);
        }
        out
    }

    /// How long a process has been running.
    fn process_age(pid: u32) -> Option<Duration> {
        use windows_sys::Win32::Foundation::FILETIME;
        use windows_sys::Win32::System::SystemInformation::GetSystemTimeAsFileTime;
        use windows_sys::Win32::System::Threading::GetProcessTimes;
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return None;
            }
            let z = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
            let (mut c, mut e, mut k, mut u) = (z, z, z, z);
            let ok = GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u);
            CloseHandle(h);
            if ok == 0 {
                return None;
            }
            let mut now = z;
            GetSystemTimeAsFileTime(&mut now);
            let ft = |f: FILETIME| (u64::from(f.dwHighDateTime) << 32) | u64::from(f.dwLowDateTime);
            // 100 ns ticks.
            Some(Duration::from_nanos(ft(now).saturating_sub(ft(c)).saturating_mul(100)))
        }
    }

    struct Listing {
        own_pid: u32,
        only: Option<Vec<u32>>,
        out: Vec<HWND>,
    }

    unsafe extern "system" fn list_visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam as *mut Listing);
        if IsWindowVisible(hwnd) == 0 || GetWindowTextLengthW(hwnd) == 0 {
            return 1;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == ctx.own_pid || ctx.only.as_ref().is_some_and(|o| !o.contains(&pid)) {
            return 1;
        }
        if (GetWindowLongW(hwnd, GWL_EXSTYLE) as u32) & WS_EX_TOOLWINDOW != 0 {
            return 1;
        }
        let mut cloaked = 0u32;
        let hr = DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED as u32,
            (&mut cloaked as *mut u32).cast(),
            std::mem::size_of::<u32>() as u32,
        );
        if (hr == 0 && cloaked != 0) || SKIP_CLASSES.contains(&class_name(hwnd).as_str()) {
            return 1;
        }
        ctx.out.push(hwnd);
        1
    }

    unsafe fn window_size(hwnd: HWND) -> (u32, u32) {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowPlacement, WINDOWPLACEMENT};
        if IsIconic(hwnd) != 0 {
            let mut p: WINDOWPLACEMENT = std::mem::zeroed();
            p.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
            if GetWindowPlacement(hwnd, &mut p) != 0 {
                let r = p.rcNormalPosition;
                return ((r.right - r.left).max(0) as u32, (r.bottom - r.top).max(0) as u32);
            }
            return (0, 0);
        }
        match frame(hwnd) {
            Some(r) => ((r.right - r.left) as u32, (r.bottom - r.top) as u32),
            None => (0, 0),
        }
    }

    /// Every visible top-level window of other apps, front to back,
    /// minimized ones included (Glitch's own and cloaked ones left out).
    pub fn app_windows() -> Vec<AppWindow> {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, IsHungAppWindow};
        let mut ctx = Listing { own_pid: unsafe { GetCurrentProcessId() }, only: only_pids(), out: Vec::new() };
        unsafe { EnumWindows(Some(list_visit), &mut ctx as *mut Listing as LPARAM) };
        let table = process_table();
        let fg = unsafe { GetForegroundWindow() };
        ctx.out
            .into_iter()
            .filter_map(|h| unsafe {
                let (width, height) = window_size(h);
                if width < 120 || height < 80 {
                    return None;
                }
                let mut pid = 0u32;
                GetWindowThreadProcessId(h, &mut pid);
                let process = table.get(&pid).map(|(_, n)| n.clone()).unwrap_or_default();
                let mut ancestors = Vec::new();
                let mut cur = table.get(&pid).map(|(p, _)| *p);
                while let (Some(p), true) = (cur, ancestors.len() < 4) {
                    let Some((parent, name)) = table.get(&p) else { break };
                    ancestors.push(name.clone());
                    cur = Some(*parent);
                }
                Some(AppWindow {
                    id: h as usize as u64,
                    pid,
                    title: title(h),
                    process,
                    ancestors,
                    age: process_age(pid),
                    minimized: IsIconic(h) != 0,
                    responsive: IsHungAppWindow(h) == 0,
                    foreground: h == fg || windows_sys::Win32::UI::WindowsAndMessaging::GetAncestor(fg, 2) == h,
                    width,
                    height,
                })
            })
            .collect()
    }

    /// Are the points of the visible part of this window covered by other
    /// apps' windows (Glitch's own don't count: they are hidden from captures)?
    unsafe fn covered(hwnd: HWND, r: RECT) -> bool {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetAncestor, WindowFromPoint, GA_ROOT};
        let own = GetCurrentProcessId();
        let (w, h) = (r.right - r.left, r.bottom - r.top);
        let pts = [(2, 2), (4, 4), (2, 4), (4, 2), (3, 3)];
        pts.iter().any(|(fx, fy)| {
            let p = POINT { x: r.left + w * fx / 6, y: r.top + h * fy / 6 };
            let top = WindowFromPoint(p);
            if top.is_null() {
                return false;
            }
            let root = GetAncestor(top, GA_ROOT);
            let mut pid = 0u32;
            GetWindowThreadProcessId(root, &mut pid);
            root != hwnd && pid != own
        })
    }

    /// A window's own picture, even with other windows in front of it
    /// (PrintWindow asks the app to draw itself). All-black means the app
    /// doesn't support that.
    unsafe fn print_window(hwnd: HWND, w: i32, h: i32) -> DesktopResult<Vec<u8>> {
        use windows_sys::Win32::Storage::Xps::PrintWindow;
        let screen = GetDC(std::ptr::null_mut());
        let mem = CreateCompatibleDC(screen);
        let mut bmi: BITMAPINFO = std::mem::zeroed();
        bmi.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..std::mem::zeroed()
        };
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let dib = CreateDIBSection(mem, &bmi, DIB_RGB_COLORS, &mut bits, std::ptr::null_mut(), 0);
        let result = if dib.is_null() || bits.is_null() {
            Err("couldn't make room for the screenshot".to_string())
        } else {
            let old = SelectObject(mem, dib);
            // PW_RENDERFULLCONTENT (2): also windows drawn by the GPU.
            let ok = PrintWindow(hwnd, mem, 2);
            SelectObject(mem, old);
            let n = (w * h * 4) as usize;
            let bgra = std::slice::from_raw_parts(bits as *const u8, n);
            if ok == 0 || bgra.chunks_exact(4).all(|p| p[0] == 0 && p[1] == 0 && p[2] == 0) {
                Err("that window is behind others and doesn't let Windows copy it".to_string())
            } else {
                let mut rgba = Vec::with_capacity(n);
                for px in bgra.as_chunks::<4>().0 {
                    rgba.extend_from_slice(&[px[2], px[1], px[0], 255]);
                }
                Ok(rgba)
            }
        };
        if !dib.is_null() {
            DeleteObject(dib);
        }
        DeleteDC(mem);
        ReleaseDC(std::ptr::null_mut(), screen);
        result
    }

    /// A screenshot of exactly one window (from `app_windows`).
    pub fn capture_window(id: u64) -> DesktopResult<Capture> {
        use windows_sys::Win32::UI::WindowsAndMessaging::IsWindow;
        let hwnd = id as usize as HWND;
        unsafe {
            if IsWindow(hwnd) == 0 {
                return Err("that window has closed".into());
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid == GetCurrentProcessId() {
                return Err("that is one of Glitch's own windows".into());
            }
            if only_pids().is_some_and(|o| !o.contains(&pid)) {
                return Err("not allowed in this test run".into());
            }
            if IsIconic(hwnd) != 0 {
                return Err("that window is minimized, so there is nothing to see".into());
            }
        }
        let wins = windows();
        let Some(f) = (unsafe { frame(hwnd) }) else { return Err("that window has no visible area".into()) };
        let mon = unsafe { monitor_rect(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)) };
        let visible = intersect(f, mon).unwrap_or(mon);
        let (tx, rx) = mpsc::channel();
        let h = hwnd as usize;
        std::thread::spawn(move || {
            let _ = tx.send(uia::password_rects(h));
        });
        // The pixels: straight from the screen when nothing covers the window
        // (works for every app, GPU ones included), else the window's own
        // picture.
        let (rect, width, height, rgba) = if unsafe { covered(hwnd, visible) } {
            let mut wr = RECT { left: 0, top: 0, right: 0, bottom: 0 };
            unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd, &mut wr) };
            let (w, h) = (wr.right - wr.left, wr.bottom - wr.top);
            if w <= 0 || h <= 0 {
                return Err("that window has no visible area".into());
            }
            let rgba = unsafe { print_window(hwnd, w, h)? };
            (wr, w as u32, h as u32, rgba)
        } else {
            let (w, h, rgba) = {
                let _hidden = HiddenFromCapture::new(&wins.own);
                unsafe { grab(visible)? }
            };
            (visible, w, h, rgba)
        };
        let redact = rx
            .recv_timeout(UIA_TIMEOUT)
            .unwrap_or_default()
            .into_iter()
            .map(|f| RECT { left: f.left, top: f.top, right: f.right, bottom: f.bottom })
            .filter_map(|f| intersect(f, rect))
            .map(|f| PixelRect {
                x: (f.left - rect.left) as u32,
                y: (f.top - rect.top) as u32,
                w: (f.right - f.left) as u32,
                h: (f.bottom - f.top) as u32,
            })
            .collect();
        Ok(Capture { width, height, rgba, window: Some(info(hwnd)), redact })
    }

    unsafe fn monitor_rect_at(p: POINT) -> RECT {
        let m = MonitorFromPoint(p, MONITOR_DEFAULTTONEAREST);
        monitor_rect(m)
    }

    unsafe fn monitor_rect(m: windows_sys::Win32::Graphics::Gdi::HMONITOR) -> RECT {
        let mut mi: MONITORINFO = std::mem::zeroed();
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        GetMonitorInfoW(m, &mut mi);
        mi.rcMonitor
    }

    fn intersect(a: RECT, b: RECT) -> Option<RECT> {
        let r = RECT {
            left: a.left.max(b.left),
            top: a.top.max(b.top),
            right: a.right.min(b.right),
            bottom: a.bottom.min(b.bottom),
        };
        (r.right > r.left && r.bottom > r.top).then_some(r)
    }

    /// Hides Glitch's windows from screen captures while it lives (they stay
    /// visible on the monitor). The user's own screenshots and recordings
    /// keep showing Glitch at all other times.
    struct HiddenFromCapture(Vec<HWND>);

    impl HiddenFromCapture {
        fn new(own: &[HWND]) -> Self {
            let mut hidden = Vec::new();
            for &h in own {
                if unsafe { SetWindowDisplayAffinity(h, WDA_EXCLUDEFROMCAPTURE) } != 0 {
                    hidden.push(h);
                }
            }
            // Let DWM compose a frame without them before we copy it.
            unsafe { DwmFlush() };
            Self(hidden)
        }
    }

    impl Drop for HiddenFromCapture {
        fn drop(&mut self) {
            for &h in &self.0 {
                unsafe { SetWindowDisplayAffinity(h, WDA_NONE) };
            }
        }
    }

    /// Copy a screen rectangle (physical px) as RGBA with GDI.
    unsafe fn grab(r: RECT) -> DesktopResult<(u32, u32, Vec<u8>)> {
        let (w, h) = (r.right - r.left, r.bottom - r.top);
        let screen = GetDC(std::ptr::null_mut());
        if screen.is_null() {
            return Err("couldn't access the screen".into());
        }
        let mem = CreateCompatibleDC(screen);
        let mut bmi: BITMAPINFO = std::mem::zeroed();
        bmi.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h, // top-down rows
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..std::mem::zeroed()
        };
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let dib = CreateDIBSection(mem, &bmi, DIB_RGB_COLORS, &mut bits, std::ptr::null_mut(), 0);
        let result = if dib.is_null() || bits.is_null() {
            Err("couldn't make room for the screenshot".to_string())
        } else {
            let old = SelectObject(mem, dib);
            let ok = BitBlt(mem, 0, 0, w, h, screen, r.left, r.top, SRCCOPY | CAPTUREBLT);
            SelectObject(mem, old);
            if ok == 0 {
                Err("the screen couldn't be copied (is it locked?)".to_string())
            } else {
                let n = (w * h * 4) as usize;
                let bgra = std::slice::from_raw_parts(bits as *const u8, n);
                let mut rgba = Vec::with_capacity(n);
                for px in bgra.as_chunks::<4>().0 {
                    rgba.extend_from_slice(&[px[2], px[1], px[0], 255]);
                }
                Ok((w as u32, h as u32, rgba))
            }
        };
        if !dib.is_null() {
            DeleteObject(dib);
        }
        DeleteDC(mem);
        ReleaseDC(std::ptr::null_mut(), screen);
        result
    }

    pub fn capture(target: CaptureTarget) -> DesktopResult<Capture> {
        let wins = windows();
        let mut cursor = POINT { x: 0, y: 0 };
        unsafe { GetCursorPos(&mut cursor) };
        let front = user_window(&wins);
        let (rect, shown) = unsafe {
            match target {
                CaptureTarget::Screen => (monitor_rect_at(cursor), front),
                CaptureTarget::Window => match front.and_then(|h| Some((h, frame(h)?))) {
                    Some((h, f)) => {
                        let mon = monitor_rect(MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST));
                        (intersect(f, mon).unwrap_or(mon), Some(h))
                    }
                    // Only the desktop is open: show the screen.
                    None => (monitor_rect_at(cursor), None),
                },
                CaptureTarget::App => (monitor_rect_at(cursor), front),
                CaptureTarget::Cursor => {
                    let mon = monitor_rect_at(cursor);
                    let (bw, bh) = CURSOR_BOX;
                    let left = (cursor.x - bw / 2).clamp(mon.left, (mon.right - bw).max(mon.left));
                    let top = (cursor.y - bh / 2).clamp(mon.top, (mon.bottom - bh).max(mon.top));
                    let r = RECT { left, top, right: left + bw, bottom: top + bh };
                    (intersect(r, mon).unwrap_or(mon), front)
                }
            }
        };
        // Password fields of the window in front, found while we capture.
        let redact_hwnd = shown.map(|h| h as usize);
        let (tx, rx) = mpsc::channel();
        if let Some(h) = redact_hwnd {
            std::thread::spawn(move || {
                let _ = tx.send(uia::password_rects(h));
            });
        }
        let (width, height, rgba) = {
            let _hidden = HiddenFromCapture::new(&wins.own);
            unsafe { grab(rect)? }
        };
        let fields = if redact_hwnd.is_some() { rx.recv_timeout(UIA_TIMEOUT).unwrap_or_default() } else { vec![] };
        let redact = fields
            .into_iter()
            .map(|f| RECT { left: f.left, top: f.top, right: f.right, bottom: f.bottom })
            .filter_map(|f| intersect(f, rect))
            .map(|f| PixelRect {
                x: (f.left - rect.left) as u32,
                y: (f.top - rect.top) as u32,
                w: (f.right - f.left) as u32,
                h: (f.bottom - f.top) as u32,
            })
            .collect();
        Ok(Capture { width, height, rgba, window: shown.map(info), redact })
    }

    /// True if a password manager marked the clipboard as private.
    pub fn clipboard_is_private() -> bool {
        ["ExcludeClipboardContentFromMonitorProcessing", "Clipboard Viewer Ignore"].iter().any(|name| unsafe {
            let id = RegisterClipboardFormatW(wide(name).as_ptr());
            id != 0 && IsClipboardFormatAvailable(id) != 0
        })
    }

    pub fn selected_text() -> DesktopResult<Option<String>> {
        let Some(h) = user_window(&windows()) else { return Ok(None) };
        let h = h as usize;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(uia::selection(h));
        });
        match rx.recv_timeout(UIA_TIMEOUT) {
            Ok(r) => Ok(r),
            Err(_) => Err("that app took too long to share its selection; ask the user to copy it instead".into()),
        }
    }

    /// UI Automation: what the OS's accessibility layer knows about a
    /// window. Each call runs on its own thread with its own COM apartment.
    mod uia {
        use windows::Win32::Foundation::{HWND, RECT};
        use windows::Win32::System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
        };
        use windows::Win32::System::Variant::VARIANT;
        use windows::Win32::UI::Accessibility::{
            CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern, TreeScope_Descendants,
            TreeScope_Subtree, UIA_IsOffscreenPropertyId, UIA_IsPasswordPropertyId,
            UIA_IsTextPatternAvailablePropertyId, UIA_TextPatternId,
        };

        const MAX_SELECTION: i32 = 20_000;

        fn with_uia<T>(
            hwnd: usize,
            f: impl FnOnce(&IUIAutomation, &IUIAutomationElement) -> windows::core::Result<T>,
        ) -> Option<T> {
            unsafe {
                let inited = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
                let r = (|| {
                    let uia: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
                    let el = uia.ElementFromHandle(HWND(hwnd as *mut _))?;
                    f(&uia, &el)
                })();
                if inited {
                    CoUninitialize();
                }
                r.ok()
            }
        }

        /// Screen rectangles of the visible password boxes in a window.
        pub fn password_rects(hwnd: usize) -> Vec<RECT> {
            with_uia(hwnd, |uia, el| unsafe {
                let cond = uia.CreatePropertyCondition(UIA_IsPasswordPropertyId, &VARIANT::from(true))?;
                let found = el.FindAll(TreeScope_Descendants, &cond)?;
                let mut out = Vec::new();
                for i in 0..found.Length()? {
                    let e = found.GetElement(i)?;
                    let offscreen = e.GetCurrentPropertyValue(UIA_IsOffscreenPropertyId).ok();
                    if offscreen.is_some_and(|v| bool::try_from(&v).unwrap_or(false)) {
                        continue;
                    }
                    let r = e.CurrentBoundingRectangle()?;
                    if r.right > r.left && r.bottom > r.top {
                        // A little margin: the dots must not peek out.
                        out.push(RECT { left: r.left - 4, top: r.top - 4, right: r.right + 4, bottom: r.bottom + 4 });
                    }
                }
                Ok(out)
            })
            .unwrap_or_default()
        }

        /// The first non-empty text selection in a window.
        pub fn selection(hwnd: usize) -> Option<String> {
            with_uia(hwnd, |uia, el| unsafe {
                let cond = uia.CreatePropertyCondition(UIA_IsTextPatternAvailablePropertyId, &VARIANT::from(true))?;
                let found = el.FindAll(TreeScope_Subtree, &cond)?;
                for i in 0..found.Length()?.min(40) {
                    let Ok(e) = found.GetElement(i) else { continue };
                    let Ok(tp) = e.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) else { continue };
                    let Ok(ranges) = tp.GetSelection() else { continue };
                    for j in 0..ranges.Length().unwrap_or(0) {
                        if let Ok(text) = ranges.GetElement(j).and_then(|r| r.GetText(MAX_SELECTION)) {
                            let text = text.to_string();
                            if !text.trim().is_empty() {
                                return Ok(Some(text));
                            }
                        }
                    }
                }
                Ok(None)
            })
            .flatten()
        }
    }
}

/// Live check on a real desktop with the REAL window listing and capture,
/// against stand-in apps this test starts itself (examples/fake_slow_app.rs):
/// it never looks at or touches any other window (debug builds scope the
/// listing to the pids in GLITCH_HANDS_ONLY_PIDS).
///
///   cargo build -p glitch --example fake_slow_app
///   cargo test -p glitch slow_app_live -- --ignored --nocapture
///   (GLITCH_QA_SHOTS=<dir> also saves the pictures)
#[cfg(all(test, target_os = "windows"))]
mod live_tests {
    use std::process::{Child, Command};
    use std::time::Duration;

    use glitch_core::appwait::{self, AppMatcher, RealClock, WaitOutcome};

    use super::*;

    struct Kill(Child);
    impl Drop for Kill {
        fn drop(&mut self) {
            let _ = self.0.kill();
        }
    }

    fn save(name: &str, c: &Capture) {
        if let Some(dir) = std::env::var_os("GLITCH_QA_SHOTS") {
            let _ = std::fs::create_dir_all(&dir);
            let _ = image::save_buffer(
                std::path::Path::new(&dir).join(name),
                &c.rgba,
                c.width,
                c.height,
                image::ExtendedColorType::Rgba8,
            );
        }
    }

    #[test]
    #[ignore = "live: needs a desktop; see the module docs"]
    fn slow_app_live() {
        let deps = std::env::current_exe().unwrap();
        let fake = deps.parent().unwrap().parent().unwrap().join("examples").join("fake_slow_app.exe");
        assert!(fake.exists(), "build it first: cargo build -p glitch --example fake_slow_app");
        let dir = tempfile::Builder::new().prefix("glitch-slow-app-").tempdir().unwrap();
        let exe = dir.path().join("SlowTune.exe");
        std::fs::copy(&fake, &exe).unwrap();
        let cover_exe = dir.path().join("CoverUp.exe");
        std::fs::copy(&fake, &cover_exe).unwrap();
        // Nothing is visible to Glitch but the two stand-ins.
        std::env::set_var("GLITCH_HANDS_ONLY_PIDS", "0");
        let desktop_before = imp::app_windows();
        assert!(desktop_before.is_empty(), "scoped listing must be empty before the stand-in exists");

        // 3 s until the window exists, then 2 s of an empty white surface.
        let child = Kill(Command::new(&exe).args(["SlowTune", "3", "2", "300", "150", "800", "500"]).spawn().unwrap());
        let pid = child.0.id();
        std::env::set_var("GLITCH_HANDS_ONLY_PIDS", pid.to_string());

        let clock = RealClock::new();
        let matcher = AppMatcher::launched("SlowTune", &desktop_before);
        let desktop = NativeDesktopForTests;
        let outcome = appwait::wait_for_window(
            &desktop,
            &clock,
            &matcher,
            Duration::from_secs(20),
            appwait::POLL,
            &mut |t| eprintln!("  waiting {} s", t.as_secs()),
        );
        let WaitOutcome::Ready { window, waited, kind } = outcome else { panic!("{outcome:?}") };
        eprintln!("ready after {waited:?}: {window:?} ({kind:?})");
        assert!(waited >= Duration::from_secs(3), "{waited:?}");
        assert_eq!(window.process, "slowtune");
        assert_eq!(window.title, "SlowTune");
        assert!(window.responsive && !window.minimized);

        // The first look finds the white loading screen, waits and looks again.
        let shot = appwait::capture_app(&desktop, &clock, &matcher, Some(window.id), "SlowTune").unwrap();
        save("slowtune-visible.png", &shot.capture);
        assert!(!shot.still_blank, "the content should be there after the retry");

        // Now cover it with another window and look again: its OWN picture.
        let cover = Kill(
            Command::new(&cover_exe).args(["CoverUp", "0", "0", "250", "100", "1000", "700"]).spawn().unwrap(),
        );
        std::env::set_var("GLITCH_HANDS_ONLY_PIDS", format!("{pid},{}", cover.0.id()));
        std::thread::sleep(Duration::from_millis(1200));
        let all = imp::app_windows();
        let cover_win = all.iter().find(|w| w.title == "CoverUp").expect("cover window listed");
        assert!(all.iter().position(|w| w.id == cover_win.id) < all.iter().position(|w| w.id == window.id));
        let behind = imp::capture_window(window.id).expect("a window behind others can be captured");
        save("slowtune-behind.png", &behind);
        assert!(!glitch_core::vision::mostly_blank(&behind), "PrintWindow shows the app, not the cover");
        assert_eq!(behind.window.as_ref().map(|w| w.title.as_str()), Some("SlowTune"));
        drop(cover);
        drop(child);
    }

    struct NativeDesktopForTests;
    impl Desktop for NativeDesktopForTests {
        fn capture(&self, _: CaptureTarget) -> DesktopResult<Capture> {
            Err("unused".into())
        }
        fn active_window(&self) -> Option<WindowInfo> {
            None
        }
        fn read_clipboard(&self) -> DesktopResult<ClipboardText> {
            Err("unused".into())
        }
        fn write_clipboard(&self, _: &str) -> DesktopResult<()> {
            Err("unused".into())
        }
        fn selected_text(&self) -> DesktopResult<Option<String>> {
            Ok(None)
        }
        fn set_timer(&self, _: Duration, _: &str) -> DesktopResult<()> {
            Err("unused".into())
        }
        fn app_windows(&self) -> Vec<AppWindow> {
            imp::app_windows()
        }
        fn capture_window(&self, id: u64) -> DesktopResult<Capture> {
            imp::capture_window(id)
        }
    }
}
