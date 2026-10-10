//! Every settings.json shape Glitch has written (taken from the git history
//! of crates/glitch-core/src/settings.rs, see tests/fixtures/settings/), a
//! file with unknown fields, wrong types and corrupted files: the app must
//! start, keep every field it can still read, fall back to defaults for the
//! rest, and never lose the original.

use std::path::{Path, PathBuf};

use glitch_core::safety::DEFAULT_PANIC_HOTKEY;
use glitch_core::settings::Settings;

const FIXTURES: &[(&str, &str)] = &[
    ("v01", include_str!("fixtures/settings/v01_initial_d103cb9.json")),
    ("v02", include_str!("fixtures/settings/v02_memory_ae71a4e.json")),
    ("v03", include_str!("fixtures/settings/v03_voice_8b493ce.json")),
    ("v04", include_str!("fixtures/settings/v04_chaos_3c455dd.json")),
    ("v05", include_str!("fixtures/settings/v05_screen_de576cc.json")),
    ("v06", include_str!("fixtures/settings/v06_context_6ec19de.json")),
    ("v07", include_str!("fixtures/settings/v07_branch_stream_c8489f3.json")),
    ("v08", include_str!("fixtures/settings/v08_branch_update_me_07f817c.json")),
    ("v09", include_str!("fixtures/settings/v09_stream_overlay_78dd697.json")),
    ("v10", include_str!("fixtures/settings/v10_hands_2d35ba4.json")),
    ("v11", include_str!("fixtures/settings/v11_update_me_merged.json")),
];

fn write(dir: &Path, text: &str) -> PathBuf {
    let path = dir.join("settings.json");
    std::fs::write(&path, text).unwrap();
    path
}

fn names_in(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> =
        std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    v.sort();
    v
}

#[test]
fn every_earlier_shape_loads_cleanly_and_keeps_its_values() {
    for (name, text) in FIXTURES {
        let dir = tempfile::tempdir().unwrap();
        let path = write(dir.path(), text);
        let (s, report) = Settings::load_with_report(&path);
        assert!(report.backup.is_none() && report.dropped.is_empty() && !report.unreadable, "{name}: {report:?}");
        assert_eq!(names_in(dir.path()), ["settings.json"], "{name}: a clean load makes no extra files");

        // The very first fields exist in every shape.
        assert_eq!(s.model.as_deref(), Some("qwen3.5:2b"), "{name}");
        assert!(!s.movement_enabled && s.onboarding_done, "{name}");
        assert_eq!(s.keep_alive, "5m", "{name}");

        // Fields newer than the file get today's defaults.
        let d = Settings::default();
        assert_eq!(s.safety, d.safety, "{name}: the panic button defaults on");
        assert_eq!(s.safety.panic_hotkey, DEFAULT_PANIC_HOTKEY);
        assert!(!s.safety.paused && !s.safety.start_with_windows, "{name}");
        if *name < "v02" {
            assert_eq!(s.memory_enabled, d.memory_enabled, "{name}");
        } else {
            assert!(!s.memory_enabled, "{name}");
        }
        if *name < "v03" {
            assert_eq!(s.voice, d.voice, "{name}");
        } else {
            assert_eq!(
                (s.voice.enabled, s.voice.model.as_deref(), s.voice.language.as_str()),
                (false, Some("tiny"), "de")
            );
            assert!(s.voice.speak_replies, "{name}");
        }
        if *name < "v04" {
            assert!(s.chaos_enabled, "{name}: chaos defaults on");
        } else {
            assert!(!s.chaos_enabled, "{name}");
        }
        if *name < "v05" {
            assert!(s.screen_enabled && !s.notes_trusted, "{name}");
        } else {
            assert!(!s.screen_enabled && s.notes_trusted, "{name}");
        }
        match *name {
            "v06" | "v09" | "v10" | "v11" => {
                assert!(!s.context.music && !s.context.video && !s.context.morning, "{name}");
                assert_eq!((s.context.night_start.as_str(), s.context.focus_minutes), ("23:00", 50), "{name}");
                assert!(s.context.focus_suggest, "{name}");
            }
            // The two branch shapes had no `context` section: defaults.
            _ => assert_eq!(s.context, d.context, "{name}"),
        }
        match *name {
            "v09" | "v10" | "v11" => {
                assert!(s.stream_overlay.enabled && s.stream_overlay.mirror_chat, "{name}");
                assert_eq!((s.stream_overlay.port, s.stream_overlay.view_token.as_str()), (7802, "viewtok"), "{name}");
                assert_eq!(s.stream_overlay.twitch_channel, "chan", "{name}");
                assert!(!s.auto_update.auto_check, "{name}");
                assert_eq!(s.auto_update.snoozed_version.as_deref(), Some("0.3.0"), "{name}");
            }
            // `stream` / `updates` were other names on feature branches: ignored, defaults.
            _ => {
                assert_eq!(s.stream_overlay, d.stream_overlay, "{name}");
                assert_eq!(s.auto_update, d.auto_update, "{name}");
            }
        }
        match *name {
            "v10" | "v11" => {
                assert!(s.hands_enabled, "{name}");
                assert_eq!(s.hands_model.as_deref(), Some("qwen3:14b"), "{name}");
            }
            _ => assert!(!s.hands_enabled && s.hands_model.is_none(), "{name}: app control stays off"),
        }
        if *name == "v11" {
            assert!(!s.update_me.endpoint_enabled && s.update_me.claude_code_enabled, "{name}");
            assert_eq!(s.update_me.notifications_blocklist, ["bank"], "{name}");
            assert_eq!(s.update_me.location.as_ref().map(|l| l.name.as_str()), Some("Zurich"), "{name}");
        } else {
            assert_eq!(s.update_me, d.update_me, "{name}");
        }

        // Saving what was loaded and loading it again changes nothing.
        let out = dir.path().join("again.json");
        s.save(&out).unwrap();
        assert_eq!(Settings::load(&out), s, "{name}: round trip");
    }
}

#[test]
fn a_file_from_a_newer_glitch_with_extra_fields_is_fine() {
    let dir = tempfile::tempdir().unwrap();
    let path = write(
        dir.path(),
        r#"{
          "model": "llama3.2:3b",
          "future_option": {"a": [1, 2, 3]},
          "voice": {"model": "base", "future_voice_thing": true},
          "stream_overlay": {"port": 7811, "future": null},
          "safety": {"paused": true, "panic_hotkey": "Ctrl+Alt+F9", "future_safety": 1},
          "movement_enabled": false
        }"#,
    );
    let (s, report) = Settings::load_with_report(&path);
    assert_eq!(report, Default::default(), "unknown fields are not an error");
    assert_eq!(s.model.as_deref(), Some("llama3.2:3b"));
    assert!(!s.movement_enabled);
    assert_eq!(s.voice.model.as_deref(), Some("base"));
    assert!(s.voice.enabled, "the rest of a partial section falls back to defaults");
    assert_eq!(s.stream_overlay.port, 7811);
    assert!(s.safety.paused && s.safety.panic_hotkey == "Ctrl+Alt+F9");
    assert_eq!(names_in(dir.path()), ["settings.json"]);
}

#[test]
fn wrong_types_drop_only_that_field_and_keep_a_backup() {
    let dir = tempfile::tempdir().unwrap();
    let original = r#"{
      "model": "qwen3.5:4b",
      "movement_enabled": "yes please",
      "chaos_enabled": false,
      "onboarding_done": true,
      "memory_enabled": 7,
      "voice": {"enabled": false, "language": 5, "model": "small"},
      "stream_overlay": {"enabled": true, "port": 99999, "twitch_channel": "chan"},
      "context": "broken",
      "hands_enabled": true,
      "update_me": {"reminders_enabled": false, "location": {"name": "x"}},
      "safety": {"paused": "no", "start_with_windows": true}
    }"#;
    let path = write(dir.path(), original);
    let (s, report) = Settings::load_with_report(&path);
    let d = Settings::default();

    // Valid fields survive, even next to broken siblings in the same section.
    assert_eq!(s.model.as_deref(), Some("qwen3.5:4b"));
    assert!(!s.chaos_enabled && s.onboarding_done && s.hands_enabled);
    assert!(!s.voice.enabled && s.voice.model.as_deref() == Some("small"));
    assert!(s.stream_overlay.enabled && s.stream_overlay.twitch_channel == "chan");
    assert!(!s.update_me.reminders_enabled);
    assert!(s.safety.start_with_windows);
    // Broken ones are their defaults.
    assert_eq!(s.movement_enabled, d.movement_enabled);
    assert_eq!(s.memory_enabled, d.memory_enabled);
    assert_eq!(s.voice.language, d.voice.language);
    assert_eq!(s.stream_overlay.port, d.stream_overlay.port);
    assert_eq!(s.context, d.context);
    assert_eq!(s.update_me.location, None);
    assert_eq!(s.safety.paused, d.safety.paused);

    let mut dropped = report.dropped.clone();
    dropped.sort();
    assert_eq!(
        dropped,
        [
            "context",
            "memory_enabled",
            "movement_enabled",
            "safety.paused",
            "stream_overlay.port",
            "update_me.location",
            "voice.language"
        ]
    );
    assert!(!report.unreadable);
    // The original is kept byte for byte.
    let backup = report.backup.expect("a backup");
    assert!(backup.ends_with("settings.json.bak"), "{backup:?}");
    assert_eq!(std::fs::read_to_string(&backup).unwrap(), original);
}

#[test]
fn a_corrupted_file_gives_defaults_and_is_kept_as_a_backup() {
    let cases: &[(&str, &[u8])] = &[
        ("truncated", br#"{"model":"qwen3.5:2b","movement_enabled":tr"#),
        ("garbage", b"{ not json"),
        ("binary", &[0xff, 0xfe, 0x00, 0x01, 0x80, 0x9f, 0x00]),
        ("array", b"[1, 2, 3]"),
        ("null", b"null"),
        ("number", b"42"),
        ("string", br#""settings""#),
        ("nul bytes", &[0u8; 64]),
    ];
    for (name, bytes) in cases {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, bytes).unwrap();
        let (s, report) = Settings::load_with_report(&path);
        assert_eq!(s, Settings::default(), "{name}");
        assert!(report.unreadable, "{name}");
        let backup = report.backup.unwrap_or_else(|| panic!("{name}: no backup"));
        assert!(backup.ends_with("settings.json.bak"), "{name}: {backup:?}");
        assert_eq!(std::fs::read(&backup).unwrap(), *bytes, "{name}: kept byte for byte");
        assert!(
            !path.exists(),
            "{name}: the broken file is out of the way, a fresh one gets written on the next change"
        );
        // Defaults are usable: they save and load.
        s.save(&path).unwrap();
        assert_eq!(Settings::load(&path), s, "{name}");
    }
}

#[test]
fn repeated_corruption_does_not_destroy_the_first_backup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    for i in 1..=3 {
        std::fs::write(&path, format!("broken {i}")).unwrap();
        let (_, report) = Settings::load_with_report(&path);
        assert!(report.unreadable);
    }
    assert_eq!(std::fs::read_to_string(dir.path().join("settings.json.bak")).unwrap(), "broken 1");
    assert_eq!(std::fs::read_to_string(dir.path().join("settings.json.bak2")).unwrap(), "broken 2");
    assert_eq!(std::fs::read_to_string(dir.path().join("settings.json.bak3")).unwrap(), "broken 3");
}

#[test]
fn empty_files_and_byte_order_marks_are_not_errors() {
    for (name, text) in [("empty", ""), ("spaces", "  \n\t "), ("missing", "<none>")] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        if name != "missing" {
            std::fs::write(&path, text).unwrap();
        }
        let (s, report) = Settings::load_with_report(&path);
        assert_eq!(s, Settings::default(), "{name}");
        assert_eq!(report, Default::default(), "{name}");
        assert!(!dir.path().join("settings.json.bak").exists(), "{name}");
    }
    // Notepad's "UTF-8 with BOM".
    let dir = tempfile::tempdir().unwrap();
    let path = write(dir.path(), "\u{feff}{\"model\":\"qwen3.5:2b\",\"memory_enabled\":false}");
    let (s, report) = Settings::load_with_report(&path);
    assert_eq!(report, Default::default());
    assert_eq!(s.model.as_deref(), Some("qwen3.5:2b"));
    assert!(!s.memory_enabled);
}

#[test]
fn a_damaged_panic_hotkey_never_leaves_the_app_without_one() {
    for bad in ["", "banana", "g", "ctrl+g", "Ctrl+Alt+Delete"] {
        let dir = tempfile::tempdir().unwrap();
        let path = write(dir.path(), &format!(r#"{{"safety":{{"panic_hotkey":"{bad}","paused":true}}}}"#));
        let s = Settings::load(&path);
        assert_eq!(s.safety.panic_hotkey, DEFAULT_PANIC_HOTKEY, "{bad:?}");
        assert!(s.safety.paused, "{bad:?}: the rest of the section is kept");
    }
    let dir = tempfile::tempdir().unwrap();
    let path = write(dir.path(), r#"{"safety":{"panic_hotkey":"alt + ctrl + f9"}}"#);
    assert_eq!(Settings::load(&path).safety.panic_hotkey, "Ctrl+Alt+F9");
}

#[test]
fn a_folder_or_unreadable_path_still_starts_with_defaults() {
    let dir = tempfile::tempdir().unwrap();
    // The settings path is a directory (somebody's odd idea of a backup).
    let path = dir.path().join("settings.json");
    std::fs::create_dir(&path).unwrap();
    let (s, report) = Settings::load_with_report(&path);
    assert_eq!(s, Settings::default());
    assert_eq!(report, Default::default());
}

#[test]
fn extreme_values_do_not_crash_loading() {
    let dir = tempfile::tempdir().unwrap();
    let huge = "x".repeat(200_000);
    let path = write(
        dir.path(),
        &format!(
            r#"{{"model":"{huge}","stream_overlay":{{"size":1e308,"port":-1}},"context":{{"focus_minutes":4294967296}},"voice":{{"language":null}}}}"#
        ),
    );
    let (s, report) = Settings::load_with_report(&path);
    assert_eq!(s.model.as_deref().map(str::len), Some(200_000));
    assert!(report.dropped.contains(&"stream_overlay.port".to_string()), "{report:?}");
    assert!(report.dropped.contains(&"context.focus_minutes".to_string()), "{report:?}");
    assert!(report.dropped.contains(&"voice.language".to_string()), "{report:?}");
}
