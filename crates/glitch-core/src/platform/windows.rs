//! Windows specifics. Pure path logic, compiled on every OS for testing.

use std::path::{Path, PathBuf};

use walkdir::WalkDir;

use super::{dedupe_apps, AppEntry, OllamaInstall};

/// Per-user and all-users Start Menu "Programs" folders.
pub fn start_menu_dirs() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        v.push(PathBuf::from(appdata).join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    if let Some(pd) = std::env::var_os("ProgramData") {
        v.push(PathBuf::from(pd).join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    v
}

/// Shortcut names that are not really "apps" a user wants to open.
fn is_noise(name_lower: &str) -> bool {
    ["uninstall", "readme", "read me", "release notes", "documentation", "help", "website", "manual", "license"]
        .iter()
        .any(|n| name_lower.contains(n))
}

/// Every `.lnk` shortcut in the Start Menu folders (max 4 levels deep).
pub fn installed_apps(start_menu_dirs: &[PathBuf]) -> Vec<AppEntry> {
    let mut apps = Vec::new();
    for dir in start_menu_dirs {
        for entry in WalkDir::new(dir).max_depth(4).into_iter().filter_map(Result::ok) {
            let p = entry.path();
            let is_lnk = p.extension().is_some_and(|e| e.eq_ignore_ascii_case("lnk"));
            if !entry.file_type().is_file() || !is_lnk {
                continue;
            }
            let Some(name) = p.file_stem().and_then(|s| s.to_str()) else { continue };
            if is_noise(&name.to_lowercase()) {
                continue;
            }
            apps.push(AppEntry { name: name.to_string(), launch_path: p.to_path_buf() });
        }
    }
    dedupe_apps(apps)
}

/// The Ollama installer puts `ollama app.exe` (tray app that starts the
/// server) and `ollama.exe` in `%LOCALAPPDATA%\Programs\Ollama` and adds that
/// folder to the user's PATH (see ollama `app/ollama.iss` and `docs/windows.mdx`).
pub fn ollama_candidates(local_app_data: Option<&Path>, path_dirs: &[PathBuf]) -> Vec<OllamaInstall> {
    let mut v = Vec::new();
    if let Some(lad) = local_app_data {
        v.push(OllamaInstall::App(lad.join("Programs").join("Ollama").join("ollama app.exe")));
    }
    // Custom install dir: it's on PATH, and the tray app sits next to ollama.exe.
    for d in path_dirs {
        v.push(OllamaInstall::App(d.join("ollama app.exe")));
    }
    for d in path_dirs {
        v.push(OllamaInstall::Cli(d.join("ollama.exe")));
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(p: &Path) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, b"").unwrap();
    }

    #[test]
    fn finds_shortcuts_and_skips_noise_and_duplicates() {
        let user = tempfile::tempdir().unwrap();
        let all = tempfile::tempdir().unwrap();
        touch(&user.path().join("Spotify.lnk"));
        touch(&user.path().join("Discord Inc/Discord.lnk"));
        touch(&user.path().join("Discord Inc/Uninstall Discord.lnk"));
        touch(&all.path().join("Spotify.lnk")); // duplicate in all-users menu
        touch(&all.path().join("Microsoft Office/Word.LNK"));
        touch(&all.path().join("desktop.ini"));
        let apps = installed_apps(&[user.path().to_path_buf(), all.path().to_path_buf()]);
        let names: Vec<_> = apps.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, ["Discord", "Spotify", "Word"]);
        assert!(apps[2].launch_path.ends_with("Microsoft Office/Word.LNK"));
    }

    #[test]
    fn ollama_default_location_first() {
        let c = ollama_candidates(Some(Path::new("C:/Users/a/AppData/Local")), &[PathBuf::from("D:/tools")]);
        assert_eq!(c[0], OllamaInstall::App(PathBuf::from("C:/Users/a/AppData/Local/Programs/Ollama/ollama app.exe")));
        assert!(c.contains(&OllamaInstall::Cli(PathBuf::from("D:/tools/ollama.exe"))));
    }
}
