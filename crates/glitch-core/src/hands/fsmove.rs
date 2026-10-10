//! Moving and renaming the user's files, and nothing else.
//!
//! * Only inside the user's home folder (Documents, Desktop, Downloads,
//!   Pictures, Videos, Music, or the home folder itself), never in system,
//!   program or app-data folders, never hidden folders, never a network
//!   path, never through a symlink or junction.
//! * A move never overwrites: if the name is taken the file gets a free one
//!   ("report (2).pdf"). Nothing is ever deleted.
//! * The caller shows the exact source and destination in a confirmation
//!   card before [`execute`] runs, and writes an undo entry afterwards.
//!
//! Pure `std::fs` over paths; the tests use temp folders.

use std::fs;
use std::path::{Component, Path, PathBuf};

/// Folder names (below a root) that are never touched.
const NEVER_NAMES: &[&str] = &[
    "appdata",
    "application data",
    "local settings",
    "programdata",
    "program files",
    "program files (x86)",
    "windows",
    "system32",
    "$recycle.bin",
    "system volume information",
    "onedrivetemp",
    "desktop.ini",
    "thumbs.db",
    "ntuser.dat",
];

const RESERVED: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2",
    "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// The folders Glitch may move things in.
#[derive(Debug, Clone)]
pub struct FileGuard {
    roots: Vec<PathBuf>,
    /// "Desktop" -> that folder, for the model's shorthand.
    shortcuts: Vec<(String, PathBuf)>,
}

/// A checked move, ready to show and to run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MovePlan {
    pub from: PathBuf,
    pub to: PathBuf,
    pub is_dir: bool,
    /// The name was taken, so a free one was picked.
    pub renamed_to_avoid_overwrite: bool,
    pub size: u64,
    /// Seconds since the epoch, to recognise the same file later (undo).
    pub modified: u64,
}

fn is_reparse(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // FILE_ATTRIBUTE_REPARSE_POINT: junctions, mount points, cloud placeholders.
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    false
}

fn mtime(meta: &fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs())
}

/// A file name Windows accepts and that isn't a trick.
pub fn valid_name(name: &str) -> Result<(), String> {
    let n = name.trim();
    if n.is_empty() || n != name || n.len() > 200 || n == "." || n == ".." {
        return Err("that is not a usable file name".into());
    }
    if n.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c)) {
        return Err("a file name can't contain < > : \" / \\ | ? * or control characters".into());
    }
    if n.ends_with('.') || n.ends_with(' ') {
        return Err("a file name can't end in a dot or a space".into());
    }
    let stem = n.split('.').next().unwrap_or("").to_lowercase();
    if RESERVED.contains(&stem.as_str()) {
        return Err("that is a reserved Windows name".into());
    }
    Ok(())
}

impl FileGuard {
    /// The standard places under `home` (real Documents / Desktop / ... may
    /// live elsewhere, e.g. OneDrive: pass them as `extra`).
    pub fn for_home(home: &Path, extra: &[PathBuf]) -> Self {
        let mut roots: Vec<PathBuf> = vec![home.to_path_buf()];
        let mut shortcuts = Vec::new();
        for name in ["Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music"] {
            let std_path = home.join(name);
            let real = extra
                .iter()
                .find(|p| p.file_name().is_some_and(|f| f.to_string_lossy().eq_ignore_ascii_case(name)))
                .cloned()
                .unwrap_or(std_path);
            roots.push(real.clone());
            shortcuts.push((name.to_lowercase(), real));
        }
        let canon = |p: &PathBuf| dunce::canonicalize(p).unwrap_or_else(|_| p.clone());
        let roots = roots.iter().map(canon).collect();
        let shortcuts = shortcuts.into_iter().map(|(n, p)| (n, canon(&p))).collect();
        Self { roots, shortcuts }
    }

    /// For tests: exactly these folders.
    pub fn with_roots(roots: Vec<PathBuf>) -> Self {
        let roots: Vec<PathBuf> = roots.iter().map(|p| dunce::canonicalize(p).unwrap_or_else(|_| p.clone())).collect();
        Self {
            shortcuts: roots
                .iter()
                .filter_map(|r| Some((r.file_name()?.to_string_lossy().to_lowercase(), r.clone())))
                .collect(),
            roots,
        }
    }

    /// "Desktop\notes.txt", "~/Downloads/a.png" or a full path -> a path.
    fn resolve(&self, arg: &str) -> Result<PathBuf, String> {
        let a = arg.trim().trim_matches(|c| c == '"' || c == '\'' || c == '\u{201c}' || c == '\u{201d}');
        if a.is_empty() {
            return Err("missing a path".into());
        }
        if a.contains('%') || a.contains('\0') {
            return Err("environment variables and odd characters aren't allowed in a path".into());
        }
        if a.starts_with("\\\\") || a.starts_with("//") {
            return Err("network paths and device paths are not allowed".into());
        }
        let norm = a.replace('\\', "/");
        let p = if let Some(rest) = norm.strip_prefix("~/").or_else(|| norm.strip_prefix("~")) {
            let home = self.roots.first().ok_or("no home folder")?;
            home.join(rest.trim_start_matches('/'))
        } else if Path::new(a).is_absolute() {
            PathBuf::from(a)
        } else {
            let mut parts = norm.splitn(2, '/');
            let first = parts.next().unwrap_or("").to_lowercase();
            let Some((_, dir)) = self.shortcuts.iter().find(|(n, _)| *n == first) else {
                return Err(
                    "give a full path (like C:\\Users\\you\\Documents\\notes.txt) or start with Desktop, Documents, \
                     Downloads, Pictures, Videos or Music"
                        .into(),
                );
            };
            dir.join(parts.next().unwrap_or(""))
        };
        if p.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) {
            return Err("\"..\" and \".\" aren't allowed in a path".into());
        }
        Ok(p)
    }

    /// The root `p` (canonical) is inside, preferring the deepest one.
    fn root_of(&self, p: &Path) -> Option<&PathBuf> {
        self.roots.iter().filter(|r| p.starts_with(r)).max_by_key(|r| r.components().count())
    }

    fn check_inside(&self, canon: &Path) -> Result<(), String> {
        let Some(root) = self.root_of(canon) else {
            return Err(
                "Glitch only moves files inside your own folders: Documents, Desktop, Downloads, Pictures, Videos, \
                 Music or your home folder"
                    .into(),
            );
        };
        // Below the (deepest) root: no hidden, system, program or app-data names.
        let below = canon.strip_prefix(root).unwrap_or(canon);
        for c in below.components() {
            let n = c.as_os_str().to_string_lossy().to_lowercase();
            if n.starts_with('.') || NEVER_NAMES.contains(&n.as_str()) {
                return Err("that is a hidden, system or program folder; Glitch leaves those alone".into());
            }
        }
        // Moving a root itself (Documents, home...) is never ok.
        if self.roots.iter().any(|r| r == canon) {
            return Err("Glitch doesn't move whole folders like Documents or your home folder".into());
        }
        Ok(())
    }

    /// No symlink / junction anywhere on the way from the root down to `p`.
    fn no_links(&self, p: &Path) -> Result<(), String> {
        let Some(root) = self.root_of(p) else { return Ok(()) };
        let mut cur = root.clone();
        for c in p.strip_prefix(root).unwrap_or(p).components() {
            cur.push(c);
            if let Ok(m) = fs::symlink_metadata(&cur) {
                if is_reparse(&m) {
                    return Err("that path goes through a link or junction, which Glitch won't follow".into());
                }
            }
        }
        Ok(())
    }

    /// Check a move and work out the exact destination. `to` may be a folder
    /// (the file keeps its name), or a new full path / name inside a folder.
    pub fn plan(&self, from: &str, to: &str) -> Result<MovePlan, String> {
        let from_p = self.resolve(from)?;
        let meta =
            fs::symlink_metadata(&from_p).map_err(|_| format!("there is no file or folder at {}", from_p.display()))?;
        if is_reparse(&meta) {
            return Err("that is a link or junction; Glitch only moves real files and folders".into());
        }
        let from_c = dunce::canonicalize(&from_p).map_err(|e| format!("can't read that path: {e}"))?;
        self.check_inside(&from_c)?;
        self.no_links(&from_c)?;
        let name = from_c.file_name().map(|n| n.to_string_lossy().into_owned()).ok_or("that has no name")?;

        let to_p = self.resolve(to)?;
        let (dir, file_name) = match fs::symlink_metadata(&to_p) {
            Ok(m) if m.is_dir() && !is_reparse(&m) => (to_p.clone(), name.clone()),
            Ok(m) if is_reparse(&m) => return Err("the destination is a link or junction".into()),
            _ => {
                // A new name: its folder must exist.
                let parent = to_p.parent().ok_or("that destination has no folder")?.to_path_buf();
                let new_name = to_p.file_name().map(|n| n.to_string_lossy().into_owned()).ok_or("missing a name")?;
                (parent, new_name)
            }
        };
        valid_name(&file_name)?;
        let dir_c = dunce::canonicalize(&dir).map_err(|_| format!("the folder {} doesn't exist", dir.display()))?;
        if !dir_c.is_dir() {
            return Err("the destination folder isn't a folder".into());
        }
        // A bare name stays where it is (a rename); `to` in another folder moves.
        self.check_inside(&dir_c).or_else(|e| if self.roots.contains(&dir_c) { Ok(()) } else { Err(e) })?;
        self.no_links(&dir_c)?;
        if meta.is_dir() && dir_c.starts_with(&from_c) {
            return Err("a folder can't be moved into itself".into());
        }
        let wanted = dir_c.join(&file_name);
        if wanted == from_c {
            return Err("it is already there under that name".into());
        }
        let (to_final, renamed) = unique(&wanted);
        Ok(MovePlan {
            from: from_c,
            to: to_final,
            is_dir: meta.is_dir(),
            renamed_to_avoid_overwrite: renamed,
            size: if meta.is_dir() { 0 } else { meta.len() },
            modified: mtime(&meta),
        })
    }
}

/// `name (2).ext` until nothing exists there.
pub fn unique(p: &Path) -> (PathBuf, bool) {
    if fs::symlink_metadata(p).is_err() {
        return (p.to_path_buf(), false);
    }
    let dir = p.parent().unwrap_or(Path::new(""));
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    for n in 2..1000 {
        let c = dir.join(format!("{stem} ({n}){ext}"));
        if fs::symlink_metadata(&c).is_err() {
            return (c, true);
        }
    }
    (p.to_path_buf(), true)
}

/// Run a checked plan. Checks the world once more right before: the source
/// must still be the same thing, the destination must still be free.
pub fn execute(plan: &MovePlan) -> Result<(), String> {
    let meta = fs::symlink_metadata(&plan.from).map_err(|_| "the file is gone".to_string())?;
    if is_reparse(&meta) {
        return Err("the file turned into a link".into());
    }
    if !plan.is_dir && (meta.len() != plan.size || mtime(&meta) != plan.modified) {
        return Err("the file changed since I looked at it, so I didn't move it".into());
    }
    if fs::symlink_metadata(&plan.to).is_ok() {
        return Err("something with that name appeared at the destination, so I didn't move anything".into());
    }
    fs::rename(&plan.from, &plan.to).map_err(|e| {
        if e.raw_os_error() == Some(17) || e.kind() == std::io::ErrorKind::CrossesDevices {
            "that is on another drive; Glitch only moves files within one drive".to_string()
        } else {
            format!("couldn't move it: {e}")
        }
    })
}

/// Put a moved file back where it came from. Only if `to` is still the same
/// file (size and time) and `from`'s folder is still there; if the old name
/// is taken now, the file comes back under a free name. Returns where it is.
pub fn undo(from: &Path, to: &Path, size: u64, modified: u64, is_dir: bool) -> Result<PathBuf, String> {
    let meta = fs::symlink_metadata(to).map_err(|_| "it is not where Glitch put it any more".to_string())?;
    if is_reparse(&meta) || (!is_dir && (meta.len() != size || mtime(&meta) != modified)) {
        return Err("it was changed since, so I left it alone".into());
    }
    let dir = from.parent().filter(|d| d.is_dir()).ok_or("the old folder is gone")?;
    let (back, _) = unique(&dir.join(from.file_name().ok_or("no name")?));
    fs::rename(to, &back).map_err(|e| format!("couldn't move it back: {e}"))?;
    Ok(back)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;

    fn home() -> (tempfile::TempDir, FileGuard) {
        let t = tempfile::tempdir().unwrap();
        for d in [
            "Desktop",
            "Documents",
            "Downloads",
            "Pictures",
            "Videos",
            "Music",
            "Documents/taxes",
            "AppData/Local",
            ".ssh",
        ] {
            fs::create_dir_all(t.path().join(d)).unwrap();
        }
        let g = FileGuard::for_home(&dunce::canonicalize(t.path()).unwrap(), &[]);
        (t, g)
    }

    fn file(p: &Path, text: &str) {
        File::create(p).unwrap().write_all(text.as_bytes()).unwrap();
    }

    #[test]
    fn a_file_moves_into_a_folder_and_keeps_its_name() {
        let (t, g) = home();
        file(&t.path().join("Desktop/report.txt"), "hello");
        let plan = g.plan("Desktop/report.txt", "Documents/taxes").unwrap();
        assert!(
            plan.to.ends_with("Documents/taxes/report.txt") || plan.to.ends_with("Documents\\taxes\\report.txt"),
            "{:?}",
            plan.to
        );
        assert!(!plan.renamed_to_avoid_overwrite && !plan.is_dir);
        execute(&plan).unwrap();
        assert!(!t.path().join("Desktop/report.txt").exists());
        assert_eq!(fs::read_to_string(&plan.to).unwrap(), "hello");
    }

    #[test]
    fn renaming_works_with_a_new_name_in_the_same_or_another_folder() {
        let (t, g) = home();
        file(&t.path().join("Desktop/a.txt"), "x");
        let p = g.plan("Desktop/a.txt", "Desktop/b.txt").unwrap();
        execute(&p).unwrap();
        assert!(t.path().join("Desktop/b.txt").exists());
        let p = g.plan("Desktop/b.txt", "Documents/final.txt").unwrap();
        execute(&p).unwrap();
        assert!(t.path().join("Documents/final.txt").exists());
    }

    #[test]
    fn a_move_never_overwrites() {
        let (t, g) = home();
        file(&t.path().join("Desktop/a.txt"), "new");
        file(&t.path().join("Documents/a.txt"), "old");
        let plan = g.plan("Desktop/a.txt", "Documents").unwrap();
        assert!(plan.renamed_to_avoid_overwrite);
        assert!(plan.to.to_string_lossy().ends_with("a (2).txt"), "{:?}", plan.to);
        execute(&plan).unwrap();
        assert_eq!(fs::read_to_string(t.path().join("Documents/a.txt")).unwrap(), "old");
        assert_eq!(fs::read_to_string(&plan.to).unwrap(), "new");
        // A destination that appears after planning stops the move.
        file(&t.path().join("Desktop/c.txt"), "c");
        let plan = g.plan("Desktop/c.txt", "Documents").unwrap();
        file(&plan.to, "squatter");
        assert!(execute(&plan).unwrap_err().contains("appeared"));
        assert!(t.path().join("Desktop/c.txt").exists());
    }

    #[test]
    fn only_the_users_own_folders_system_and_hidden_places_are_refused() {
        let (t, g) = home();
        file(&t.path().join("AppData/Local/x.db"), "x");
        file(&t.path().join(".ssh/id"), "x");
        file(&t.path().join("Desktop/a.txt"), "x");
        for (from, to) in [
            ("AppData/Local/x.db", "Desktop"),
            (".ssh/id", "Desktop"),
            ("Desktop/a.txt", "AppData/Local"),
            ("Desktop/a.txt", ".ssh"),
            ("C:\\Windows\\System32\\notepad.exe", "Desktop"),
            ("Desktop/a.txt", "C:\\Program Files"),
            ("\\\\server\\share\\a.txt", "Desktop"),
            ("Desktop/a.txt", "\\\\?\\C:\\x"),
            ("Desktop/../../etc/passwd", "Desktop"),
            ("Desktop/a.txt", "%APPDATA%"),
            ("somewhere/a.txt", "Desktop"),
            ("Desktop", "Documents"),
            ("Documents", "Desktop"),
        ] {
            assert!(g.plan(from, to).is_err(), "{from} -> {to} should be refused");
        }
        assert!(t.path().join("Desktop/a.txt").exists());
    }

    #[test]
    fn bad_names_are_refused() {
        for bad in ["a<b", "con", "aux.txt", "x.", " x", "a|b", "x/y", ""] {
            assert!(valid_name(bad).is_err(), "{bad:?}");
        }
        assert!(valid_name("holiday photo (2).jpg").is_ok());
        let (t, g) = home();
        file(&t.path().join("Desktop/a.txt"), "x");
        assert!(g.plan("Desktop/a.txt", "Desktop/NUL").is_err());
    }

    #[test]
    fn folders_move_but_not_into_themselves() {
        let (t, g) = home();
        fs::create_dir_all(t.path().join("Desktop/proj/sub")).unwrap();
        assert!(g.plan("Desktop/proj", "Desktop/proj/sub").unwrap_err().contains("itself"));
        let p = g.plan("Desktop/proj", "Documents").unwrap();
        assert!(p.is_dir);
        execute(&p).unwrap();
        assert!(t.path().join("Documents/proj/sub").is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn links_are_never_followed() {
        let (t, g) = home();
        file(&t.path().join("Desktop/real.txt"), "x");
        std::os::unix::fs::symlink(t.path().join("Desktop/real.txt"), t.path().join("Desktop/link.txt")).unwrap();
        std::os::unix::fs::symlink(t.path().join("Documents"), t.path().join("Desktop/dirlink")).unwrap();
        assert!(g.plan("Desktop/link.txt", "Documents").unwrap_err().contains("link"));
        assert!(g.plan("Desktop/real.txt", "Desktop/dirlink").unwrap_err().contains("link"));
        assert!(g.plan("Desktop/dirlink/real2.txt", "Documents").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn junctions_are_never_followed() {
        let (t, g) = home();
        file(&t.path().join("Desktop/real.txt"), "x");
        let junction = t.path().join("Desktop/jct");
        let ok = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J", junction.to_str().unwrap(), t.path().join("Documents").to_str().unwrap()])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !ok {
            return; // no permission to make one here
        }
        assert!(g.plan("Desktop/real.txt", "Desktop/jct").is_err());
        assert!(g.plan("Desktop/jct", "Documents").is_err());
    }

    #[test]
    fn a_changed_source_is_not_moved() {
        let (t, g) = home();
        file(&t.path().join("Desktop/a.txt"), "one");
        let plan = g.plan("Desktop/a.txt", "Documents").unwrap();
        file(&t.path().join("Desktop/a.txt"), "now much longer text");
        assert!(execute(&plan).unwrap_err().contains("changed"));
    }

    #[test]
    fn undo_puts_it_back_but_only_if_it_is_still_the_same_file() {
        let (t, g) = home();
        file(&t.path().join("Desktop/a.txt"), "one");
        let plan = g.plan("Desktop/a.txt", "Documents").unwrap();
        execute(&plan).unwrap();
        let back = undo(&plan.from, &plan.to, plan.size, plan.modified, false).unwrap();
        assert_eq!(back, plan.from);
        assert!(t.path().join("Desktop/a.txt").exists() && !plan.to.exists());
        // Taken name -> a free one, nothing overwritten.
        let plan = g.plan("Desktop/a.txt", "Documents").unwrap();
        execute(&plan).unwrap();
        file(&t.path().join("Desktop/a.txt"), "someone else's");
        let back = undo(&plan.from, &plan.to, plan.size, plan.modified, false).unwrap();
        assert!(back.to_string_lossy().ends_with("a (2).txt"));
        assert_eq!(fs::read_to_string(t.path().join("Desktop/a.txt")).unwrap(), "someone else's");
        // Edited since: left alone.
        file(&t.path().join("Documents/b.txt"), "x");
        let plan = g.plan("Documents/b.txt", "Desktop").unwrap();
        execute(&plan).unwrap();
        file(&plan.to, "edited a lot");
        assert!(undo(&plan.from, &plan.to, plan.size, plan.modified, false).unwrap_err().contains("changed"));
        assert!(undo(&plan.from, &t.path().join("Desktop/nope"), 0, 0, false).unwrap_err().contains("not where"));
    }
}
