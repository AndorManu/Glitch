//! A classic-Notepad stand-in for the live app-control test
//! (`src-tauri/src/hands_live.rs`): a "Notepad" window class with a
//! multi-line EDIT control and a File/Edit menu, titled "<file> - Notepad",
//! loading the file given on the command line. Never saves anything.
//!
//! Why not the real Notepad: on Windows 11 notepad.exe hands over to the
//! Store Notepad, which restores the user's own open (and unsaved) tabs into
//! the window and may open the file as a tab of a window the user already
//! has. The test must never touch the user's work, so it drives this.
//!
//!   cargo build -p glitch --example fake_notepad
//!   fake_notepad.exe <file> [x y width height]

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("Windows only");
}

#[cfg(target_os = "windows")]
fn main() {
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    static mut EDIT: HWND = std::ptr::null_mut();

    unsafe extern "system" fn proc(h: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
        match msg {
            WM_SIZE => {
                let (cw, ch) = ((l & 0xffff) as i32, ((l >> 16) & 0xffff) as i32);
                MoveWindow(EDIT, 0, 0, cw, ch, 1);
                0
            }
            WM_SETFOCUS => {
                windows_sys::Win32::UI::Input::KeyboardAndMouse::SetFocus(EDIT);
                0
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                0
            }
            _ => DefWindowProcW(h, msg, w, l),
        }
    }

    let args: Vec<String> = std::env::args().collect();
    let path = args.get(1).cloned().unwrap_or_else(|| "Untitled".into());
    // Optional: x y width height (the QA script frames it for screenshots).
    let mut geo = [200, 200, 700, 450];
    for (i, g) in geo.iter_mut().enumerate() {
        if let Some(v) = args.get(i + 2).and_then(|a| a.parse().ok()) {
            *g = v;
        }
    }
    let text = std::fs::read_to_string(&path).unwrap_or_default().replace('\n', "\r\n");
    let name = std::path::Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(path);
    unsafe {
        let inst = GetModuleHandleW(std::ptr::null());
        let class = wide("Notepad");
        let wc = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: inst,
            hIcon: std::ptr::null_mut(),
            hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW),
            hbrBackground: std::ptr::null_mut(),
            lpszMenuName: std::ptr::null(),
            lpszClassName: class.as_ptr(),
        };
        RegisterClassW(&wc);
        let menu = CreateMenu();
        for item in ["File", "Edit", "Format", "View", "Help"] {
            AppendMenuW(menu, MF_STRING | MF_POPUP, CreatePopupMenu() as usize, wide(item).as_ptr());
        }
        let title = wide(&format!("{name} - Notepad"));
        let win = CreateWindowExW(
            0,
            class.as_ptr(),
            title.as_ptr(),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            geo[0],
            geo[1],
            geo[2],
            geo[3],
            std::ptr::null_mut(),
            menu,
            inst,
            std::ptr::null(),
        );
        EDIT = CreateWindowExW(
            0,
            wide("Edit").as_ptr(),
            wide(&text).as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_VSCROLL | (ES_MULTILINE | ES_AUTOVSCROLL | ES_WANTRETURN) as u32,
            0,
            0,
            700,
            450,
            win,
            std::ptr::null_mut(),
            inst,
            std::ptr::null(),
        );
        ShowWindow(win, SW_SHOWNORMAL);
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}
