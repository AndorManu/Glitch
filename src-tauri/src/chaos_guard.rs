//! Test-only: the promise "Glitch only ever MOVES other apps' windows (and,
//! in chaos mode 2, minimises one and puts it back)" as a source scan. Chaos
//! mode (and the code that lists or follows other apps' windows) must contain
//! none of the Win32 calls that close, minimise, maximise, resize, focus,
//! raise, kill or send input to another program, except the ONE audited
//! function in `chaos_native.rs` between the BEGIN/END AUDITED markers, which
//! may call `ShowWindow` with `SW_SHOWMINNOACTIVE` (minimise, nothing
//! activated) or `SW_SHOWNOACTIVATE` (restore, no focus) and nothing else.
//!
//! This file lists the forbidden names, so it is the one file not scanned.

const SCANNED: &[(&str, &str)] = &[
    ("chaos.rs", include_str!("chaos.rs")),
    ("chaos2.rs", include_str!("chaos2.rs")),
    ("chaos_native.rs", include_str!("chaos_native.rs")),
    ("ledge_watch.rs", include_str!("ledge_watch.rs")),
    ("world_native.rs", include_str!("world_native.rs")),
    ("../../crates/glitch-core/src/chaos.rs", include_str!("../../crates/glitch-core/src/chaos.rs")),
    ("../../crates/glitch-core/src/chaos2.rs", include_str!("../../crates/glitch-core/src/chaos2.rs")),
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

const BEGIN: &str = "// BEGIN AUDITED MINIMIZE/RESTORE";
const END: &str = "// END AUDITED MINIMIZE/RESTORE";

/// Everything outside the audited function, and the audited function itself.
fn split_audited(src: &str) -> (String, String) {
    match (src.find(BEGIN), src.find(END)) {
        (Some(a), Some(b)) if a < b => (format!("{}{}", &src[..a], &src[b + END.len()..]), src[a..b].to_string()),
        _ => (src.to_string(), String::new()),
    }
}

/// What the audited function may mention (besides plain Rust and the wrappers it needs).
const AUDITED_ALLOWED: &[&str] = &[
    "ShowWindow", "SW_SHOWMINNOACTIVE", "SW_SHOWNOACTIVATE", "IsWindow", "is_own", "hwnd", "HWND", "id", "u64", "usize", "as", "let", "if",
    "else", "pub", "fn", "cmd", "YoinkCmd", "Minimize", "Restore", "bool", "unsafe", "return", "false", "true", "how", "ONLY", "BEGIN", "END",
    "yoink_show",
];

/// Forbidden identifiers in `src` outside the audited function.
fn violations(src: &str) -> Vec<(usize, String)> {
    let (outside, _) = split_audited(src);
    identifiers(&outside).filter(|(_, w)| FORBIDDEN.contains(w)).map(|(n, w)| (n, w.to_string())).collect()
}

#[test]
fn chaos_code_never_calls_anything_that_closes_resizes_or_drives_other_windows() {
    for (file, src) in SCANNED {
        let v = violations(src);
        assert!(v.is_empty(), "{file}:{} uses {}: chaos mode may only move windows (and minimise/restore through the audited function)", v[0].0, v[0].1);
    }
}

#[test]
fn the_only_window_writes_are_a_move_without_resize_the_audited_minimize_and_a_quiet_show_of_our_own_window() {
    let native = include_str!("chaos_native.rs");
    // Exactly one SetWindowPos call, and it is flagged "don't resize, don't re-order, don't activate".
    assert_eq!(identifiers(native).filter(|(_, w)| *w == "SetWindowPos").count(), 2, "import + the one call");
    for flag in ["SWP_NOSIZE", "SWP_NOZORDER", "SWP_NOACTIVATE", "SWP_NOOWNERZORDER"] {
        assert!(native.contains(flag), "{flag} must be set on the move");
    }
    // ShowWindow: the import, the quiet show of our own window, and the audited function.
    let show_calls: Vec<_> = identifiers(native).filter(|(_, w)| *w == "ShowWindow").collect();
    assert_eq!(show_calls.len(), 3, "import + show_no_activate + the audited yoink_show");
    assert!(native.contains("ShowWindow(hwnd, SW_SHOWNOACTIVATE)"));
    assert!(native.contains("!is_own(hwnd)"), "moving and showing refuse windows that are not Glitch's / are Glitch's");
    // The audited function: present exactly once, small, and only the allowed names.
    assert_eq!(native.matches(BEGIN).count(), 1);
    assert_eq!(native.matches(END).count(), 1);
    let (_, inside) = split_audited(native);
    let code_lines = inside.lines().filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with("//")).count();
    assert!(code_lines <= 14, "the audited function stays tiny ({code_lines} lines)");
    assert_eq!(identifiers(&inside).filter(|(_, w)| *w == "ShowWindow").count(), 1, "one ShowWindow call in the audited function");
    assert!(inside.contains("SW_SHOWMINNOACTIVE") && inside.contains("SW_SHOWNOACTIVATE"));
    for (n, w) in identifiers(&inside) {
        assert!(AUDITED_ALLOWED.contains(&w), "audited function line {n} uses {w}: not on the allowed list");
    }
    // The page-facing commands never take a flag, size or message from the page.
    for (name, cmds) in [("chaos.rs", include_str!("chaos.rs")), ("chaos2.rs", include_str!("chaos2.rs"))] {
        assert!(!cmds.contains("SetWindowPos") && !cmds.contains("ShowWindow"), "{name} only calls the native wrappers");
    }
}

#[test]
fn only_chaos2_calls_the_audited_function_and_the_page_never_picks_the_window() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut callers = vec![];
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|e| e == "rs") {
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            let text = std::fs::read_to_string(&path).unwrap();
            if name != "chaos_guard.rs" && identifiers(&text).any(|(_, w)| w == "yoink_show") {
                callers.push(name);
            }
        }
    }
    callers.sort();
    assert_eq!(callers, ["chaos2.rs", "chaos_native.rs"]);
    // The runtime restores only windows it has in its book and minimises only ones it picked itself.
    let rt = include_str!("chaos2.rs");
    assert!(rt.contains("YoinkCmd::Minimize") && rt.contains("YoinkCmd::Restore"));
    assert!(!rt.contains("fn chaos2_restore") && !rt.contains("fn chaos2_minimize"), "no command lets the page choose a window to minimise or restore");
}

#[test]
fn the_scan_would_catch_a_forbidden_call() {
    let bad = "unsafe { CloseWindow(hwnd) };\nlet x = SC_MINIMIZE; // SendInput in a comment is fine";
    let hits: Vec<_> = identifiers(bad).filter(|(_, w)| FORBIDDEN.contains(w)).collect();
    assert_eq!(hits, [(1, "CloseWindow"), (2, "SC_MINIMIZE")]);
}

#[test]
fn the_audit_allows_exactly_one_function_and_rejects_any_other_use() {
    let audited = format!("fn a() {{}}\n{BEGIN}\npub fn yoink_show() {{ ShowWindow(h, SW_SHOWMINNOACTIVE); }}\n{END}\nfn b() {{}}\n");
    assert!(violations(&audited).is_empty(), "inside the markers it is allowed");
    // The same call anywhere else is a violation.
    let elsewhere = format!("{audited}fn other() {{ ShowWindow(h, SW_SHOWMINNOACTIVE); }}\n");
    assert_eq!(violations(&elsewhere), [(4, "SW_SHOWMINNOACTIVE".to_string())]);
    for bad in ["SW_MINIMIZE", "SW_RESTORE", "SW_HIDE", "SW_SHOWMAXIMIZED", "SW_FORCEMINIMIZE", "CloseWindow", "SendInput", "mouse_event", "SetForegroundWindow", "MoveWindow", "PostMessageW"] {
        let src = format!("fn other() {{ unsafe {{ {bad}(h, 1) }} }}\n");
        assert_eq!(violations(&src).len(), 1, "{bad} outside the audited function");
        // Not even inside the markers: the inside has its own, much shorter allow-list.
        let inside = format!("{BEGIN}\n{bad}(h, 1);\n{END}\n");
        let (_, body) = split_audited(&inside);
        assert!(identifiers(&body).any(|(_, w)| w == bad && !AUDITED_ALLOWED.contains(&w)), "{bad} inside the audited function");
    }
}
