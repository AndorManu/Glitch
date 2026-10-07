//! "Update me": things that happen outside the chat and that Glitch tells
//! the user about (a build finished, Claude Code needs you, a reminder is
//! due, 3 new WhatsApp messages, the morning briefing).
//!
//! Safety: every event that arrives from outside (the local endpoint, a
//! Claude Code hook, other apps' notifications) is **untrusted text**. It is
//! cleaned and shortened here, shown in the bubble as-is, and never put into
//! the chat agent's context, so it can't make Glitch open, send or change
//! anything. The only model call that sees outside text (the notification
//! digest summary) runs without tools and its output is validated in Rust
//! (see [`notifications::parse_summaries`]).

pub mod briefing;
pub mod claude_code;
pub mod endpoint;
pub mod notifications;
pub mod reminders;
pub mod when;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_TITLE: usize = 80;
pub const MAX_BODY: usize = 300;
pub const MAX_SOURCE: usize = 40;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    #[default]
    Info,
    Success,
    Warning,
    Error,
}

impl Level {
    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "success" | "ok" | "done" => Level::Success,
            "warning" | "warn" => Level::Warning,
            "error" | "fail" | "failed" | "failure" => Level::Error,
            _ => Level::Info,
        }
    }
}

/// One thing to tell the user about, already cleaned (see [`UpdateEvent::from_json`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UpdateEvent {
    pub title: String,
    pub body: String,
    /// Who sent it: "claude-code", "build", "script"... (lowercase, short).
    pub source: String,
    pub level: Level,
    /// For Claude Code: the project folder's name (from the hook's `cwd`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// For Claude Code: "done" or "needs_input".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

/// Shown text: no control characters (newlines become spaces), no bidi
/// overrides, collapsed whitespace, at most `max` characters.
pub fn clean(s: &str, max: usize) -> String {
    let filtered: String = s
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        // Bidi overrides / isolates can make text read differently than it is.
        .filter(|c| !matches!(*c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200B}'..='\u{200F}'))
        .collect();
    let collapsed = filtered.split_whitespace().collect::<Vec<_>>().join(" ");
    crate::tools::ellipsize(&collapsed, max)
}

/// "claude-code", "build": lowercase letters, digits, '-', '_', '.'.
fn clean_source(s: &str) -> String {
    let s: String = s
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_whitespace() { '-' } else { c })
        .filter(|c| c.is_ascii_alphanumeric() || "-_.".contains(*c))
        .take(MAX_SOURCE)
        .collect();
    if s.is_empty() {
        "script".into()
    } else {
        s
    }
}

impl UpdateEvent {
    pub fn new(title: &str, body: &str, source: &str, level: Level) -> Self {
        Self {
            title: clean(title, MAX_TITLE),
            body: clean(body, MAX_BODY),
            source: clean_source(source),
            level,
            project: None,
            kind: None,
        }
    }

    /// From the endpoint's JSON body `{title, body, source, level}`. Needs
    /// a title or a body; everything else is optional.
    pub fn from_json(v: &Value) -> Result<Self, String> {
        if !v.is_object() {
            return Err("expected a JSON object".into());
        }
        let text = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("");
        let (title, body) = (text("title"), text("body"));
        if title.trim().is_empty() && body.trim().is_empty() {
            return Err("needs a \"title\" or a \"body\"".into());
        }
        let mut e = Self::new(title, body, text("source"), Level::parse(text("level")));
        if e.title.is_empty() {
            // Only a body: it becomes the title (the sign shows the title).
            e.title = clean(&e.body, MAX_TITLE);
            e.body.clear();
        }
        let project = clean(text("project"), 60);
        e.project = (!project.is_empty()).then_some(project);
        let kind = text("kind");
        if matches!(kind, "done" | "needs_input") {
            e.kind = Some(kind.into());
        }
        Ok(e)
    }

    /// What the bubble says.
    pub fn speech(&self) -> String {
        let project = self.project.as_deref().map(|p| format!(" ({p})")).unwrap_or_default();
        if self.body.is_empty() {
            format!("{}{project}", self.title)
        } else {
            format!("{}{project}: {}", self.title, self.body)
        }
    }

    /// What the sign Glitch holds says (short).
    pub fn sign(&self) -> String {
        crate::tools::ellipsize(&self.title, 28)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn events_are_cleaned_and_shortened() {
        let e = UpdateEvent::from_json(&json!({
            "title": "Build\ndone\u{202E}!",
            "body": "x".repeat(1000),
            "source": "My Build Script!!",
            "level": "SUCCESS",
        }))
        .unwrap();
        assert_eq!(e.title, "Build done!");
        assert!(e.body.chars().count() <= MAX_BODY);
        assert_eq!(e.source, "my-build-script");
        assert_eq!(e.level, Level::Success);
    }

    #[test]
    fn body_only_becomes_the_title_and_bad_input_is_refused() {
        let e = UpdateEvent::from_json(&json!({"body": "download finished"})).unwrap();
        assert_eq!((e.title.as_str(), e.body.as_str(), e.source.as_str()), ("download finished", "", "script"));
        assert_eq!(e.level, Level::Info);
        assert!(UpdateEvent::from_json(&json!({"title": "  "})).is_err());
        assert!(UpdateEvent::from_json(&json!(["x"])).is_err());
        assert!(UpdateEvent::from_json(&json!({"title": 5})).is_err());
    }

    #[test]
    fn speech_and_sign() {
        let mut e = UpdateEvent::new("Claude Code is done", "Finished the task", "claude-code", Level::Success);
        e.project = Some("Glitch".into());
        assert_eq!(e.speech(), "Claude Code is done (Glitch): Finished the task");
        assert_eq!(e.sign(), "Claude Code is done");
        assert!(UpdateEvent::new(&"a".repeat(50), "", "x", Level::Info).sign().chars().count() <= 28);
    }
}
