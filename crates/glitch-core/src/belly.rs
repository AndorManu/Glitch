//! Glitch's belly: files the user feeds him (drag a file onto him) are MOVED
//! into a folder the user chose, never deleted, and listed here so each one
//! can be put back where it came from.
//!
//! Safety rules (all here, unit-tested):
//! * only regular files under the user's home (no folders, no symlinks, no
//!   UNC / device paths), never anything already inside the belly;
//! * nothing is ever overwritten: moves are a hard link + unlink of the
//!   original (the link fails if the target exists), or across drives a
//!   copy into a brand-new file (`create_new`) -> size check -> remove the
//!   original; if removing the original fails, the copy goes again, so there
//!   is always exactly one copy;
//! * names never clash when eating: "report (2).pdf";
//! * `belly.json` is not trusted on restore: the stored file must be a real
//!   file inside the belly folder, the original path under the home folder,
//!   and the file must still be the one he ate (size + SHA-256). Restore
//!   never overwrites: if something new is at the original path, it fails.

use std::fs::OpenOptions;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf, Prefix};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

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
    /// SHA-256 of the content (hex), checked before a restore.
    #[serde(default)]
    pub sha256: String,
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
    #[error("{0} isn't in your own folders, so I'd rather not")]
    OutsideHome(String),
    #[error("Something else is at {0} now. Move it away first, then try again")]
    Occupied(String),
    #[error("{0} in my belly isn't the file I ate any more, so I won't put it back")]
    Changed(String),
    #[error("my belly list looks tampered with, so I won't touch {0}")]
    BadEntry(String),
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

/// UNC shares (`\\server\share`), device paths (`\\.\`, `\\?\UNC`), relative paths.
pub fn plain_local_path(p: &Path) -> bool {
    if !p.is_absolute() {
        return false;
    }
    let s = p.as_os_str().to_string_lossy();
    if s.starts_with("\\\\") || s.starts_with("//") {
        return false;
    }
    match p.components().next() {
        Some(Component::Prefix(pre)) => matches!(pre.kind(), Prefix::Disk(_)),
        _ => true,
    }
}

fn canon(p: &Path) -> PathBuf {
    dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

fn inside(path: &Path, dir: &Path) -> bool {
    canon(path).starts_with(canon(dir))
}

/// `dir/name`, or `dir/stem (2).ext`, `(3)`... whatever doesn't exist yet.
/// (Only a suggestion: the move itself refuses to overwrite.)
pub fn free_name(dir: &Path, name: &str) -> PathBuf {
    let p = Path::new(name);
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| name.to_string());
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let first = dir.join(name);
    if std::fs::symlink_metadata(&first).is_err() {
        return first;
    }
    for n in 2..10_000 {
        let c = dir.join(format!("{stem} ({n}){ext}"));
        if std::fs::symlink_metadata(&c).is_err() {
            return c;
        }
    }
    dir.join(format!("{stem} ({}){ext}", std::process::id()))
}

/// Move a file without ever overwriting `to` (fails with AlreadyExists).
pub fn move_no_clobber(from: &Path, to: &Path) -> io::Result<()> {
    if std::fs::symlink_metadata(to).is_ok() {
        return Err(io::Error::new(io::ErrorKind::AlreadyExists, "target exists"));
    }
    // Same drive: a hard link is atomic and refuses an existing target.
    match std::fs::hard_link(from, to) {
        Ok(()) => {
            if let Err(e) = std::fs::remove_file(from) {
                let _ = std::fs::remove_file(to);
                return Err(e);
            }
            return Ok(());
        }
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => return Err(e),
        Err(_) => {}
    }
    // Another drive (or no hard links there): copy into a NEW file, check, remove the original.
    let size = std::fs::metadata(from)?.len();
    {
        let mut src = std::fs::File::open(from)?;
        let mut dst = OpenOptions::new().write(true).create_new(true).open(to)?;
        let copied = io::copy(&mut src, &mut dst).and_then(|n| dst.sync_all().map(|_| n));
        if copied.as_ref().ok() != Some(&size) {
            drop(dst);
            let _ = std::fs::remove_file(to);
            return Err(copied.err().unwrap_or_else(|| io::Error::other("the copy came out the wrong size")));
        }
    }
    if let Err(e) = std::fs::remove_file(from) {
        // Couldn't take the original: undo, so there is exactly one copy.
        let _ = std::fs::remove_file(to);
        return Err(e);
    }
    Ok(())
}

pub fn sha256_file(p: &Path) -> io::Result<String> {
    let mut f = std::fs::File::open(p)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
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

    /// May he eat this? (Checked before asking the user.) Returns its size.
    pub fn check(src: &Path, belly_dir: &Path, home: &Path) -> Result<u64, BellyError> {
        let name = display(src);
        if !plain_local_path(src) {
            return Err(BellyError::OutsideHome(name));
        }
        let meta = std::fs::symlink_metadata(src).map_err(|_| BellyError::Missing(name.clone()))?;
        if meta.file_type().is_symlink() {
            return Err(BellyError::Link(name));
        }
        if !meta.is_file() {
            return Err(BellyError::NotAFile(name));
        }
        if !inside(src, home) {
            return Err(BellyError::OutsideHome(name));
        }
        if inside(src, belly_dir) {
            return Err(BellyError::AlreadyInside(name));
        }
        Ok(meta.len())
    }

    /// Move `src` into `belly_dir` and remember where it came from.
    pub fn eat(&mut self, src: &Path, belly_dir: &Path, home: &Path, now: &str) -> Result<Eaten, BellyError> {
        let size = Self::check(src, belly_dir, home)?;
        let name = display(src);
        let io_err = |e: io::Error| BellyError::Io(name.clone(), e.to_string());
        if !plain_local_path(belly_dir) {
            return Err(BellyError::BadEntry(belly_dir.display().to_string()));
        }
        std::fs::create_dir_all(belly_dir).map_err(io_err)?;
        let sha256 = sha256_file(src).map_err(io_err)?;
        let original = canon(src);
        // A name taken between choosing and moving: try the next one.
        let mut to = free_name(belly_dir, &name);
        let mut tries = 0;
        loop {
            match move_no_clobber(src, &to) {
                Ok(()) => break,
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists && tries < 5 => {
                    tries += 1;
                    to = free_name(belly_dir, &name);
                }
                Err(e) => return Err(io_err(e)),
            }
        }
        self.data.next_id += 1;
        let item = Eaten {
            id: self.data.next_id,
            name,
            original: original.display().to_string(),
            stored: to.display().to_string(),
            size,
            sha256,
            eaten: now.to_string(),
        };
        self.data.items.push(item.clone());
        Ok(item)
    }

    /// Put an eaten file back where it came from, after checking the entry
    /// (it may have been edited) and that the file is the one he ate.
    pub fn restore(&mut self, id: u64, belly_dir: &Path, home: &Path) -> Result<PathBuf, BellyError> {
        let i = self.data.items.iter().position(|e| e.id == id).ok_or(BellyError::UnknownId)?;
        let item = self.data.items[i].clone();
        let stored = PathBuf::from(&item.stored);
        let original = PathBuf::from(&item.original);
        let bad = || BellyError::BadEntry(item.name.clone());
        if !plain_local_path(&stored) || !plain_local_path(&original) {
            return Err(bad());
        }
        if original.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) {
            return Err(bad());
        }
        let meta = match std::fs::symlink_metadata(&stored) {
            Ok(m) => m,
            Err(_) => {
                // Gone from the belly folder (the user moved it): nothing to put back.
                self.data.items.remove(i);
                return Err(BellyError::Missing(item.name));
            }
        };
        if meta.file_type().is_symlink() || !meta.is_file() || !inside(&stored, belly_dir) {
            return Err(bad());
        }
        // The original folder: under home once resolved (its existing part has no link out of it).
        let mut existing = original.parent().map(Path::to_path_buf).ok_or_else(bad)?;
        while std::fs::symlink_metadata(&existing).is_err() {
            existing = existing.parent().map(Path::to_path_buf).ok_or_else(bad)?;
        }
        if !inside(&existing, home) || !original.starts_with(canon(home)) {
            return Err(bad());
        }
        if meta.len() != item.size || sha256_file(&stored).ok().as_deref() != Some(item.sha256.as_str()) {
            return Err(BellyError::Changed(item.name));
        }
        if std::fs::symlink_metadata(&original).is_ok() {
            return Err(BellyError::Occupied(original.display().to_string()));
        }
        let io_err = |e: io::Error| BellyError::Io(item.name.clone(), e.to_string());
        if let Some(dir) = original.parent() {
            std::fs::create_dir_all(dir).map_err(io_err)?;
        }
        move_no_clobber(&stored, &original).map_err(|e| {
            if e.kind() == io::ErrorKind::AlreadyExists {
                BellyError::Occupied(original.display().to_string())
            } else {
                io_err(e)
            }
        })?;
        self.data.items.remove(i);
        Ok(original)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct T {
        _t: tempfile::TempDir,
        home: PathBuf,
        belly: PathBuf,
        docs: PathBuf,
    }

    fn setup() -> T {
        let t = tempfile::tempdir().unwrap();
        let home = canon(t.path()).join("home");
        let docs = home.join("docs");
        let belly = home.join("belly");
        std::fs::create_dir_all(&docs).unwrap();
        T { _t: t, home, belly, docs }
    }

    #[test]
    fn eat_moves_and_restore_brings_back() {
        let t = setup();
        let src = t.docs.join("report.pdf");
        std::fs::write(&src, b"hello").unwrap();
        let mut b = Belly::in_memory();
        let e = b.eat(&src, &t.belly, &t.home, "2026-10-07 10:00").unwrap();
        assert!(!src.exists(), "moved, not copied");
        assert_eq!(std::fs::read(&e.stored).unwrap(), b"hello");
        assert_eq!((e.size, e.name.as_str(), e.sha256.len()), (5, "report.pdf", 64));
        // Same name again: no overwrite.
        std::fs::write(&src, b"second").unwrap();
        let e2 = b.eat(&src, &t.belly, &t.home, "x").unwrap();
        assert!(e2.stored.ends_with("report (2).pdf"), "{}", e2.stored);
        assert_eq!(std::fs::read(&e.stored).unwrap(), b"hello");
        // Restore the first one.
        let back = b.restore(e.id, &t.belly, &t.home).unwrap();
        assert_eq!(std::fs::read(&back).unwrap(), b"hello");
        assert_eq!(back, src);
        assert_eq!(b.data.items.len(), 1);
        // The second has the same original path, which is taken now: refused, nothing touched.
        assert!(matches!(b.restore(e2.id, &t.belly, &t.home), Err(BellyError::Occupied(_))));
        assert_eq!(std::fs::read(&src).unwrap(), b"hello");
        assert_eq!(std::fs::read(&e2.stored).unwrap(), b"second");
        assert_eq!(b.data.items.len(), 1);
        assert_eq!(b.restore(e.id, &t.belly, &t.home), Err(BellyError::UnknownId));
    }

    #[test]
    fn refuses_folders_missing_files_outside_home_and_the_belly_itself() {
        let t = setup();
        let mut b = Belly::in_memory();
        assert!(matches!(b.eat(&t.docs, &t.belly, &t.home, "x"), Err(BellyError::NotAFile(_))));
        assert!(matches!(b.eat(&t.docs.join("nope.txt"), &t.belly, &t.home, "x"), Err(BellyError::Missing(_))));
        std::fs::create_dir_all(&t.belly).unwrap();
        let inner = t.belly.join("a.txt");
        std::fs::write(&inner, b"a").unwrap();
        assert!(matches!(b.eat(&inner, &t.belly, &t.home, "x"), Err(BellyError::AlreadyInside(_))));
        assert!(inner.exists());
        // Outside the home folder.
        let outside = t.home.parent().unwrap().join("system.dat");
        std::fs::write(&outside, b"s").unwrap();
        assert!(matches!(b.eat(&outside, &t.belly, &t.home, "x"), Err(BellyError::OutsideHome(_))));
        assert!(outside.exists());
        assert!(matches!(Belly::check(Path::new("relative.txt"), &t.belly, &t.home), Err(BellyError::OutsideHome(_))));
        assert!(b.data.items.is_empty());
    }

    #[test]
    fn unc_and_device_paths_are_not_plain() {
        assert!(!plain_local_path(Path::new(r"\\server\share\x.txt")));
        assert!(!plain_local_path(Path::new(r"\\.\PhysicalDrive0")));
        assert!(!plain_local_path(Path::new(r"\\?\UNC\server\share\x")));
        assert!(!plain_local_path(Path::new("rel/x.txt")));
        if cfg!(windows) {
            assert!(plain_local_path(Path::new(r"C:\Users\a\x.txt")));
        } else {
            assert!(plain_local_path(Path::new("/home/a/x.txt")));
        }
    }

    #[test]
    fn move_never_overwrites() {
        let t = setup();
        let a = t.docs.join("a.txt");
        let c = t.docs.join("c.txt");
        std::fs::write(&a, b"a").unwrap();
        std::fs::write(&c, b"c").unwrap();
        let e = move_no_clobber(&a, &c).unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read(&a).unwrap(), b"a");
        assert_eq!(std::fs::read(&c).unwrap(), b"c");
        move_no_clobber(&a, &t.docs.join("d.txt")).unwrap();
        assert!(!a.exists());
    }

    #[test]
    fn tampered_entries_are_refused() {
        let t = setup();
        let src = t.docs.join("n.txt");
        std::fs::write(&src, b"n").unwrap();
        let mut b = Belly::in_memory();
        let e = b.eat(&src, &t.belly, &t.home, "x").unwrap();
        let fresh = b.data.items[0].clone();
        let set = |b: &mut Belly, f: &dyn Fn(&mut Eaten)| {
            b.data.items[0] = fresh.clone();
            f(&mut b.data.items[0]);
        };
        // The original redirected outside home (e.g. into a system folder).
        let outside = t.home.parent().unwrap().join("evil.txt");
        set(&mut b, &|it| it.original = outside.display().to_string());
        assert!(matches!(b.restore(e.id, &t.belly, &t.home), Err(BellyError::BadEntry(_))));
        set(&mut b, &|it| it.original = r"\\server\share\x.txt".into());
        assert!(matches!(b.restore(e.id, &t.belly, &t.home), Err(BellyError::BadEntry(_))));
        set(&mut b, &|it| it.original = format!("{}/../../evil.txt", t.docs.display()));
        assert!(matches!(b.restore(e.id, &t.belly, &t.home), Err(BellyError::BadEntry(_))));
        // The stored path pointed at a file outside the belly.
        let other = t.docs.join("other.txt");
        std::fs::write(&other, b"o").unwrap();
        set(&mut b, &|it| it.stored = other.display().to_string());
        assert!(matches!(b.restore(e.id, &t.belly, &t.home), Err(BellyError::BadEntry(_))));
        assert!(other.exists());
        // The file in the belly was swapped for something else.
        set(&mut b, &|_| {});
        std::fs::write(&e.stored, b"X").unwrap();
        assert!(matches!(b.restore(e.id, &t.belly, &t.home), Err(BellyError::Changed(_))));
        std::fs::write(&e.stored, b"n").unwrap();
        assert!(!outside.exists());
        // Untampered: fine.
        assert_eq!(b.restore(e.id, &t.belly, &t.home).unwrap(), src);
    }

    #[test]
    fn restore_recreates_the_folder_and_drops_vanished_entries() {
        let t = setup();
        let dir = t.docs.join("gone/deep");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("n.txt");
        std::fs::write(&src, b"n").unwrap();
        let mut b = Belly::in_memory();
        let e = b.eat(&src, &t.belly, &t.home, "x").unwrap();
        std::fs::remove_dir_all(t.docs.join("gone")).unwrap();
        assert_eq!(b.restore(e.id, &t.belly, &t.home).unwrap(), PathBuf::from(&e.original));
        assert!(src.exists());
        // The user took it out of the belly folder by hand.
        let e = b.eat(&src, &t.belly, &t.home, "x").unwrap();
        std::fs::remove_file(&e.stored).unwrap();
        assert!(matches!(b.restore(e.id, &t.belly, &t.home), Err(BellyError::Missing(_))));
        assert!(b.data.items.is_empty());
    }

    #[test]
    fn free_names() {
        let t = tempfile::tempdir().unwrap();
        assert_eq!(free_name(t.path(), "a.txt"), t.path().join("a.txt"));
        std::fs::write(t.path().join("a.txt"), b"").unwrap();
        assert_eq!(free_name(t.path(), "a.txt"), t.path().join("a (2).txt"));
        assert_eq!(free_name(t.path(), "noext"), t.path().join("noext"));
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
