//! `open_app`: match a name from the model against discovered installed apps.

use crate::platform::{normalise_name, AppEntry};

use super::ToolError;

/// Apps the model may never open, even with confirmation: they would give
/// it a way around "no shell access" (terminals, script runners) or let it
/// change system internals.
const BLOCKED: &[&str] = &[
    "terminal",
    "iterm",
    "iterm2",
    "warp",
    "commandprompt",
    "cmd",
    "powershell",
    "windowspowershell",
    "windowspowershellise",
    "pwsh",
    "windowsterminal",
    "registryeditor",
    "regedit",
    "scripteditor",
    "automator",
    "shortcuts",
    "gitbash",
];

fn is_blocked(name: &str) -> bool {
    let n = normalise_name(name);
    const CONTAINS: &[&str] = &[
        "powershell",
        "commandprompt",
        "terminal",
        "iterm",
        "anacondaprompt",
        "gitbash",
        "gitcmd",
        "wezterm",
        "alacritty",
        "ghostty",
        "diskutility",
    ];
    const PREFIX: &[&str] = &["python", "idlepython", "nodejs", "wsl", "kitty", "hyper", "tabby"];
    const EXACT: &[&str] = &["idle", "node", "run", "ubuntu", "debian", "kali", "opensuse", "fedora"];
    BLOCKED.iter().any(|b| n == *b)
        || CONTAINS.iter().any(|w| n.contains(w))
        || PREFIX.iter().any(|p| n.starts_with(p))
        || EXACT.contains(&n.as_str())
}

/// Score how well an installed app name matches what was asked for.
fn score(query: &str, app_name: &str) -> u8 {
    let q = normalise_name(query);
    let n = normalise_name(app_name);
    if q.is_empty() {
        return 0;
    }
    if n == q {
        return 100;
    }
    // A whole word of the app name: "word" → "Microsoft Word".
    let words: Vec<String> = app_name.split_whitespace().map(normalise_name).collect();
    if words.contains(&q) {
        return 80;
    }
    if n.starts_with(&q) {
        return 60;
    }
    if q.len() >= 3 && n.contains(&q) {
        return 40;
    }
    0
}

pub fn resolve(query: &str, installed: &[AppEntry]) -> Result<AppEntry, ToolError> {
    if is_blocked(query) {
        return Err(ToolError(format!("for safety, Glitch can't open \"{query}\"")));
    }
    let candidates: Vec<&AppEntry> = installed.iter().filter(|a| !is_blocked(&a.name)).collect();
    if installed.is_empty() {
        return Err(ToolError("app discovery isn't available on this computer".into()));
    }
    let best = candidates.iter().map(|a| score(query, &a.name)).max().unwrap_or(0);
    if best == 0 {
        return Err(ToolError(format!(
            "no installed app called \"{query}\" was found. If it's a website, use open_url instead."
        )));
    }
    let top: Vec<&&AppEntry> = candidates.iter().filter(|a| score(query, &a.name) == best).collect();
    if top.len() == 1 {
        return Ok((*top[0]).clone());
    }
    let names: Vec<&str> = top.iter().take(8).map(|a| a.name.as_str()).collect();
    Err(ToolError(format!("several apps match \"{query}\": {}. Ask the user which one they mean.", names.join(", "))))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apps(names: &[&str]) -> Vec<AppEntry> {
        names.iter().map(|n| AppEntry { name: n.to_string(), launch_path: format!("/apps/{n}").into() }).collect()
    }

    #[test]
    fn exact_and_case_insensitive() {
        let a = apps(&["Spotify", "Spotify Helper Tool", "Calculator"]);
        assert_eq!(resolve("spotify", &a).unwrap().name, "Spotify");
        assert_eq!(resolve("CALCULATOR", &a).unwrap().name, "Calculator");
    }

    #[test]
    fn whole_word_beats_prefix() {
        let a = apps(&["Microsoft Word", "WordPad"]);
        assert_eq!(resolve("word", &a).unwrap().name, "Microsoft Word");
    }

    #[test]
    fn prefix_and_contains() {
        let a = apps(&["Visual Studio Code", "Google Chrome"]);
        assert_eq!(resolve("visual studio", &a).unwrap().name, "Visual Studio Code");
        assert_eq!(resolve("chrome", &a).unwrap().name, "Google Chrome");
    }

    #[test]
    fn ambiguous_lists_candidates() {
        let a = apps(&["Adobe Photoshop 2024", "Adobe Illustrator 2024"]);
        let err = resolve("adobe", &a).unwrap_err();
        assert!(err.0.contains("Photoshop") && err.0.contains("Illustrator"), "{err}");
    }

    #[test]
    fn not_found_suggests_open_url() {
        let a = apps(&["Calculator"]);
        assert!(resolve("twitter", &a).unwrap_err().0.contains("open_url"));
    }

    #[test]
    fn shells_and_terminals_are_never_opened() {
        let a = apps(&[
            "Terminal",
            "Windows PowerShell",
            "Command Prompt",
            "iTerm",
            "Registry Editor",
            "Notes",
            "Git CMD",
            "Python 3.12 (64-bit)",
            "IDLE (Python 3.12 64-bit)",
            "Ubuntu",
            "Run",
            "WezTerm",
            "Disk Utility",
        ]);
        for q in [
            "terminal",
            "powershell",
            "Windows PowerShell",
            "command prompt",
            "cmd",
            "iterm",
            "regedit",
            "Registry Editor",
        ] {
            assert!(resolve(q, &a).is_err(), "{q} must be blocked");
        }
        // "power" would prefix-match PowerShell; blocked apps aren't candidates.
        assert!(resolve("power", &a).is_err());
        assert_eq!(resolve("notes", &a).unwrap().name, "Notes");
    }

    #[test]
    fn empty_discovery_explains_itself() {
        assert!(resolve("spotify", &[]).unwrap_err().0.contains("discovery"));
    }
}
