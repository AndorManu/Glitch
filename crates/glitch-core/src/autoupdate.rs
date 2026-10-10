//! Auto-update rules (the Tauri shell does the downloading, see
//! `src-tauri/src/autoupdate.rs`): when to check, and when to offer a
//! version the user already said "Later" to.

use crate::settings::UpdateSettings;

/// Checks run this long after start (Glitch first settles in), then daily.
pub const FIRST_CHECK_SECS: u64 = 45;
pub const CHECK_EVERY_SECS: u64 = 24 * 60 * 60;
/// "Later" hides that version's bubble for this long.
pub const SNOOZE_SECS: u64 = 24 * 60 * 60;

/// Releases are only ever fetched from here (HTTPS, pinned): the same URL is
/// in `tauri.conf.json > plugins > updater > endpoints`.
pub const ENDPOINT: &str = "https://github.com/AndorManu/Glitch/releases/latest/download/latest.json";

/// Show the "new version" bubble for `version` now?
pub fn should_offer(s: &UpdateSettings, version: &str, now: u64) -> bool {
    match &s.snoozed_version {
        Some(v) if v == version => now.saturating_sub(s.snoozed_at) >= SNOOZE_SECS,
        _ => true,
    }
}

/// The release notes for the bubble: first non-empty lines, plain, short.
pub fn short_notes(body: Option<&str>) -> String {
    let Some(body) = body else { return String::new() };
    let lines: Vec<String> = body
        .lines()
        .map(|l| l.trim().trim_start_matches(['#', '-', '*', ' ']).trim().to_string())
        .filter(|l| !l.is_empty())
        .take(3)
        .collect();
    crate::stream::clean(&lines.join(" · "), 160)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn later_snoozes_that_version_for_a_day() {
        let mut s = UpdateSettings::default();
        assert!(should_offer(&s, "0.2.0", 1000));
        s.snoozed_version = Some("0.2.0".into());
        s.snoozed_at = 1000;
        assert!(!should_offer(&s, "0.2.0", 1000 + 3600));
        assert!(should_offer(&s, "0.2.0", 1000 + SNOOZE_SECS));
        assert!(should_offer(&s, "0.3.0", 1001), "a newer version asks again");
    }

    #[test]
    fn notes_are_short_plain_text() {
        assert_eq!(short_notes(None), "");
        assert_eq!(
            short_notes(Some("## Glitch 0.2.0\n\n- Stream overlay\n- Auto-update\n- More\n- Hidden")),
            "Glitch 0.2.0 · Stream overlay · Auto-update"
        );
        assert!(short_notes(Some(&"x".repeat(500))).chars().count() <= 160);
    }

    #[test]
    fn endpoint_is_pinned_https_github() {
        assert!(ENDPOINT.starts_with("https://github.com/"));
        let conf = include_str!("../../../src-tauri/tauri.conf.json");
        assert!(conf.contains(ENDPOINT), "tauri.conf.json must use the same pinned endpoint");
        assert!(!conf.contains("dangerousInsecureTransportProtocol"));
    }
}
