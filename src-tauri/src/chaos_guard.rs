//! Test-only: the promise "Glitch only ever MOVES other apps' windows" as a
//! source scan. Chaos mode (and the code that lists or follows other apps'
//! windows) must contain none of the Win32 calls that close, minimise,
//! maximise, resize, focus, raise, kill or send input to another program.
//!
//! This file lists the forbidden names, so it is the one file not scanned.

const SCANNED: &[(&str, &str)] = &[
    ("chaos.rs", include_str!("chaos.rs")),
    ("chaos_native.rs", include_str!("chaos_native.rs")),
    ("ledge_watch.rs", include_str!("ledge_watch.rs")),
    ("world_native.rs", include_str!("world_native.rs")),
    ("../../crates/glitch-core/src/chaos.rs", include_str!("../../crates/glitch-core/src/chaos.rs")),
    ("../../crates/glitch-core/src/world.rs", include_str!("../../crates/glitch-core/src/world.rs")),
];

/// Calls that act on another program's window or process in a way chaos
/// mode must never do. Matched as whole identifiers.
const FORBIDDEN: &[&str] = &[
    // close / destroy / kill
    "CloseWindow",
    "DestroyWindow",
    "EndTask",
    "TerminateProcess",
    "TerminateThread",
    "ExitWindowsEx",
    "WM_CLOSE",
    "WM_SYSCOMMAND",
    "SC_CLOSE",
    "SC_MINIMIZE",
    "SC_MAXIMIZE",
    "SC_SIZE",
    // minimise / maximise / resize / restore / hide
    "MoveWindow",
    "SetWindowPlacement",
    "ArrangeIconicWindows",
    "TileWindows",
    "CascadeWindows",
    "AnimateWindow",
    "SW_MINIMIZE",
    "SW_FORCEMINIMIZE",
    "SW_SHOWMINIMIZED",
    "SW_SHOWMINNOACTIVE",
    "SW_MAXIMIZE",
    "SW_SHOWMAXIMIZED",
    "SW_RESTORE",
    "SW_HIDE",
    "SWP_HIDEWINDOW",
    "SWP_FRAMECHANGED",
    // focus / raise / z-order
    "SetForegroundWindow",
    "SetFocus",
    "SetActiveWindow",
    "BringWindowToTop",
    "SwitchToThisWindow",
    "LockSetForegroundWindow",
    "AttachThreadInput",
    "HWND_TOPMOST",
    "HWND_TOP",
    // input and messages into other programs
    "SendInput",
    "keybd_event",
    "mouse_event",
    "PostMessageW",
    "PostMessageA",
    "SendMessageW",
    "SendMessageA",
    "SendMessageTimeoutW",
    "PostThreadMessageW",
    "SetWindowTextW",
    "SetWindowLongW",
    "SetWindowLongPtrW",
    // injection
    "WriteProcessMemory",
    "CreateRemoteThread",
    "SetWindowsHookExW",
];

fn identifiers(src: &str) -> impl Iterator<Item = (usize, &str)> {
    src.lines().enumerate().flat_map(|(n, line)| {
        // Doc and line comments may talk about what is NOT done.
        let code = line.split("//").next().unwrap_or("");
        code.split(|c: char| !(c.is_alphanumeric() || c == '_')).filter(|w| !w.is_empty()).map(move |w| (n + 1, w))
    })
}

#[test]
fn chaos_code_never_calls_anything_that_closes_resizes_or_drives_other_windows() {
    for (file, src) in SCANNED {
        for (line, ident) in identifiers(src) {
            assert!(!FORBIDDEN.contains(&ident), "{file}:{line} uses {ident}: chaos mode may only move windows");
        }
    }
}

#[test]
fn the_only_window_writes_are_a_move_without_resize_and_a_quiet_show_of_our_own_window() {
    let native = include_str!("chaos_native.rs");
    // Exactly one SetWindowPos call, and it is flagged "don't resize, don't re-order, don't activate".
    assert_eq!(identifiers(native).filter(|(_, w)| *w == "SetWindowPos").count(), 2, "import + the one call");
    for flag in ["SWP_NOSIZE", "SWP_NOZORDER", "SWP_NOACTIVATE", "SWP_NOOWNERZORDER"] {
        assert!(native.contains(flag), "{flag} must be set on the move");
    }
    // ShowWindow exists only to show Glitch's own window without activating it.
    let show_calls: Vec<_> = identifiers(native).filter(|(_, w)| *w == "ShowWindow").collect();
    assert_eq!(show_calls.len(), 2, "import + show_no_activate");
    assert!(native.contains("ShowWindow(hwnd, SW_SHOWNOACTIVATE)"));
    assert!(native.contains("!is_own(hwnd)"), "moving and showing refuse windows that are not Glitch's / are Glitch's");
    // The page-facing commands never take a flag, size or message from the page.
    let cmds = include_str!("chaos.rs");
    assert!(!cmds.contains("SetWindowPos") && !cmds.contains("ShowWindow"), "chaos.rs only calls the native wrappers");
}

#[test]
fn the_scan_would_catch_a_forbidden_call() {
    let bad = "unsafe { CloseWindow(hwnd) };\nlet x = SC_MINIMIZE; // SendInput in a comment is fine";
    let hits: Vec<_> = identifiers(bad).filter(|(_, w)| FORBIDDEN.contains(w)).collect();
    assert_eq!(hits, [(1, "CloseWindow"), (2, "SC_MINIMIZE")]);
}
