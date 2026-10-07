//! The four tools the model may call.
//!
//! Every call goes through two steps:
//! 1. [`prepare`] validates the model's arguments and resolves them into a
//!    concrete [`Action`] (a normalised URL, a specific app, a real path).
//!    Anything invalid or unsafe is rejected here and the error goes back to
//!    the model as the tool result.
//! 2. [`execute`] performs the action. Whether the user must approve it first
//!    is decided by [`crate::confirm`]; the user approves the *prepared*
//!    action, so what they see is exactly what runs.
//!
//! There is deliberately no tool that deletes, moves, renames or edits files,
//! and no tool that runs commands.

pub mod apps;
pub mod files;
pub mod paths;
pub mod urls;

use std::path::PathBuf;

use serde::Serialize;
use serde_json::{json, Value};

use crate::ai::{ToolCall, ToolSpec};
use crate::platform::{AppEntry, Platform};

pub const OPEN_URL: &str = "open_url";
pub const OPEN_APP: &str = "open_app";
pub const SEARCH_FILES: &str = "search_files";
pub const OPEN_PATH: &str = "open_path";
pub const REMEMBER: &str = "remember";
pub const FORGET: &str = "forget";

/// Tools offered to the model. Memory tools only when memory is on.
pub fn specs(memory: bool) -> Vec<ToolSpec> {
    let mut v = computer_specs();
    if memory {
        v.extend(memory_specs());
    }
    v
}

fn memory_specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: REMEMBER,
            description: "Save one short, lasting fact about the user to your memory, e.g. \"The user's dog is \
                called Rex\" or \"Prefers dark mode\". Use it when the user tells you something worth knowing \
                next week, or asks you to remember something. Never passwords, codes or card numbers.",
            parameters: json!({
                "type": "object",
                "required": ["fact"],
                "properties": { "fact": { "type": "string", "description": "One sentence, third person" } }
            }),
        },
        ToolSpec {
            name: FORGET,
            description:
                "Remove facts from your memory that contain these words, when the user asks you to forget something.",
            parameters: json!({
                "type": "object",
                "required": ["about"],
                "properties": { "about": { "type": "string", "description": "Key words, e.g. \"dog Rex\"" } }
            }),
        },
    ]
}

fn computer_specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: OPEN_URL,
            description: "Open a web page in the user's default browser. Build the full URL yourself, \
                e.g. a Twitter/X profile is https://x.com/<handle>, a YouTube search is \
                https://www.youtube.com/results?search_query=<words>.",
            parameters: json!({
                "type": "object",
                "required": ["url"],
                "properties": { "url": { "type": "string", "description": "Full http(s) URL" } }
            }),
        },
        ToolSpec {
            name: OPEN_APP,
            description: "Open an app installed on this computer, by its name (e.g. \"Spotify\", \"Calculator\").",
            parameters: json!({
                "type": "object",
                "required": ["name"],
                "properties": { "name": { "type": "string", "description": "App name" } }
            }),
        },
        ToolSpec {
            name: SEARCH_FILES,
            description: "Search the user's Desktop, Documents, Downloads, Pictures, Music and Videos folders \
                by FILE NAME (not contents). Returns matching paths, newest first.",
            parameters: json!({
                "type": "object",
                "required": ["query"],
                "properties": {
                    "query": { "type": "string", "description": "Words that appear in the file name, e.g. \"dog\"" },
                    "kind": {
                        "type": "string",
                        "enum": files::Kind::NAMES,
                        "description": "Type of file to look for (default: any)"
                    }
                }
            }),
        },
        ToolSpec {
            name: OPEN_PATH,
            description: "Open a file or folder with its default app. Use a path returned by search_files, \
                or a folder name like \"Downloads\" or \"Pictures\".",
            parameters: json!({
                "type": "object",
                "required": ["path"],
                "properties": { "path": { "type": "string" } }
            }),
        },
    ]
}

/// A validated, ready-to-run tool call.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    OpenUrl {
        url: String,
    },
    OpenApp {
        app: AppEntry,
    },
    SearchFiles {
        query: files::Query,
    },
    OpenPath {
        path: PathBuf,
        is_dir: bool,
    },
    /// Handled by the agent (it owns the memory), not by `execute`.
    Remember {
        fact: String,
    },
    Forget {
        about: String,
    },
}

/// How an action is shown to the user in a confirmation card.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Description {
    pub title: String,
    pub detail: String,
}

impl Action {
    pub fn tool_name(&self) -> &'static str {
        match self {
            Action::OpenUrl { .. } => OPEN_URL,
            Action::OpenApp { .. } => OPEN_APP,
            Action::SearchFiles { .. } => SEARCH_FILES,
            Action::OpenPath { .. } => OPEN_PATH,
            Action::Remember { .. } => REMEMBER,
            Action::Forget { .. } => FORGET,
        }
    }

    pub fn describe(&self) -> Description {
        match self {
            Action::OpenUrl { url } => Description { title: "Open a web page".into(), detail: url.clone() },
            Action::OpenApp { app } => Description {
                title: format!("Open the app \u{201c}{}\u{201d}", app.name),
                detail: match crate::platform::windows::packaged_app_id(&app.launch_path) {
                    // "shell:AppsFolder\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" means nothing to people.
                    Some(_) => "An app installed on this PC (Microsoft Store or built into Windows)".into(),
                    None => app.launch_path.display().to_string(),
                },
            },
            Action::SearchFiles { query } => Description {
                title: format!("Search your files for \u{201c}{}\u{201d}{}", query.words_text(), query.kind_suffix()),
                detail: "Looks at file names in Desktop, Documents, Downloads, Pictures, Music and Videos. \
                    Nothing is changed."
                    .into(),
            },
            Action::OpenPath { path, is_dir } => Description {
                title: format!(
                    "Open {} \u{201c}{}\u{201d}",
                    if *is_dir { "the folder" } else { "the file" },
                    path.file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| path.display().to_string())
                ),
                detail: path.display().to_string(),
            },
            Action::Remember { fact } => Description { title: "Remember something".into(), detail: fact.clone() },
            Action::Forget { about } => Description { title: "Forget something".into(), detail: about.clone() },
        }
    }
}

/// Error shown to the model (and logged); never executed.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{0}")]
pub struct ToolError(pub String);

fn str_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, ToolError> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ToolError(format!("missing required argument \"{key}\"")))
}

/// Step 1: validate and resolve a tool call from the model.
pub fn prepare(call: &ToolCall, platform: &dyn Platform) -> Result<Action, ToolError> {
    let args = &call.arguments;
    match call.name.as_str() {
        OPEN_URL => Ok(Action::OpenUrl { url: urls::normalise(str_arg(args, "url")?)? }),
        OPEN_APP => Ok(Action::OpenApp { app: apps::resolve(str_arg(args, "name")?, &platform.installed_apps())? }),
        SEARCH_FILES => {
            let kind = match args.get("kind").and_then(Value::as_str) {
                None => files::Kind::Any,
                Some(k) => files::Kind::parse(k).ok_or_else(|| ToolError(format!("unknown kind \"{k}\"")))?,
            };
            Ok(Action::SearchFiles { query: files::Query::new(str_arg(args, "query")?, kind)? })
        }
        OPEN_PATH => {
            let (path, is_dir) = paths::validate(str_arg(args, "path")?, platform)?;
            Ok(Action::OpenPath { path, is_dir })
        }
        REMEMBER => Ok(Action::Remember { fact: str_arg(args, "fact")?.to_string() }),
        FORGET => Ok(Action::Forget { about: str_arg(args, "about")?.to_string() }),
        other => Err(ToolError(format!("there is no tool called \"{other}\""))),
    }
}

/// What happened, for the model (`for_model`, JSON) and for the chat log (`summary`).
#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    pub for_model: String,
    pub summary: String,
}

/// Step 2: run an action that has passed validation (and confirmation, if needed).
pub fn execute(action: &Action, platform: &dyn Platform) -> Outcome {
    let failed = |what: &str, e: std::io::Error| Outcome {
        for_model: json!({ "ok": false, "error": format!("{what}: {e}") }).to_string(),
        summary: format!("Couldn't {what}"),
    };
    match action {
        Action::OpenUrl { url } => match platform.open_url(url) {
            Ok(()) => Outcome {
                for_model: json!({ "ok": true, "opened": url }).to_string(),
                summary: format!("Opened {url}"),
            },
            Err(e) => failed("open the web page", e),
        },
        Action::OpenApp { app } => match platform.launch_app(app) {
            Ok(()) => Outcome {
                for_model: json!({ "ok": true, "opened_app": app.name }).to_string(),
                summary: format!("Opened {}", app.name),
            },
            Err(e) => failed("open the app", e),
        },
        Action::SearchFiles { query } => {
            let result = files::search(query, &platform.search_roots(), &files::Limits::default());
            let n = result.hits.len();
            let mut v = json!({ "results": result.hits });
            if n == 0 {
                v["note"] =
                    json!("No file names matched. Only file names are searched, not what is inside files or photos.");
            }
            if result.truncated {
                v["note"] = json!("Search stopped early (too many files); results may be incomplete.");
            }
            Outcome {
                for_model: v.to_string(),
                summary: format!("Searched files for \u{201c}{}\u{201d}: {n} found", query.words_text()),
            }
        }
        Action::Remember { .. } | Action::Forget { .. } => Outcome {
            for_model: json!({ "ok": false, "error": "memory is turned off" }).to_string(),
            summary: "Memory is off".into(),
        },
        Action::OpenPath { path, .. } => match platform.open_path(path) {
            Ok(()) => Outcome {
                for_model: json!({ "ok": true, "opened": path }).to_string(),
                summary: format!("Opened {}", path.display()),
            },
            Err(e) => failed("open it", e),
        },
    }
}

#[cfg(test)]
pub(crate) mod fake {
    //! A fake platform that records what would have been opened.
    use std::io;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    use crate::platform::{AppEntry, Platform};

    #[derive(Default)]
    pub struct FakePlatform {
        pub home: Option<PathBuf>,
        pub roots: Vec<PathBuf>,
        pub apps: Vec<AppEntry>,
        pub opened: Mutex<Vec<String>>,
    }

    impl Platform for FakePlatform {
        fn open_url(&self, url: &str) -> io::Result<()> {
            self.opened.lock().unwrap().push(format!("url:{url}"));
            Ok(())
        }
        fn open_path(&self, path: &Path) -> io::Result<()> {
            self.opened.lock().unwrap().push(format!("path:{}", path.display()));
            Ok(())
        }
        fn launch_app(&self, app: &AppEntry) -> io::Result<()> {
            self.opened.lock().unwrap().push(format!("app:{}", app.name));
            Ok(())
        }
        fn installed_apps(&self) -> Vec<AppEntry> {
            self.apps.clone()
        }
        fn search_roots(&self) -> Vec<PathBuf> {
            self.roots.clone()
        }
        fn home_dir(&self) -> Option<PathBuf> {
            self.home.clone()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::FakePlatform;
    use super::*;

    fn call(name: &str, args: Value) -> ToolCall {
        ToolCall { name: name.into(), arguments: args }
    }

    #[test]
    fn specs_have_unique_names_and_object_schemas() {
        let s = specs(true);
        let names: Vec<_> = s.iter().map(|t| t.name).collect();
        assert_eq!(names, [OPEN_URL, OPEN_APP, SEARCH_FILES, OPEN_PATH, REMEMBER, FORGET]);
        assert_eq!(specs(false).len(), 4);
        for t in &s {
            assert_eq!(t.parameters["type"], "object");
            assert!(t.parameters["required"].is_array());
        }
    }

    #[test]
    fn unknown_tools_and_missing_args_are_rejected() {
        let p = FakePlatform::default();
        assert!(prepare(&call("delete_file", json!({"path": "/x"})), &p).is_err());
        assert!(prepare(&call("run_shell", json!({"cmd": "rm -rf /"})), &p).is_err());
        assert_eq!(prepare(&call(OPEN_URL, json!({})), &p), Err(ToolError("missing required argument \"url\"".into())));
        assert!(prepare(&call(OPEN_URL, json!({"url": "   "})), &p).is_err());
        assert!(prepare(&call(OPEN_URL, json!({"url": 42})), &p).is_err());
        assert!(prepare(&call(SEARCH_FILES, json!({"query": "dog", "kind": "executable"})), &p).is_err());
    }

    #[test]
    fn open_url_end_to_end() {
        let p = FakePlatform::default();
        let a = prepare(&call(OPEN_URL, json!({"url": "x.com/elonmusk"})), &p).unwrap();
        assert_eq!(a, Action::OpenUrl { url: "https://x.com/elonmusk".into() });
        let out = execute(&a, &p);
        assert_eq!(*p.opened.lock().unwrap(), ["url:https://x.com/elonmusk"]);
        assert!(out.for_model.contains("\"ok\":true"));
    }

    #[test]
    fn open_app_end_to_end() {
        let p = FakePlatform {
            apps: vec![AppEntry { name: "Spotify".into(), launch_path: "/Applications/Spotify.app".into() }],
            ..Default::default()
        };
        let a = prepare(&call(OPEN_APP, json!({"name": "spotify"})), &p).unwrap();
        assert_eq!(a.describe().title, "Open the app \u{201c}Spotify\u{201d}");
        execute(&a, &p);
        assert_eq!(*p.opened.lock().unwrap(), ["app:Spotify"]);
    }

    #[test]
    fn search_then_open_end_to_end() {
        let home = tempfile::tempdir().unwrap();
        let pics = home.path().join("Pictures");
        std::fs::create_dir_all(&pics).unwrap();
        std::fs::write(pics.join("my_dog_rex.jpg"), b"").unwrap();
        std::fs::write(pics.join("cat.jpg"), b"").unwrap();
        let p = FakePlatform { home: Some(home.path().into()), roots: vec![pics.clone()], ..Default::default() };

        let search = prepare(&call(SEARCH_FILES, json!({"query": "photo of a dog", "kind": "image"})), &p).unwrap();
        let out = execute(&search, &p);
        let v: Value = serde_json::from_str(&out.for_model).unwrap();
        let hits = v["results"].as_array().unwrap();
        assert_eq!(hits.len(), 1);
        let found = hits[0]["path"].as_str().unwrap();
        assert!(found.ends_with("my_dog_rex.jpg"));

        let open = prepare(&call(OPEN_PATH, json!({"path": found})), &p).unwrap();
        assert!(matches!(open, Action::OpenPath { is_dir: false, .. }));
        execute(&open, &p);
        assert_eq!(p.opened.lock().unwrap().len(), 1);
    }
}
