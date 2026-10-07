//! Glitch's memory: what he keeps between chats and across restarts.
//!
//! Three layers, all in one small JSON file on this computer:
//! * **facts**: short lasting things about the user ("Their dog is called
//!   Rex"), saved with the `remember` tool or picked out during compaction,
//!   always shown to the model;
//! * **summary**: a rolling summary of today's earlier conversation. When the
//!   chat grows, the oldest messages are compacted into it by the model, so
//!   the context stays small no matter how long you chat;
//! * **journal**: one line per earlier day (the summary moves there when the
//!   date changes), last 30 days.
//!
//! Everything is capped, so the memory section of the prompt stays small.

use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::ai::{Message, Role};

pub const MAX_FACTS: usize = 60;
pub const MAX_FACT_CHARS: usize = 200;
pub const MAX_SUMMARY_CHARS: usize = 900;
pub const MAX_JOURNAL_DAYS: usize = 30;
const MAX_JOURNAL_LINE_CHARS: usize = 220;
/// Messages carried over to the next app start so the chat continues.
const MAX_CARRY_OVER: usize = 12;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Fact {
    pub id: u64,
    pub text: String,
    /// "YYYY-MM-DD"
    pub added: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JournalEntry {
    pub date: String,
    pub text: String,
}

/// A chat message kept for the next app start (text only, no tool calls).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedMessage {
    pub role: Role,
    pub text: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryData {
    pub facts: Vec<Fact>,
    pub summary: String,
    /// Day the summary belongs to.
    pub summary_date: String,
    pub journal: Vec<JournalEntry>,
    /// The unsummarised end of the last conversation.
    pub carry_over: Vec<SavedMessage>,
    pub next_id: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Remembered {
    Added(Fact),
    /// Replaced an older, overlapping fact.
    Updated(Fact),
    AlreadyKnown(Fact),
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{0}")]
pub struct RememberError(pub String);

pub struct MemoryStore {
    pub data: MemoryData,
    path: Option<PathBuf>,
}

impl MemoryStore {
    /// In-memory only (tests, or when there is nowhere to save).
    pub fn in_memory() -> Self {
        Self { data: MemoryData::default(), path: None }
    }

    /// Load from `path`; a missing or broken file starts an empty memory.
    pub fn load(path: &Path) -> Self {
        let data = std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        Self { data, path: Some(path.to_path_buf()) }
    }

    pub fn save(&self) -> io::Result<()> {
        let Some(path) = &self.path else { return Ok(()) };
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&self.data)?)?;
        std::fs::rename(&tmp, path)
    }

    pub fn remember(&mut self, text: &str, today: &str) -> Result<Remembered, RememberError> {
        let text = clean_fact(text)?;
        let key = normalise(&text);
        // Same fact, or one that contains / is contained by an existing one:
        // keep the longer (more specific) wording.
        if let Some(i) = self.data.facts.iter().position(|f| {
            let k = normalise(&f.text);
            k == key || (k.len() >= 12 && key.contains(&k)) || (key.len() >= 12 && k.contains(&key))
        }) {
            let existing = &mut self.data.facts[i];
            if normalise(&existing.text).len() >= key.len() {
                return Ok(Remembered::AlreadyKnown(existing.clone()));
            }
            existing.text = text;
            existing.added = today.to_string();
            return Ok(Remembered::Updated(existing.clone()));
        }
        self.data.next_id += 1;
        let fact = Fact { id: self.data.next_id, text, added: today.to_string() };
        self.data.facts.push(fact.clone());
        if self.data.facts.len() > MAX_FACTS {
            self.data.facts.remove(0); // oldest goes first
        }
        Ok(Remembered::Added(fact))
    }

    pub fn forget_id(&mut self, id: u64) -> Option<Fact> {
        let i = self.data.facts.iter().position(|f| f.id == id)?;
        Some(self.data.facts.remove(i))
    }

    /// Forget facts containing every word of `query` (case-insensitive).
    pub fn forget_matching(&mut self, query: &str) -> Vec<Fact> {
        let words: Vec<String> = query
            .split_whitespace()
            .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase())
            .filter(|w| w.len() >= 2 && !["my", "the", "that", "about", "i", "me"].contains(&w.as_str()))
            .collect();
        if words.is_empty() {
            return Vec::new();
        }
        let (gone, kept): (Vec<Fact>, Vec<Fact>) = self.data.facts.drain(..).partition(|f| {
            let t = f.text.to_lowercase();
            words.iter().all(|w| t.contains(w.as_str()))
        });
        self.data.facts = kept;
        gone
    }

    pub fn clear(&mut self) {
        self.data = MemoryData { next_id: self.data.next_id, ..Default::default() };
    }

    /// When the date changes, today's summary becomes a journal line.
    pub fn roll_day(&mut self, today: &str) {
        if self.data.summary_date == today {
            return;
        }
        if !self.data.summary.trim().is_empty() && !self.data.summary_date.is_empty() {
            let text = truncate_chars(&self.data.summary.replace('\n', " "), MAX_JOURNAL_LINE_CHARS);
            self.data.journal.push(JournalEntry { date: self.data.summary_date.clone(), text });
            let excess = self.data.journal.len().saturating_sub(MAX_JOURNAL_DAYS);
            self.data.journal.drain(..excess);
        }
        self.data.summary.clear();
        self.data.summary_date = today.to_string();
    }

    /// Apply the model's compaction output: new summary + any facts found.
    /// Returns the facts that were newly added.
    pub fn apply_compaction(&mut self, output: &str, today: &str) -> Vec<Fact> {
        let parsed = parse_compaction(output);
        if !parsed.summary.is_empty() {
            self.data.summary = truncate_chars(&parsed.summary, MAX_SUMMARY_CHARS);
            self.data.summary_date = today.to_string();
        }
        parsed
            .facts
            .iter()
            .filter_map(|f| match self.remember(f, today) {
                Ok(Remembered::Added(f)) | Ok(Remembered::Updated(f)) => Some(f),
                _ => None,
            })
            .collect()
    }

    /// The memory part of the system prompt (empty string if nothing known).
    pub fn prompt_section(&self) -> String {
        let mut out = String::new();
        if !self.data.facts.is_empty() {
            out.push_str("What you remember about the user:\n");
            for f in &self.data.facts {
                out.push_str("- ");
                out.push_str(&f.text);
                out.push('\n');
            }
        }
        let recent: Vec<&JournalEntry> = self.data.journal.iter().rev().take(7).collect();
        if !recent.is_empty() {
            out.push_str("Earlier days:\n");
            for e in recent.into_iter().rev() {
                out.push_str(&format!("- {}: {}\n", e.date, e.text));
            }
        }
        if !self.data.summary.trim().is_empty() {
            out.push_str("Earlier today:\n");
            out.push_str(self.data.summary.trim());
            out.push('\n');
        }
        out
    }

    /// Keep the end of the conversation for the next app start.
    pub fn save_carry_over(&mut self, history: &[Message]) {
        let msgs: Vec<SavedMessage> = history
            .iter()
            .filter(|m| matches!(m.role, Role::User | Role::Assistant) && !m.content.trim().is_empty())
            .map(|m| SavedMessage { role: m.role, text: m.content.clone() })
            .collect();
        let start = msgs.len().saturating_sub(MAX_CARRY_OVER);
        self.data.carry_over = msgs[start..].to_vec();
    }

    /// Messages to restore on start-up (always begins with a user message).
    pub fn take_carry_over(&mut self) -> Vec<Message> {
        let saved = std::mem::take(&mut self.data.carry_over);
        let first_user = saved.iter().position(|m| m.role == Role::User).unwrap_or(saved.len());
        saved[first_user..]
            .iter()
            .map(|m| match m.role {
                Role::User => Message::user(&m.text),
                _ => Message::assistant(&m.text),
            })
            .collect()
    }
}

// ------------------------------------------------------------- compaction

/// Messages asking the model to fold `chunk` into the running summary.
pub fn compaction_request(summary: &str, chunk: &[Message]) -> Vec<Message> {
    let mut transcript = String::new();
    for m in chunk {
        match m.role {
            Role::User => transcript.push_str(&format!("User: {}\n", m.content.trim())),
            Role::Assistant if !m.content.trim().is_empty() => {
                transcript.push_str(&format!("Glitch: {}\n", m.content.trim()))
            }
            Role::Assistant => {
                for c in &m.tool_calls {
                    transcript.push_str(&format!("(Glitch used {} {})\n", c.name, c.arguments));
                }
            }
            Role::Tool => {} // tool outputs (file lists etc.) are not worth keeping
            Role::System => {}
        }
    }
    let summary = if summary.trim().is_empty() { "(nothing yet)" } else { summary.trim() };
    vec![
        Message::system(
            "You keep the memory of Glitch, a desktop companion. Rewrite the running summary so it also covers \
             the new conversation: at most 80 words, past tense, about what the user wanted and what happened. \
             After the summary, add one line per LASTING fact about the user that is worth remembering for \
             weeks (name, pets, preferences, projects, people), each starting with \"FACT: \". Only facts the user \
             clearly said. Never facts about passwords, codes or money. No FACT lines if there are none.",
        ),
        Message::user(format!("Running summary:\n{summary}\n\nNew conversation:\n{transcript}")),
    ]
}

#[derive(Debug, Default, PartialEq)]
pub struct Compaction {
    pub summary: String,
    pub facts: Vec<String>,
}

/// Lenient parser: "FACT:" lines are facts, everything else is summary.
pub fn parse_compaction(output: &str) -> Compaction {
    let mut summary = Vec::new();
    let mut facts = Vec::new();
    for line in output.lines() {
        let t = line.trim().trim_start_matches(['-', '*', '•']).trim();
        let lower = t.to_lowercase();
        if lower.starts_with("fact:") {
            let rest = t.get(5..).unwrap_or("").trim();
            if !rest.is_empty() {
                facts.push(rest.to_string());
            }
        } else if lower.starts_with("summary:") {
            let rest = t.get(8..).unwrap_or("").trim();
            if !rest.is_empty() {
                summary.push(rest.to_string());
            }
        } else if !t.is_empty() {
            summary.push(t.to_string());
        }
    }
    Compaction { summary: summary.join(" "), facts }
}

// ---------------------------------------------------------------- helpers

/// Things Glitch refuses to store, even if asked.
fn looks_sensitive(text: &str) -> bool {
    let lower = text.to_lowercase();
    let words = ["password", "passcode", "pin code", "pincode", "credit card", "cvv", "social security", "ssn", "iban"];
    if words.iter().any(|w| lower.contains(w)) {
        return true;
    }
    // Long digit runs: card numbers, account numbers, ID numbers.
    let mut run = 0;
    for c in text.chars() {
        if c.is_ascii_digit() {
            run += 1;
            if run >= 9 {
                return true;
            }
        } else if c != ' ' && c != '-' {
            run = 0;
        }
    }
    false
}

fn clean_fact(text: &str) -> Result<String, RememberError> {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let text = text.trim_matches(|c: char| c == '"' || c == '\'').trim().to_string();
    if text.chars().count() < 3 {
        return Err(RememberError("that's too short to remember".into()));
    }
    if looks_sensitive(&text) {
        return Err(RememberError("for safety, Glitch doesn't remember passwords, codes or card numbers".into()));
    }
    Ok(truncate_chars(&text, MAX_FACT_CHARS))
}

fn normalise(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

fn truncate_chars(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Today's date (UTC) as "YYYY-MM-DD", without a date library.
pub fn today() -> String {
    let days = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() / 86_400).unwrap_or(0);
    ymd_from_days(days as i64)
}

/// Days since 1970-01-01 → "YYYY-MM-DD" (Howard Hinnant's civil_from_days).
fn ymd_from_days(z: i64) -> String {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates() {
        assert_eq!(ymd_from_days(0), "1970-01-01");
        assert_eq!(ymd_from_days(19_723), "2024-01-01");
        assert_eq!(ymd_from_days(20_733), "2026-10-07");
        assert_eq!(ymd_from_days(11_016), "2000-02-29");
        assert_eq!(today().len(), 10);
    }

    #[test]
    fn remember_dedupes_and_prefers_the_more_specific_fact() {
        let mut m = MemoryStore::in_memory();
        assert!(matches!(m.remember("The user's dog is called Rex", "d"), Ok(Remembered::Added(_))));
        assert!(matches!(m.remember("the user's dog is called rex.", "d"), Ok(Remembered::AlreadyKnown(_))));
        let r = m.remember("The user's dog is called Rex, a beagle", "d2").unwrap();
        assert!(matches!(r, Remembered::Updated(ref f) if f.text.ends_with("beagle") && f.added == "d2"));
        assert_eq!(m.data.facts.len(), 1);
    }

    #[test]
    fn remember_refuses_secrets_and_junk() {
        let mut m = MemoryStore::in_memory();
        for bad in ["my password is hunter2", "card 4111 1111 1111 1111", "PIN code 1234", "ok", "  "] {
            assert!(m.remember(bad, "d").is_err(), "{bad}");
        }
        assert!(m.remember("Their phone model is iPhone 15", "d").is_ok());
    }

    #[test]
    fn facts_are_capped_oldest_first() {
        let mut m = MemoryStore::in_memory();
        for i in 0..MAX_FACTS + 5 {
            m.remember(&format!("fact number {i} about cats"), "d").unwrap();
        }
        assert_eq!(m.data.facts.len(), MAX_FACTS);
        assert_eq!(m.data.facts[0].text, "fact number 5 about cats");
        let long = "x".repeat(500);
        let Remembered::Added(f) = m.remember(&long, "d").unwrap() else { panic!() };
        assert_eq!(f.text.chars().count(), MAX_FACT_CHARS);
    }

    #[test]
    fn forget_by_id_and_by_words() {
        let mut m = MemoryStore::in_memory();
        m.remember("Lives in Ghent", "d").unwrap();
        m.remember("Has a dog called Rex", "d").unwrap();
        m.remember("Likes lofi music", "d").unwrap();
        let gone = m.forget_matching("forget about my dog Rex");
        assert!(gone.is_empty(), "'forget' and 'about' are not in the fact");
        let gone = m.forget_matching("dog rex");
        assert_eq!(gone.len(), 1);
        let id = m.data.facts[0].id;
        assert_eq!(m.forget_id(id).unwrap().text, "Lives in Ghent");
        assert_eq!(m.data.facts.len(), 1);
        assert!(m.forget_matching("the my").is_empty());
    }

    #[test]
    fn day_roll_moves_summary_into_journal() {
        let mut m = MemoryStore::in_memory();
        m.roll_day("2026-10-06");
        m.data.summary = "Opened Spotify.\nFound dog photos.".into();
        m.roll_day("2026-10-06");
        assert!(m.data.journal.is_empty());
        m.roll_day("2026-10-07");
        assert_eq!(
            m.data.journal,
            [JournalEntry { date: "2026-10-06".into(), text: "Opened Spotify. Found dog photos.".into() }]
        );
        assert!(m.data.summary.is_empty());
        for d in 0..40 {
            m.data.summary = format!("day {d}");
            m.roll_day(&format!("2027-01-{d:02}"));
        }
        assert_eq!(m.data.journal.len(), MAX_JOURNAL_DAYS);
    }

    #[test]
    fn prompt_section_is_empty_until_something_is_known() {
        let mut m = MemoryStore::in_memory();
        assert_eq!(m.prompt_section(), "");
        m.remember("Name is Andor", "d").unwrap();
        m.data.summary = "Asked for lofi.".into();
        let p = m.prompt_section();
        assert!(p.contains("- Name is Andor") && p.contains("Earlier today:\nAsked for lofi."));
    }

    #[test]
    fn parses_compaction_output_leniently() {
        let out = "Summary: The user asked Glitch to open Spotify and talked about their dog.\n\
                   - FACT: The user's dog is called Rex\nfact: Likes lofi\nFACT:\n";
        let c = parse_compaction(out);
        assert_eq!(c.summary, "The user asked Glitch to open Spotify and talked about their dog.");
        assert_eq!(c.facts, ["The user's dog is called Rex", "Likes lofi"]);
        let mut m = MemoryStore::in_memory();
        let added = m.apply_compaction(out, "2026-10-07");
        assert_eq!(added.len(), 2);
        assert_eq!(m.data.summary_date, "2026-10-07");
        // A bad model answer never wipes the existing summary.
        m.apply_compaction("", "2026-10-07");
        assert!(m.data.summary.starts_with("The user asked"));
    }

    #[test]
    fn compaction_request_skips_tool_output() {
        let chunk = vec![
            Message::user("find my dog photo"),
            Message {
                tool_calls: vec![crate::ai::ToolCall {
                    name: "search_files".into(),
                    arguments: serde_json::json!({"query": "dog"}),
                }],
                ..Message::assistant("")
            },
            Message::tool_result("search_files", "{\"results\":[\"/home/a/secret.jpg\"]}"),
            Message::assistant("Found one!"),
        ];
        let req = compaction_request("", &chunk);
        let body = &req[1].content;
        assert!(body.contains("User: find my dog photo") && body.contains("Glitch: Found one!"));
        assert!(body.contains("(Glitch used search_files"));
        assert!(!body.contains("secret.jpg"));
    }

    #[test]
    fn carry_over_round_trip_and_file_persistence() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memory.json");
        let mut m = MemoryStore::load(&path);
        m.remember("Likes cats", "d").unwrap();
        let history = vec![
            Message::assistant("leftover"),
            Message::user("hi"),
            Message::tool_result("open_url", "{}"),
            Message::assistant("hello!"),
        ];
        m.save_carry_over(&history);
        m.save().unwrap();
        let mut again = MemoryStore::load(&path);
        assert_eq!(again.data.facts.len(), 1);
        let restored = again.take_carry_over();
        assert_eq!(restored, vec![Message::user("hi"), Message::assistant("hello!")]);
        assert!(again.data.carry_over.is_empty());
        std::fs::write(&path, "garbage").unwrap();
        assert_eq!(MemoryStore::load(&path).data, MemoryData::default());
    }
}
