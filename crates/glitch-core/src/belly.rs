//! Glitch's belly: files the user feeds him (drag a file onto him) are MOVED
//! into a folder the user chose, never deleted, and listed here so each one
//! can be put back where it came from.
//!
//! Safety rules (all here, unit-tested):
//! * only regular files (no folders, no symlinks/shortcut targets followed),
//!   never anything already inside the belly;
//! * a move is a rename; across drives it is copy -> check size -> remove the
//!   original, and if removing fails the copy is removed again (the original
//!   stays where it was). Nothing is ever deleted without a verified copy;
//! * names never clash: "report (2).pdf" instead of overwriting;
//! * restore never overwrites either: if something new now has the original
//!   name, the file comes back as "name (restored).ext".

use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// At most this many files per drop.
pub const MAX_PER_MEAL: usize = 10;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Eaten {
    pub id: u64,
    /// File name as it was.
    pub name: String,
    /// Where it came from (restore puts it back here).
    pub original: String,
    /// Where it is now, inside the belly folder.
    pub stored: String,
    pub size: u64,
    /// Local date-time "YYYY-MM-DD HH:MM".
    pub eaten: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct BellyData {
    pub items: Vec<Eaten>,
    pub next_id: u64,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum BellyError {
    #[error("{0} isn't there any more")]
    Missing(String),
    #[error("{0} is a folder; I only eat files")]
    NotAFile(String),
    #[error("{0} is a shortcut/link; I only eat real files")]
    Link(String),
    #[error("{0} is already in my belly")]
    AlreadyInside(String),
    #[error("I couldn't move {0}: {1}")]
    Io(String, String),
    #[error("I don't know that snack")]
    UnknownId,
}

pub struct Belly {
    pub data: BellyData,
    path: Option<PathBuf>,
}

fn display(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.display().to_string())
}

/// `dir/name`, or `dir/stem (2).ext`, `(3)`... whatever doesn't exist yet.
/// With `tag`, the first try is `stem (tag).ext`.
pub fn free_name(dir: &Path, name: &str, tag: Option<&str>) -> PathBuf {
    let p = Path::new(name);
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| name.to_string());
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let first = match tag {
        None => dir.join(name),
        Some(t) => dir.join(format!("{stem} ({t}){ext}")),
    };
    if std::fs::symlink_metadata(&first).is_err() {
        return first;
    }
    for n in 2..10_000 {
        let label = match tag {
            None => format!("{n}"),
            Some(t) => format!("{t} {n}"),
        };
        let c = dir.join(format!("{stem} ({label}){ext}"));
        if std::fs::symlink_metadata(&c).is_err() {
            return c;
        }
    }
    dir.join(format!("{stem} ({}){ext}", std::process::id()))
}

/// Move a file: rename, or (across drives) copy, verify, remove the original.
pub fn move_file(from: &Path, to: &Path) -> io::Result<()> {
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    let size = std::fs::metadata(from)?.len();
    std::fs::copy(from, to)?;
    let copied = std::fs::metadata(to).map(|m| m.len()).unwrap_or(u64::MAX);
    if copied != size {
        let _ = std::fs::remove_file(to);
        return Err(io::Error::other("the copy came out the wrong size"));
    }
    if let Err(e) = std::fs::remove_file(from) {
        // Couldn't take the original: undo, so there is exactly one copy.
        let _ = std::fs::remove_file(to);
        return Err(e);
    }
    Ok(())
}

fn inside(path: &Path, dir: &Path) -> bool {
    let canon = |p: &Path| dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    canon(path).starts_with(canon(dir))
}

impl Belly {
    pub fn in_memory() -> Self {
        Self { data: BellyData::default(), path: None }
    }

    pub fn load(path: &Path) -> Self {
        let data = match std::fs::read_to_string(path) {
            Err(_) => BellyData::default(),
            Ok(s) => serde_json::from_str(&s).unwrap_or_else(|_| {
                let _ = std::fs::rename(path, path.with_extension("corrupt.json"));
                BellyData::default()
            }),
        };
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

    /// Is this something he may eat? (Checked before asking the user.)
    pub fn check(src: &Path, belly_dir: &Path) -> Result<u64, BellyError> {
        let name = display(src);
        let meta = std::fs::symlink_metadata(src).map_err(|_| BellyError::Missing(name.clone()))?;
        if meta.file_type().is_symlink() {
            return Err(BellyError::Link(name));
        }
        if !meta.is_file() {
            return Err(BellyError::NotAFile(name));
        }
        if inside(src, belly_dir) {
            return Err(BellyError::AlreadyInside(name));
        }
        Ok(meta.len())
    }

    /// Move `src` into `belly_dir` and remember where it came from.
    pub fn eat(&mut self, src: &Path, belly_dir: &Path, now: &str) -> Result<Eaten, BellyError> {
        let size = Self::check(src, belly_dir)?;
        let name = display(src);
        std::fs::create_dir_all(belly_dir).map_err(|e| BellyError::Io(name.clone(), e.to_string()))?;
        let original = dunce::canonicalize(src).unwrap_or_else(|_| src.to_path_buf());
        let to = free_name(belly_dir, &name, None);
        move_file(src, &to).map_err(|e| BellyError::Io(name.clone(), e.to_string()))?;
        self.data.next_id += 1;
        let item = Eaten {
            id: self.data.next_id,
            name,
            original: original.display().to_string(),
            stored: to.display().to_string(),
            size,
            eaten: now.to_string(),
        };
        self.data.items.push(item.clone());
        Ok(item)
    }

    /// Put an eaten file back where it came from. Returns where it went.
    pub fn restore(&mut self, id: u64) -> Result<PathBuf, BellyError> {
        let i = self.data.items.iter().position(|e| e.id == id).ok_or(BellyError::UnknownId)?;
        let item = self.data.items[i].clone();
        let stored = PathBuf::from(&item.stored);
        if std::fs::symlink_metadata(&stored).is_err() {
            // Gone from the belly folder (the user moved it): nothing to put back.
            self.data.items.remove(i);
            return Err(BellyError::Missing(item.name));
        }
        let original = PathBuf::from(&item.original);
        let dir = original.parent().map(Path::to_path_buf).unwrap_or_default();
        std::fs::create_dir_all(&dir).map_err(|e| BellyError::Io(item.name.clone(), e.to_string()))?;
        let file_name = original.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(item.name.clone());
        let to = if std::fs::symlink_metadata(&original).is_err() {
            original.clone()
        } else {
            free_name(&dir, &file_name, Some("restored"))
        };
        move_file(&stored, &to).map_err(|e| BellyError::Io(item.name.clone(), e.to_string()))?;
        self.data.items.remove(i);
        Ok(to)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eat_moves_and_restore_brings_back() {
        let t = tempfile::tempdir().unwrap();
        let docs = t.path().join("docs");
        std::fs::create_dir_all(&docs).unwrap();
        let src = docs.join("report.pdf");
        std::fs::write(&src, b"hello").unwrap();
        let belly_dir = t.path().join("belly");
        let mut b = Belly::in_memory();
        let e = b.eat(&src, &belly_dir, "2026-10-07 10:00").unwrap();
        assert!(!src.exists(), "moved, not copied");
        assert_eq!(std::fs::read(&e.stored).unwrap(), b"hello");
        assert_eq!((e.size, e.name.as_str()), (5, "report.pdf"));
        // Same name again: no overwrite.
        std::fs::write(&src, b"second").unwrap();
        let e2 = b.eat(&src, &belly_dir, "x").unwrap();
        assert!(e2.stored.ends_with("report (2).pdf"), "{}", e2.stored);
        assert_eq!(std::fs::read(&e.stored).unwrap(), b"hello");
        // Restore the first one.
        let back = b.restore(e.id).unwrap();
        assert_eq!(std::fs::read(&back).unwrap(), b"hello");
        assert_eq!(dunce::canonicalize(&back).unwrap(), dunce::canonicalize(&src).unwrap());
        assert_eq!(b.data.items.len(), 1);
        // Restore the second: the name is taken now, so it comes back next to it.
        let back2 = b.restore(e2.id).unwrap();
        assert!(back2.ends_with("report (restored).pdf"), "{}", back2.display());
        assert_eq!(std::fs::read(&back).unwrap(), b"hello");
        assert_eq!(std::fs::read(&back2).unwrap(), b"second");
        assert!(b.data.items.is_empty());
        assert_eq!(b.restore(e.id), Err(BellyError::UnknownId));
    }

    #[test]
    fn refuses_folders_missing_files_and_the_belly_itself() {
        let t = tempfile::tempdir().unwrap();
        let belly_dir = t.path().join("belly");
        std::fs::create_dir_all(&belly_dir).unwrap();
        let mut b = Belly::in_memory();
        assert!(matches!(
            b.eat(t.path(), &belly_dir, "x"),
            Err(BellyError::NotAFile(_) | BellyError::AlreadyInside(_))
        ));
        let sub = t.path().join("folder");
        std::fs::create_dir_all(&sub).unwrap();
        assert!(matches!(b.eat(&sub, &belly_dir, "x"), Err(BellyError::NotAFile(_))));
        assert!(matches!(b.eat(&t.path().join("nope.txt"), &belly_dir, "x"), Err(BellyError::Missing(_))));
        let inner = belly_dir.join("a.txt");
        std::fs::write(&inner, b"a").unwrap();
        assert!(matches!(b.eat(&inner, &belly_dir, "x"), Err(BellyError::AlreadyInside(_))));
        assert!(inner.exists());
        assert!(b.data.items.is_empty());
    }

    #[test]
    fn restore_recreates_the_folder_and_drops_vanished_entries() {
        let t = tempfile::tempdir().unwrap();
        let dir = t.path().join("gone/deep");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("n.txt");
        std::fs::write(&src, b"n").unwrap();
        let mut b = Belly::in_memory();
        let e = b.eat(&src, &t.path().join("belly"), "x").unwrap();
        std::fs::remove_dir_all(t.path().join("gone")).unwrap();
        assert_eq!(b.restore(e.id).unwrap(), PathBuf::from(&e.original));
        assert!(src.exists());
        // The user took it out of the belly folder by hand.
        std::fs::write(&src, b"n").unwrap();
        let e = b.eat(&src, &t.path().join("belly"), "x").unwrap();
        std::fs::remove_file(&e.stored).unwrap();
        assert!(matches!(b.restore(e.id), Err(BellyError::Missing(_))));
        assert!(b.data.items.is_empty());
    }

    #[test]
    fn free_names() {
        let t = tempfile::tempdir().unwrap();
        assert_eq!(free_name(t.path(), "a.txt", None), t.path().join("a.txt"));
        std::fs::write(t.path().join("a.txt"), b"").unwrap();
        assert_eq!(free_name(t.path(), "a.txt", None), t.path().join("a (2).txt"));
        assert_eq!(free_name(t.path(), "a.txt", Some("restored")), t.path().join("a (restored).txt"));
        std::fs::write(t.path().join("a (restored).txt"), b"").unwrap();
        assert_eq!(free_name(t.path(), "a.txt", Some("restored")), t.path().join("a (restored 2).txt"));
        assert_eq!(free_name(t.path(), "noext", None), t.path().join("noext"));
    }

    #[test]
    fn store_round_trip() {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join("belly.json");
        let mut b = Belly::load(&p);
        b.data.next_id = 3;
        b.save().unwrap();
        assert_eq!(Belly::load(&p).data.next_id, 3);
    }
}
