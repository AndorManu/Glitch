//! Twitch chat, read-only: an anonymous IRC login (`justinfan<number>`,
//! which Twitch allows for reading public chat without an account or a
//! token). Glitch only ever sends CAP / PASS / NICK / JOIN / PONG: there is
//! no code path that sends PRIVMSG, so he can't post in chat.

use std::collections::HashMap;

use super::{EventKind, StreamEvent};

pub const HOST: &str = "irc.chat.twitch.tv";
/// TLS port.
pub const PORT: u16 = 6697;

/// A Twitch login name from what the user typed ("#Name", "twitch.tv/name"...).
pub fn channel_name(input: &str) -> Option<String> {
    let s = input.trim().trim_end_matches('/');
    let s = s.rsplit('/').next().unwrap_or(s).trim_start_matches('#').to_ascii_lowercase();
    let ok =
        (3..=25).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && !s.starts_with('_');
    ok.then_some(s)
}

/// The lines that log in anonymously and join `channel` (already validated).
pub fn login(channel: &str, nick_number: u32) -> Vec<String> {
    vec![
        "CAP REQ :twitch.tv/tags twitch.tv/commands".into(),
        "PASS SCHMOOPIIE".into(),
        format!("NICK justinfan{}", 10_000 + nick_number % 89_999),
        format!("JOIN #{channel}"),
    ]
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Line {
    /// Answer with `PONG :<payload>`.
    Ping(String),
    Event(StreamEvent),
    /// Twitch asks clients to reconnect (server maintenance).
    Reconnect,
    /// The channel was joined (ROOMSTATE or our JOIN echoed).
    Joined,
    Other,
}

fn unescape(v: &str) -> String {
    let mut out = String::new();
    let mut it = v.chars();
    while let Some(c) = it.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match it.next() {
            Some('s') => out.push(' '),
            Some(':') => out.push(';'),
            Some('\\') => out.push('\\'),
            Some('r') | Some('n') => out.push(' '),
            Some(o) => out.push(o),
            None => {}
        }
    }
    out
}

pub fn parse(line: &str) -> Line {
    let mut rest = line.trim_end_matches(['\r', '\n']);
    let mut tags = HashMap::new();
    if let Some(t) = rest.strip_prefix('@') {
        let (raw, r) = t.split_once(' ').unwrap_or((t, ""));
        for kv in raw.split(';') {
            let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
            tags.insert(k.to_string(), unescape(v));
        }
        rest = r;
    }
    let mut nick = "";
    if let Some(p) = rest.strip_prefix(':') {
        let (prefix, r) = p.split_once(' ').unwrap_or((p, ""));
        nick = prefix.split('!').next().unwrap_or("");
        rest = r;
    }
    let (head, trailing) = match rest.split_once(" :") {
        Some((h, t)) => (h, t),
        None => (rest, ""),
    };
    let command = head.split(' ').next().unwrap_or("");
    let tag = |k: &str| tags.get(k).map(String::as_str).unwrap_or("");
    let name = |fallback: &str| {
        let d = tag("display-name");
        if d.is_empty() {
            fallback.to_string()
        } else {
            d.to_string()
        }
    };
    match command {
        "PING" => Line::Ping(if trailing.is_empty() {
            head.trim_start_matches("PING").trim().to_string()
        } else {
            trailing.to_string()
        }),
        "RECONNECT" => Line::Reconnect,
        "ROOMSTATE" | "JOIN" => Line::Joined,
        "PRIVMSG" => {
            // "/me waves" arrives as \x01ACTION waves\x01.
            let text = trailing.strip_prefix("\u{1}ACTION ").map(|t| t.trim_end_matches('\u{1}')).unwrap_or(trailing);
            if text.trim().is_empty() {
                return Line::Other;
            }
            Line::Event(StreamEvent::new(EventKind::Chat, &name(nick), text))
        }
        "USERNOTICE" => match tag("msg-id") {
            "sub" | "resub" | "subgift" | "submysterygift" | "anonsubgift" | "giftpaidupgrade" | "primepaidupgrade" => {
                let user =
                    if tag("msg-id") == "anonsubgift" { "An anonymous gifter".to_string() } else { name(tag("login")) };
                Line::Event(StreamEvent::new(EventKind::Sub, &user, trailing))
            }
            "raid" => {
                let user = tag("msg-param-displayName");
                let user = if user.is_empty() { name(tag("login")) } else { user.to_string() };
                Line::Event(StreamEvent::new(EventKind::Raid, &user, tag("msg-param-viewerCount")))
            }
            _ => Line::Other,
        },
        _ => Line::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_names() {
        assert_eq!(channel_name("#SomeStreamer").as_deref(), Some("somestreamer"));
        assert_eq!(channel_name("https://www.twitch.tv/some_one/").as_deref(), Some("some_one"));
        assert_eq!(channel_name("ab"), None);
        assert_eq!(channel_name("bad name"), None);
        assert_eq!(channel_name("x\r\nPRIVMSG #y :hi"), None);
        assert_eq!(channel_name(""), None);
    }

    #[test]
    fn login_is_anonymous_and_never_posts() {
        let l = login("glitchfan", 7);
        assert!(l.contains(&"NICK justinfan10007".to_string()));
        assert!(l.contains(&"JOIN #glitchfan".to_string()));
        assert!(l.iter().all(|x| !x.contains("PRIVMSG")));
        assert!(l.iter().any(|x| x.starts_with("PASS ")));
    }

    #[test]
    fn chat_lines() {
        let l = "@badge-info=;display-name=Ana\\sB;user-id=1 :ana!ana@ana.tmi.twitch.tv PRIVMSG #chan :hello there :)";
        assert_eq!(parse(l), Line::Event(StreamEvent::new(EventKind::Chat, "Ana B", "hello there :)")));
        let me = ":bo!bo@bo.tmi.twitch.tv PRIVMSG #chan :\u{1}ACTION waves\u{1}";
        assert_eq!(parse(me), Line::Event(StreamEvent::new(EventKind::Chat, "bo", "waves")));
    }

    #[test]
    fn subs_and_raids() {
        let sub = "@display-name=Cy;login=cy;msg-id=resub :tmi.twitch.tv USERNOTICE #chan :love the raccoon";
        assert_eq!(parse(sub), Line::Event(StreamEvent::new(EventKind::Sub, "Cy", "love the raccoon")));
        let raid =
            "@login=dee;msg-id=raid;msg-param-displayName=Dee;msg-param-viewerCount=25 :tmi.twitch.tv USERNOTICE #chan";
        assert_eq!(parse(raid), Line::Event(StreamEvent::new(EventKind::Raid, "Dee", "25")));
        assert_eq!(parse("@msg-id=announcement :tmi.twitch.tv USERNOTICE #chan :x"), Line::Other);
    }

    #[test]
    fn housekeeping() {
        assert_eq!(parse("PING :tmi.twitch.tv"), Line::Ping("tmi.twitch.tv".into()));
        assert_eq!(parse(":tmi.twitch.tv RECONNECT"), Line::Reconnect);
        assert_eq!(parse("@room-id=1 :tmi.twitch.tv ROOMSTATE #chan"), Line::Joined);
        assert_eq!(parse(":tmi.twitch.tv 001 justinfan1 :Welcome, GLHF!"), Line::Other);
    }
}
