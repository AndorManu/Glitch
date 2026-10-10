//! Test-only: the promise "desktop control never closes or kills anything"
//! as a source scan. App control and desktop control may move, resize,
//! snap, minimize, restore and focus windows, and send input to the window
//! the user allowed; they must contain none of the Win32 calls that close a
//! window, end a program, log the user out or shut the computer down.
//!
//! This file lists the forbidden names, so it is the one file not scanned.

const SCANNED: &[(&str, &str)] = &[
    ("hands.rs", include_str!("hands.rs")),
    ("hands_desktop.rs", include_str!("hands_desktop.rs")),
    ("hands_desktop/overlay.rs", include_str!("hands_desktop/overlay.rs")),
    ("../../crates/glitch-core/src/hands/control.rs", include_str!("../../crates/glitch-core/src/hands/control.rs")),
    ("../../crates/glitch-core/src/hands/fsmove.rs", include_str!("../../crates/glitch-core/src/hands/fsmove.rs")),
];

/// Calls and messages that close, destroy, kill, log out or shut down.
const FORBIDDEN: &[&str] = &[
    "CloseWindow",
    "DestroyWindow",
    "EndTask",
    "TerminateProcess",
    "TerminateThread",
    "ExitWindowsEx",
    "InitiateSystemShutdownExW",
    "InitiateSystemShutdownW",
    "LockWorkStation",
    "WM_CLOSE",
    "WM_DESTROY",
    "WM_SYSCOMMAND",
    "SC_CLOSE",
    "SC_MINIMIZE",
    "SC_MAXIMIZE",
    // posting a message to another program's window could be WM_CLOSE
    "PostMessageW",
    "PostMessageA",
    "SendNotifyMessageW",
    "SendNotifyMessageA",
    "keybd_event",
    "mouse_event",
    // the key combination that closes the front window
    "VK_F4",
    // deleting files: moves only
    "remove_file",
    "remove_dir",
    "remove_dir_all",
    "DeleteFileW",
    "RemoveDirectoryW",
    "SHFileOperationW",
    "IFileOperation",
];

fn identifiers(src: &str) -> impl Iterator<Item = (usize, &str)> {
    // Everything before the unit tests: tests may build and delete temp files.
    let code_only = src.split("#[cfg(test)]").next().unwrap_or(src);
    code_only.lines().enumerate().flat_map(|(n, line)| {
        let code = line.split("//").next().unwrap_or("");
        code.split(|c: char| !(c.is_alphanumeric() || c == '_')).filter(|w| !w.is_empty()).map(move |w| (n + 1, w))
    })
}

#[test]
fn desktop_control_never_closes_deletes_or_shuts_down_anything() {
    for (file, src) in SCANNED {
        for (line, ident) in identifiers(src) {
            assert!(
                !FORBIDDEN.contains(&ident),
                "{file}:{line} uses {ident}: Glitch never closes windows or deletes files"
            );
        }
    }
}

#[test]
fn the_only_ways_to_change_a_window_are_move_size_show_state_and_focus() {
    let native = include_str!("hands_desktop.rs");
    // Every ShowWindow state used is one of these.
    for state in ["SW_MAXIMIZE", "SW_MINIMIZE", "SW_RESTORE"] {
        assert!(native.contains(state), "{state}");
    }
    let allowed = ["SW_MAXIMIZE", "SW_MINIMIZE", "SW_RESTORE", "SW_SHOWMAXIMIZED", "SW_SHOWMINIMIZED"];
    for (line, ident) in identifiers(native).filter(|(_, w)| w.starts_with("SW_")) {
        assert!(allowed.contains(&ident), "hands_desktop.rs:{line} uses {ident}");
    }
    // Windows are only ever moved with the "don't re-order, don't activate" flags.
    assert!(native.contains("SWP_NOZORDER | SWP_NOACTIVATE"));
    // Every window action starts from a window the Driver already checked
    // and refuses administrator windows.
    assert!(native.contains("base::elevated(id)"));
    assert!(native.contains("base::ready_to_act()"));
}

#[test]
fn the_pointer_never_leaves_a_mouse_button_down() {
    let native = include_str!("hands_desktop.rs");
    // The drag holds the button through a guard that releases on drop.
    assert!(native.contains("impl Drop for Held"));
    assert!(native.contains("held.release()"));
}

#[test]
fn the_scan_would_catch_a_forbidden_call() {
    let bad =
        "unsafe { PostMessageW(h, WM_CLOSE, 0, 0) };\nstd::fs::remove_file(p); // remove_dir in a comment is fine";
    let hits: Vec<_> = identifiers(bad).filter(|(_, w)| FORBIDDEN.contains(w)).collect();
    assert_eq!(hits, [(1, "PostMessageW"), (1, "WM_CLOSE"), (2, "remove_file")]);
}
