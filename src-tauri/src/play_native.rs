//! OS bits for the play overlay (the fetch ball): make Glitch's overlay a
//! tool window that never shows up in Alt+Tab or the taskbar and never takes
//! focus, read the cursor and the left mouse button (to notice a release
//! the page missed).

#[cfg(target_os = "windows")]
mod imp {
    use windows_sys::Win32::Foundation::{HWND, POINT};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetCursorPos, GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_APPWINDOW, WS_EX_NOACTIVATE,
        WS_EX_TOOLWINDOW,
    };

    /// No Alt+Tab entry, no taskbar button, never activated by a click.
    pub fn make_tool_window(hwnd: isize) {
        let hwnd = hwnd as HWND;
        // SAFETY: plain style get/set on our own window handle.
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            let want = (ex | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE) & !WS_EX_APPWINDOW;
            if want != ex {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want as isize);
            }
        }
    }

    /// Pet windows: no Alt+Tab entry and no taskbar button (a tool window
    /// without WS_EX_APPWINDOW), but they may still be activated (the chat
    /// bubble takes typing). `skip_taskbar` alone only removes the button.
    pub fn hide_from_switcher(hwnd: isize) {
        let hwnd = hwnd as HWND;
        // SAFETY: plain style get/set on our own window handle.
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            let want = (ex | WS_EX_TOOLWINDOW) & !WS_EX_APPWINDOW;
            if want != ex {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want as isize);
            }
        }
    }

    pub fn cursor() -> Option<(f64, f64)> {
        let mut p = POINT { x: 0, y: 0 };
        // SAFETY: out-parameter call.
        (unsafe { GetCursorPos(&mut p) } != 0).then_some((p.x as f64, p.y as f64))
    }

    /// Is the left mouse button down right now?
    pub fn left_down() -> Option<bool> {
        // SAFETY: no pointers involved.
        Some(unsafe { GetAsyncKeyState(VK_LBUTTON as i32) } as u16 & 0x8000 != 0)
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    pub fn make_tool_window(_hwnd: isize) {}
    pub fn hide_from_switcher(_hwnd: isize) {}
    pub fn cursor() -> Option<(f64, f64)> {
        None
    }
    pub fn left_down() -> Option<bool> {
        None
    }
}

pub use imp::*;
