//! Keeps the per-window command permissions honest (review 2026-10-08, L4):
//! every registered command has a permission in build.rs, and only the
//! bubble may chat with the agent or approve its actions.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

/// Command names in `generate_handler![...]` in main.rs.
fn registered() -> BTreeSet<String> {
    let main = include_str!("main.rs");
    let start = main.find("generate_handler![").expect("main.rs registers commands");
    let list = &main[start + "generate_handler![".len()..];
    let list = &list[..list.find(']').expect("closing bracket")];
    list.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).map(|s| s.rsplit("::").next().unwrap().into()).collect()
}

/// Command names in build.rs's `COMMANDS`.
fn with_permission() -> BTreeSet<String> {
    let build = include_str!("../build.rs");
    let start = build.find("const COMMANDS").expect("build.rs lists commands");
    let list = &build[start..];
    let list = &list[list.find("= &[").unwrap() + 4..list.find("];").unwrap()];
    list.split(',').map(|s| s.trim().trim_matches('"')).filter(|s| !s.is_empty()).map(String::from).collect()
}

/// Window label -> app commands it may call, from capabilities/*.json.
fn granted() -> BTreeMap<String, BTreeSet<String>> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
    let mut out: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let text = std::fs::read_to_string(entry.unwrap().path()).unwrap();
        let cap: serde_json::Value = serde_json::from_str(&text).unwrap();
        let windows: Vec<String> =
            cap["windows"].as_array().unwrap().iter().map(|w| w.as_str().unwrap().to_string()).collect();
        assert!(!windows.contains(&"*".to_string()), "no capability may apply to every window");
        for p in cap["permissions"].as_array().unwrap() {
            let p = p.as_str().expect("plain permission names");
            let Some(cmd) = p.strip_prefix("allow-") else {
                assert!(p.starts_with("core:"), "unexpected permission {p}");
                continue;
            };
            for w in &windows {
                out.entry(w.clone()).or_default().insert(cmd.replace('-', "_"));
            }
        }
    }
    out
}

#[test]
fn every_command_has_a_permission_and_a_window() {
    let registered = registered();
    assert_eq!(registered, with_permission(), "build.rs COMMANDS must match generate_handler!");
    let granted = granted();
    let all: BTreeSet<String> = granted.values().flatten().cloned().collect();
    for c in &all {
        assert!(registered.contains(c), "capability grants unknown command {c}");
    }
    for c in &registered {
        assert!(all.contains(c), "no window may call {c}");
    }
}

#[test]
fn only_the_bubble_talks_to_the_agent() {
    let granted = granted();
    for cmd in ["send_message", "confirm_action"] {
        let who: Vec<&String> = granted.iter().filter(|(_, c)| c.contains(cmd)).map(|(w, _)| w).collect();
        assert_eq!(who, ["bubble"], "{cmd}");
    }
    for cmd in ["update_settings", "clear_memory", "forget_memory", "reset_chat"] {
        let who: Vec<&String> = granted.iter().filter(|(_, c)| c.contains(cmd)).map(|(w, _)| w).collect();
        assert_eq!(who, ["panel"], "{cmd}");
    }
    // Stream overlay and updates: only the mascot reports what he is doing,
    // only Settings changes the overlay or its tokens, and installing a
    // signed update is the bubble's offer or the Settings card.
    let who = |cmd: &str| -> Vec<&String> { granted.iter().filter(|(_, c)| c.contains(cmd)).map(|(w, _)| w).collect() };
    assert_eq!(who("stream_mirror"), ["mascot"]);
    for cmd in [
        "update_stream_settings",
        "stream_new_token",
        "stream_copy",
        "stream_test_event",
        "update_set_auto",
        "update_check",
    ] {
        assert_eq!(who(cmd), ["panel"], "{cmd}");
    }
    assert_eq!(who("update_install"), ["bubble", "panel"]);
    // The panic button, its hotkey and "Start with Windows" are Settings only:
    // a web page in another window must never be able to turn the safety off.
    for cmd in ["safety_status", "safety_set_paused", "safety_set_hotkey", "safety_set_autostart"] {
        assert_eq!(who(cmd), ["panel"], "{cmd}");
    }
    // The updater plugin is driven from Rust only: no webview may call it.
    for entry in std::fs::read_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities")).unwrap() {
        let text = std::fs::read_to_string(entry.unwrap().path()).unwrap();
        assert!(!text.contains("updater:"), "no window gets updater plugin permissions");
    }
    // The chaos helper windows get one command each.
    assert_eq!(granted["note"].iter().collect::<Vec<_>>(), ["chaos_note_close"]);
    assert_eq!(granted["pawprints"].iter().collect::<Vec<_>>(), ["chaos_paws_idle"]);
    // Chaos mode 2: the effects overlay can fetch the melt picture once and hide itself, the fake popup can
    // only close itself, and only Settings may test or stop from outside the mascot.
    assert_eq!(granted["chaosfx"].iter().collect::<Vec<_>>(), ["chaos2_fx_idle", "chaos2_fx_ready", "chaos2_melt_frame"]);
    assert_eq!(granted["virus"].iter().collect::<Vec<_>>(), ["chaos2_popup_close"]);
    for cmd in ["chaos2_test", "chaos2_stop"] {
        assert_eq!(who(cmd), ["panel"], "{cmd}");
    }
    // The acts that touch the cursor, windows or the screen are the mascot's alone, and Rust re-checks each.
    for cmd in ["chaos2_cursor_act", "chaos2_dance", "chaos2_yoink", "chaos2_fx_start", "chaos2_popup", "chaos2_abort"]
    {
        assert_eq!(who(cmd), ["mascot"], "{cmd}");
    }
}
