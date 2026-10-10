//! Live check of the unsaved-work guard against REAL windows (Windows):
//! two stand-in Notepad windows that this test starts itself
//! (examples/fake_notepad.rs), one titled "*draft-a.md - Notepad" (what
//! Notepad shows when there are unsaved changes) and one "reddit-posts.md -
//! Notepad". Chaos mode's real window description and Hands' real UI
//! Automation tree must treat them differently.
//!
//! It only ever looks at (and, for the clean one, prepares a call on) its own
//! two processes: `GLITCH_HANDS_ONLY_PIDS` limits Hands to them, chaos is only
//! asked about their window handles, nothing is moved, closed or typed into.
//! The windows take the keyboard focus for a moment, so it waits until the
//! user has been idle for a few seconds first (like hands_live).
//!
//!   cargo test -p glitch unsaved_live -- --ignored --nocapture

use std::process::{Child, Command};
use std::time::Duration;

use glitch_core::ai::ToolCall;
use glitch_core::chaos::{self, Refusal};
use glitch_core::hands::{self, Driver};
use glitch_core::unsaved::Unsaved;
use glitch_core::world::ScreenRect;
use serde_json::json;
use windows_sys::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId, IsWindowVisible};

use crate::hands::NativeHands;

fn stand_in(name: &str, x: i32) -> (Child, std::path::PathBuf) {
    let deps = std::env::current_exe().unwrap();
    let fake = deps.parent().unwrap().parent().unwrap().join("examples").join("fake_notepad.exe");
    assert!(fake.exists(), "build it first: cargo build -p glitch --example fake_notepad ({})", fake.display());
    let dir = tempfile::Builder::new().prefix("glitch-unsaved-live-").tempdir().unwrap();
    let exe = dir.path().join("notepad.exe");
    std::fs::copy(&fake, &exe).unwrap();
    // The file name is only used for the title; `*` can't exist in a real file name, which is fine here.
    let path = dir.path().join(name);
    let child =
        Command::new(&exe).arg(&path).args([x.to_string(), "120".into(), "620".into(), "380".into()]).spawn().unwrap();
    // The temp dir (and the copied exe) stay until the OS cleans up; the process is killed by the caller.
    let keep = dir.keep();
    (child, keep)
}

fn hwnd_of(pid: u32) -> Option<u64> {
    struct Ctx {
        pid: u32,
        found: Option<u64>,
    }
    unsafe extern "system" fn visit(hwnd: windows_sys::Win32::Foundation::HWND, lparam: isize) -> i32 {
        let ctx = &mut *(lparam as *mut Ctx);
        let mut p = 0u32;
        GetWindowThreadProcessId(hwnd, &mut p);
        if p == ctx.pid && IsWindowVisible(hwnd) != 0 {
            ctx.found = Some(hwnd as usize as u64);
            return 0;
        }
        1
    }
    let mut ctx = Ctx { pid, found: None };
    unsafe { EnumWindows(Some(visit), &mut ctx as *mut Ctx as isize) };
    ctx.found
}

async fn wait_until_idle() {
    for _ in 0..600 {
        if crate::chaos_native::idle_ms() > 4000 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "live: opens two small windows of its own; see the module docs"]
async fn unsaved_windows_are_refused_by_chaos_and_by_hands() {
    wait_until_idle().await;
    let (dirty, dir1) = stand_in("*draft-a.md", 40);
    let (clean, dir2) = stand_in("notes-b.md", 700);
    std::env::set_var("GLITCH_HANDS_ONLY_PIDS", format!("{},{}", dirty.id(), clean.id()));
    let mut ids = (None, None);
    for _ in 0..40 {
        ids = (hwnd_of(dirty.id()), hwnd_of(clean.id()));
        if ids.0.is_some() && ids.1.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let (dirty_id, clean_id) = (ids.0.expect("dirty window"), ids.1.expect("clean window"));

    // ------------------------------------------------------------- chaos
    let area = ScreenRect { x: -4000, y: -4000, w: 12000, h: 12000 };
    let d = crate::chaos_native::target(dirty_id).expect("the dirty window is described");
    let c = crate::chaos_native::target(clean_id).expect("the clean window is described");
    assert_eq!(d.cand.unsaved, Some(Unsaved::Star), "the star in the real title is seen");
    assert_eq!(c.cand.unsaved, None);
    assert_eq!(chaos::eligible(&d.cand, area, u32::MAX), Err(Refusal::UnsavedWork));
    assert_eq!(chaos::eligible(&c.cand, area, u32::MAX), Ok(()), "the clean one is a normal target");
    assert!(crate::chaos_native::looks_unsaved(dirty_id) && !crate::chaos_native::looks_unsaved(clean_id));
    // It is never even listed as a candidate for the picker.
    let picked = chaos::pick_target(&[d.cand, c.cand], area, u32::MAX, (0, 0)).map(|t| t.id);
    assert_eq!(picked, Some(clean_id));

    // ------------------------------------------------------------- hands
    let driver = Driver::new(NativeHands::new(None, false));
    driver.new_task("type hello in notepad");
    let call = |name: &str, args: serde_json::Value| ToolCall { name: name.into(), arguments: args };
    // Reading is allowed on both (it changes nothing).
    for title in ["*draft-a.md", "notes-b.md"] {
        let p = driver.prepare(&call(hands::READ_UI, json!({ "target": title }))).expect("reading is allowed");
        let done = driver.execute(&p.action, "read");
        assert!(done.ok, "{title}: {:?}", done.for_model);
    }
    // Acting: the clean one passes the check (we don't run it), the starred one is refused.
    let read = driver.prepare(&call(hands::READ_UI, json!({ "target": "*draft-a.md" }))).unwrap();
    let seen = driver.execute(&read.action, "read2").for_model;
    let line = seen["elements"]
        .as_array()
        .and_then(|a| a.iter().filter_map(|v| v.as_str()).find(|l| l.contains("edit") || l.contains("document")));
    let id: u64 = line
        .and_then(|l| l.strip_prefix('['))
        .and_then(|l| l.split(']').next())
        .and_then(|n| n.parse().ok())
        .unwrap_or_else(|| panic!("an editable element in {seen}"));
    let refused = driver.prepare(&call(hands::UI_SET_TEXT, json!({ "id": id, "text": "hello" }))).unwrap_err();
    assert_eq!(refused["refused"], true, "{refused}");
    assert!(refused["error"].as_str().unwrap().contains("isn't saved"), "{refused}");
    let focus = driver.prepare(&call(hands::FOCUS_WINDOW, json!({ "target": "*draft-a.md" }))).unwrap_err();
    assert_eq!(focus["refused"], true, "{focus}");

    let read = driver.prepare(&call(hands::READ_UI, json!({ "target": "notes-b.md" }))).unwrap();
    let seen = driver.execute(&read.action, "read3").for_model;
    let line = seen["elements"]
        .as_array()
        .and_then(|a| a.iter().filter_map(|v| v.as_str()).find(|l| l.contains("edit") || l.contains("document")));
    let id: u64 = line
        .and_then(|l| l.strip_prefix('['))
        .and_then(|l| l.split(']').next())
        .and_then(|n| n.parse().ok())
        .unwrap_or_else(|| panic!("an editable element in {seen}"));
    let ok = driver.prepare(&call(hands::UI_SET_TEXT, json!({ "id": id, "text": "hello" })));
    assert!(ok.is_ok(), "a saved document is fine: {ok:?}");

    for mut c in [dirty, clean] {
        let _ = c.kill();
        let _ = c.wait();
    }
    std::env::set_var("GLITCH_HANDS_ONLY_PIDS", "0");
    let _ = std::fs::remove_dir_all(dir1);
    let _ = std::fs::remove_dir_all(dir2);
}
