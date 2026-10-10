//! A music-app stand-in that starts SLOWLY, for testing "open an app and
//! tell me what you see" without touching a real app (Spotify, Discord...).
//!
//!   fake_slow_app.exe <title> <delay_s> <blank_s> [x y width height]
//!
//! * the process starts at once but shows NO window for `delay_s` seconds,
//! * then the window appears with an empty white surface (a loading screen)
//!   for `blank_s` seconds,
//! * then it paints a small dark "library" with playlist names.
//!
//! Copy it as `<title>.exe` so the program name matches the app name, like
//! real apps. It never saves, opens or sends anything.
//!
//!   cargo build -p glitch --example fake_slow_app

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("Windows only");
}

#[cfg(target_os = "windows")]
fn main() {
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::*;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    static mut LOADED: bool = false;
    static mut TITLE: String = String::new();

    unsafe fn text(hdc: HDC, size: i32, bold: bool, color: u32, x: i32, y: i32, s: &str) {
        let font = CreateFontW(
            size,
            0,
            0,
            0,
            if bold { 700 } else { 400 },
            0,
            0,
            0,
            0,
            0,
            0,
            5, // CLEARTYPE_QUALITY
            0,
            wide("Segoe UI").as_ptr(),
        );
        let old = SelectObject(hdc, font);
        SetTextColor(hdc, color);
        SetBkMode(hdc, TRANSPARENT as i32);
        let w: Vec<u16> = s.encode_utf16().collect();
        TextOutW(hdc, x, y, w.as_ptr(), w.len() as i32);
        SelectObject(hdc, old);
        DeleteObject(font);
    }

    unsafe extern "system" fn proc(h: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
        match msg {
            WM_TIMER => {
                KillTimer(h, 1);
                LOADED = true;
                InvalidateRect(h, std::ptr::null(), 1);
                0
            }
            WM_PAINT => {
                let mut ps: PAINTSTRUCT = std::mem::zeroed();
                let hdc = BeginPaint(h, &mut ps);
                let mut r: RECT = std::mem::zeroed();
                GetClientRect(h, &mut r);
                if !LOADED {
                    let white = CreateSolidBrush(0x00FF_FFFF);
                    FillRect(hdc, &r, white);
                    DeleteObject(white);
                } else {
                    let dark = CreateSolidBrush(0x0012_1212);
                    FillRect(hdc, &r, dark);
                    DeleteObject(dark);
                    let side = RECT { left: 0, top: 0, right: 230, bottom: r.bottom };
                    let side_b = CreateSolidBrush(0x0000_0000);
                    FillRect(hdc, &side, side_b);
                    DeleteObject(side_b);
                    let white = 0x00FF_FFFF;
                    let grey = 0x00B3_B3B3;
                    text(hdc, 26, true, white, 24, 24, &*std::ptr::addr_of!(TITLE));
                    text(hdc, 20, false, grey, 24, 90, "Home");
                    text(hdc, 20, false, grey, 24, 130, "Search");
                    text(hdc, 20, true, white, 24, 170, "Your Library");
                    text(hdc, 32, true, white, 260, 24, "Made For You");
                    text(hdc, 24, false, white, 260, 100, "1. Rainy Day Jazz  (Playlist)");
                    text(hdc, 24, false, white, 260, 150, "2. Desert Roads  (Playlist)");
                    text(hdc, 24, false, white, 260, 200, "3. Gym Mix  (Playlist)");
                }
                EndPaint(h, &ps);
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
    let title = args.get(1).cloned().unwrap_or_else(|| "SlowTune".into());
    let delay: u64 = args.get(2).and_then(|a| a.parse().ok()).unwrap_or(4);
    let blank: u32 = args.get(3).and_then(|a| a.parse().ok()).unwrap_or(0);
    let mut geo = [200, 120, 900, 560];
    for (i, g) in geo.iter_mut().enumerate() {
        if let Some(v) = args.get(i + 4).and_then(|a| a.parse().ok()) {
            *g = v;
        }
    }
    unsafe { TITLE = title.clone() };
    std::thread::sleep(std::time::Duration::from_secs(delay));
    unsafe {
        let hinst = GetModuleHandleW(std::ptr::null());
        let class = wide("FakeSlowApp");
        let wc = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinst,
            hIcon: std::ptr::null_mut(),
            hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW),
            hbrBackground: std::ptr::null_mut(),
            lpszMenuName: std::ptr::null(),
            lpszClassName: class.as_ptr(),
        };
        RegisterClassW(&wc);
        LOADED = blank == 0;
        let hwnd = CreateWindowExW(
            0,
            class.as_ptr(),
            wide(&title).as_ptr(),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            geo[0],
            geo[1],
            geo[2],
            geo[3],
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            hinst,
            std::ptr::null(),
        );
        if blank > 0 {
            SetTimer(hwnd, 1, blank * 1000, None);
        }
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}
