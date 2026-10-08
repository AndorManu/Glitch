//! The real [`Hands`] (app control, "Let Glitch control apps"): Windows UI
//! Automation for reading and acting, SendInput only as a fallback, the
//! system media session for play/pause, a low-level input hook so the user
//! can stop Glitch at any moment, and the "Glitch is driving <App>" banner.
//!
//! Safety checks enforced here (on top of `glitch_core::hands::safety`):
//! * never Glitch's own windows; never elevated / higher-integrity /
//!   UIAccess processes (UIPI would block most of it anyway);
//! * nothing at all while the secure desktop (UAC, lock screen) is up;
//! * keystrokes only go out after checking, right before `SendInput`, that
//!   the target window is still the one in front;
//! * password fields (UIA `IsPassword`) are refused at the moment of acting.
//!
//! Debug builds only: `GLITCH_HANDS_ONLY_PIDS=123,456` limits Glitch to the
//! windows of those processes (the live tests use it so they can never touch
//! the owner's own apps).
//!
//! macOS / Linux: "not available yet".

use std::sync::Arc;

use glitch_core::hands::{Hands, HandsResult, Key, Media, MediaStatus, UiElement, WindowRef};
use tauri::AppHandle;

pub struct NativeHands {
    app: Option<AppHandle>,
    dry_run: bool,
}

/// What the agent gets for "Let Glitch control apps" (`None`: off).
pub fn for_setting(app: &AppHandle, enabled: bool) -> Option<Arc<dyn Hands>> {
    if !enabled {
        return None;
    }
    let dry_run = std::env::var_os(crate::state::DRY_RUN_ENV).is_some_and(|v| v == "1");
    Some(NativeHands::new(Some(app.clone()), dry_run))
}

impl NativeHands {
    /// `app`: for the banner window (None in tests: no banner).
    pub fn new(app: Option<AppHandle>, dry_run: bool) -> Arc<Self> {
        Arc::new(Self { app, dry_run })
    }

    fn refuse_dry(&self) -> HandsResult<()> {
        if self.dry_run {
            return Err("dry run (GLITCH_DRY_RUN_ACTIONS=1): Glitch doesn't touch other apps".into());
        }
        Ok(())
    }
}

impl Hands for NativeHands {
    fn unavailable(&self) -> Option<String> {
        imp::unavailable()
    }
    fn windows(&self) -> Vec<WindowRef> {
        imp::windows()
    }
    fn responsive(&self, w: &WindowRef) -> bool {
        imp::responsive(w.id)
    }
    fn focus(&self, w: &WindowRef) -> HandsResult<WindowRef> {
        self.refuse_dry()?;
        imp::focus(w.id)?;
        imp::windows().into_iter().find(|x| x.id == w.id).ok_or_else(|| "the window closed".into())
    }
    fn read(&self, w: &WindowRef) -> HandsResult<Vec<UiElement>> {
        imp::read(w.id)
    }
    fn click(&self, w: &WindowRef, el: &UiElement) -> HandsResult<String> {
        self.refuse_dry()?;
        imp::click(w.id, el.key)
    }
    fn set_text(&self, w: &WindowRef, el: &UiElement, text: &str, replace: bool) -> HandsResult<String> {
        self.refuse_dry()?;
        imp::set_text(w.id, el.key, text, replace)
    }
    fn press(&self, w: Option<&WindowRef>, key: Key) -> HandsResult<()> {
        self.refuse_dry()?;
        imp::press(w.map(|w| w.id), key)
    }
    fn scroll(&self, w: &WindowRef, el: Option<&UiElement>, down: bool) -> HandsResult<String> {
        self.refuse_dry()?;
        imp::scroll(w.id, el.map(|e| e.key), down)
    }
    fn media(&self, m: Media) -> HandsResult<()> {
        self.refuse_dry()?;
        imp::media(m)
    }
    fn media_status(&self) -> Option<MediaStatus> {
        imp::media_status()
    }
    fn open_link(&self, uri: &str) -> HandsResult<()> {
        self.refuse_dry()?;
        open::that_detached(uri).map_err(|e| format!("couldn't open {uri}: {e}"))
    }
    fn ready_to_act(&self) -> HandsResult<()> {
        imp::ready_to_act()
    }
    fn elevated(&self, w: &WindowRef) -> bool {
        imp::elevated(w.id)
    }
    fn drive(&self, app: Option<&str>) {
        match app {
            Some(name) => {
                imp::watch_input(true);
                if let Some(h) = &self.app {
                    let (h, name) = (h.clone(), name.to_string());
                    // Off this (worker) thread: window creation hops to the main thread.
                    tauri::async_runtime::spawn(async move { banner::show(&h, &name) });
                }
            }
            None => {
                imp::watch_input(false);
                if let Some(h) = &self.app {
                    banner::hide(h);
                }
            }
        }
    }
    fn interrupted(&self) -> bool {
        imp::interrupted()
    }
}

/// The small always-on-top "Glitch is driving <App>, press Esc to stop"
/// banner (banner.html). Never takes focus or the mouse.
mod banner {
    use tauri::{AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

    pub const LABEL: &str = "hands-banner";
    const W: f64 = 440.0;
    const H: f64 = 52.0;

    /// Percent-encode for the URL hash (the page decodes it).
    fn encode(s: &str) -> String {
        s.bytes()
            .map(|b| if b.is_ascii_alphanumeric() { (b as char).to_string() } else { format!("%{b:02X}") })
            .collect()
    }

    pub fn show(app: &AppHandle, name: &str) {
        if let Some(old) = app.get_webview_window(LABEL) {
            let _ = old.destroy();
        }
        let built =
            WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(format!("banner.html#{}", encode(name)).into()))
                .title("Glitch is driving")
                .inner_size(W, H)
                .transparent(true)
                .decorations(false)
                .shadow(false)
                .resizable(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .focused(false)
                .focusable(false)
                .visible(false)
                .build();
        let Ok(win) = built.map_err(|e| eprintln!("glitch: hands banner failed: {e}")) else { return };
        let _ = win.set_ignore_cursor_events(true);
        if let Ok(Some(m)) = win.primary_monitor() {
            let wa = m.work_area();
            let scale = m.scale_factor();
            let x = wa.position.x + ((wa.size.width as f64 - W * scale) / 2.0) as i32;
            let _ = win.set_position(PhysicalPosition::new(x, wa.position.y + (12.0 * scale) as i32));
        }
        #[cfg(target_os = "windows")]
        if let Ok(h) = win.hwnd() {
            if crate::chaos_native::show_no_activate(h.0 as usize as u64) {
                return;
            }
        }
        let _ = win.show();
    }

    pub fn hide(app: &AppHandle) {
        if let Some(w) = app.get_webview_window(LABEL) {
            let _ = w.destroy();
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::*;

    const NOT_YET: &str = "controlling apps only works on Windows so far";

    pub fn unavailable() -> Option<String> {
        Some(NOT_YET.into())
    }
    pub fn windows() -> Vec<WindowRef> {
        vec![]
    }
    pub fn responsive(_: u64) -> bool {
        false
    }
    pub fn focus(_: u64) -> HandsResult<()> {
        Err(NOT_YET.into())
    }
    pub fn read(_: u64) -> HandsResult<Vec<UiElement>> {
        Err(NOT_YET.into())
    }
    pub fn click(_: u64, _: u64) -> HandsResult<String> {
        Err(NOT_YET.into())
    }
    pub fn set_text(_: u64, _: u64, _: &str, _: bool) -> HandsResult<String> {
        Err(NOT_YET.into())
    }
    pub fn press(_: Option<u64>, _: Key) -> HandsResult<()> {
        Err(NOT_YET.into())
    }
    pub fn scroll(_: u64, _: Option<u64>, _: bool) -> HandsResult<String> {
        Err(NOT_YET.into())
    }
    pub fn media(_: Media) -> HandsResult<()> {
        Err(NOT_YET.into())
    }
    pub fn media_status() -> Option<MediaStatus> {
        None
    }
    pub fn ready_to_act() -> HandsResult<()> {
        Err(NOT_YET.into())
    }
    pub fn elevated(_: u64) -> bool {
        true
    }
    pub fn watch_input(_: bool) {}
    pub fn interrupted() -> bool {
        false
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use std::collections::HashMap;
    use std::hash::{Hash, Hasher};
    use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, Ordering};
    use std::sync::mpsc;
    use std::sync::Mutex;
    use std::time::Duration;

    use glitch_core::hands::{HandsResult, Key, Media, MediaStatus, UiElement, WindowRef};
    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows_sys::Win32::Security::{
        GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel, TokenUIAccess,
        TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::StationsAndDesktops::{
        CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, UOI_NAME,
    };
    use windows_sys::Win32::System::Threading::{
        AttachThreadInput, GetCurrentProcess, GetCurrentProcessId, GetCurrentThreadId, GetProcessTimes, OpenProcess,
        OpenProcessToken, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE,
        MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_VIRTUALDESK,
        MOUSEEVENTF_WHEEL, MOUSEINPUT, VIRTUAL_KEY, VK_DOWN, VK_END, VK_ESCAPE, VK_HOME, VK_LCONTROL, VK_LEFT,
        VK_LSHIFT, VK_MEDIA_NEXT_TRACK, VK_MEDIA_PLAY_PAUSE, VK_MEDIA_PREV_TRACK, VK_MENU, VK_NEXT, VK_PRIOR,
        VK_RETURN, VK_RIGHT, VK_SPACE, VK_TAB, VK_UP, VK_VOLUME_DOWN, VK_VOLUME_MUTE, VK_VOLUME_UP,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        AllowSetForegroundWindow, BringWindowToTop, CallNextHookEx, EnumWindows, FindWindowExW, GetAncestor,
        GetClassNameW, GetCursorPos, GetForegroundWindow, GetMessageW, GetSystemMetrics, GetWindowLongW, GetWindowRect,
        GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsHungAppWindow, IsIconic, IsWindow,
        IsWindowVisible, PostThreadMessageW, SendMessageTimeoutW, SetForegroundWindow, SetWindowsHookExW, ShowWindow,
        SwitchToThisWindow, UnhookWindowsHookEx, WindowFromPoint, ASFW_ANY, GA_ROOT, GWL_EXSTYLE, KBDLLHOOKSTRUCT, MSG,
        MSLLHOOKSTRUCT, SMTO_ABORTIFHUNG, SMTO_BLOCK, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN, SW_RESTORE, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_GETOBJECT, WM_KEYDOWN, WM_LBUTTONDOWN,
        WM_MBUTTONDOWN, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_NULL, WM_QUIT, WM_RBUTTONDOWN, WM_SYSKEYDOWN, WS_EX_TOOLWINDOW,
    };

    use crate::desktop::friendly_app;

    /// UI Automation calls get this long; a hung app must not hang Glitch.
    const UIA_TIMEOUT: Duration = Duration::from_secs(6);
    /// Elements walked per read (Chromium pages can have thousands).
    const MAX_WALK: i32 = 1500;
    const SKIP_CLASSES: &[&str] =
        &["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Windows.UI.Core.CoreWindow"];

    pub fn unavailable() -> Option<String> {
        None
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn class_name(hwnd: HWND) -> String {
        let mut buf = [0u16; 128];
        let n = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    fn title(hwnd: HWND) -> String {
        let len = unsafe { GetWindowTextLengthW(hwnd) };
        if len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; len as usize + 1];
        let n = unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    fn pid_of(hwnd: HWND) -> u32 {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        pid
    }

    /// (exe stem, process start time) of a process.
    fn process_info(pid: u32) -> (String, u64) {
        let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if h.is_null() {
            return (String::new(), 0);
        }
        let mut buf = [0u16; 512];
        let mut len = buf.len() as u32;
        let stem = if unsafe { QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len) } != 0 {
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            std::path::Path::new(&path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
        } else {
            String::new()
        };
        let z = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let (mut c, mut e, mut k, mut u) = (z, z, z, z);
        let started = if unsafe { GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u) } != 0 {
            ((c.dwHighDateTime as u64) << 32) | c.dwLowDateTime as u64
        } else {
            0
        };
        unsafe { CloseHandle(h) };
        (stem, started)
    }

    /// Debug builds: only these processes (live tests).
    fn only_pids() -> Option<Vec<u32>> {
        if !cfg!(debug_assertions) {
            return None;
        }
        let v = std::env::var("GLITCH_HANDS_ONLY_PIDS").ok()?;
        Some(v.split(',').filter_map(|p| p.trim().parse().ok()).collect())
    }

    struct Found {
        own: u32,
        only: Option<Vec<u32>>,
        out: Vec<HWND>,
    }

    unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam as *mut Found);
        if IsWindowVisible(hwnd) == 0 || GetWindowTextLengthW(hwnd) == 0 {
            return 1;
        }
        let pid = pid_of(hwnd);
        if pid == ctx.own || ctx.only.as_ref().is_some_and(|o| !o.contains(&pid)) {
            return 1;
        }
        if (GetWindowLongW(hwnd, GWL_EXSTYLE) as u32) & WS_EX_TOOLWINDOW != 0 {
            return 1;
        }
        let mut cloaked = 0u32;
        let hr = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED as u32, (&mut cloaked as *mut u32).cast(), 4);
        if (hr == 0 && cloaked != 0) || SKIP_CLASSES.contains(&class_name(hwnd).as_str()) {
            return 1;
        }
        ctx.out.push(hwnd);
        1
    }

    fn info(hwnd: HWND, fg: HWND) -> WindowRef {
        let pid = pid_of(hwnd);
        let (exe, started) = process_info(pid);
        WindowRef {
            id: hwnd as usize as u64,
            pid,
            title: title(hwnd),
            app: friendly_app(&exe),
            exe: exe.to_lowercase(),
            minimized: unsafe { IsIconic(hwnd) } != 0,
            foreground: hwnd == fg,
            started,
        }
    }

    pub fn windows() -> Vec<WindowRef> {
        let mut ctx = Found { own: unsafe { GetCurrentProcessId() }, only: only_pids(), out: Vec::new() };
        unsafe { EnumWindows(Some(visit), &mut ctx as *mut Found as LPARAM) };
        let fg = unsafe { GetForegroundWindow() };
        ctx.out.into_iter().map(|h| info(h, fg)).collect()
    }

    fn hwnd(id: u64) -> HandsResult<HWND> {
        let h = id as usize as HWND;
        if unsafe { IsWindow(h) } == 0 {
            return Err("that window has closed".into());
        }
        if pid_of(h) == unsafe { GetCurrentProcessId() } {
            return Err("that is one of Glitch's own windows".into());
        }
        if let Some(only) = only_pids() {
            if !only.contains(&pid_of(h)) {
                return Err("not allowed in this test run".into());
            }
        }
        Ok(h)
    }

    pub fn responsive(id: u64) -> bool {
        let Ok(h) = hwnd(id) else { return false };
        let mut r = 0usize;
        unsafe {
            IsHungAppWindow(h) == 0
                && SendMessageTimeoutW(h, WM_NULL, 0, 0, SMTO_ABORTIFHUNG | SMTO_BLOCK, 1000, &mut r) != 0
        }
    }

    fn root_of(h: HWND) -> HWND {
        unsafe { GetAncestor(h, GA_ROOT) }
    }

    fn in_front(h: HWND) -> bool {
        let fg = unsafe { GetForegroundWindow() };
        !fg.is_null() && (fg == h || root_of(fg) == h)
    }

    pub fn focus(id: u64) -> HandsResult<()> {
        let h = hwnd(id)?;
        if elevated(id) {
            return Err("that window runs as administrator".into());
        }
        unsafe {
            if IsIconic(h) != 0 {
                ShowWindow(h, SW_RESTORE);
                std::thread::sleep(Duration::from_millis(250));
            }
            for attempt in 0..4 {
                if in_front(h) {
                    return Ok(());
                }
                AllowSetForegroundWindow(ASFW_ANY);
                let fg = GetForegroundWindow();
                let fg_thread = if fg.is_null() { 0 } else { GetWindowThreadProcessId(fg, std::ptr::null_mut()) };
                let me = GetCurrentThreadId();
                let attached = fg_thread != 0 && fg_thread != me && AttachThreadInput(me, fg_thread, 1) != 0;
                match attempt {
                    0 | 1 => {
                        BringWindowToTop(h);
                        SetForegroundWindow(h);
                    }
                    2 => {
                        // The Alt-key trick: the foreground lock is lifted
                        // for a process that just "pressed" a key.
                        send(&[key_input(VK_MENU, false), key_input(VK_MENU, true)]);
                        SetForegroundWindow(h);
                    }
                    _ => SwitchToThisWindow(h, 1),
                }
                if attached {
                    AttachThreadInput(me, fg_thread, 0);
                }
                std::thread::sleep(Duration::from_millis(150));
            }
            if in_front(h) {
                Ok(())
            } else {
                Err("Windows didn't let me bring that window to the front".into())
            }
        }
    }

    // ------------------------------------------------------------ elevation

    /// Integrity RID and UIAccess flag of a process token.
    fn token_level(process: HANDLE) -> Option<(u32, bool)> {
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(process, TOKEN_QUERY, &mut token) == 0 {
                return None;
            }
            // u64s: TOKEN_MANDATORY_LABEL holds a pointer, so the buffer must be 8-byte aligned.
            let mut buf = [0u64; 32];
            let mut len = 0u32;
            let ok = GetTokenInformation(
                token,
                TokenIntegrityLevel,
                buf.as_mut_ptr().cast(),
                std::mem::size_of_val(&buf) as u32,
                &mut len,
            );
            let mut ui = 0u32;
            let ok2 = GetTokenInformation(token, TokenUIAccess, (&mut ui as *mut u32).cast(), 4, &mut len);
            CloseHandle(token);
            if ok == 0 {
                return None;
            }
            let label = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
            let sid = label.Label.Sid;
            let count = *GetSidSubAuthorityCount(sid);
            if count == 0 {
                return None;
            }
            let rid = *GetSidSubAuthority(sid, count as u32 - 1);
            Some((rid, ok2 != 0 && ui != 0))
        }
    }

    /// Higher integrity than Glitch, UIAccess, or unknown: hands off.
    pub fn elevated(id: u64) -> bool {
        let Ok(h) = hwnd(id) else { return true };
        let pid = pid_of(h);
        let own = token_level(unsafe { GetCurrentProcess() });
        let p = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if p.is_null() {
            return true;
        }
        let theirs = token_level(p);
        unsafe { CloseHandle(p) };
        match (own, theirs) {
            (Some((mine, _)), Some((rid, uia))) => rid > mine || uia,
            _ => true,
        }
    }

    /// Nothing happens while UAC or the lock screen (secure desktop) is up.
    pub fn ready_to_act() -> HandsResult<()> {
        unsafe {
            let d = OpenInputDesktop(0, 0, 0x0001 /* DESKTOP_READOBJECTS */);
            if d.is_null() {
                return Err("a security prompt or the lock screen is up, so Glitch won't touch anything".into());
            }
            let mut buf = [0u16; 64];
            let mut need = 0u32;
            let ok = GetUserObjectInformationW(d, UOI_NAME, buf.as_mut_ptr().cast(), (buf.len() * 2) as u32, &mut need);
            CloseDesktop(d);
            let name = String::from_utf16_lossy(&buf).trim_end_matches('\0').to_string();
            if ok == 0 || !name.eq_ignore_ascii_case("Default") {
                return Err("a security prompt or the lock screen is up, so Glitch won't touch anything".into());
            }
        }
        Ok(())
    }

    // ------------------------------------------------------------ input

    fn key_input(vk: VIRTUAL_KEY, up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: if up { KEYEVENTF_KEYUP } else { 0 },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn unicode_input(unit: u16, up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: 0,
                    wScan: unit,
                    dwFlags: KEYEVENTF_UNICODE | if up { KEYEVENTF_KEYUP } else { 0 },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn mouse_input(flags: u32, x: i32, y: i32, data: i32) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT { dx: x, dy: y, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: 0 },
            },
        }
    }

    fn send(inputs: &[INPUT]) -> bool {
        let n = unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32) };
        n as usize == inputs.len()
    }

    /// Screen px -> SendInput's 0..65535 virtual-desktop coordinates.
    fn absolute(x: i32, y: i32) -> (i32, i32) {
        unsafe {
            let (vx, vy) = (GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN));
            let (vw, vh) = (GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1), GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1));
            (((x - vx) * 65535) / (vw - 1).max(1), ((y - vy) * 65535) / (vh - 1).max(1))
        }
    }

    fn move_to(x: i32, y: i32) -> INPUT {
        let (ax, ay) = absolute(x, y);
        mouse_input(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, ax, ay, 0)
    }

    /// Keystrokes only go to the window that was checked: verify right
    /// before sending (a pop-up could have taken the focus meanwhile).
    fn send_to(h: HWND, inputs: &[INPUT]) -> HandsResult<()> {
        ready_to_act()?;
        if !in_front(h) {
            return Err("another window took the front, so I didn't type anything".into());
        }
        if send(inputs) {
            Ok(())
        } else {
            Err("Windows blocked the keystrokes (the app may run as administrator)".into())
        }
    }

    fn combo(mods: &[VIRTUAL_KEY], vk: VIRTUAL_KEY) -> Vec<INPUT> {
        let mut v: Vec<INPUT> = mods.iter().map(|m| key_input(*m, false)).collect();
        v.push(key_input(vk, false));
        v.push(key_input(vk, true));
        v.extend(mods.iter().rev().map(|m| key_input(*m, true)));
        v
    }

    fn key_inputs(key: Key) -> Vec<INPUT> {
        let one = |vk| combo(&[], vk);
        match key {
            Key::Enter => one(VK_RETURN),
            Key::Space => one(VK_SPACE),
            Key::Tab => one(VK_TAB),
            Key::ShiftTab => combo(&[VK_LSHIFT], VK_TAB),
            Key::Up => one(VK_UP),
            Key::Down => one(VK_DOWN),
            Key::Left => one(VK_LEFT),
            Key::Right => one(VK_RIGHT),
            Key::Escape => one(VK_ESCAPE),
            Key::Home => one(VK_HOME),
            Key::End => one(VK_END),
            Key::PageUp => one(VK_PRIOR),
            Key::PageDown => one(VK_NEXT),
            Key::CtrlL => combo(&[VK_LCONTROL], b'L' as u16),
            Key::CtrlF => combo(&[VK_LCONTROL], b'F' as u16),
            Key::PlayPause => one(VK_MEDIA_PLAY_PAUSE),
            Key::NextTrack => one(VK_MEDIA_NEXT_TRACK),
            Key::PreviousTrack => one(VK_MEDIA_PREV_TRACK),
            Key::VolumeUp => one(VK_VOLUME_UP),
            Key::VolumeDown => one(VK_VOLUME_DOWN),
            Key::Mute => one(VK_VOLUME_MUTE),
        }
    }

    pub fn press(id: Option<u64>, key: Key) -> HandsResult<()> {
        match id {
            None if key.is_media() => {
                ready_to_act()?;
                send(&key_inputs(key)).then_some(()).ok_or_else(|| "the media key didn't go through".into())
            }
            None => Err("say which app to press it in".into()),
            Some(id) => send_to(hwnd(id)?, &key_inputs(key)),
        }
    }

    // ------------------------------------------------------------ the user taking over

    static INTERRUPTED: AtomicBool = AtomicBool::new(false);
    /// What stopped Glitch (1 key, 2 mouse button/wheel, 3 mouse moved), for the log.
    static WHY: AtomicU32 = AtomicU32::new(0);
    static WATCH_THREAD: AtomicU32 = AtomicU32::new(0);
    static ANCHOR_X: AtomicI32 = AtomicI32::new(i32::MIN);
    static ANCHOR_Y: AtomicI32 = AtomicI32::new(i32::MIN);
    /// How far the user may nudge the mouse before it counts as taking over.
    const MOUSE_SLACK: i32 = 40;
    const LLKHF_INJECTED: u32 = 0x10;
    const LLKHF_LOWER_IL_INJECTED: u32 = 0x02;
    const LLMHF_INJECTED: u32 = 0x01;
    const LLMHF_LOWER_IL_INJECTED: u32 = 0x02;

    unsafe extern "system" fn on_key(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
        if code >= 0 && (w as u32 == WM_KEYDOWN || w as u32 == WM_SYSKEYDOWN) {
            let k = &*(l as *const KBDLLHOOKSTRUCT);
            // Glitch's own SendInput is "injected"; anything else is the user (Esc included).
            if k.flags & (LLKHF_INJECTED | LLKHF_LOWER_IL_INJECTED) == 0 {
                {
                    WHY.store(1, Ordering::SeqCst);
                    INTERRUPTED.store(true, Ordering::SeqCst);
                }
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, w, l)
    }

    unsafe extern "system" fn on_mouse(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
        if code >= 0 {
            let m = &*(l as *const MSLLHOOKSTRUCT);
            if m.flags & (LLMHF_INJECTED | LLMHF_LOWER_IL_INJECTED) == 0 {
                match w as u32 {
                    WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_MOUSEWHEEL => {
                        WHY.store(2, Ordering::SeqCst);
                        INTERRUPTED.store(true, Ordering::SeqCst);
                    }
                    WM_MOUSEMOVE => {
                        let (ax, ay) = (ANCHOR_X.load(Ordering::SeqCst), ANCHOR_Y.load(Ordering::SeqCst));
                        if ax == i32::MIN {
                            ANCHOR_X.store(m.pt.x, Ordering::SeqCst);
                            ANCHOR_Y.store(m.pt.y, Ordering::SeqCst);
                        } else if (m.pt.x - ax).abs() > MOUSE_SLACK || (m.pt.y - ay).abs() > MOUSE_SLACK {
                            {
                                WHY.store(3, Ordering::SeqCst);
                                INTERRUPTED.store(true, Ordering::SeqCst);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, w, l)
    }

    /// Start (or stop) watching for the user's own keyboard/mouse input.
    pub fn watch_input(on: bool) {
        let running = WATCH_THREAD.load(Ordering::SeqCst);
        if !on {
            if running != 0 {
                unsafe { PostThreadMessageW(running, WM_QUIT, 0, 0) };
                WATCH_THREAD.store(0, Ordering::SeqCst);
            }
            INTERRUPTED.store(false, Ordering::SeqCst);
            return;
        }
        if running != 0 {
            return;
        }
        INTERRUPTED.store(false, Ordering::SeqCst);
        let mut p = POINT { x: 0, y: 0 };
        unsafe { GetCursorPos(&mut p) };
        ANCHOR_X.store(p.x, Ordering::SeqCst);
        ANCHOR_Y.store(p.y, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || unsafe {
            let module = GetModuleHandleW(std::ptr::null());
            let kb = SetWindowsHookExW(WH_KEYBOARD_LL, Some(on_key), module, 0);
            let ms = SetWindowsHookExW(WH_MOUSE_LL, Some(on_mouse), module, 0);
            let _ = tx.send(GetCurrentThreadId());
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {}
            if !kb.is_null() {
                UnhookWindowsHookEx(kb);
            }
            if !ms.is_null() {
                UnhookWindowsHookEx(ms);
            }
        });
        if let Ok(tid) = rx.recv_timeout(Duration::from_secs(2)) {
            WATCH_THREAD.store(tid, Ordering::SeqCst);
        }
    }

    pub fn interrupted() -> bool {
        let stop = INTERRUPTED.load(Ordering::SeqCst);
        if stop {
            let why = WHY.swap(0, Ordering::SeqCst);
            if why != 0 {
                let what = ["", "a key press", "a mouse click or wheel", "the mouse moving"][why as usize];
                eprintln!("glitch: hands stopped by the user's own input ({what})");
            }
        }
        stop
    }

    // ------------------------------------------------------------ UI Automation worker

    type Job = Box<dyn FnOnce(&mut Worker) + Send>;

    /// One long-lived thread owns the COM objects (they aren't `Send`) and
    /// the elements of the last reads, so a click acts on the very element
    /// that was read.
    struct Worker {
        uia: windows::Win32::UI::Accessibility::IUIAutomation,
        cache: HashMap<(u64, u64), windows::Win32::UI::Accessibility::IUIAutomationElement>,
    }

    static WORKER: Mutex<Option<mpsc::Sender<Job>>> = Mutex::new(None);

    fn start_worker() -> Option<mpsc::Sender<Job>> {
        use windows::Win32::System::Com::{
            CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
        };
        use windows::Win32::UI::Accessibility::CUIAutomation;
        let (tx, rx) = mpsc::channel::<Job>();
        let (ready_tx, ready_rx) = mpsc::channel();
        std::thread::spawn(move || unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let uia = match CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) {
                Ok(u) => u,
                Err(_) => {
                    let _ = ready_tx.send(false);
                    return;
                }
            };
            let _ = ready_tx.send(true);
            let mut w = Worker { uia, cache: HashMap::new() };
            while let Ok(job) = rx.recv() {
                job(&mut w);
            }
        });
        ready_rx.recv_timeout(Duration::from_secs(5)).ok().filter(|ok| *ok).map(|_| tx)
    }

    /// Run `f` on the UIA thread and wait (with a timeout: a stuck app
    /// abandons that worker and the next call starts a fresh one).
    fn on_worker<T: Send + 'static>(f: impl FnOnce(&mut Worker) -> HandsResult<T> + Send + 'static) -> HandsResult<T> {
        let tx = {
            let mut g = WORKER.lock().unwrap();
            if g.is_none() {
                *g = start_worker();
            }
            g.clone().ok_or("UI Automation isn't available")?
        };
        let (rtx, rrx) = mpsc::channel();
        let job: Job = Box::new(move |w| {
            let _ = rtx.send(f(w));
        });
        if tx.send(job).is_err() {
            *WORKER.lock().unwrap() = None;
            return Err("UI Automation stopped; try again".into());
        }
        match rrx.recv_timeout(UIA_TIMEOUT) {
            Ok(r) => r,
            Err(_) => {
                *WORKER.lock().unwrap() = None;
                Err("that app took too long to answer (it may be busy)".into())
            }
        }
    }

    fn role(ct: i32) -> &'static str {
        match ct {
            50000 => "button",
            50002 => "check box",
            50003 => "combo box",
            50004 => "edit",
            50005 => "link",
            50006 => "image",
            50007 => "list item",
            50008 => "list",
            50009 => "menu",
            50010 => "menu bar",
            50011 => "menu item",
            50012 => "progress bar",
            50013 => "radio button",
            50014 => "scroll bar",
            50015 => "slider",
            50016 => "spinner",
            50017 => "status bar",
            50018 => "tab",
            50019 => "tab item",
            50020 => "text",
            50021 => "tool bar",
            50023 => "tree",
            50024 => "tree item",
            50025 => "custom",
            50026 => "group",
            50027 => "thumb",
            50028 => "data grid",
            50029 => "row",
            50030 => "document",
            50031 => "split button",
            50032 => "window",
            50033 => "pane",
            50034 => "header",
            50035 => "header item",
            50036 => "table",
            50037 => "title bar",
            50038 => "separator",
            _ => "element",
        }
    }

    fn bool_prop(
        e: &windows::Win32::UI::Accessibility::IUIAutomationElement,
        id: windows::Win32::UI::Accessibility::UIA_PROPERTY_ID,
    ) -> bool {
        unsafe { e.GetCachedPropertyValue(id).ok().and_then(|v| bool::try_from(&v).ok()).unwrap_or(false) }
    }

    /// Chromium (Spotify, Discord, Chrome, Electron apps) builds its
    /// accessibility tree only once an assistive tool asks for it. Asking
    /// the render widget for its accessible object switches it on.
    fn wake_chromium(h: HWND) -> bool {
        if class_name(h) != "Chrome_WidgetWin_1" {
            return false;
        }
        let cls = wide("Chrome_RenderWidgetHostHWND");
        let mut woke = false;
        let mut child = unsafe { FindWindowExW(h, std::ptr::null_mut(), cls.as_ptr(), std::ptr::null()) };
        if child.is_null() {
            // Sometimes one level deeper (Chrome_WidgetWin_0 / intermediate D3D window).
            let mid = wide("Intermediate D3D Window");
            let m = unsafe { FindWindowExW(h, std::ptr::null_mut(), mid.as_ptr(), std::ptr::null()) };
            if !m.is_null() {
                child = unsafe { FindWindowExW(m, std::ptr::null_mut(), cls.as_ptr(), std::ptr::null()) };
            }
        }
        for target in [child, h] {
            if target.is_null() {
                continue;
            }
            for objid in [-4isize /* OBJID_CLIENT */, -25 /* UiaRootObjectId */] {
                let mut r = 0usize;
                unsafe {
                    SendMessageTimeoutW(target, WM_GETOBJECT, 0, objid, SMTO_ABORTIFHUNG, 500, &mut r);
                }
                woke = true;
            }
        }
        woke
    }

    fn read_once(w: &mut Worker, id: u64) -> HandsResult<Vec<UiElement>> {
        use windows::Win32::Foundation::HWND as WHWND;
        use windows::Win32::UI::Accessibility::*;
        unsafe {
            let root = w
                .uia
                .ElementFromHandle(WHWND(id as usize as *mut _))
                .map_err(|e| format!("can't read that window: {e}"))?;
            let req = w.uia.CreateCacheRequest().map_err(|e| e.to_string())?;
            for p in [
                UIA_NamePropertyId,
                UIA_ControlTypePropertyId,
                UIA_IsEnabledPropertyId,
                UIA_BoundingRectanglePropertyId,
                UIA_IsPasswordPropertyId,
                UIA_IsOffscreenPropertyId,
                UIA_HasKeyboardFocusPropertyId,
                UIA_AutomationIdPropertyId,
                UIA_ValueValuePropertyId,
                UIA_IsKeyboardFocusablePropertyId,
                UIA_IsInvokePatternAvailablePropertyId,
                UIA_IsValuePatternAvailablePropertyId,
                UIA_IsTogglePatternAvailablePropertyId,
                UIA_IsSelectionItemPatternAvailablePropertyId,
                UIA_IsExpandCollapsePatternAvailablePropertyId,
            ] {
                let _ = req.AddProperty(p);
            }
            let cond = w.uia.ControlViewCondition().map_err(|e| e.to_string())?;
            let all = root
                .FindAllBuildCache(TreeScope_Descendants, &cond, &req)
                .map_err(|e| format!("can't read that window: {e}"))?;
            let n = all.Length().unwrap_or(0).min(MAX_WALK);
            let mut out = Vec::new();
            let mut seen: HashMap<(i32, String, String), u32> = HashMap::new();
            w.cache.retain(|(win, _), _| *win != id);
            for i in 0..n {
                let Ok(e) = all.GetElement(i) else { continue };
                let name = e.CachedName().map(|b| b.to_string()).unwrap_or_default();
                let ct = e.CachedControlType().map(|c| c.0).unwrap_or(0);
                let aid = e.CachedAutomationId().map(|b| b.to_string()).unwrap_or_default();
                let value = e
                    .GetCachedPropertyValue(UIA_ValueValuePropertyId)
                    .ok()
                    .and_then(|v| windows::core::BSTR::try_from(&v).ok())
                    .map(|b| b.to_string())
                    .filter(|v| !v.is_empty());
                let r = e.CachedBoundingRectangle().unwrap_or_default();
                let password = e.CachedIsPassword().map(|b| b.as_bool()).unwrap_or(false);
                // Stable key: type + name + automation id + which occurrence.
                let n_same = seen.entry((ct, name.clone(), aid.clone())).or_insert(0);
                *n_same += 1;
                let mut h = std::collections::hash_map::DefaultHasher::new();
                (ct, &name, &aid, *n_same).hash(&mut h);
                let key = h.finish();
                let actionable = [
                    UIA_IsInvokePatternAvailablePropertyId,
                    UIA_IsValuePatternAvailablePropertyId,
                    UIA_IsTogglePatternAvailablePropertyId,
                    UIA_IsSelectionItemPatternAvailablePropertyId,
                    UIA_IsExpandCollapsePatternAvailablePropertyId,
                ]
                .iter()
                .any(|p| bool_prop(&e, *p));
                out.push(UiElement {
                    key,
                    role: role(ct).into(),
                    name: name.trim().chars().take(200).collect(),
                    // Never pass a password box's content on, even if it leaks one.
                    value: if password { None } else { value.map(|v| v.chars().take(400).collect()) },
                    enabled: e.CachedIsEnabled().map(|b| b.as_bool()).unwrap_or(true),
                    focused: e.CachedHasKeyboardFocus().map(|b| b.as_bool()).unwrap_or(false),
                    password,
                    offscreen: e.CachedIsOffscreen().map(|b| b.as_bool()).unwrap_or(false),
                    rect: (r.left, r.top, r.right - r.left, r.bottom - r.top),
                    actionable: actionable || bool_prop(&e, UIA_IsKeyboardFocusablePropertyId),
                });
                w.cache.insert((id, key), e);
            }
            if w.cache.len() > 20_000 {
                w.cache.clear();
            }
            Ok(out)
        }
    }

    pub fn read(id: u64) -> HandsResult<Vec<UiElement>> {
        let h = hwnd(id)?;
        let els = on_worker(move |w| read_once(w, id))?;
        let named = els.iter().filter(|e| !e.name.is_empty()).count();
        if named < 5 && wake_chromium(h) {
            std::thread::sleep(Duration::from_millis(900));
            return on_worker(move |w| read_once(w, id));
        }
        Ok(els)
    }

    fn cached(w: &Worker, id: u64, key: u64) -> HandsResult<windows::Win32::UI::Accessibility::IUIAutomationElement> {
        w.cache.get(&(id, key)).cloned().ok_or_else(|| "that element isn't known any more; read_ui again".into())
    }

    fn live_checks(e: &windows::Win32::UI::Accessibility::IUIAutomationElement) -> HandsResult<()> {
        unsafe {
            if e.CurrentIsPassword().map(|b| b.as_bool()).unwrap_or(true) {
                return Err("that is a password field (or can't be checked); Glitch never touches those".into());
            }
            if !e.CurrentIsEnabled().map(|b| b.as_bool()).unwrap_or(false) {
                return Err("that element is disabled (or gone) right now".into());
            }
        }
        Ok(())
    }

    /// Patterns, in order of preference. `None`: none worked, use the mouse.
    fn click_by_pattern(w: &mut Worker, id: u64, key: u64) -> HandsResult<Option<(String, (i32, i32))>> {
        use windows::Win32::UI::Accessibility::*;
        let e = cached(w, id, key)?;
        live_checks(&e)?;
        unsafe {
            if let Ok(p) = e.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) {
                if p.Invoke().is_ok() {
                    return Ok(Some(("invoke".into(), (0, 0))));
                }
            }
            if let Ok(p) = e.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId) {
                if p.Toggle().is_ok() {
                    return Ok(Some(("toggle".into(), (0, 0))));
                }
            }
            if let Ok(p) = e.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId) {
                if p.Select().is_ok() {
                    return Ok(Some(("select".into(), (0, 0))));
                }
            }
            if let Ok(p) = e.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId) {
                let collapsed =
                    p.CurrentExpandCollapseState().map(|s| s == ExpandCollapseState_Collapsed).unwrap_or(true);
                if (if collapsed { p.Expand() } else { p.Collapse() }).is_ok() {
                    return Ok(Some(("expand/collapse".into(), (0, 0))));
                }
            }
            if let Ok(p) =
                e.GetCurrentPatternAs::<IUIAutomationLegacyIAccessiblePattern>(UIA_LegacyIAccessiblePatternId)
            {
                if p.DoDefaultAction().is_ok() {
                    return Ok(Some(("default action".into(), (0, 0))));
                }
            }
            let r = e.CurrentBoundingRectangle().map_err(|e| e.to_string())?;
            if r.right <= r.left || r.bottom <= r.top {
                return Err("that element has no place on screen (scroll to it first)".into());
            }
            Ok(None).map(|_: Option<()>| Some(("mouse".to_string(), ((r.left + r.right) / 2, (r.top + r.bottom) / 2))))
        }
    }

    pub fn click(id: u64, key: u64) -> HandsResult<String> {
        let h = hwnd(id)?;
        ready_to_act()?;
        let (how, (x, y)) = on_worker(move |w| click_by_pattern(w, id, key))?.ok_or("couldn't click that")?;
        if how != "mouse" {
            return Ok(how);
        }
        // No pattern: a real click in the middle of the element, only if
        // that point really belongs to the target window and it is in front.
        if !in_front(h) {
            focus(id)?;
        }
        let at = unsafe { WindowFromPoint(POINT { x, y }) };
        if at.is_null() || root_of(at) != h {
            return Err("something else covers that element, so I didn't click".into());
        }
        let mut was = POINT { x: 0, y: 0 };
        unsafe { GetCursorPos(&mut was) };
        send_to(
            h,
            &[
                move_to(x, y),
                mouse_input(MOUSEEVENTF_LEFTDOWN, 0, 0, 0),
                mouse_input(MOUSEEVENTF_LEFTUP, 0, 0, 0),
                move_to(was.x, was.y),
            ],
        )?;
        Ok("mouse click".into())
    }

    enum TextWay {
        Done(String),
        Type { focus_ok: bool },
    }

    fn set_value(w: &mut Worker, id: u64, key: u64, text: String, replace: bool) -> HandsResult<TextWay> {
        use windows::Win32::UI::Accessibility::*;
        let e = cached(w, id, key)?;
        live_checks(&e)?;
        unsafe {
            if let Ok(p) = e.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) {
                if !p.CurrentIsReadOnly().map(|b| b.as_bool()).unwrap_or(true) {
                    let old = p.CurrentValue().map(|b| b.to_string()).unwrap_or_default();
                    let new = if replace || old.is_empty() { text.clone() } else { format!("{old}{text}") };
                    if p.SetValue(&windows::core::BSTR::from(new.as_str())).is_ok() {
                        let now = p.CurrentValue().map(|b| b.to_string()).unwrap_or_default();
                        if now == new {
                            return Ok(TextWay::Done("set value".into()));
                        }
                    }
                }
            }
            Ok(TextWay::Type { focus_ok: e.SetFocus().is_ok() })
        }
    }

    pub fn set_text(id: u64, key: u64, text: &str, replace: bool) -> HandsResult<String> {
        let h = hwnd(id)?;
        ready_to_act()?;
        let t = text.to_string();
        match on_worker(move |w| set_value(w, id, key, t, replace))? {
            TextWay::Done(how) => Ok(how),
            TextWay::Type { focus_ok } => {
                if !focus_ok {
                    return Err("couldn't put the cursor in that field; click it first".into());
                }
                std::thread::sleep(Duration::from_millis(80));
                // Re-check the field that has the focus now is the one we read.
                let still = on_worker(move |w| {
                    let e = cached(w, id, key)?;
                    live_checks(&e)?;
                    Ok(unsafe { e.CurrentHasKeyboardFocus().map(|b| b.as_bool()).unwrap_or(false) })
                })?;
                if !still {
                    return Err("the field lost the keyboard focus, so I didn't type".into());
                }
                let mut inputs = Vec::new();
                if replace {
                    inputs.extend(combo(&[VK_LCONTROL], b'A' as u16));
                } else {
                    inputs.extend(combo(&[VK_LCONTROL], VK_END));
                }
                for unit in text.encode_utf16() {
                    if unit == b'\n' as u16 {
                        inputs.extend(combo(&[], VK_RETURN));
                    } else {
                        inputs.push(unicode_input(unit, false));
                        inputs.push(unicode_input(unit, true));
                    }
                }
                send_to(h, &inputs)?;
                Ok("typed".into())
            }
        }
    }

    pub fn scroll(id: u64, key: Option<u64>, down: bool) -> HandsResult<String> {
        use windows::Win32::UI::Accessibility::*;
        let h = hwnd(id)?;
        ready_to_act()?;
        let by_pattern = on_worker(move |w| unsafe {
            let target = match key {
                Some(k) => cached(w, id, k)?,
                None => {
                    let root = w
                        .uia
                        .ElementFromHandle(windows::Win32::Foundation::HWND(id as usize as *mut _))
                        .map_err(|e| e.to_string())?;
                    let cond = w
                        .uia
                        .CreatePropertyCondition(
                            UIA_IsScrollPatternAvailablePropertyId,
                            &windows::Win32::System::Variant::VARIANT::from(true),
                        )
                        .map_err(|e| e.to_string())?;
                    match root.FindFirst(TreeScope_Descendants, &cond) {
                        Ok(e) => e,
                        Err(_) => return Ok(false),
                    }
                }
            };
            let Ok(p) = target.GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId) else {
                return Ok(false);
            };
            let amount = if down { ScrollAmount_LargeIncrement } else { ScrollAmount_LargeDecrement };
            Ok(p.Scroll(ScrollAmount_NoAmount, amount).is_ok())
        })?;
        if by_pattern {
            return Ok("scroll pattern".into());
        }
        // Mouse wheel over the middle of the window.
        if !in_front(h) {
            focus(id)?;
        }
        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        unsafe { GetWindowRect(h, &mut r) };
        let (x, y) = ((r.left + r.right) / 2, (r.top + r.bottom) / 2);
        let mut was = POINT { x: 0, y: 0 };
        unsafe { GetCursorPos(&mut was) };
        let delta = if down { -360 } else { 360 };
        send_to(h, &[move_to(x, y), mouse_input(MOUSEEVENTF_WHEEL, 0, 0, delta), move_to(was.x, was.y)])?;
        Ok("mouse wheel".into())
    }

    // ------------------------------------------------------------ media

    fn session() -> Option<windows::Media::Control::GlobalSystemMediaTransportControlsSession> {
        use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager as Manager;
        Manager::RequestAsync().ok()?.join().ok()?.GetCurrentSession().ok()
    }

    pub fn media(m: Media) -> HandsResult<()> {
        ready_to_act()?;
        let done = on_worker(move |_| {
            let Some(s) = session() else { return Ok(false) };
            let r = match m {
                Media::Play => s.TryPlayAsync(),
                Media::Pause => s.TryPauseAsync(),
                Media::PlayPause => s.TryTogglePlayPauseAsync(),
                Media::Next => s.TrySkipNextAsync(),
                Media::Previous => s.TrySkipPreviousAsync(),
            };
            Ok(r.ok().and_then(|op| op.join().ok()).unwrap_or(false))
        })?;
        if done {
            return Ok(());
        }
        // No media session: the media keys.
        let key = match m {
            Media::Next => Key::NextTrack,
            Media::Previous => Key::PreviousTrack,
            _ => Key::PlayPause,
        };
        if matches!(m, Media::Play | Media::Pause) {
            return Err("no app reports a media session to play or pause".into());
        }
        press(None, key)
    }

    pub fn media_status() -> Option<MediaStatus> {
        use windows::Media::Control::GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status;
        on_worker(|_| {
            let Some(s) = session() else { return Ok(None) };
            let playing =
                s.GetPlaybackInfo().ok().and_then(|i| i.PlaybackStatus().ok()).is_some_and(|st| st == Status::Playing);
            let props = s.TryGetMediaPropertiesAsync().ok().and_then(|op| op.join().ok());
            let (title, artist) = props
                .map(|p| {
                    (
                        p.Title().map(|t| t.to_string()).unwrap_or_default(),
                        p.Artist().map(|t| t.to_string()).unwrap_or_default(),
                    )
                })
                .unwrap_or_default();
            let aumid = s.SourceAppUserModelId().map(|t| t.to_string()).unwrap_or_default();
            let app = aumid
                .split(['!', '.', '_'])
                .find(|p| !p.is_empty() && p.chars().next().is_some_and(char::is_uppercase))
                .unwrap_or(&aumid)
                .trim_end_matches(".exe")
                .to_string();
            Ok(Some(MediaStatus { app: if app.is_empty() { "an app".into() } else { app }, title, artist, playing }))
        })
        .ok()
        .flatten()
    }
}
