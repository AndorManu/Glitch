//! macOS specifics. Pure path logic, compiled on every OS for testing.

use std::path::{Path, PathBuf};

use super::{dedupe_apps, AppEntry, OllamaInstall};

pub fn app_dirs(home: Option<&Path>) -> Vec<PathBuf> {
    let mut v = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/Applications/Utilities"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/System/Applications/Utilities"),
    ];
    if let Some(h) = home {
        v.push(h.join("Applications"));
    }
    v
}

/// `*.app` bundles directly inside the given folders. We never look inside a
/// bundle (they are folders too).
pub fn installed_apps(app_dirs: &[PathBuf]) -> Vec<AppEntry> {
    let mut apps = Vec::new();
    for dir in app_dirs {
        let Ok(rd) = std::fs::read_dir(dir) else { continue };
        for entry in rd.filter_map(Result::ok) {
            let p = entry.path();
            if !p.extension().is_some_and(|e| e.eq_ignore_ascii_case("app")) {
                continue;
            }
            if let Some(name) = p.file_stem().and_then(|s| s.to_str()) {
                apps.push(AppEntry { name: name.to_string(), launch_path: p.clone() });
            }
        }
    }
    dedupe_apps(apps)
}

/// The Ollama app is dragged to /Applications (see ollama `docs/macos.mdx`);
/// Homebrew installs only the CLI.
pub fn ollama_candidates(home: Option<&Path>, path_dirs: &[PathBuf]) -> Vec<OllamaInstall> {
    let mut v = vec![OllamaInstall::App(PathBuf::from("/Applications/Ollama.app"))];
    if let Some(h) = home {
        v.push(OllamaInstall::App(h.join("Applications/Ollama.app")));
    }
    // GUI apps on macOS don't inherit the shell PATH, so add the usual spots.
    let mut cli_dirs: Vec<PathBuf> = path_dirs.to_vec();
    cli_dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    v.extend(cli_dirs.into_iter().map(|d| OllamaInstall::Cli(d.join("ollama"))));
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_app_bundles_only() {
        let a = tempfile::tempdir().unwrap();
        let u = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(a.path().join("Safari.app/Contents/MacOS")).unwrap();
        std::fs::create_dir_all(a.path().join("Spotify.app")).unwrap();
        std::fs::create_dir_all(a.path().join("Utilities")).unwrap();
        std::fs::write(a.path().join("notes.txt"), "").unwrap();
        std::fs::create_dir_all(u.path().join("Spotify.app")).unwrap(); // duplicate
        let apps = installed_apps(&[a.path().to_path_buf(), u.path().to_path_buf(), PathBuf::from("/does/not/exist")]);
        let names: Vec<_> = apps.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, ["Safari", "Spotify"]);
    }

    #[test]
    fn ollama_app_preferred_over_cli() {
        let c = ollama_candidates(Some(Path::new("/Users/a")), &[]);
        assert_eq!(c[0], OllamaInstall::App(PathBuf::from("/Applications/Ollama.app")));
        assert!(c.contains(&OllamaInstall::Cli(PathBuf::from("/opt/homebrew/bin/ollama"))));
    }
}
