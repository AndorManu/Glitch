//! Claude Code buddy: a hook in the user's Claude Code settings
//! (`~/.claude/settings.json`) that tells Glitch when a session finishes
//! (`Stop`) or needs the user (`Notification`).
//!
//! The settings merge is careful with someone else's file:
//! * nothing is written unless the user clicked "Connect" after seeing the
//!   exact entries ([`preview`]);
//! * other hooks and settings are kept (keys come out sorted, as
//!   serde_json writes them; the content is the same);
//! * connecting twice changes nothing; a moved Glitch updates its own entry;
//! * before every change the old file is copied to one backup next to it
//!   (`settings.json.glitch-backup`, readable only by the user: it can
//!   hold API keys), replacing the previous backup;
//! * a file that isn't valid JSON is never touched;
//! * "Disconnect" removes only Glitch's entries: commands ending in exactly
//!   ` --glitch-claude-hook`.

use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};

use super::{clean, Level, UpdateEvent};

/// Marks Glitch's own hook commands: only a command that ends with exactly
/// this flag is Glitch's (other tools' hooks are never touched).
pub const HOOK_FLAG: &str = "--glitch-claude-hook";
pub const EVENTS: [&str; 2] = ["Stop", "Notification"];
/// Seconds Claude Code gives the hook (it returns in well under one).
const HOOK_TIMEOUT: u64 = 10;

/// `~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json`.
pub fn settings_path() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir).join("settings.json"));
    }
    dirs::home_dir().map(|h| h.join(".claude").join("settings.json"))
}

/// Characters that mean something inside double quotes to cmd.exe, sh or
/// bash (Claude Code may run hooks through either). A path with one of them
/// is refused rather than quoted cleverly.
const UNSAFE_IN_QUOTES: &[char] = &['"', '\'', '$', '`', '%', '!', '\\', '\n', '\r', '\0'];

/// The hook command for this Glitch: `"C:/.../glitch.exe" --glitch-claude-hook`.
/// Forward slashes work for Windows paths in cmd and in bash alike, so the
/// only quoting needed is the double quotes around a path with spaces.
pub fn hook_command(exe: &Path) -> Result<String, String> {
    let path = exe.display().to_string().replace('\\', "/");
    if path.is_empty() || path.contains(UNSAFE_IN_QUOTES) {
        return Err(format!(
            "Glitch's install folder ({path}) has characters that aren't safe in a command line; move Glitch to a \
             plain folder to connect Claude Code"
        ));
    }
    Ok(format!("\"{path}\" {HOOK_FLAG}"))
}

fn is_ours(hook: &Value) -> bool {
    hook.get("command").and_then(Value::as_str).is_some_and(|c| c.trim_end().ends_with(&format!(" {HOOK_FLAG}")))
}

fn our_group(command: &str) -> Value {
    json!({ "hooks": [ { "type": "command", "command": command, "timeout": HOOK_TIMEOUT } ] })
}

/// What "Connect" adds, exactly as it will appear in the file.
pub fn added_entries(command: &str) -> Value {
    let mut hooks = Map::new();
    for ev in EVENTS {
        hooks.insert(ev.into(), json!([our_group(command)]));
    }
    json!({ "hooks": hooks })
}

#[derive(Debug, thiserror::Error)]
pub enum MergeError {
    #[error("the Claude Code settings file isn't valid JSON, so Glitch won't touch it: {0}")]
    Invalid(String),
    #[error("the Claude Code settings file has an unexpected shape (\"{0}\" isn't what Claude Code writes)")]
    Shape(&'static str),
    #[error("{0}")]
    Io(#[from] io::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
}

fn parse(existing: Option<&str>) -> Result<Map<String, Value>, MergeError> {
    match existing.map(str::trim) {
        None | Some("") => Ok(Map::new()),
        Some(s) => match serde_json::from_str::<Value>(s) {
            Ok(Value::Object(m)) => Ok(m),
            Ok(_) => Err(MergeError::Shape("the top level")),
            Err(e) => Err(MergeError::Invalid(e.to_string())),
        },
    }
}

/// Remove our hook entries everywhere; drops groups / event lists / the
/// `hooks` object only if removing ours left them empty.
fn strip_ours(root: &mut Map<String, Value>) -> Result<bool, MergeError> {
    let Some(hooks) = root.get_mut("hooks") else { return Ok(false) };
    let hooks = hooks.as_object_mut().ok_or(MergeError::Shape("hooks"))?;
    let mut removed = false;
    for (_, groups) in hooks.iter_mut() {
        let Some(groups) = groups.as_array_mut() else { continue };
        let mut emptied = false;
        for g in groups.iter_mut() {
            if let Some(list) = g.get_mut("hooks").and_then(Value::as_array_mut) {
                let n = list.len();
                list.retain(|h| !is_ours(h));
                if list.len() != n {
                    removed = true;
                    emptied |= list.is_empty();
                }
            }
        }
        if emptied {
            groups.retain(|g| g.get("hooks").and_then(Value::as_array).is_none_or(|l| !l.is_empty()));
        }
    }
    if removed {
        hooks.retain(|_, g| g.as_array().is_none_or(|a| !a.is_empty()));
        if hooks.is_empty() {
            root.remove("hooks");
        }
    }
    Ok(removed)
}

/// Our command as it currently stands for each event (`None` if missing).
fn our_commands(root: &Map<String, Value>) -> Vec<Option<String>> {
    EVENTS
        .iter()
        .map(|ev| {
            root.get("hooks")?.get(*ev)?.as_array()?.iter().find_map(|g| {
                g.get("hooks")?.as_array()?.iter().find(|h| is_ours(h))?.get("command")?.as_str().map(String::from)
            })
        })
        .collect()
}

fn count_ours(root: &Map<String, Value>) -> usize {
    root.get("hooks")
        .and_then(Value::as_object)
        .map(|h| {
            h.values()
                .filter_map(Value::as_array)
                .flatten()
                .filter_map(|g| g.get("hooks").and_then(Value::as_array))
                .flatten()
                .filter(|x| is_ours(x))
                .count()
        })
        .unwrap_or(0)
}

/// The merged file text, or `None` if it is already exactly connected.
pub fn merge_connect(existing: Option<&str>, command: &str) -> Result<Option<String>, MergeError> {
    let mut root = parse(existing)?;
    let current = our_commands(&root);
    if current.iter().all(|c| c.as_deref() == Some(command)) && count_ours(&root) == EVENTS.len() {
        return Ok(None);
    }
    strip_ours(&mut root)?;
    let hooks = root.entry("hooks").or_insert_with(|| json!({}));
    let hooks = hooks.as_object_mut().ok_or(MergeError::Shape("hooks"))?;
    for ev in EVENTS {
        let groups = hooks.entry(ev).or_insert_with(|| json!([]));
        groups.as_array_mut().ok_or(MergeError::Shape("hooks"))?.push(our_group(command));
    }
    Ok(Some(serde_json::to_string_pretty(&Value::Object(root))? + "\n"))
}

/// The file text without our entries, or `None` if there were none.
pub fn merge_disconnect(existing: Option<&str>) -> Result<Option<String>, MergeError> {
    let mut root = parse(existing)?;
    if !strip_ours(&mut root)? {
        return Ok(None);
    }
    Ok(Some(serde_json::to_string_pretty(&Value::Object(root))? + "\n"))
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Status {
    pub path: PathBuf,
    pub file_exists: bool,
    /// Our hooks are in the file (for every event).
    pub connected: bool,
    /// Connected, but pointing at another Glitch exe (moved/reinstalled).
    pub outdated: bool,
    /// The file can't be read as JSON (Glitch won't touch it).
    pub problem: Option<String>,
    /// What "Connect" would add (pretty JSON), shown before connecting.
    pub preview: String,
    pub command: String,
}

pub fn status(path: &Path, command: &str) -> Status {
    let text = std::fs::read_to_string(path).ok();
    let (connected, outdated, problem) = match parse(text.as_deref()) {
        Ok(root) => {
            let cmds = our_commands(&root);
            let connected = cmds.iter().all(Option::is_some);
            (connected, connected && cmds.iter().any(|c| c.as_deref() != Some(command)), None)
        }
        Err(e) => (false, false, Some(e.to_string())),
    };
    Status {
        path: path.to_path_buf(),
        file_exists: text.is_some(),
        connected,
        outdated,
        problem,
        preview: serde_json::to_string_pretty(&added_entries(command)).unwrap_or_default(),
        command: command.to_string(),
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Change {
    pub changed: bool,
    pub backup: Option<PathBuf>,
}

/// The one backup Glitch keeps, next to the original.
pub fn backup_path(path: &Path) -> PathBuf {
    path.with_file_name("settings.json.glitch-backup")
}

/// Only the current user may read the file (it can hold API keys).
/// Created empty, locked down, then filled, so the content is never
/// readable by others even for a moment.
fn write_private(path: &Path, content: &str) -> io::Result<()> {
    let _ = std::fs::remove_file(path);
    std::fs::write(path, "")?;
    restrict_to_user(path)?;
    std::fs::write(path, content)
}

#[cfg(unix)]
fn restrict_to_user(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

/// Windows: drop inherited entries, grant only the current user (icacls is
/// part of every Windows; no extra dependency for a one-off).
#[cfg(windows)]
fn restrict_to_user(path: &Path) -> io::Result<()> {
    use std::os::windows::process::CommandExt;
    let user = std::env::var("USERNAME").map_err(|_| io::Error::other("unknown user"))?;
    let who = match std::env::var("USERDOMAIN") {
        Ok(d) if !d.is_empty() => format!("{d}\\{user}"),
        _ => user,
    };
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let status = std::process::Command::new("icacls")
        .arg(path)
        .args(["/inheritance:r", "/grant:r", &format!("{who}:F")])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other("couldn't make the backup private"))
    }
}

#[cfg(not(any(unix, windows)))]
fn restrict_to_user(_: &Path) -> io::Result<()> {
    Ok(())
}

fn write_with_backup(path: &Path, old: Option<&str>, new: &str) -> io::Result<Option<PathBuf>> {
    let backup = match old {
        Some(old) => {
            let b = backup_path(path);
            write_private(&b, old)?;
            Some(b)
        }
        None => None,
    };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_file_name("settings.json.glitch-tmp");
    std::fs::write(&tmp, new)?;
    std::fs::rename(&tmp, path)?;
    Ok(backup)
}

pub fn connect(path: &Path, command: &str) -> Result<Change, MergeError> {
    let old = std::fs::read_to_string(path).ok();
    match merge_connect(old.as_deref(), command)? {
        None => Ok(Change { changed: false, backup: None }),
        Some(new) => Ok(Change { changed: true, backup: write_with_backup(path, old.as_deref(), &new)? }),
    }
}

pub fn disconnect(path: &Path) -> Result<Change, MergeError> {
    let old = std::fs::read_to_string(path).ok();
    match merge_disconnect(old.as_deref())? {
        None => Ok(Change { changed: false, backup: None }),
        Some(new) => Ok(Change { changed: true, backup: write_with_backup(path, old.as_deref(), &new)? }),
    }
}

/// "C:\code\Glitch" -> "Glitch".
fn project_name(cwd: &str) -> Option<String> {
    let name = cwd.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next()?;
    let name = clean(name, 40);
    (!name.is_empty()).then_some(name)
}

/// The hook's stdin JSON -> the event sent to Glitch. Only the event name,
/// the folder name and the short notification message are kept; the
/// transcript path and session id never leave the hook.
pub fn event_from_hook(input: &str) -> Option<UpdateEvent> {
    let v: Value = serde_json::from_str(input).ok()?;
    let name = v.get("hook_event_name")?.as_str()?;
    let project = v.get("cwd").and_then(Value::as_str).and_then(project_name);
    let mut e = match name {
        "Stop" => {
            let body = match &project {
                Some(p) => format!("Finished in {p}."),
                None => "Finished.".into(),
            };
            let mut e = UpdateEvent::new("Claude Code is done", &body, "claude-code", Level::Success);
            e.kind = Some("done".into());
            e
        }
        "Notification" => {
            let msg = v.get("message").and_then(Value::as_str).unwrap_or("Claude Code is waiting for you.");
            let mut e = UpdateEvent::new("Claude Code needs you", msg, "claude-code", Level::Warning);
            e.kind = Some("needs_input".into());
            e
        }
        _ => return None,
    };
    e.project = project;
    Some(e)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CMD: &str = r#""C:\Program Files\Glitch\glitch.exe" --glitch-claude-hook"#;

    #[test]
    fn connect_into_nothing() {
        let out = merge_connect(None, CMD).unwrap().unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v, added_entries(CMD));
        assert_eq!(v["hooks"]["Stop"][0]["hooks"][0]["command"], CMD);
    }

    #[test]
    fn keeps_everything_else_in_order_and_is_idempotent() {
        let existing = r#"{
  "model": "opus",
  "permissions": { "allow": ["Bash(ls:*)"] },
  "hooks": {
    "Stop": [ { "hooks": [ { "type": "command", "command": "say done" } ] } ],
    "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "check.sh" } ] } ]
  },
  "zeta": 1
}"#;
        let once = merge_connect(Some(existing), CMD).unwrap().unwrap();
        let v: Value = serde_json::from_str(&once).unwrap();
        assert_eq!(v["model"], "opus");
        assert_eq!(v["permissions"]["allow"][0], "Bash(ls:*)");
        assert_eq!(v["hooks"]["PreToolUse"][0]["hooks"][0]["command"], "check.sh");
        // The user's own Stop hook stays first, ours is added after it.
        assert_eq!(v["hooks"]["Stop"][0]["hooks"][0]["command"], "say done");
        assert_eq!(v["hooks"]["Stop"][1]["hooks"][0]["command"], CMD);
        assert_eq!(v["hooks"]["Notification"][0]["hooks"][0]["command"], CMD);
        assert_eq!(v["zeta"], 1);
        // Second time: nothing to do.
        assert_eq!(merge_connect(Some(&once), CMD).unwrap(), None);
        // Moved exe: our entry is replaced, not duplicated.
        let moved = r#""D:\Glitch\glitch.exe" --glitch-claude-hook"#;
        let v: Value = serde_json::from_str(&merge_connect(Some(&once), moved).unwrap().unwrap()).unwrap();
        assert_eq!(v["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert_eq!(v["hooks"]["Stop"][1]["hooks"][0]["command"], moved);
        // Disconnect restores the original content.
        let back = merge_disconnect(Some(&once)).unwrap().unwrap();
        assert_eq!(serde_json::from_str::<Value>(&back).unwrap(), serde_json::from_str::<Value>(existing).unwrap());
        assert_eq!(merge_disconnect(Some(&back)).unwrap(), None);
    }

    #[test]
    fn disconnect_from_a_file_that_only_had_ours_leaves_no_empty_hooks() {
        let only = merge_connect(Some(r#"{"theme":"dark"}"#), CMD).unwrap().unwrap();
        let back: Value = serde_json::from_str(&merge_disconnect(Some(&only)).unwrap().unwrap()).unwrap();
        assert_eq!(back, json!({"theme": "dark"}));
        // A group holding the user's hook and ours: only ours goes.
        let mixed = json!({"hooks": {"Stop": [{"hooks": [
            {"type": "command", "command": "say hi"},
            {"type": "command", "command": CMD}
        ]}]}});
        let back: Value = serde_json::from_str(&merge_disconnect(Some(&mixed.to_string())).unwrap().unwrap()).unwrap();
        assert_eq!(back, json!({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "say hi"}]}]}}));
    }

    #[test]
    fn broken_or_odd_files_are_never_touched() {
        assert!(matches!(merge_connect(Some("{ nope"), CMD), Err(MergeError::Invalid(_))));
        assert!(matches!(merge_connect(Some("[1,2]"), CMD), Err(MergeError::Shape(_))));
        assert!(matches!(merge_connect(Some(r#"{"hooks": 5}"#), CMD), Err(MergeError::Shape(_))));
        // Other tools' hooks, even ones with a similar flag, are never ours.
        for cmd in ["other --claude-hook", "x --glitch-claude-hook-v2", "glitch --glitch-claude-hook && rm -rf ~", "glitch.exe"] {
            let other = json!({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": cmd}]}]}});
            assert_eq!(merge_disconnect(Some(&other.to_string())).unwrap(), None, "{cmd}");
        }
    }

    #[test]
    fn hook_command_quoting() {
        assert_eq!(
            hook_command(Path::new(r"C:\Program Files\Glitch\glitch.exe")).unwrap(),
            "\"C:/Program Files/Glitch/glitch.exe\" --glitch-claude-hook"
        );
        for bad in [r#"C:\a"b\glitch.exe"#, "/tmp/$HOME/glitch", "C:\\100%\\glitch.exe", "/x/`id`/glitch", "/it's/glitch", ""] {
            assert!(hook_command(Path::new(bad)).is_err(), "{bad}");
        }
    }

    #[test]
    fn files_on_disk_with_backup_in_a_temp_home() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude").join("settings.json");
        // No file yet: created, no backup needed.
        let c = connect(&path, CMD).unwrap();
        assert!(c.changed && c.backup.is_none());
        let s = status(&path, CMD);
        assert!(s.connected && !s.outdated && s.problem.is_none() && s.file_exists);
        assert!(s.preview.contains("--glitch-claude-hook"));
        // Again: unchanged, no backup.
        assert_eq!(connect(&path, CMD).unwrap(), Change { changed: false, backup: None });
        assert!(status(&path, "\"x\\glitch.exe\" --glitch-claude-hook").outdated);
        // Disconnect: one backup of the connected file, next to it, private.
        let before = std::fs::read_to_string(&path).unwrap();
        let d = disconnect(&path).unwrap();
        let backup = d.backup.unwrap();
        assert_eq!(backup, backup_path(&path));
        assert_eq!(backup.parent(), path.parent());
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), before);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&backup).unwrap().permissions().mode() & 0o777, 0o600);
        }
        #[cfg(windows)]
        {
            let acl = std::process::Command::new("icacls").arg(&backup).output().unwrap();
            let acl = String::from_utf8_lossy(&acl.stdout).to_string();
            let user = std::env::var("USERNAME").unwrap();
            assert!(acl.contains(&user), "{acl}");
            assert!(!acl.contains("(I)"), "no inherited entries: {acl}");
            assert!(!acl.contains("Everyone") && !acl.contains("BUILTIN\\Users"), "{acl}");
        }
        // Connecting again overwrites that one backup instead of adding more.
        connect(&path, CMD).unwrap();
        let backups = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().contains("backup"))
            .count();
        assert_eq!(backups, 1);
        disconnect(&path).unwrap();
        assert!(!status(&path, CMD).connected);
        assert!(!dir.path().join(".claude").join("settings.json.glitch-tmp").exists());
        // A broken file: refused, left exactly as it was.
        std::fs::write(&path, "{ broken").unwrap();
        assert!(connect(&path, CMD).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ broken");
        assert!(status(&path, CMD).problem.is_some());
    }

    #[test]
    fn hook_events() {
        let stop = r#"{"session_id":"abc","transcript_path":"C:\\secret\\t.jsonl","cwd":"C:\\Users\\me\\code\\Glitch","hook_event_name":"Stop","stop_hook_active":false}"#;
        let e = event_from_hook(stop).unwrap();
        assert_eq!(e.title, "Claude Code is done");
        assert_eq!(e.project.as_deref(), Some("Glitch"));
        assert_eq!(e.kind.as_deref(), Some("done"));
        assert!(!serde_json::to_string(&e).unwrap().contains("secret"));
        let n = r#"{"cwd":"/home/me/shop/","hook_event_name":"Notification","message":"Claude needs your permission to use Bash"}"#;
        let e = event_from_hook(n).unwrap();
        assert_eq!(e.title, "Claude Code needs you");
        assert_eq!(e.body, "Claude needs your permission to use Bash");
        assert_eq!(e.project.as_deref(), Some("shop"));
        assert_eq!(e.kind.as_deref(), Some("needs_input"));
        assert_eq!(event_from_hook(r#"{"hook_event_name":"PreToolUse"}"#), None);
        assert_eq!(event_from_hook("nope"), None);
    }
}
