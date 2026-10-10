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

/// Prefix of a packaged (Microsoft Store / built-in UWP) app's launch path.
/// Opened with `explorer.exe shell:AppsFolder\<AppUserModelID>`.
pub const APPS_FOLDER_PREFIX: &str = r"shell:AppsFolder\";

/// PowerShell that lists packaged apps as "Name<TAB>AppUserModelID" lines.
/// Calculator, Photos, Paint, Notepad, Clock, Settings and Store apps such as
/// WhatsApp have no `.lnk` in the Start Menu folders, so the shortcut scan
/// alone can't find them ("open calculator" failed on Windows 11).
pub const PACKAGED_APPS_SCRIPT: &str = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; \
    Get-StartApps | Where-Object { $_.AppID -like '*!*' } | ForEach-Object { $_.Name + \"`t\" + $_.AppID }";

/// An AppUserModelID such as `Microsoft.WindowsCalculator_8wekyb3d8bbwe!App`.
/// Strict, because it ends up on explorer.exe's command line.
pub fn is_app_user_model_id(id: &str) -> bool {
    id.len() <= 256
        && id.contains('!')
        && !id.starts_with(['-', '/', '.'])
        && id.chars().all(|c| c.is_ascii_alphanumeric() || "._-!".contains(c))
}

/// Parse [`PACKAGED_APPS_SCRIPT`]'s output.
pub fn parse_packaged_apps(output: &str) -> Vec<AppEntry> {
    output
        .lines()
        .filter_map(|l| {
            let (name, id) = l.trim_end_matches('\r').split_once('\t')?;
            let (name, id) = (name.trim(), id.trim());
            (!name.is_empty() && is_app_user_model_id(id) && !is_noise(&name.to_lowercase()))
                .then(|| AppEntry { name: name.to_string(), launch_path: format!("{APPS_FOLDER_PREFIX}{id}").into() })
        })
        .collect()
}

/// Start Menu shortcuts first (they win on equal names), then packaged apps.
pub fn merge_apps(shortcuts: Vec<AppEntry>, packaged: Vec<AppEntry>) -> Vec<AppEntry> {
    dedupe_apps(shortcuts.into_iter().chain(packaged).collect())
}

/// The packaged app's AppUserModelID if `launch_path` is one of ours.
pub fn packaged_app_id(launch_path: &Path) -> Option<&str> {
    let id = launch_path.to_str()?.strip_prefix(APPS_FOLDER_PREFIX)?;
    is_app_user_model_id(id).then_some(id)
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
    fn packaged_apps_are_parsed_and_merged() {
        let out = "Calculator\tMicrosoft.WindowsCalculator_8wekyb3d8bbwe!App\r\n\
                   Spotify\tSpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify\r\n\
                   Evil\tfoo!bar & calc.exe\r\n\
                   Uninstall Thing\tA.B_c!App\r\n\
                   garbage line\n";
        let packaged = parse_packaged_apps(out);
        let names: Vec<_> = packaged.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, ["Calculator", "Spotify"]);
        assert_eq!(packaged_app_id(&packaged[0].launch_path), Some("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"));
        // A real Start Menu shortcut wins over the packaged entry of the same name.
        let lnk = AppEntry { name: "Spotify".into(), launch_path: "C:/x/Spotify.lnk".into() };
        let all = merge_apps(vec![lnk.clone()], packaged);
        assert_eq!(all.len(), 2);
        assert_eq!(all.iter().find(|a| a.name == "Spotify").unwrap(), &lnk);
        assert_eq!(packaged_app_id(Path::new("C:/x/Spotify.lnk")), None);
        assert_eq!(packaged_app_id(Path::new(r"shell:AppsFolder\a!b c")), None);
    }

    #[test]
    fn ollama_default_location_first() {
        let c = ollama_candidates(Some(Path::new("C:/Users/a/AppData/Local")), &[PathBuf::from("D:/tools")]);
        assert_eq!(c[0], OllamaInstall::App(PathBuf::from("C:/Users/a/AppData/Local/Programs/Ollama/ollama app.exe")));
        assert!(c.contains(&OllamaInstall::Cli(PathBuf::from("D:/tools/ollama.exe"))));
    }
}
