//! `open_path` validation. Opening a file with its default app is harmless for
//! documents and photos, but "opening" a program *runs* it. So:
//!
//! * the path must be inside the user's home folder or one of the searched
//!   folders, checked **before touching the disk** (so a model-chosen
//!   `\\server\share` or `/net/host` path can't make the OS connect anywhere),
//!   and again after resolving `..` and symlinks,
//! * files must have a known document/media extension (allowlist); programs,
//!   scripts, installers, shortcuts and app bundles are refused,
//! * (and, in [`crate::confirm`], the user must approve it).

use std::path::{Component, Path, PathBuf};

use crate::platform::Platform;

use super::files::Kind;
use super::ToolError;

/// Besides images/documents/videos/audio (see `files::Kind`), these are fine
/// to open with their default app.
const EXTRA_OK_EXTENSIONS: &[&str] =
    &["txt", "md", "log", "json", "csv", "tsv", "xml", "yaml", "yml", "zip", "7z", "rar", "tar", "gz", "html", "htm"];

fn allowed_file_extension(p: &Path) -> bool {
    let Some(ext) = p.extension().and_then(|e| e.to_str()).map(str::to_lowercase) else { return false };
    EXTRA_OK_EXTENSIONS.contains(&ext.as_str())
        || [Kind::Image, Kind::Document, Kind::Video, Kind::Audio].iter().any(|k| k.has_extension(&ext))
}

/// Resolve `.` and `..` without touching the disk.
fn lexical_normalise(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// Component-wise prefix check; case-insensitive on Windows.
fn lexically_under(path: &Path, base: &Path) -> bool {
    let norm = |c: Component| {
        let s = c.as_os_str().to_string_lossy().into_owned();
        if cfg!(windows) {
            s.to_lowercase()
        } else {
            s
        }
    };
    let (mut p, mut b) = (path.components(), base.components());
    loop {
        match (b.next(), p.next()) {
            (None, _) => return true,
            (Some(bc), Some(pc)) if norm(bc) == norm(pc) => {}
            _ => return false,
        }
    }
}

/// Folder names the user might say, mapped to the real folder names
/// (macOS calls Videos "Movies", people say "photos" for Pictures).
fn folder_alias(raw: &str) -> &'static [&'static str] {
    match raw.trim().to_lowercase().as_str() {
        "desktop" => &["Desktop"],
        "documents" | "docs" | "my documents" => &["Documents"],
        "downloads" => &["Downloads"],
        "pictures" | "photos" | "images" => &["Pictures"],
        "music" => &["Music"],
        "videos" | "movies" => &["Videos", "Movies"],
        _ => &[],
    }
}

/// Extensions that run code, install things, or redirect somewhere else when
/// "opened". Checked on every OS (a stray `.exe` on a Mac is still refused).
const BLOCKED_EXTENSIONS: &[&str] = &[
    // Windows programs, scripts, installers, shortcuts
    "exe",
    "com",
    "bat",
    "cmd",
    "msi",
    "msix",
    "msixbundle",
    "appx",
    "appxbundle",
    "ps1",
    "psm1",
    "psd1",
    "vbs",
    "vbe",
    "js",
    "jse",
    "wsf",
    "wsh",
    "scr",
    "pif",
    "lnk",
    "url",
    "reg",
    "hta",
    "cpl",
    "msc",
    "gadget",
    "application",
    "appref-ms",
    "inf",
    "sys",
    "dll",
    "settingcontent-ms",
    "library-ms",
    "search-ms",
    "iso",
    "img",
    "vhd",
    "vhdx",
    // macOS apps, scripts, installers, shortcuts
    "app",
    "saver",
    "qlgenerator",
    "mdimporter",
    "plugin",
    "osax",
    "mobileconfig",
    "shortcut",
    "chm",
    "website",
    "scf",
    "wsb",
    "command",
    "tool",
    "scpt",
    "scptd",
    "applescript",
    "workflow",
    "action",
    "terminal",
    "pkg",
    "mpkg",
    "dmg",
    "webloc",
    "inetloc",
    "fileloc",
    "prefpane",
    "kext",
    // cross-platform scripts / programs
    "sh",
    "bash",
    "zsh",
    "csh",
    "ksh",
    "fish",
    "py",
    "pyw",
    "pl",
    "rb",
    "php",
    "jar",
    "desktop",
    "appimage",
    "run",
    "bin",
];

fn has_blocked_extension(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()).is_some_and(|e| BLOCKED_EXTENSIONS.contains(&e.to_lowercase().as_str()))
}

#[cfg(unix)]
fn is_unix_executable(p: &Path, is_dir: bool) -> bool {
    use std::os::unix::fs::PermissionsExt;
    // On macOS, `open` runs an executable file in Terminal.
    !is_dir && std::fs::metadata(p).is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_unix_executable(_: &Path, _: bool) -> bool {
    false
}

/// Resolve and check a path from the model. Returns the canonical path and
/// whether it is a folder.
pub fn validate(raw: &str, platform: &dyn Platform) -> Result<(PathBuf, bool), ToolError> {
    let home = platform.home_dir();
    let roots = platform.search_roots();
    let raw = raw.trim().trim_matches('"');
    let refuse = || ToolError("for safety, Glitch only opens documents, photos, music, videos and folders".into());

    // Folder names: "Downloads", "pictures", "home".
    let names = folder_alias(raw);
    let alias = if raw.eq_ignore_ascii_case("home") || raw == "~" {
        home.clone()
    } else {
        roots
            .iter()
            .find(|r| {
                r.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.eq_ignore_ascii_case(raw) || names.iter().any(|a| n.eq_ignore_ascii_case(a)))
            })
            .cloned()
    };
    let path = match alias {
        Some(p) => p,
        None => match (raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")), &home) {
            (Some(rest), Some(h)) => h.join(rest),
            _ => PathBuf::from(raw),
        },
    };
    if !path.is_absolute() {
        return Err(ToolError("please use a full path from search_files, or a folder name like \"Downloads\"".into()));
    }
    // NTFS alternate data streams ("file.txt:evil.exe").
    if cfg!(windows)
        && path.components().any(|c| matches!(c, Component::Normal(n) if n.to_string_lossy().contains(':')))
    {
        return Err(refuse());
    }
    // Lexical check BEFORE any disk access: no network shares, no /net, no
    // other drives, unless they are the user's own (redirected) folders.
    let lexical = lexical_normalise(&path);
    let bases: Vec<&PathBuf> = home.iter().chain(roots.iter()).collect();
    if !bases.iter().any(|b| lexically_under(&lexical, b)) {
        return Err(ToolError("Glitch can only open things inside your own user folders".into()));
    }
    if has_blocked_extension(&path) {
        return Err(refuse());
    }
    let canonical =
        dunce::canonicalize(&path).map_err(|_| ToolError(format!("couldn't find \"{}\"", path.display())))?;

    // Again after resolving symlinks.
    let allowed_bases: Vec<PathBuf> = bases.iter().filter_map(|b| dunce::canonicalize(b).ok()).collect();
    if !allowed_bases.iter().any(|b| canonical.starts_with(b)) {
        return Err(ToolError("Glitch can only open things inside your own user folders".into()));
    }
    let is_dir = canonical.is_dir();
    if has_blocked_extension(&canonical) || is_unix_executable(&canonical, is_dir) {
        return Err(refuse());
    }
    if !is_dir && !allowed_file_extension(&canonical) {
        return Err(refuse());
    }
    Ok((canonical, is_dir))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::fake::FakePlatform;

    struct Home {
        _dir: tempfile::TempDir,
        root: PathBuf,
        platform: FakePlatform,
    }

    fn home() -> Home {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        for d in ["Downloads", "Pictures"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        let platform = FakePlatform {
            home: Some(root.clone()),
            roots: vec![root.join("Downloads"), root.join("Pictures")],
            ..Default::default()
        };
        Home { _dir: dir, root, platform }
    }

    #[test]
    fn opens_files_and_folders_in_home() {
        let h = home();
        std::fs::write(h.root.join("Pictures/dog.jpg"), b"").unwrap();
        let (p, is_dir) = validate(h.root.join("Pictures/dog.jpg").to_str().unwrap(), &h.platform).unwrap();
        assert!(p.ends_with("dog.jpg") && !is_dir);
        let (p, is_dir) = validate("downloads", &h.platform).unwrap();
        assert!(p.ends_with("Downloads") && is_dir);
        assert_eq!(validate("home", &h.platform).unwrap().0, h.root);
        assert!(validate("~/Pictures/dog.jpg", &h.platform).is_ok());
    }

    #[test]
    fn refuses_programs_scripts_and_shortcuts() {
        let h = home();
        for f in [
            "setup.exe",
            "run.BAT",
            "x.ps1",
            "Evil.app",
            "a.command",
            "s.sh",
            "l.lnk",
            "w.webloc",
            "i.dmg",
            "p.py",
            "help.chm",
            "x.rdp",
            "y.theme",
            "z.jnlp",
            "noextension",
            "Screen.saver",
        ] {
            let p = h.root.join("Downloads").join(f);
            if f.ends_with(".app") {
                std::fs::create_dir_all(&p).unwrap(); // bundles are folders
            } else {
                std::fs::write(&p, b"").unwrap();
            }
            assert!(validate(p.to_str().unwrap(), &h.platform).is_err(), "{f} must be refused");
        }
    }

    #[cfg(unix)]
    #[test]
    fn refuses_extensionless_executables() {
        use std::os::unix::fs::PermissionsExt;
        let h = home();
        let p = h.root.join("Downloads/installer");
        std::fs::write(&p, b"#!/bin/sh").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(validate(p.to_str().unwrap(), &h.platform).is_err());
    }

    #[test]
    fn refuses_paths_outside_home() {
        let h = home();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), b"").unwrap();
        assert!(validate(outside.path().join("secret.txt").to_str().unwrap(), &h.platform).is_err());
        // `..` tricks are resolved before checking.
        let sneaky = h.root.join("Downloads/../../").join(outside.path().file_name().unwrap()).join("secret.txt");
        assert!(validate(sneaky.to_str().unwrap(), &h.platform).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_that_escape_home() {
        let h = home();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("target.txt"), b"").unwrap();
        let link = h.root.join("Downloads/innocent.txt");
        std::os::unix::fs::symlink(outside.path().join("target.txt"), &link).unwrap();
        assert!(validate(link.to_str().unwrap(), &h.platform).is_err());
    }

    #[test]
    fn opens_common_documents_and_media() {
        let h = home();
        for f in ["a.pdf", "b.DOCX", "c.png", "d.mp3", "e.mov", "notes.txt", "page.html", "pack.zip"] {
            let p = h.root.join("Downloads").join(f);
            std::fs::write(&p, b"").unwrap();
            assert!(validate(p.to_str().unwrap(), &h.platform).is_ok(), "{f} should open");
        }
    }

    #[test]
    fn network_and_foreign_paths_are_refused_without_touching_them() {
        let h = home();
        let foreign: &[&str] = if cfg!(windows) {
            &[
                r"\\attacker.example\s\a.jpg",
                r"\\?\UNC\attacker.example\s\a.jpg",
                r"Z:\stick\a.jpg",
                r"C:\Windows\win.ini",
            ]
        } else {
            &["/net/attacker.example/s/a.jpg", "/Volumes/stick/a.jpg", "/etc/hosts"]
        };
        for p in foreign {
            assert!(validate(p, &h.platform).unwrap_err().0.contains("your own user folders"), "{p}");
        }
        // `..` is resolved lexically before the check.
        let sneaky = format!("{}/Downloads/../../../etc/hosts", h.root.display());
        assert!(validate(&sneaky, &h.platform).is_err());
    }

    #[test]
    fn folder_nicknames() {
        let h = home();
        assert!(validate("photos", &h.platform).unwrap().0.ends_with("Pictures"));
        assert!(validate("Downloads", &h.platform).unwrap().1);
    }

    #[test]
    fn refuses_relative_and_missing() {
        let h = home();
        assert!(validate("dog.jpg", &h.platform).is_err());
        assert!(validate(h.root.join("Pictures/nope.jpg").to_str().unwrap(), &h.platform).is_err());
    }
}
