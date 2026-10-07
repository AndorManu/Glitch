//! The chat loop: user message → model → (tool calls → maybe confirm → run →
//! model again) → reply.

use std::collections::VecDeque;
use std::sync::Arc;

use serde::Serialize;
use serde_json::json;

use crate::ai::{AiError, AiProvider, ChatRequest, Message, Role, ToolCall};
use crate::confirm::{approval_for, Approval, ConfirmError, ConfirmationGate};
use crate::memory::{self, MemoryStore, Remembered};
use crate::platform::{Os, Platform};
use crate::tools::{self, Action};

/// Model round-trips allowed per user message (stops tool-call loops).
pub const MAX_MODEL_CALLS: usize = 5;
/// Messages kept in memory; older ones are dropped (small context = less RAM).
pub const MAX_HISTORY: usize = 24;
/// With memory on, once the chat is this long the oldest part is compacted
/// into the memory summary...
pub const COMPACT_AT: usize = 14;
/// ...keeping roughly this many recent messages word for word.
pub const KEEP_RECENT: usize = 6;

pub const MEMORY_PROMPT: &str = "You have a memory. Use the remember tool for lasting facts the user tells you \
    about themselves (their name, family, pets, likes, projects) and always when they ask you to remember \
    something. Greetings, moods and requests like opening a website are not facts. Use the forget tool when \
    they ask you to forget. Never remember passwords, codes or card numbers. Use what you remember \
    naturally; don't recite it.";

/// What the UI should show after a step.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Step {
    /// Glitch's answer. `actions` lists what was done along the way.
    Reply { text: String, actions: Vec<String> },
    /// Waiting for the user to allow/deny an action.
    Confirm { id: String, title: String, detail: String, actions: Vec<String> },
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum AgentError {
    #[error(transparent)]
    Ai(#[from] AiError),
    #[error(transparent)]
    Confirm(#[from] ConfirmError),
}

pub struct Agent {
    provider: Arc<dyn AiProvider>,
    platform: Arc<dyn Platform>,
    system_prompt: String,
    history: Vec<Message>,
    queue: VecDeque<ToolCall>,
    gate: ConfirmationGate,
    model_calls: usize,
    actions: Vec<String>,
    /// `None` when the user turned memory off.
    memory: Option<MemoryStore>,
    /// The `remember` tool stored something during the current user turn.
    remembered_this_turn: bool,
}

/// How many recent user messages a `remember` call may be based on.
const REMEMBER_LOOKBACK: usize = 3;

pub fn system_prompt(os: Os) -> String {
    let os_name = match os {
        Os::Windows => "Windows",
        Os::MacOs => "macOS",
        Os::Linux => "Linux",
    };
    format!(
        "You are Glitch, a small, friendly pixel-art creature who lives on the user's {os_name} desktop. \
         Keep replies short (one to three sentences), warm and a little playful, but always helpful. \
         You can use tools: open_url opens a website (build the full URL yourself), open_app opens an \
         installed app, search_files finds files by name, open_path opens a file or folder. \
         Only use a tool when the user asks you to do something on their computer. \
         For a file request like \"find a photo of a dog\", call search_files with query \"dog\" and kind \"image\", \
         then tell the user what you found and offer to open it. \
         You cannot delete, move, rename or edit files and you cannot run commands; say so if asked. \
         If the user declines an action, accept it cheerfully and don't ask again."
    )
}

impl Agent {
    pub fn new(provider: Arc<dyn AiProvider>, platform: Arc<dyn Platform>) -> Self {
        Self {
            provider,
            platform,
            system_prompt: system_prompt(Os::current()),
            history: Vec::new(),
            queue: VecDeque::new(),
            gate: ConfirmationGate::default(),
            model_calls: 0,
            actions: Vec::new(),
            memory: None,
            remembered_this_turn: false,
        }
    }

    /// Turn memory on (with this store) or off (`None`). Turning it on also
    /// restores the end of the previous conversation.
    pub fn set_memory(&mut self, memory: Option<MemoryStore>) {
        self.memory = memory;
        if let Some(m) = &mut self.memory {
            if self.history.is_empty() {
                self.history = m.take_carry_over();
            }
        }
    }

    pub fn memory(&self) -> Option<&MemoryStore> {
        self.memory.as_ref()
    }

    pub fn forget_fact(&mut self, id: u64) -> bool {
        let Some(m) = &mut self.memory else { return false };
        let gone = m.forget_id(id).is_some();
        self.save_memory();
        gone
    }

    pub fn clear_memory(&mut self) {
        if let Some(m) = &mut self.memory {
            m.clear();
        }
        self.save_memory();
    }

    fn save_memory(&self) {
        if let Some(Err(e)) = self.memory.as_ref().map(MemoryStore::save) {
            eprintln!("glitch: could not save memory: {e}");
        }
    }

    /// Save the unsummarised end of the chat so it continues after a restart.
    pub fn persist(&mut self) {
        if let Some(m) = &mut self.memory {
            m.save_carry_over(&self.history);
        }
        self.save_memory();
    }

    /// True when the chat is long enough to fold its oldest part into memory.
    pub fn needs_compaction(&self) -> bool {
        self.memory.is_some() && self.gate.pending().is_none() && self.history.len() > COMPACT_AT
    }

    /// Fold the oldest part of the chat (or all of it, with `everything`)
    /// into the memory summary, picking up lasting facts on the way. Returns
    /// the facts that were newly remembered. Uses the model, so call it while
    /// the model is still loaded (right after a reply).
    pub async fn compact(&mut self, model: &str, everything: bool) -> Result<Vec<String>, AgentError> {
        let Some(memory) = &self.memory else { return Ok(Vec::new()) };
        let cut = if everything {
            self.history.len()
        } else {
            // Cut at a user message so the kept part starts cleanly.
            let limit = self.history.len().saturating_sub(KEEP_RECENT);
            match (1..=limit).rev().find(|&i| self.history[i].role == Role::User) {
                Some(i) => i,
                None => return Ok(Vec::new()),
            }
        };
        if cut == 0 {
            return Ok(Vec::new());
        }
        let request = memory::compaction_request(&memory.data.summary, &self.history[..cut]);
        let said = memory::user_said(&self.history[..cut]);
        let reply = self.provider.chat(ChatRequest { model, messages: &request, tools: &[] }).await?;
        let memory = self.memory.as_mut().expect("checked above");
        let added = memory.apply_compaction(&reply.content, &memory::today(), &said);
        self.history.drain(..cut);
        self.save_memory();
        Ok(added.into_iter().map(|f| f.text).collect())
    }

    /// Swap the AI backend (e.g. after the user changes the Ollama URL).
    pub fn set_provider(&mut self, provider: Arc<dyn AiProvider>) {
        self.provider = provider;
    }

    /// Start a fresh chat (memory is kept; see `compact(.., true)` to fold
    /// the old chat into it first).
    pub fn reset(&mut self) {
        self.history.clear();
        self.queue.clear();
        self.gate.cancel();
    }

    pub fn history(&self) -> &[Message] {
        &self.history
    }

    pub async fn send(&mut self, model: &str, text: &str) -> Result<Step, AgentError> {
        // A new message while something waits for approval counts as "no".
        if let Some(p) = self.gate.cancel() {
            self.history.push(declined(p.action.tool_name()));
        }
        for call in self.queue.drain(..) {
            self.history.push(Message::tool_result(&call.name, json!({"ok": false, "skipped": true}).to_string()));
        }
        if let Some(m) = &mut self.memory {
            m.roll_day(&memory::today());
        }
        self.history.push(Message::user(text));
        self.trim_history();
        self.model_calls = 0;
        self.actions.clear();
        self.remembered_this_turn = false;
        let step = self.run(model).await?;
        Ok(self.remember_fallback(text, step))
    }

    /// Small models sometimes answer "remember that my dog is called Rex"
    /// with a cheerful "Got it!" but no `remember` call. An explicit request
    /// is stored anyway (same safety rules as the tool).
    fn remember_fallback(&mut self, user_text: &str, step: Step) -> Step {
        let Step::Reply { text, mut actions } = step else { return step };
        if !self.remembered_this_turn {
            if let (Some(m), Some(fact)) = (&mut self.memory, memory::explicit_remember_request(user_text)) {
                if let Ok(Remembered::Added(f) | Remembered::Updated(f)) = m.remember(&fact, &memory::today()) {
                    actions.push(format!("Remembered: {}", f.text));
                    self.save_memory();
                }
            }
        }
        Step::Reply { text, actions }
    }

    /// The user's last few messages (what a `remember` call may be about).
    fn recent_user_text(&self) -> String {
        let recent: Vec<&str> = self
            .history
            .iter()
            .rev()
            .filter(|m| m.role == Role::User)
            .take(REMEMBER_LOOKBACK)
            .map(|m| m.content.as_str())
            .collect();
        recent.join("\n")
    }

    pub async fn confirm(&mut self, model: &str, id: &str, approved: bool) -> Result<Step, AgentError> {
        let pending_tool = self.gate.pending().map(|p| p.action.tool_name());
        match self.gate.resolve(id, approved)? {
            Some(action) => self.execute(action).await,
            None => self.history.push(declined(pending_tool.unwrap_or_default())),
        }
        self.run(model).await
    }

    async fn execute(&mut self, action: Action) {
        if let Action::Remember { .. } | Action::Forget { .. } = action {
            return self.execute_memory(action);
        }
        let platform = self.platform.clone();
        let tool = action.tool_name();
        // File search touches the disk; keep it off the async worker threads.
        let outcome =
            tokio::task::spawn_blocking(move || tools::execute(&action, &*platform)).await.unwrap_or_else(|e| {
                tools::Outcome {
                    for_model: json!({"ok": false, "error": e.to_string()}).to_string(),
                    summary: "Something went wrong".into(),
                }
            });
        self.actions.push(outcome.summary);
        self.history.push(Message::tool_result(tool, outcome.for_model));
    }

    fn execute_memory(&mut self, action: Action) {
        let tool = action.tool_name();
        let said = self.recent_user_text();
        let (for_model, summary) = match (&mut self.memory, &action) {
            (None, _) => (json!({"ok": false, "error": "memory is turned off"}), None),
            // Small models sometimes "remember" a greeting or their own guess.
            (Some(_), Action::Remember { fact }) if !memory::grounded(fact, &said) => (
                json!({"ok": false, "error": "not saved: only remember lasting things the user told you about \
                    themselves, using their words. Just answer the user normally."}),
                None,
            ),
            (Some(m), Action::Remember { fact }) => match m.remember(fact, &memory::today()) {
                Ok(Remembered::Added(f) | Remembered::Updated(f)) => {
                    self.remembered_this_turn = true;
                    (json!({"ok": true, "remembered": f.text}), Some(format!("Remembered: {}", f.text)))
                }
                Ok(Remembered::AlreadyKnown(f)) => {
                    self.remembered_this_turn = true;
                    (json!({"ok": true, "already_known": f.text}), None)
                }
                Err(e) => (json!({"ok": false, "error": e.0}), None),
            },
            (Some(m), Action::Forget { about }) => {
                let gone = m.forget_matching(about);
                let n = gone.len();
                let texts: Vec<String> = gone.into_iter().map(|f| f.text).collect();
                (json!({"ok": n > 0, "forgotten": texts}), (n > 0).then(|| format!("Forgot {n} thing(s)")))
            }
            _ => unreachable!("only memory actions get here"),
        };
        self.save_memory();
        if let Some(s) = summary {
            self.actions.push(s);
        }
        self.history.push(Message::tool_result(tool, for_model.to_string()));
    }

    fn full_system_prompt(&self) -> String {
        match &self.memory {
            None => self.system_prompt.clone(),
            Some(m) => {
                let known = m.prompt_section();
                if known.is_empty() {
                    format!("{}\n\n{MEMORY_PROMPT}", self.system_prompt)
                } else {
                    format!("{}\n\n{MEMORY_PROMPT}\n\n{known}", self.system_prompt)
                }
            }
        }
    }

    async fn run(&mut self, model: &str) -> Result<Step, AgentError> {
        loop {
            while let Some(call) = self.queue.pop_front() {
                // Validation can touch the disk (path checks, app discovery).
                let (platform, c) = (self.platform.clone(), call.clone());
                let prepared = tokio::task::spawn_blocking(move || tools::prepare(&c, &*platform))
                    .await
                    .unwrap_or_else(|e| Err(tools::ToolError(e.to_string())));
                match prepared {
                    Err(e) => self
                        .history
                        .push(Message::tool_result(&call.name, json!({"ok": false, "error": e.0}).to_string())),
                    Ok(action) => match approval_for(&action) {
                        Approval::Automatic => self.execute(action).await,
                        Approval::AskUser => {
                            let p = self.gate.request(action);
                            return Ok(Step::Confirm {
                                id: p.id.clone(),
                                title: p.description.title.clone(),
                                detail: p.description.detail.clone(),
                                actions: self.actions.clone(),
                            });
                        }
                    },
                }
            }

            if self.model_calls >= MAX_MODEL_CALLS {
                return Ok(self.reply("I got a bit tangled up trying to do that. Could you say it another way?".into()));
            }
            self.model_calls += 1;

            let mut messages = Vec::with_capacity(self.history.len() + 1);
            messages.push(Message::system(self.full_system_prompt()));
            messages.extend(self.history.iter().cloned());
            let specs = tools::specs(self.memory.is_some());
            let reply = self.provider.chat(ChatRequest { model, messages: &messages, tools: &specs }).await?;

            self.queue.extend(reply.tool_calls.iter().cloned());
            let text = reply.content.clone();
            self.history.push(reply);
            if self.queue.is_empty() {
                let text = if !text.is_empty() {
                    text
                } else if !self.actions.is_empty() {
                    "Done!".into()
                } else {
                    "Hmm, I'm not sure what to say to that.".into()
                };
                return Ok(self.reply(text));
            }
        }
    }

    fn reply(&mut self, text: String) -> Step {
        Step::Reply { text, actions: std::mem::take(&mut self.actions) }
    }

    /// Keep the newest messages, and always start at a user message so we
    /// never send an orphaned tool result.
    fn trim_history(&mut self) {
        if self.history.len() <= MAX_HISTORY {
            return;
        }
        let mut start = self.history.len() - MAX_HISTORY;
        while start < self.history.len() && self.history[start].role != Role::User {
            start += 1;
        }
        self.history.drain(..start);
    }
}

fn declined(tool: &str) -> Message {
    Message::tool_result(
        tool,
        json!({"ok": false, "declined": true, "message": "The user chose not to allow this."}).to_string(),
    )
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;

    use super::*;
    use crate::platform::AppEntry;
    use crate::tools::fake::FakePlatform;

    /// Plays back scripted model replies and records what it was sent.
    struct ScriptedModel {
        replies: Mutex<VecDeque<Message>>,
        seen: Mutex<Vec<Vec<Message>>>,
        seen_tools: Mutex<Vec<Vec<&'static str>>>,
    }

    impl ScriptedModel {
        fn new(replies: Vec<Message>) -> Arc<Self> {
            Arc::new(Self {
                replies: Mutex::new(replies.into()),
                seen: Mutex::new(Vec::new()),
                seen_tools: Mutex::new(Vec::new()),
            })
        }
    }

    #[async_trait]
    impl AiProvider for ScriptedModel {
        fn name(&self) -> &'static str {
            "scripted"
        }
        async fn chat(&self, req: ChatRequest<'_>) -> Result<Message, AiError> {
            self.seen.lock().unwrap().push(req.messages.to_vec());
            self.seen_tools.lock().unwrap().push(req.tools.iter().map(|t| t.name).collect());
            Ok(self.replies.lock().unwrap().pop_front().unwrap_or_else(|| Message::assistant("(script ended)")))
        }
    }

    fn calls(name: &str, args: serde_json::Value) -> Message {
        Message { tool_calls: vec![ToolCall { name: name.into(), arguments: args }], ..Message::assistant("") }
    }

    fn platform() -> Arc<FakePlatform> {
        Arc::new(FakePlatform {
            apps: vec![AppEntry { name: "Spotify".into(), launch_path: "/Applications/Spotify.app".into() }],
            ..Default::default()
        })
    }

    #[tokio::test]
    async fn plain_chat() {
        let model = ScriptedModel::new(vec![Message::assistant("Hi! I'm Glitch.")]);
        let mut a = Agent::new(model.clone(), platform());
        let step = a.send("m", "hello").await.unwrap();
        assert_eq!(step, Step::Reply { text: "Hi! I'm Glitch.".into(), actions: vec![] });
        let seen = model.seen.lock().unwrap();
        assert_eq!(seen[0][0].role, Role::System);
        assert_eq!(seen[0][1], Message::user("hello"));
    }

    #[tokio::test]
    async fn open_url_runs_without_confirmation() {
        let p = platform();
        let model = ScriptedModel::new(vec![
            calls("open_url", json!({"url": "https://x.com/elonmusk"})),
            Message::assistant("Opened Elon's page!"),
        ]);
        let mut a = Agent::new(model.clone(), p.clone());
        let step = a.send("m", "open twitter on elon musk's page").await.unwrap();
        assert_eq!(
            step,
            Step::Reply { text: "Opened Elon's page!".into(), actions: vec!["Opened https://x.com/elonmusk".into()] }
        );
        assert_eq!(*p.opened.lock().unwrap(), ["url:https://x.com/elonmusk"]);
        // The tool result went back to the model with the tool name.
        let second_call = &model.seen.lock().unwrap()[1];
        let last = second_call.last().unwrap();
        assert_eq!((last.role, last.tool_name.as_deref()), (Role::Tool, Some("open_url")));
    }

    #[tokio::test]
    async fn open_app_waits_for_approval_then_runs() {
        let p = platform();
        let model =
            ScriptedModel::new(vec![calls("open_app", json!({"name": "spotify"})), Message::assistant("Enjoy!")]);
        let mut a = Agent::new(model.clone(), p.clone());
        let Step::Confirm { id, title, .. } = a.send("m", "open spotify").await.unwrap() else {
            panic!("expected confirm")
        };
        assert!(title.contains("Spotify"));
        assert!(p.opened.lock().unwrap().is_empty(), "nothing runs before approval");
        assert_eq!(model.seen.lock().unwrap().len(), 1, "model is not called again while waiting");

        let step = a.confirm("m", &id, true).await.unwrap();
        assert_eq!(step, Step::Reply { text: "Enjoy!".into(), actions: vec!["Opened Spotify".into()] });
        assert_eq!(*p.opened.lock().unwrap(), ["app:Spotify"]);
    }

    #[tokio::test]
    async fn declining_runs_nothing_and_tells_the_model() {
        let p = platform();
        let model =
            ScriptedModel::new(vec![calls("open_app", json!({"name": "spotify"})), Message::assistant("No problem!")]);
        let mut a = Agent::new(model.clone(), p.clone());
        let Step::Confirm { id, .. } = a.send("m", "open spotify").await.unwrap() else { panic!() };
        let step = a.confirm("m", &id, false).await.unwrap();
        assert_eq!(step, Step::Reply { text: "No problem!".into(), actions: vec![] });
        assert!(p.opened.lock().unwrap().is_empty());
        let seen = model.seen.lock().unwrap();
        assert!(seen[1].last().unwrap().content.contains("declined"));
    }

    #[tokio::test]
    async fn stale_confirmation_ids_cannot_run_actions() {
        let p = platform();
        let model = ScriptedModel::new(vec![
            calls("open_app", json!({"name": "spotify"})),
            Message::assistant("ok"),
            calls("open_app", json!({"name": "spotify"})),
        ]);
        let mut a = Agent::new(model, p.clone());
        let Step::Confirm { id: first, .. } = a.send("m", "open spotify").await.unwrap() else { panic!() };
        // User ignores the card and types something else: the request is dropped.
        a.send("m", "never mind").await.unwrap();
        assert_eq!(a.confirm("m", &first, true).await, Err(AgentError::Confirm(ConfirmError::NothingPending)));
        let Step::Confirm { .. } = a.send("m", "open spotify again").await.unwrap() else { panic!() };
        assert_eq!(a.confirm("m", &first, true).await, Err(AgentError::Confirm(ConfirmError::WrongId)));
        assert!(p.opened.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn invalid_tool_calls_are_reported_back_not_run() {
        let p = platform();
        let model = ScriptedModel::new(vec![
            calls("open_url", json!({"url": "file:///etc/passwd"})),
            calls("delete_file", json!({"path": "/"})),
            Message::assistant("Sorry, I can't do that."),
        ]);
        let mut a = Agent::new(model.clone(), p.clone());
        let step = a.send("m", "do bad things").await.unwrap();
        assert_eq!(step, Step::Reply { text: "Sorry, I can't do that.".into(), actions: vec![] });
        assert!(p.opened.lock().unwrap().is_empty());
        let seen = model.seen.lock().unwrap();
        assert!(seen[1].last().unwrap().content.contains("http"));
        assert!(seen[2].last().unwrap().content.contains("no tool called"));
    }

    #[tokio::test]
    async fn tool_loops_are_capped() {
        let replies = (0..20).map(|i| calls("open_url", json!({"url": format!("https://e.com/{i}")}))).collect();
        let model = ScriptedModel::new(replies);
        let mut a = Agent::new(model.clone(), platform());
        let Step::Reply { text, actions } = a.send("m", "loop").await.unwrap() else { panic!() };
        assert!(text.contains("tangled"));
        assert_eq!(actions.len(), MAX_MODEL_CALLS);
        assert_eq!(model.seen.lock().unwrap().len(), MAX_MODEL_CALLS);
    }

    #[tokio::test]
    async fn mixed_calls_run_urls_then_stop_at_the_gated_one() {
        let p = platform();
        let model = ScriptedModel::new(vec![
            Message {
                tool_calls: vec![
                    ToolCall { name: "open_url".into(), arguments: json!({"url": "https://example.com"}) },
                    ToolCall { name: "open_app".into(), arguments: json!({"name": "Spotify"}) },
                ],
                ..Message::assistant("")
            },
            Message::assistant("All set."),
        ]);
        let mut a = Agent::new(model, p.clone());
        let Step::Confirm { id, actions, .. } = a.send("m", "both").await.unwrap() else { panic!() };
        assert_eq!(actions, ["Opened https://example.com/"]);
        let step = a.confirm("m", &id, true).await.unwrap();
        assert_eq!(
            step,
            Step::Reply {
                text: "All set.".into(),
                actions: vec!["Opened https://example.com/".into(), "Opened Spotify".into()]
            }
        );
    }

    #[tokio::test]
    async fn history_is_trimmed_at_a_user_message() {
        let model = ScriptedModel::new((0..40).map(|i| Message::assistant(format!("r{i}"))).collect());
        let mut a = Agent::new(model, platform());
        for i in 0..20 {
            a.send("m", &format!("u{i}")).await.unwrap();
        }
        assert!(a.history().len() <= MAX_HISTORY);
        assert_eq!(a.history()[0].role, Role::User);
        assert_eq!(a.history().last().unwrap().content, "r19");
    }

    #[tokio::test]
    async fn provider_errors_surface() {
        struct Down;
        #[async_trait]
        impl AiProvider for Down {
            fn name(&self) -> &'static str {
                "down"
            }
            async fn chat(&self, _: ChatRequest<'_>) -> Result<Message, AiError> {
                Err(AiError::Unreachable("connection refused".into()))
            }
        }
        let mut a = Agent::new(Arc::new(Down), platform());
        assert!(matches!(a.send("m", "hi").await, Err(AgentError::Ai(AiError::Unreachable(_)))));
    }

    // ------------------------------------------------------------- memory

    fn with_memory(model: Arc<ScriptedModel>) -> Agent {
        let mut a = Agent::new(model, platform());
        a.set_memory(Some(MemoryStore::in_memory()));
        a
    }

    #[tokio::test]
    async fn memory_tools_only_when_memory_is_on() {
        let model = ScriptedModel::new(vec![Message::assistant("a"), Message::assistant("b")]);
        let mut off = Agent::new(model.clone(), platform());
        off.send("m", "hi").await.unwrap();
        let mut on = with_memory(model.clone());
        on.send("m", "hi").await.unwrap();
        let tools = model.seen_tools.lock().unwrap();
        assert!(!tools[0].contains(&"remember"));
        assert!(tools[1].contains(&"remember") && tools[1].contains(&"forget"));
        let seen = model.seen.lock().unwrap();
        assert!(!seen[0][0].content.contains("You have a memory"));
        assert!(seen[1][0].content.contains("You have a memory"));
    }

    #[tokio::test]
    async fn remembered_facts_show_up_and_reach_the_next_prompt() {
        let model = ScriptedModel::new(vec![
            calls("remember", json!({"fact": "The user's dog is called Rex"})),
            Message::assistant("Noted!"),
            Message::assistant("Rex!"),
        ]);
        let mut a = with_memory(model.clone());
        let step = a.send("m", "my dog is called Rex").await.unwrap();
        assert_eq!(
            step,
            Step::Reply { text: "Noted!".into(), actions: vec!["Remembered: The user's dog is called Rex".into()] }
        );
        a.send("m", "what's my dog called?").await.unwrap();
        let seen = model.seen.lock().unwrap();
        assert!(seen[2][0].content.contains("- The user's dog is called Rex"));
    }

    #[tokio::test]
    async fn secrets_are_refused_and_forget_works() {
        let model = ScriptedModel::new(vec![
            calls("remember", json!({"fact": "Password is hunter2"})),
            Message::assistant("I won't keep that."),
            calls("forget", json!({"about": "dog"})),
            Message::assistant("Forgotten."),
        ]);
        let mut a = with_memory(model.clone());
        a.memory.as_mut().unwrap().remember("Has a dog called Rex", "d").unwrap();
        let Step::Reply { actions, .. } = a.send("m", "remember my password is hunter2").await.unwrap() else {
            panic!()
        };
        assert!(actions.is_empty());
        assert_eq!(a.memory().unwrap().data.facts.len(), 1);
        let Step::Reply { actions, .. } = a.send("m", "forget my dog").await.unwrap() else { panic!() };
        assert_eq!(actions, ["Forgot 1 thing(s)"]);
        assert!(a.memory().unwrap().data.facts.is_empty());
    }

    #[tokio::test]
    async fn explicit_remember_requests_are_kept_even_without_a_tool_call() {
        let model = ScriptedModel::new(vec![Message::assistant("Got it, Rex!"), Message::assistant("Sure!")]);
        let mut a = with_memory(model);
        let step = a.send("m", "remember that my dog is called Rex").await.unwrap();
        assert_eq!(
            step,
            Step::Reply {
                text: "Got it, Rex!".into(),
                actions: vec!["Remembered: The user's dog is called Rex".into()]
            }
        );
        // Not for normal chat or questions.
        let Step::Reply { actions, .. } = a.send("m", "do you remember my dog?").await.unwrap() else { panic!() };
        assert!(actions.is_empty());
        assert_eq!(a.memory().unwrap().data.facts.len(), 1);
    }

    #[tokio::test]
    async fn invented_facts_are_not_remembered() {
        let model = ScriptedModel::new(vec![
            calls("remember", json!({"fact": "The user is greeting Glitch warmly."})),
            Message::assistant("I'm great, thanks!"),
        ]);
        let mut a = with_memory(model.clone());
        let step = a.send("m", "hi! how are you today?").await.unwrap();
        assert_eq!(step, Step::Reply { text: "I'm great, thanks!".into(), actions: vec![] });
        assert!(a.memory().unwrap().data.facts.is_empty());
        assert!(model.seen.lock().unwrap()[1].last().unwrap().content.contains("not saved"));
    }

    #[tokio::test]
    async fn long_chats_are_compacted_into_memory() {
        let mut replies: Vec<Message> = (0..8).map(|i| Message::assistant(format!("r{i}"))).collect();
        replies.push(Message::assistant("Summary: They chatted about cats.\nFACT: The user likes cats"));
        let model = ScriptedModel::new(replies);
        let mut a = with_memory(model.clone());
        for i in 0..8 {
            a.send("m", &format!("u{i}: I like cats")).await.unwrap();
        }
        assert!(a.needs_compaction());
        let added = a.compact("m", false).await.unwrap();
        assert_eq!(added, ["The user likes cats"]);
        let mem = a.memory().unwrap();
        assert_eq!(mem.data.summary, "They chatted about cats.");
        assert!(a.history().len() <= KEEP_RECENT && a.history()[0].role == Role::User);
        assert!(!a.needs_compaction());
        // The compaction call had no tools and saw the old messages.
        assert!(model.seen_tools.lock().unwrap().last().unwrap().is_empty());
        assert!(model.seen.lock().unwrap().last().unwrap()[1].content.contains("User: u0"));
        // The summary is part of the next prompt.
        a.send("m", "hello again").await.unwrap();
        assert!(model.seen.lock().unwrap().last().unwrap()[0].content.contains("They chatted about cats."));
    }

    #[tokio::test]
    async fn compaction_never_cuts_while_waiting_for_approval_or_without_memory() {
        let model = ScriptedModel::new(vec![]);
        let mut off = Agent::new(model, platform());
        assert_eq!(off.compact("m", true).await.unwrap(), Vec::<String>::new());
        assert!(!off.needs_compaction());
    }

    #[tokio::test]
    async fn the_chat_continues_after_a_restart() {
        let model = ScriptedModel::new(vec![Message::assistant("Hi Andor!")]);
        let mut a = with_memory(model.clone());
        a.send("m", "I'm Andor").await.unwrap();
        a.persist();
        let carried = a.memory.as_mut().unwrap().data.carry_over.clone();
        let mut store = MemoryStore::in_memory();
        store.data.carry_over = carried;
        let mut b = Agent::new(model, platform());
        b.set_memory(Some(store));
        assert_eq!(b.history(), [Message::user("I'm Andor"), Message::assistant("Hi Andor!")]);
    }
}
