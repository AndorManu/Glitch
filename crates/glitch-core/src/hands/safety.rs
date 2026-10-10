//! What "Hands" (app control) may never touch, and which actions always need
//! their own confirmation. Pure functions over names and text, so the rules
//! are unit-tested here and the native side only reports facts.

/// Executables Glitch never controls: password managers, crypto wallets,
/// terminals and shells, and admin / security tools. Lower-case file stems.
const BLOCKED_EXES: &[&str] = &[
    // password managers
    "1password",
    "bitwarden",
    "keepass",
    "keepassxc",
    "lastpass",
    "dashlane",
    "keeper",
    "keeperpasswordmanager",
    "nordpass",
    "enpass",
    "roboform",
    "protonpass",
    "passwordsafe",
    "pwsafe",
    // wallets
    "ledger live",
    "ledgerlive",
    "exodus",
    "electrum",
    "metamask",
    // terminals and shells
    "cmd",
    "powershell",
    "powershell_ise",
    "pwsh",
    "windowsterminal",
    "wt",
    "conhost",
    "openconsole",
    "mintty",
    "bash",
    "wsl",
    "wslhost",
    "putty",
    "alacritty",
    "wezterm-gui",
    "hyper",
    "tabby",
    "kitty",
    "terminal",
    "iterm2",
    // admin, security, credentials
    "regedit",
    "mmc",
    "taskmgr",
    "consent",
    "gpedit",
    "secpol",
    "services",
    "compmgmt",
    "devmgmt",
    "eventvwr",
    "msconfig",
    "perfmon",
    "resmon",
    "credentialuibroker",
    "sechealthui",
    "systemsettingsadminflows",
    "lsass",
    "useraccountcontrolsettings",
    "keychain access",
    // anything that can run commands: Explorer's address bar and Run box,
    // script hosts, installers, remote shells, IDEs with integrated terminals
    "explorer",
    "rundll32",
    "mshta",
    "wscript",
    "cscript",
    "msiexec",
    "mstsc",
    "ssh",
    "control",
    "systemsettings",
    "taskschd",
    "certmgr",
    "netplwiz",
    "regedt32",
    "code",
    "code - insiders",
    "cursor",
    "windsurf",
    "devenv",
    "idea64",
    "idea",
    "pycharm64",
    "webstorm64",
    "rider64",
    "clion64",
    "goland64",
    "phpstorm64",
    "rubymine64",
    "datagrip64",
    "rustrover64",
    "studio64",
    "fleet",
    "sublime_text",
    "notepad++",
    "virtualbox",
    "vmconnect",
];

/// Window-title words that mean money, passwords or admin rights. Checked
/// on whole words (lower-case) so "Bank Holiday playlist" still blocks (we'd
/// rather refuse a playlist than click inside a bank).
const BLOCKED_TITLE_WORDS: &[&str] = &[
    "bank",
    "banking",
    "paypal",
    "revolut",
    "coinbase",
    "binance",
    "kraken",
    "metamask",
    "wallet",
    "1password",
    "bitwarden",
    "lastpass",
    "keepass",
    "dashlane",
    "password manager",
    "passwords",
    "credential manager",
    "user account control",
    "windows security",
    "command prompt",
    "powershell",
    "terminal",
    "registry editor",
    "devtools",
    "developer tools",
    "admin",
    "administrator",
    "management console",
    "control panel",
    "router",
    "credit card",
    "checkout",
    "payment",
    "payments",
    "billing",
    "brokerage",
    "trading",
    "crypto",
    "tax",
];

/// Browsers: their address bar runs `javascript:` and opens anything, so
/// Glitch never types into it (open_url exists for URLs).
const BROWSERS: &[&str] = &[
    "chrome",
    "msedge",
    "firefox",
    "brave",
    "opera",
    "vivaldi",
    "arc",
    "iexplore",
    "chromium",
    "waterfox",
    "librewolf",
];

/// Element names that mean "address bar", "terminal" or "console": never typed into.
const NO_TYPE_ELEMENTS: &[&str] = &[
    "address and search bar",
    "search or enter address",
    "enter address",
    "address bar",
    "location bar",
    "url bar",
    "terminal",
    "console",
    "command prompt",
    "command line",
    "powershell",
];

/// Apps where pressing Enter or clicking certain buttons sends a message.
const MESSAGING: &[&str] = &[
    "discord",
    "slack",
    "teams",
    "microsoft teams",
    "whatsapp",
    "telegram",
    "signal",
    "messenger",
    "outlook",
    "mail",
    "thunderbird",
    "skype",
    "zoom",
    "gmail",
    "instagram",
    "messages",
    "wechat",
    "line",
    "viber",
];

/// Element names that send, publish, buy or destroy something: clicking one
/// always shows its own confirmation with the exact target.
const SENSITIVE_WORDS: &[&str] = &[
    "send",
    "post",
    "publish",
    "tweet",
    "reply",
    "submit",
    "buy",
    "purchase",
    "pay",
    "checkout",
    "check out",
    "place order",
    "order now",
    "subscribe",
    "upgrade",
    "donate",
    "transfer",
    "delete",
    "uninstall",
    "format",
    "factory reset",
    "remove account",
    "confirm payment",
    "add to cart",
    "allow",
    "accept",
    "approve",
    "install",
    "run",
    "ok",
    "yes",
    "confirm",
    "share",
    "merge",
    "deploy",
    "grant",
    "authorize",
    "authorise",
    "sign",
    "agree",
    "invite",
    "forward",
    // desktop control: saving, closing and anything that changes the system
    "save",
    "save as",
    "close",
    "exit",
    "quit",
    "remove",
    "erase",
    "wipe",
    "reset",
    "restart",
    "shut down",
    "shutdown",
    "sign out",
    "log out",
    "turn off",
    "disable",
    "empty recycle bin",
];

fn words(s: &str) -> Vec<String> {
    s.to_lowercase()
        .split(|c: char| !c.is_alphanumeric() && c != '\'')
        .filter(|w| !w.is_empty())
        .map(String::from)
        .collect()
}

/// `needle` (one or more words) appears in `hay` as whole words.
fn has_phrase(hay: &[String], needle: &str) -> bool {
    let n = words(needle);
    !n.is_empty() && hay.windows(n.len()).any(|w| w == n.as_slice())
}

/// "Spotify" / "spotify.exe" / " SPOTIFY " -> "spotify".
pub fn norm_app(s: &str) -> String {
    let s = s.trim().to_lowercase();
    s.strip_suffix(".exe").unwrap_or(&s).trim().to_string()
}

/// Why Glitch won't control this window (None: it may, after the user allows it).
pub fn blocked(app: &str, exe: &str, title: &str) -> Option<&'static str> {
    let (app, exe) = (norm_app(app), norm_app(exe));
    if BLOCKED_EXES.iter().any(|b| *b == exe || *b == app) {
        return Some(
            "Glitch never controls password managers, wallets, terminals, shells or admin tools. Tell the user \
             to do this one themselves.",
        );
    }
    let t = words(title);
    let lt = title.trim().to_lowercase();
    if BLOCKED_TITLE_WORDS.iter().any(|w| has_phrase(&t, w)) || lt.starts_with("administrator:") || lt == "run" {
        return Some(
            "this window looks like banking, passwords or an admin tool, and Glitch never controls those. Tell \
             the user to do this one themselves.",
        );
    }
    None
}

/// An element that closes the window / quits the app. Closing is never done
/// with a key or a tool of its own, only by clicking the app's own control,
/// and always behind its own confirmation card.
pub fn is_close_control(name: &str) -> bool {
    let w = words(name);
    ["close", "close window", "close tab", "exit", "quit", "quit app"].iter().any(|c| w == words(c))
}

/// Is the task about a web address ("go to this url", "type it in the
/// address bar")? Only then may Glitch use a browser's address bar.
pub fn task_about_url(user_said: &str) -> bool {
    let t = user_said.to_lowercase();
    ["url", "address bar", "web address", "http://", "https://", "www."].iter().any(|k| t.contains(k))
}

/// A plain web address (no spaces, no script scheme).
pub fn looks_like_url(text: &str) -> bool {
    let t = text.trim().to_lowercase();
    if t.is_empty() || t.contains(char::is_whitespace) || t.starts_with("javascript:") || t.starts_with("data:") {
        return false;
    }
    t.starts_with("http://")
        || t.starts_with("https://")
        || t.starts_with("www.")
        || (t.contains('.') && !t.contains(':'))
}

pub fn is_messaging(app: &str, title: &str) -> bool {
    let app = norm_app(app);
    let t = words(title);
    MESSAGING.iter().any(|m| app == *m || app.contains(m) && m.len() > 4 || has_phrase(&t, m) && m.len() > 4)
}

/// The sensitive word an element's name contains, if any ("Send", "Buy now").
pub fn sensitive_name(name: &str) -> Option<&'static str> {
    let w = words(name);
    SENSITIVE_WORDS.iter().copied().find(|s| has_phrase(&w, s))
}

/// Text Glitch refuses to type anywhere: card numbers, API keys, tokens,
/// private keys, things labelled as passwords, bank account numbers.
pub fn looks_secret(text: &str) -> bool {
    let lower = text.to_lowercase();
    for label in ["password:", "password =", "passwd", "passcode", "pin:", "pin code", "cvv", "cvc", "seed phrase"] {
        if lower.contains(label) {
            return true;
        }
    }
    for prefix in
        ["sk-", "sk_live", "pk_live", "ghp_", "gho_", "github_pat_", "xoxb-", "xoxp-", "akia", "aiza", "-----begin"]
    {
        if lower.split_whitespace().any(|t| t.starts_with(prefix) && t.len() >= 12) || lower.contains("-----begin") {
            return true;
        }
    }
    // A card number: 13 to 19 digits (spaces/dashes allowed) passing Luhn.
    let digits: Vec<u32> = text.chars().filter(|c| !matches!(c, ' ' | '-')).map_while(|c| c.to_digit(10)).collect();
    let all_digits = text.chars().all(|c| c.is_ascii_digit() || c == ' ' || c == '-');
    if all_digits && (13..=19).contains(&digits.len()) && luhn(&digits) {
        return true;
    }
    for token in text.split_whitespace() {
        let t = token.trim_matches(|c: char| ",.;:!?\"'()".contains(c));
        let n = t.chars().count();
        // IBAN: two letters, two digits, then 10 to 30 letters/digits.
        let b = t.as_bytes();
        if (15..=34).contains(&n)
            && b[..2].iter().all(u8::is_ascii_alphabetic)
            && b[2..4].iter().all(u8::is_ascii_digit)
            && b.iter().all(u8::is_ascii_alphanumeric)
        {
            return true;
        }
        // A long random-looking token (key, token, password).
        if n >= 20 {
            let classes = [
                t.chars().any(|c| c.is_ascii_lowercase()),
                t.chars().any(|c| c.is_ascii_uppercase()),
                t.chars().any(|c| c.is_ascii_digit()),
                t.chars().any(|c| "_-+/=$!@#%".contains(c)),
            ];
            if classes.iter().filter(|x| **x).count() >= 3 && !t.contains("://") {
                return true;
            }
        }
        // JWT-ish: three base64 parts.
        if t.starts_with("eyJ") && t.matches('.').count() == 2 {
            return true;
        }
    }
    false
}

fn luhn(digits: &[u32]) -> bool {
    let sum: u32 = digits
        .iter()
        .rev()
        .enumerate()
        .map(|(i, &d)| {
            if i % 2 == 1 {
                let x = d * 2;
                if x > 9 {
                    x - 9
                } else {
                    x
                }
            } else {
                d
            }
        })
        .sum();
    sum.is_multiple_of(10)
}

fn tokens(s: &str) -> Vec<String> {
    s.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(String::from).collect()
}

/// Did the user say this text themselves (so typing it needs no extra OK)?
/// Whole words only, in the same order, as one stretch of the user's own
/// message ("rm" is not grounded by "form"); every symbol in it must also be
/// in the user's message. Text under 3 letters only counts when the user
/// quoted it or said it right after "type" / "write" / "enter" / "search".
pub fn grounded_in(text: &str, user_said: &str) -> bool {
    let t = tokens(text);
    let u = tokens(user_said);
    if t.is_empty() || t.len() > u.len() {
        return false;
    }
    let harmless = |c: char| c.is_alphanumeric() || c.is_whitespace() || "\"'\u{201c}\u{201d}.,!?".contains(c);
    if text.chars().any(|c| !harmless(c) && !user_said.contains(c)) {
        return false;
    }
    let Some(at) = u.windows(t.len()).position(|w| w == t.as_slice()) else { return false };
    if t.iter().map(|w| w.chars().count()).sum::<usize>() >= 3 {
        return true;
    }
    let lower = user_said.to_lowercase();
    let phrase = t.join(" ");
    let quoted = ["\"", "'", "\u{201c}"].iter().any(|q| lower.contains(&format!("{q}{phrase}")));
    let after_verb = at > 0 && ["type", "write", "enter", "search", "say"].contains(&u[at - 1].as_str());
    quoted || after_verb
}

/// Never type into this element: a browser address bar, a terminal or console.
pub fn no_typing_into(exe: &str, role: &str, name: &str) -> Option<&'static str> {
    let n = tokens(name);
    if is_address_bar(exe, role, name) {
        return Some(
            "that is the browser's address bar; Glitch never types there. Use open_url to open a web page instead.",
        );
    }
    if NO_TYPE_ELEMENTS.iter().any(|w| has_phrase(&n, w)) {
        return Some("that looks like an address bar, terminal or console; Glitch never types into those.");
    }
    None
}

/// A browser's address bar (the one field that may be used when the task is
/// about a web address, with its own confirmation card).
pub fn is_address_bar(exe: &str, role: &str, name: &str) -> bool {
    let n = tokens(name);
    let field = matches!(role, "edit" | "combo box" | "document");
    is_browser(exe) && field && n.iter().any(|w| ["address", "url", "location", "omnibox"].contains(&w.as_str()))
}

pub fn is_browser(exe: &str) -> bool {
    BROWSERS.contains(&norm_app(exe).as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_passwords_terminals_admin_and_banks() {
        assert!(blocked("1Password", "1Password", "1Password").is_some());
        assert!(blocked("Windows Terminal", "WindowsTerminal", "PowerShell").is_some());
        assert!(blocked("Command Prompt", "cmd", "C:\\WINDOWS\\system32\\cmd.exe").is_some());
        assert!(blocked("Google Chrome", "chrome", "KBC Online Banking - Google Chrome").is_some());
        assert!(blocked("Microsoft Edge", "msedge", "PayPal: Summary - Microsoft Edge").is_some());
        assert!(blocked("Notepad", "notepad", "Administrator: notes.txt").is_some());
        assert!(blocked("consent", "consent.exe", "User Account Control").is_some());
        assert!(blocked("Spotify", "Spotify", "Spotify Premium").is_none());
        assert!(blocked("Notepad", "notepad", "shopping.txt - Notepad").is_none());
        assert!(blocked("Google Chrome", "chrome", "YouTube - Google Chrome").is_none());
        for exe in [
            "explorer",
            "rundll32",
            "mshta",
            "wscript",
            "cscript",
            "regedit",
            "powershell_ise",
            "pwsh",
            "wt",
            "cmd",
            "mmc",
            "control",
            "code",
            "devenv",
            "idea64",
            "pycharm64",
            "msiexec",
            "mstsc",
            "systemsettings",
        ] {
            assert!(blocked(exe, exe, "Something").is_some(), "{exe}");
        }
        assert!(blocked("Run", "", "Run").is_some(), "the Run box");
        assert!(blocked("Google Chrome", "chrome", "DevTools - example.com").is_some());
        assert!(blocked("Google Chrome", "chrome", "Router admin - Google Chrome").is_some());
    }

    #[test]
    fn never_types_into_address_bars_or_terminals() {
        assert!(no_typing_into("chrome", "edit", "Address and search bar").is_some());
        assert!(no_typing_into("msedge.exe", "edit", "Address and search bar").is_some());
        assert!(no_typing_into("firefox", "combo box", "Search with Google or enter address").is_some());
        assert!(no_typing_into("spotify", "edit", "Terminal 1, powershell").is_some());
        assert!(no_typing_into("notepad", "document", "Text editor").is_none());
        assert!(no_typing_into("spotify", "edit", "What do you want to play?").is_none());
        assert!(no_typing_into("chrome", "edit", "Search").is_none());
    }

    #[test]
    fn sensitive_buttons_are_whole_words() {
        assert_eq!(sensitive_name("Send"), Some("send"));
        assert_eq!(sensitive_name("Buy now"), Some("buy"));
        assert_eq!(sensitive_name("Place order"), Some("place order"));
        assert_eq!(sensitive_name("Play Late Night Drive"), None);
        assert_eq!(sensitive_name("Playlist"), None);
        assert_eq!(sensitive_name("Repost"), None, "whole words only");
        assert_eq!(sensitive_name("Search"), None);
        for w in
            ["Allow", "Accept all", "Approve", "Install", "Run", "OK", "Yes", "Confirm", "Share", "Merge", "Deploy"]
        {
            assert!(sensitive_name(w).is_some(), "{w}");
        }
        assert_eq!(sensitive_name("Not now"), None);
    }

    #[test]
    fn desktop_control_words_need_their_own_card() {
        for w in ["Save", "Save as...", "Close", "Exit", "Quit", "Remove", "Shut down", "Turn off", "Restart now"] {
            assert!(sensitive_name(w).is_some(), "{w}");
        }
        for w in ["Savings", "Closet", "Open", "Cancel", "Item A", "Folder X"] {
            assert_eq!(sensitive_name(w), None, "{w}");
        }
        assert!(is_close_control("Close"));
        assert!(is_close_control("Close window"));
        assert!(is_close_control("Quit"));
        assert!(!is_close_control("Close all other tabs"), "only the plain close controls");
        assert!(!is_close_control("Save"));
    }

    #[test]
    fn the_address_bar_is_only_for_url_tasks() {
        assert!(task_about_url("go to https://example.com and scroll"));
        assert!(task_about_url("type this url in the address bar"));
        assert!(!task_about_url("play my playlist"));
        assert!(is_address_bar("chrome", "edit", "Address and search bar"));
        assert!(!is_address_bar("notepad", "edit", "Address"));
        assert!(looks_like_url("https://example.com/a?b=1"));
        assert!(looks_like_url("example.com"));
        assert!(!looks_like_url("javascript:alert(1)"));
        assert!(!looks_like_url("two words.com"));
        assert!(!looks_like_url("data:text/html,<b>"));
    }

    #[test]
    fn messaging_apps() {
        assert!(is_messaging("Discord", "#general - Discord"));
        assert!(is_messaging("Google Chrome", "WhatsApp - Google Chrome"));
        assert!(is_messaging("Outlook", "Inbox - Outlook"));
        assert!(!is_messaging("Spotify", "Spotify Premium"));
        assert!(!is_messaging("Notepad", "hello.txt - Notepad"));
    }

    #[test]
    fn secrets_are_never_typed() {
        for s in [
            "4111 1111 1111 1111",
            "4111-1111-1111-1111",
            "sk-abcdefghijklmnop1234",
            "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
            "my password: hunter2",
            "BE68539007547034",
            "xY9#kL2$mN8pQ4rT6vW1zA",
            "eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4fw",
        ] {
            assert!(looks_secret(s), "{s}");
        }
        for s in ["hello", "Late Night Drive", "https://www.example.com/some/long/path?x=1", "call mum at 5", "12345"] {
            assert!(!looks_secret(s), "{s}");
        }
    }

    #[test]
    fn grounding() {
        assert!(grounded_in("hello", "open notepad and type hello"));
        assert!(grounded_in("\"Hello World\"", "type hello   world in notepad"));
        assert!(!grounded_in("buy bitcoin", "open notepad and type hello"));
        assert!(!grounded_in("  ", "anything"));
        // Whole words only: "rm" is not in "form".
        assert!(!grounded_in("rm", "fill in the form"));
        assert!(!grounded_in("rm -rf /", "fill in the form for tmp"));
        assert!(!grounded_in("hello world", "world hello"));
        assert!(!grounded_in("a", "type something in a notepad"), "single letters need quoting");
        assert!(grounded_in("hi", "type hi in discord"));
        assert!(grounded_in("ok", "write 'ok' in the box"));
        assert!(!grounded_in("hello; rm", "type hello rm"), "symbols must come from the user too");
    }
}
