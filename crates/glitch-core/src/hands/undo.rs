//! "Undo last Glitch action": a small log of what desktop control moved,
//! so it can be put back. Saved as `undo.json` in the app data folder, so
//! the button still works after a restart.
//!
//! Only two things are undoable, because only two things are changed
//! without being able to ask the app: files that were moved or renamed, and
//! where windows were (position, size, maximized). Clicks and typing inside
//! apps belong to those apps' own undo (Ctrl+Z).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::winops::WinGeom;

/// Oldest entries fall off.
pub const MAX_ENTRIES: usize = 50;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UndoEntry {
    FileMove { from: PathBuf, to: PathBuf, is_dir: bool, size: u64, modified: u64, at: u64 },
    WindowMove { window: u64, pid: u32, started: u64, app: String, title: String, before: WinGeom, at: u64 },
}

impl UndoEntry {
    /// "Move report.txt back to Desktop" for the button and the log.
    pub fn describe(&self) -> String {
        let name = |p: &Path| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        match self {
            UndoEntry::FileMove { from, to, .. } => {
                let dir = from.parent().and_then(|d| d.file_name()).map(|d| d.to_string_lossy().into_owned());
                format!("Move {} back{}", name(to), dir.map(|d| format!(" to {d}")).unwrap_or_default())
            }
            UndoEntry::WindowMove { app, before, .. } => format!("Put {app} back ({})", before.describe()),
        }
    }
}

pub fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

#[derive(Debug, Default)]
pub struct UndoLog {
    path: Option<PathBuf>,
    entries: Vec<UndoEntry>,
}

#[derive(Serialize, Deserialize, Default)]
struct OnDisk {
    entries: Vec<UndoEntry>,
}

impl UndoLog {
    /// In memory only (tests, or no data folder).
    pub fn memory() -> Self {
        Self::default()
    }

    /// Load from `path` (a missing or broken file is an empty log).
    pub fn open(path: PathBuf) -> Self {
        let entries = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str::<OnDisk>(&t).ok())
            .map(|d| d.entries)
            .unwrap_or_default();
        let mut log = Self { path: Some(path), entries };
        log.cap();
        log
    }

    fn cap(&mut self) {
        let extra = self.entries.len().saturating_sub(MAX_ENTRIES);
        self.entries.drain(..extra);
    }

    fn save(&self) {
        let Some(path) = &self.path else { return };
        let Ok(text) = serde_json::to_string_pretty(&OnDisk { entries: self.entries.clone() }) else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // Write a sibling and rename over: a crash never leaves half a file.
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, text).is_ok() && std::fs::rename(&tmp, path).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }

    pub fn push(&mut self, e: UndoEntry) {
        self.entries.push(e);
        self.cap();
        self.save();
    }

    pub fn last(&self) -> Option<&UndoEntry> {
        self.entries.last()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Take the newest entry off (the caller undoes it, and `push`es it back
    /// if that failed so it can be tried again).
    pub fn pop(&mut self) -> Option<UndoEntry> {
        let e = self.entries.pop();
        self.save();
        e
    }

    pub fn entries(&self) -> &[UndoEntry] {
        &self.entries
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hands::winops::WinState;

    fn mv(n: u64) -> UndoEntry {
        UndoEntry::FileMove {
            from: PathBuf::from(format!("C:/Users/a/Desktop/f{n}.txt")),
            to: PathBuf::from(format!("C:/Users/a/Documents/f{n}.txt")),
            is_dir: false,
            size: n,
            modified: 1,
            at: 2,
        }
    }

    fn win() -> UndoEntry {
        UndoEntry::WindowMove {
            window: 7,
            pid: 99,
            started: 5,
            app: "Notepad".into(),
            title: "notes".into(),
            before: WinGeom { rect: (10, 20, 810, 620), state: WinState::Normal },
            at: 3,
        }
    }

    #[test]
    fn the_log_is_last_in_first_out() {
        let mut l = UndoLog::memory();
        assert!(l.is_empty() && l.pop().is_none());
        l.push(mv(1));
        l.push(win());
        assert_eq!(l.len(), 2);
        assert_eq!(l.pop(), Some(win()));
        assert_eq!(l.last(), Some(&mv(1)));
    }

    #[test]
    fn it_survives_a_restart_and_a_broken_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data").join("undo.json");
        let mut l = UndoLog::open(path.clone());
        l.push(mv(1));
        l.push(win());
        let again = UndoLog::open(path.clone());
        assert_eq!(again.entries(), [mv(1), win()]);
        std::fs::write(&path, "{ not json").unwrap();
        assert!(UndoLog::open(path).is_empty(), "a broken file is an empty log, not a crash");
    }

    #[test]
    fn only_the_newest_fifty_are_kept() {
        let mut l = UndoLog::memory();
        for n in 0..70 {
            l.push(mv(n));
        }
        assert_eq!(l.len(), MAX_ENTRIES);
        assert_eq!(l.entries()[0], mv(20));
    }

    #[test]
    fn entries_describe_themselves_for_the_button() {
        assert_eq!(mv(1).describe(), "Move f1.txt back to Desktop");
        assert_eq!(win().describe(), "Put Notepad back (800x600 at 10,20)");
    }

    #[test]
    fn popping_is_saved() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("undo.json");
        let mut l = UndoLog::open(path.clone());
        l.push(mv(1));
        l.pop();
        assert!(UndoLog::open(path).is_empty());
    }
}
