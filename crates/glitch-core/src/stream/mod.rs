//! Streaming overlay: Glitch as an OBS browser source.
//!
//! The Tauri shell runs a tiny HTTP server on 127.0.0.1 (see
//! `src-tauri/src/stream/`). Everything here is the pure part, so it can be
//! unit-tested without sockets: the stream events Glitch reacts to, how he
//! reacts, rate limits, request parsing and routing ([`http`]), and the
//! readers for Streamer.bot ([`streamerbot`], over a WebSocket: [`ws`]) and
//! Twitch chat ([`irc`], read-only and anonymous).

pub mod http;
pub mod irc;
pub mod streamerbot;
pub mod ws;

use serde::{Deserialize, Serialize};

/// Longest user name / text kept from an event (characters).
pub const MAX_USER: usize = 40;
pub const MAX_TEXT: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EventKind {
    Follow,
    Sub,
    Raid,
    Chat,
}

impl EventKind {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "follow" | "follower" => Some(Self::Follow),
            "sub" | "subscribe" | "subscription" | "resub" | "giftsub" | "member" | "sponsor" => Some(Self::Sub),
            "raid" | "host" => Some(Self::Raid),
            "chat" | "message" | "chatmessage" => Some(Self::Chat),
            _ => None,
        }
    }
}

/// Something that happened on stream. Always cleaned (see [`clean`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StreamEvent {
    #[serde(rename = "type")]
    pub kind: EventKind,
    pub user: String,
    pub text: String,
}

impl StreamEvent {
    pub fn new(kind: EventKind, user: &str, text: &str) -> Self {
        let user = clean(user, MAX_USER);
        Self { kind, user: if user.is_empty() { "someone".into() } else { user }, text: clean(text, MAX_TEXT) }
    }
}

/// One line of plain text: no control characters (no newlines, no terminal
/// or bidi tricks), whitespace collapsed, at most `max` characters (with an
/// ellipsis when cut). The overlay draws it as text, never as HTML.
pub fn clean(s: &str, max: usize) -> String {
    let mut out = String::new();
    let mut space = false;
    for c in s.chars() {
        let bidi = matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200E}' | '\u{200F}');
        if c.is_whitespace() || c.is_control() || bidi {
            space = !out.is_empty();
            continue;
        }
        if space {
            out.push(' ');
            space = false;
        }
        out.push(c);
    }
    if out.chars().count() > max {
        let mut cut: String = out.chars().take(max.saturating_sub(1)).collect();
        cut = cut.trim_end().to_string();
        cut.push('…');
        return cut;
    }
    out
}

/// The body of `POST /stream-event`: `{"type":"follow","user":"ana","text":"..."}`.
#[derive(Deserialize)]
struct WebhookBody {
    #[serde(rename = "type", alias = "kind", alias = "event")]
    kind: String,
    #[serde(default, alias = "name", alias = "username", alias = "displayName")]
    user: Option<serde_json::Value>,
    #[serde(default, alias = "message")]
    text: Option<serde_json::Value>,
}

fn value_text(v: Option<serde_json::Value>) -> String {
    match v {
        Some(serde_json::Value::String(s)) => s,
        Some(serde_json::Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

pub fn parse_webhook_json(body: &[u8]) -> Result<StreamEvent, String> {
    let b: WebhookBody = serde_json::from_slice(body).map_err(|e| format!("not the JSON I expected: {e}"))?;
    let kind = EventKind::parse(&b.kind)
        .ok_or_else(|| format!("unknown type \"{}\" (use follow, sub, raid or chat)", clean(&b.kind, 20)))?;
    Ok(StreamEvent::new(kind, &value_text(b.user), &value_text(b.text)))
}

/// `GET /stream-event?type=follow&user=ana&text=...` (for tools that can only
/// fetch a URL, like Streamer.bot's "Fetch URL" sub-action).
pub fn parse_webhook_query(query: &[(String, String)]) -> Result<StreamEvent, String> {
    let get = |k: &str| query.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str()).unwrap_or("");
    let kind = EventKind::parse(get("type")).ok_or("add type=follow, sub, raid or chat")?;
    Ok(StreamEvent::new(kind, get("user"), get("text")))
}

/// How Glitch reacts: an animation (a name the mascot's `playAction` knows)
/// and the line in his speech bubble.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Reaction {
    pub action: &'static str,
    pub line: String,
    /// The bubble shows "user: text" with the user in bold (chat lines).
    pub speaker: Option<String>,
}

pub fn reaction(e: &StreamEvent) -> Reaction {
    let u = &e.user;
    match e.kind {
        EventKind::Follow => Reaction { action: "wave", line: format!("Thanks for the follow, {u}!"), speaker: None },
        EventKind::Sub => Reaction {
            action: "celebrate",
            line: if e.text.is_empty() {
                format!("{u} just subscribed! Thank you!")
            } else {
                format!("{u} subscribed! \"{}\"", e.text)
            },
            speaker: None,
        },
        EventKind::Raid => Reaction {
            action: "dance",
            line: match e.text.parse::<u32>() {
                Ok(n) if n > 0 => format!("RAID! {u} brought {n} friends! Welcome!"),
                _ => format!("RAID! Welcome, {u} and friends!"),
            },
            speaker: None,
        },
        EventKind::Chat => Reaction { action: "talk", line: e.text.clone(), speaker: Some(u.clone()) },
    }
}

/// Keeps a busy chat from turning Glitch into a ticker: at most one chat
/// line per `chat_gap_ms`, and alerts (follow/sub/raid) at most `burst` per
/// `alert_window_ms` (a follow-bot wave shouldn't queue minutes of waving).
#[derive(Debug, Clone)]
pub struct Throttle {
    pub chat_gap_ms: u64,
    pub alert_window_ms: u64,
    pub burst: usize,
    last_chat: Option<u64>,
    alerts: Vec<u64>,
}

impl Default for Throttle {
    fn default() -> Self {
        Self { chat_gap_ms: 4000, alert_window_ms: 30_000, burst: 6, last_chat: None, alerts: Vec::new() }
    }
}

impl Throttle {
    pub fn allow(&mut self, kind: EventKind, now_ms: u64) -> bool {
        if kind == EventKind::Chat {
            if self.last_chat.is_some_and(|t| now_ms.saturating_sub(t) < self.chat_gap_ms) {
                return false;
            }
            self.last_chat = Some(now_ms);
            return true;
        }
        self.alerts.retain(|&t| now_ms.saturating_sub(t) < self.alert_window_ms);
        if self.alerts.len() >= self.burst {
            return false;
        }
        self.alerts.push(now_ms);
        true
    }
}

/// A fresh secret for the overlay URL: 128 random bits as 32 hex characters.
pub fn new_token() -> String {
    let mut b = [0u8; 16];
    if getrandom::fill(&mut b).is_err() {
        // No OS randomness (never seen in practice): std's randomly seeded hasher.
        use std::hash::{BuildHasher, Hasher};
        let s = std::collections::hash_map::RandomState::new();
        for (i, chunk) in b.chunks_mut(8).enumerate() {
            let mut h = s.build_hasher();
            h.write_usize(i);
            chunk.copy_from_slice(&h.finish().to_le_bytes());
        }
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Compare a token without leaking how many leading characters matched.
pub fn token_matches(expected: &str, given: &str) -> bool {
    if expected.is_empty() || expected.len() != given.len() {
        return false;
    }
    expected.bytes().zip(given.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_strips_controls_and_cuts() {
        assert_eq!(clean("  hi\n\tthere\u{0007}  ", 50), "hi there");
        assert_eq!(clean("a\u{202E}b", 50), "a b");
        assert_eq!(clean("<b>x</b>", 50), "<b>x</b>"); // drawn as text, not HTML
        let long = "x".repeat(300);
        let c = clean(&long, 10);
        assert_eq!(c.chars().count(), 10);
        assert!(c.ends_with('…'));
        assert_eq!(StreamEvent::new(EventKind::Follow, " \n", "").user, "someone");
    }

    #[test]
    fn webhook_json_and_query() {
        let e = parse_webhook_json(br#"{"type":"follow","user":"Ana"}"#).unwrap();
        assert_eq!(e, StreamEvent::new(EventKind::Follow, "Ana", ""));
        let e = parse_webhook_json(br#"{"type":"raid","user":"Bo","text":12}"#).unwrap();
        assert_eq!(e.text, "12");
        let e = parse_webhook_json(br#"{"type":"CHAT","username":"c","message":"hello\nworld"}"#).unwrap();
        assert_eq!((e.kind, e.user.as_str(), e.text.as_str()), (EventKind::Chat, "c", "hello world"));
        assert!(parse_webhook_json(br#"{"type":"donate"}"#).unwrap_err().contains("unknown type"));
        assert!(parse_webhook_json(b"nope").is_err());
        let q = vec![("type".to_string(), "sub".to_string()), ("user".to_string(), "Dee".to_string())];
        assert_eq!(parse_webhook_query(&q).unwrap().kind, EventKind::Sub);
        assert!(parse_webhook_query(&[]).is_err());
    }

    #[test]
    fn reactions() {
        let r = reaction(&StreamEvent::new(EventKind::Follow, "Ana", ""));
        assert_eq!(r.action, "wave");
        assert!(r.line.contains("Ana"));
        assert_eq!(reaction(&StreamEvent::new(EventKind::Sub, "Bo", "")).action, "celebrate");
        let r = reaction(&StreamEvent::new(EventKind::Raid, "Cy", "42"));
        assert!(r.line.contains("42 friends"));
        let r = reaction(&StreamEvent::new(EventKind::Chat, "Dee", "hi Glitch"));
        assert_eq!((r.action, r.line.as_str(), r.speaker.as_deref()), ("talk", "hi Glitch", Some("Dee")));
        // House style: no em or en dashes in anything Glitch says.
        for k in [EventKind::Follow, EventKind::Sub, EventKind::Raid] {
            let line = reaction(&StreamEvent::new(k, "x", "")).line;
            assert!(!line.contains('\u{2014}') && !line.contains('\u{2013}'), "{line}");
        }
    }

    #[test]
    fn throttle_limits_chat_and_alert_floods() {
        let mut t = Throttle::default();
        assert!(t.allow(EventKind::Chat, 0));
        assert!(!t.allow(EventKind::Chat, 1000));
        assert!(t.allow(EventKind::Chat, 4000));
        for i in 0..6 {
            assert!(t.allow(EventKind::Follow, 100 + i));
        }
        assert!(!t.allow(EventKind::Raid, 200));
        assert!(t.allow(EventKind::Raid, 30_200));
    }

    #[test]
    fn tokens() {
        let a = new_token();
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, new_token());
        assert!(token_matches(&a, &a.clone()));
        assert!(!token_matches(&a, &a[..31]));
        assert!(!token_matches("", ""));
        assert!(!token_matches(&a, &new_token()));
    }
}
