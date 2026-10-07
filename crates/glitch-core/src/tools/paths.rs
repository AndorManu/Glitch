//! `open_path` validation. Opening a file with its default app is harmless for
//! documents and photos, but "opening" a program *runs* it. So:
//!
//! * the path must exist and be inside the user's home folder or one of the
//!   searched folders (after resolving `..` and symlinks),
//! * programs, scripts, installers, shortcuts and app bundles are refused,
//! * (and, in [`crate::confirm`], the user must approve it).

use std::path::{Path, PathBuf};

use crate::platform::Platform;

use super::ToolError;

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

    // Folder names: "Downloads", "pictures", "home".
    let alias = if raw.eq_ignore_ascii_case("home") || raw == "~" {
        home.clone()
    } else {
        roots
            .iter()
            .find(|r| r.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.eq_ignore_ascii_case(raw)))
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
    if has_blocked_extension(&path) {
        return Err(ToolError("for safety, Glitch doesn't open programs, scripts, installers or shortcuts".into()));
    }
    let canonical =
        dunce::canonicalize(&path).map_err(|_| ToolError(format!("couldn't find \"{}\"", path.display())))?;

    let allowed_bases: Vec<PathBuf> =
        home.iter().chain(roots.iter()).filter_map(|b| dunce::canonicalize(b).ok()).collect();
    if !allowed_bases.iter().any(|b| canonical.starts_with(b)) {
        return Err(ToolError("Glitch can only open things inside your own user folders".into()));
    }
    let is_dir = canonical.is_dir();
    if has_blocked_extension(&canonical) || is_unix_executable(&canonical, is_dir) {
        return Err(ToolError("for safety, Glitch doesn't open programs, scripts, installers or shortcuts".into()));
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
        for f in
            ["setup.exe", "run.BAT", "x.ps1", "Evil.app", "a.command", "s.sh", "l.lnk", "w.webloc", "i.dmg", "p.py"]
        {
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
    fn refuses_relative_and_missing() {
        let h = home();
        assert!(validate("dog.jpg", &h.platform).is_err());
        assert!(validate(h.root.join("Pictures/nope.jpg").to_str().unwrap(), &h.platform).is_err());
    }
}
