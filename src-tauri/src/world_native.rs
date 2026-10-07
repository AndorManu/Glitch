//! Lists other apps' windows (front-to-back, physical px) so Glitch can stand
//! on them. Only positions are read: no titles, no contents, no screenshots.
//!
//! * Windows: `EnumWindows` (top-to-bottom z-order) + DWM extended frame
//!   bounds (the visible frame, without the invisible resize border).
//! * macOS: `CGWindowListCopyWindowInfo` (front-to-back), normal layer only.
//!   Window bounds are readable without the Screen Recording permission.
//! * Linux: not implemented (no ledges).

use glitch_core::world::AppWindow;

/// `scale`: physical px per point of Glitch's monitor (used on macOS, where
/// the OS reports points).
pub fn app_windows(scale: f64) -> Vec<AppWindow> {
    imp::app_windows(scale)
}

#[cfg(target_os = "windows")]
mod imp {
    use glitch_core::world::{AppWindow, ScreenRect};
    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows_sys::Win32::System::Threading::GetCurrentProcessId;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowLongW, GetWindowTextLengthW, GetWindowThreadProcessId, IsIconic,
        IsWindowVisible, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
    };

    struct Ctx {
        own_pid: u32,
        out: Vec<AppWindow>,
    }

    /// Shell windows that look like app windows but aren't.
    const SKIP_CLASSES: &[&str] = &["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"];

    unsafe fn class_name(hwnd: HWND) -> String {
        let mut buf = [0u16; 64];
        let n = GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam as *mut Ctx);
        if IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 || GetWindowTextLengthW(hwnd) == 0 {
            return 1;
        }
        if (GetWindowLongW(hwnd, GWL_EXSTYLE) as u32) & WS_EX_TOOLWINDOW != 0 {
            return 1;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == ctx.own_pid {
            return 1;
        }
        // "Cloaked" windows are invisible (other virtual desktops, UWP ghosts).
        let mut cloaked = 0u32;
        let hr = DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED as u32,
            (&mut cloaked as *mut u32).cast(),
            std::mem::size_of::<u32>() as u32,
        );
        if hr == 0 && cloaked != 0 {
            return 1;
        }
        if SKIP_CLASSES.contains(&class_name(hwnd).as_str()) {
            return 1;
        }
        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        let hr = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS as u32,
            (&mut r as *mut RECT).cast(),
            std::mem::size_of::<RECT>() as u32,
        );
        if hr != 0 {
            return 1;
        }
        ctx.out.push(AppWindow {
            id: hwnd as usize as u64,
            rect: ScreenRect { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top },
        });
        1 // keep enumerating
    }

    pub fn app_windows(_scale: f64) -> Vec<AppWindow> {
        let mut ctx = Ctx { own_pid: unsafe { GetCurrentProcessId() }, out: Vec::new() };
        // EnumWindows walks top-level windows in z-order, topmost first.
        unsafe { EnumWindows(Some(visit), &mut ctx as *mut Ctx as LPARAM) };
        ctx.out
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use core_foundation::array::CFArray;
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;
    use core_graphics::window::{
        copy_window_info, kCGNullWindowID, kCGWindowBounds, kCGWindowLayer, kCGWindowListExcludeDesktopElements,
        kCGWindowListOptionOnScreenOnly, kCGWindowNumber, kCGWindowOwnerPID,
    };
    use glitch_core::world::{AppWindow, ScreenRect};

    fn number(dict: &CFDictionary<CFString, CFType>, key: &CFString) -> Option<f64> {
        dict.find(key).and_then(|v| v.downcast::<CFNumber>()).and_then(|n| n.to_f64())
    }

    pub fn app_windows(scale: f64) -> Vec<AppWindow> {
        let own_pid = std::process::id() as f64;
        let Some(list): Option<CFArray> =
            copy_window_info(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID)
        else {
            return Vec::new();
        };
        let (k_layer, k_pid, k_num, k_bounds) = unsafe {
            (
                CFString::wrap_under_get_rule(kCGWindowLayer),
                CFString::wrap_under_get_rule(kCGWindowOwnerPID),
                CFString::wrap_under_get_rule(kCGWindowNumber),
                CFString::wrap_under_get_rule(kCGWindowBounds),
            )
        };
        let (kx, ky, kw, kh) =
            (CFString::new("X"), CFString::new("Y"), CFString::new("Width"), CFString::new("Height"));
        let mut out = Vec::new();
        // The list is ordered front-to-back.
        for item in list.iter() {
            let dict: CFDictionary<CFString, CFType> =
                unsafe { CFDictionary::wrap_under_get_rule(*item as core_foundation::dictionary::CFDictionaryRef) };
            // Layer 0 = normal app windows (not the menu bar, Dock, overlays).
            if number(&dict, &k_layer) != Some(0.0) || number(&dict, &k_pid) == Some(own_pid) {
                continue;
            }
            let Some(bounds) = dict.find(&k_bounds).and_then(|b| b.downcast::<CFDictionary>()) else { continue };
            let bounds: CFDictionary<CFString, CFType> =
                unsafe { CFDictionary::wrap_under_get_rule(bounds.as_concrete_TypeRef()) };
            let (Some(x), Some(y), Some(w), Some(h)) =
                (number(&bounds, &kx), number(&bounds, &ky), number(&bounds, &kw), number(&bounds, &kh))
            else {
                continue;
            };
            out.push(AppWindow {
                id: number(&dict, &k_num).unwrap_or(0.0) as u64,
                rect: ScreenRect {
                    x: (x * scale).round() as i32,
                    y: (y * scale).round() as i32,
                    w: (w * scale).round() as i32,
                    h: (h * scale).round() as i32,
                },
            });
        }
        out
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod imp {
    use glitch_core::world::AppWindow;

    pub fn app_windows(_scale: f64) -> Vec<AppWindow> {
        Vec::new()
    }
}
