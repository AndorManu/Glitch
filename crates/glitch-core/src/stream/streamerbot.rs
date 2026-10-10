//! Streamer.bot's WebSocket server (Servers/Clients > WebSocket Server,
//! default `ws://127.0.0.1:8080/`): subscribe to follows, subs, raids and
//! chat, and turn its event messages into [`StreamEvent`]s. Payloads differ
//! between Streamer.bot versions, so names are looked up in several places.

use serde_json::{json, Value};

use super::{EventKind, StreamEvent};

pub const DEFAULT_URL: &str = "ws://127.0.0.1:8080/";

/// One Subscribe request per platform, so a platform this Streamer.bot
/// version doesn't know can't make the other one fail.
pub fn subscribe_requests() -> Vec<String> {
    vec![
        json!({"request": "Subscribe", "id": "glitch-twitch", "events": {"Twitch": ["Follow", "Sub", "ReSub", "GiftSub", "GiftBomb", "Raid", "ChatMessage"]}}).to_string(),
        json!({"request": "Subscribe", "id": "glitch-youtube", "events": {"YouTube": ["NewSubscriber", "NewSponsor", "MembershipGift", "Message"]}}).to_string(),
    ]
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Message {
    /// The greeting; `auth` = it wants a password first.
    Hello {
        auth: bool,
    },
    Event(StreamEvent),
    Other,
}

fn kind_for(source: &str, kind: &str) -> Option<EventKind> {
    match (source.to_ascii_lowercase().as_str(), kind) {
        ("twitch", "Follow") | ("youtube", "NewSubscriber") => Some(EventKind::Follow),
        ("twitch", "Sub" | "ReSub" | "GiftSub" | "GiftBomb") | ("youtube", "NewSponsor" | "MembershipGift") => {
            Some(EventKind::Sub)
        }
        ("twitch", "Raid") => Some(EventKind::Raid),
        ("twitch", "ChatMessage") | ("youtube", "Message") => Some(EventKind::Chat),
        _ => None,
    }
}

fn at<'a>(v: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.').try_fold(v, |v, k| v.get(k))
}

fn first_str(v: &Value, paths: &[&str]) -> String {
    for p in paths {
        match at(v, p) {
            Some(Value::String(s)) if !s.trim().is_empty() => return s.clone(),
            Some(Value::Number(n)) => return n.to_string(),
            _ => {}
        }
    }
    String::new()
}

const USER: &[&str] = &[
    "user.name",
    "user.display_name",
    "user.displayName",
    "user.login",
    "targetUser.name",
    "from_broadcaster_user_name",
    "fromBroadcaster.name",
    "displayName",
    "display_name",
    "userName",
    "user_name",
    "message.displayName",
    "message.username",
    "author.name",
    "user",
];
const TEXT: &[&str] = &["text", "message.message", "messageStripped", "message.text", "message", "rawInput"];
const VIEWERS: &[&str] = &["viewers", "viewerCount", "viewer_count", "raidViewers"];

pub fn parse(text: &str) -> Message {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return Message::Other };
    if v.get("request").and_then(Value::as_str) == Some("Hello") {
        return Message::Hello { auth: v.get("authentication").is_some_and(|a| !a.is_null()) };
    }
    let (Some(source), Some(kind)) =
        (at(&v, "event.source").and_then(Value::as_str), at(&v, "event.type").and_then(Value::as_str))
    else {
        return Message::Other;
    };
    let Some(k) = kind_for(source, kind) else { return Message::Other };
    let data = v.get("data").unwrap_or(&Value::Null);
    let user = first_str(data, USER);
    let text = match k {
        EventKind::Chat => first_str(data, TEXT),
        EventKind::Raid => first_str(data, VIEWERS),
        EventKind::Sub => first_str(data, &["text", "message.message", "message"]),
        EventKind::Follow => String::new(),
    };
    // Bot test buttons and empty chat lines: nothing to show.
    if k == EventKind::Chat && text.trim().is_empty() {
        return Message::Other;
    }
    Message::Event(StreamEvent::new(k, &user, &text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subscribes_per_platform() {
        let r = subscribe_requests();
        assert_eq!(r.len(), 2);
        let v: Value = serde_json::from_str(&r[0]).unwrap();
        assert_eq!(v["request"], "Subscribe");
        assert!(v["events"]["Twitch"].as_array().unwrap().iter().any(|e| e == "Raid"));
    }

    #[test]
    fn hello() {
        assert_eq!(parse(r#"{"request":"Hello","info":{}}"#), Message::Hello { auth: false });
        assert_eq!(
            parse(r#"{"request":"Hello","authentication":{"challenge":"c","salt":"s"}}"#),
            Message::Hello { auth: true }
        );
    }

    #[test]
    fn current_payloads() {
        let chat = r#"{"timeStamp":"x","event":{"source":"Twitch","type":"ChatMessage"},"data":{"user":{"id":"1","login":"ana","name":"Ana"},"text":"hello glitch"}}"#;
        assert_eq!(parse(chat), Message::Event(StreamEvent::new(EventKind::Chat, "Ana", "hello glitch")));
        let follow = r#"{"event":{"source":"Twitch","type":"Follow"},"data":{"targetUser":{"login":"bo","name":"Bo"},"isTest":false}}"#;
        assert_eq!(parse(follow), Message::Event(StreamEvent::new(EventKind::Follow, "Bo", "")));
        let raid =
            r#"{"event":{"source":"Twitch","type":"Raid"},"data":{"from_broadcaster_user_name":"Cy","viewers":17}}"#;
        assert_eq!(parse(raid), Message::Event(StreamEvent::new(EventKind::Raid, "Cy", "17")));
    }

    #[test]
    fn older_payloads_and_youtube() {
        let chat = r#"{"event":{"source":"Twitch","type":"ChatMessage"},"data":{"message":{"displayName":"Dee","message":"hi"}}}"#;
        assert_eq!(parse(chat), Message::Event(StreamEvent::new(EventKind::Chat, "Dee", "hi")));
        let sub = r#"{"event":{"source":"Twitch","type":"Sub"},"data":{"userName":"Eve"}}"#;
        assert_eq!(parse(sub), Message::Event(StreamEvent::new(EventKind::Sub, "Eve", "")));
        let yt = r#"{"event":{"source":"YouTube","type":"Message"},"data":{"user":{"name":"Fay"},"message":"yo"}}"#;
        assert_eq!(parse(yt), Message::Event(StreamEvent::new(EventKind::Chat, "Fay", "yo")));
    }

    #[test]
    fn ignores_the_rest() {
        assert_eq!(parse("not json"), Message::Other);
        assert_eq!(parse(r#"{"id":"glitch-twitch","status":"ok"}"#), Message::Other);
        assert_eq!(parse(r#"{"event":{"source":"Twitch","type":"Cheer"},"data":{}}"#), Message::Other);
        assert_eq!(
            parse(r#"{"event":{"source":"Twitch","type":"ChatMessage"},"data":{"user":{"name":"x"}}}"#),
            Message::Other
        );
    }
}
