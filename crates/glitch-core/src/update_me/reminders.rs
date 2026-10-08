//! Saved reminders ("remind me to call mum at 5"). Kept in
//! `reminders.json` next to the settings, so they survive restarts.
//!
//! When one is due, Glitch pops up with it. Until the user clicks "Done"
//! (or "Snooze"), he nags again every [`NAG_GAP_SECS`], a bit more insistent
//! each time, and gives up politely after [`MAX_NAGS`] reminders.
//! Times are unix seconds; the caller passes `now` (testable).

use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::clean;

pub const FILE_NAME: &str = "reminders.json";
pub const MAX_TEXT: usize = 200;
pub const MAX_REMINDERS: usize = 50;
/// Ignored reminders come back after this long.
pub const NAG_GAP_SECS: i64 = 10 * 60;
/// How many times one reminder is said (the first time included).
pub const MAX_NAGS: u32 = 4;
/// Reminders that were due while Glitch wasn't running for longer than
/// this are said once ("you missed this"), not nagged.
pub const STALE_SECS: i64 = 12 * 3600;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Reminder {
    pub id: u64,
    pub text: String,
    /// When it was due (unix seconds).
    pub due: i64,
    /// When it is said next (due, or the next nag / the snooze end).
    pub next: i64,
    /// How many times it has been said.
    #[serde(default)]
    pub said: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
struct Data {
    next_id: u64,
    items: Vec<Reminder>,
}

/// What to say now for a reminder that is due.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Due {
    pub id: u64,
    pub text: String,
    /// The line Glitch says (in character, more insistent each time).
    pub line: String,
    /// The last time: no "Snooze", it goes away by itself.
    pub last: bool,
}

pub struct ReminderStore {
    path: PathBuf,
    data: Data,
}

/// The line for the `said`-th time (0 = first).
pub fn nag_line(text: &str, said: u32, missed: bool) -> String {
    if missed {
        return format!("While I was away: {text}. Did that happen?");
    }
    match said {
        0 => format!("Reminder: {text}!"),
        1 => format!("Psst. Still on the list: {text}."),
        2 => format!("*knock knock* {text}. I'm not leaving."),
        _ => format!("Last nag, promise: {text}. I'll let it go now."),
    }
}

impl ReminderStore {
    pub fn load(path: &Path) -> Self {
        let data = std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        Self { path: path.to_path_buf(), data }
    }

    pub fn save(&self) -> io::Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&self.data)?)?;
        std::fs::rename(&tmp, &self.path)
    }

    /// Sorted by due time.
    pub fn list(&self) -> Vec<Reminder> {
        let mut v = self.data.items.clone();
        v.sort_by_key(|r| r.next);
        v
    }

    pub fn add(&mut self, text: &str, due: i64, now: i64) -> Result<Reminder, String> {
        let text = clean(text, MAX_TEXT);
        if text.is_empty() {
            return Err("what should I remind you of?".into());
        }
        if due <= now {
            return Err("that time is already in the past".into());
        }
        if self.data.items.len() >= MAX_REMINDERS {
            return Err(format!("there are already {MAX_REMINDERS} reminders; delete some in Settings first"));
        }
        // The same reminder twice (a model repeating itself) is one reminder.
        if let Some(r) = self.data.items.iter().find(|r| r.text == text && r.due == due) {
            return Ok(r.clone());
        }
        self.data.next_id += 1;
        let r = Reminder { id: self.data.next_id, text, due, next: due, said: 0 };
        self.data.items.push(r.clone());
        Ok(r)
    }

    pub fn remove(&mut self, id: u64) -> bool {
        let n = self.data.items.len();
        self.data.items.retain(|r| r.id != id);
        n != self.data.items.len()
    }

    pub fn snooze(&mut self, id: u64, minutes: i64, now: i64) -> bool {
        match self.data.items.iter_mut().find(|r| r.id == id) {
            Some(r) => {
                r.next = now + minutes.clamp(1, 24 * 60) * 60;
                // A snooze starts the nagging over.
                r.said = 0;
                true
            }
            None => false,
        }
    }

    /// The soonest time something is said (for the UI / scheduling).
    pub fn next_time(&self) -> Option<i64> {
        self.data.items.iter().map(|r| r.next).min()
    }

    /// Everything due at `now`: what to say, and bookkeeping (next nag, or
    /// gone after the last one). Returns whether anything changed.
    pub fn take_due(&mut self, now: i64) -> Vec<Due> {
        let mut out = Vec::new();
        for r in self.data.items.iter_mut().filter(|r| r.next <= now) {
            let missed = r.said == 0 && now - r.due > STALE_SECS;
            let last = missed || r.said + 1 >= MAX_NAGS;
            out.push(Due { id: r.id, text: r.text.clone(), line: nag_line(&r.text, r.said, missed), last });
            r.said += 1;
            r.next = if last { i64::MIN } else { now + NAG_GAP_SECS };
        }
        self.data.items.retain(|r| r.next != i64::MIN);
        out
    }

    /// Reminders due between `from` and `to` (for the daily briefing).
    pub fn between(&self, from: i64, to: i64) -> Vec<Reminder> {
        self.list().into_iter().filter(|r| r.next >= from && r.next < to).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_list_remove_and_persist() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let mut s = ReminderStore::load(&path);
        let a = s.add("call mum", 2000, 1000).unwrap();
        let b = s.add("  water \n the plants ", 1500, 1000).unwrap();
        assert_eq!(b.text, "water the plants");
        // Same again: no duplicate.
        assert_eq!(s.add("call mum", 2000, 1000).unwrap().id, a.id);
        assert!(s.add("", 2000, 1000).is_err());
        assert!(s.add("late", 999, 1000).is_err());
        s.save().unwrap();
        // A restart keeps them, sorted by time.
        let mut s = ReminderStore::load(&path);
        assert_eq!(s.list().iter().map(|r| r.id).collect::<Vec<_>>(), vec![b.id, a.id]);
        assert_eq!(s.next_time(), Some(1500));
        assert!(s.remove(b.id));
        assert!(!s.remove(b.id));
        let c = s.add("new", 3000, 1000).unwrap();
        assert!(c.id > b.id, "ids are never reused");
    }

    #[test]
    fn nags_until_done_then_gives_up() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = ReminderStore::load(&dir.path().join(FILE_NAME));
        let r = s.add("stretch", 100, 0).unwrap();
        assert!(s.take_due(99).is_empty());
        let mut t = 100;
        let mut lines = Vec::new();
        loop {
            let due = s.take_due(t);
            if due.is_empty() {
                break;
            }
            assert_eq!(due.len(), 1);
            lines.push(due[0].line.clone());
            if due[0].last {
                break;
            }
            // Not again before the gap.
            assert!(s.take_due(t + NAG_GAP_SECS - 1).is_empty());
            t += NAG_GAP_SECS;
        }
        assert_eq!(lines.len() as u32, MAX_NAGS);
        assert_eq!(lines[0], "Reminder: stretch!");
        assert!(lines.last().unwrap().starts_with("Last nag"));
        assert!(lines.iter().all(|l| !l.contains('\u{2014}') && !l.contains('\u{2013}')));
        assert!(s.list().is_empty());
        assert!(!s.remove(r.id));
    }

    #[test]
    fn snooze_and_missed_while_away() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = ReminderStore::load(&dir.path().join(FILE_NAME));
        let r = s.add("tea", 100, 0).unwrap();
        assert_eq!(s.take_due(100).len(), 1);
        assert!(s.snooze(r.id, 5, 200));
        assert!(s.take_due(499).is_empty());
        assert_eq!(s.take_due(500)[0].line, "Reminder: tea!");
        // Due long ago (Glitch wasn't running): said once, then gone.
        let old = s.add("old thing", 1000, 900).unwrap();
        let due = s.take_due(1000 + STALE_SECS + 1);
        let d = due.iter().find(|d| d.id == old.id).unwrap();
        assert!(d.last && d.line.starts_with("While I was away"));
        assert!(s.list().iter().all(|x| x.id != old.id));
    }

    #[test]
    fn between_for_the_briefing() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = ReminderStore::load(&dir.path().join(FILE_NAME));
        s.add("a", 100, 0).unwrap();
        s.add("b", 200, 0).unwrap();
        s.add("c", 300, 0).unwrap();
        assert_eq!(s.between(150, 300).iter().map(|r| r.text.as_str()).collect::<Vec<_>>(), ["b"]);
    }
}
