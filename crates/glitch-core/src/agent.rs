//! The chat loop: user message → model → (tool calls → maybe confirm → run →
//! model again) → reply.

use std::collections::VecDeque;
use std::sync::Arc;

use serde::Serialize;
use serde_json::json;

use crate::ai::{AiError, AiProvider, ChatRequest, Message, Role, ToolCall};
use crate::confirm::{approval_for, Approval, ConfirmError, ConfirmationGate};
use crate::platform::{Os, Platform};
use crate::tools::{self, Action};

/// Model round-trips allowed per user message (stops tool-call loops).
pub const MAX_MODEL_CALLS: usize = 5;
/// Messages kept in memory; older ones are dropped (small context = less RAM).
pub const MAX_HISTORY: usize = 24;

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
}

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
        }
    }

    /// Swap the AI backend (e.g. after the user changes the Ollama URL).
    pub fn set_provider(&mut self, provider: Arc<dyn AiProvider>) {
        self.provider = provider;
    }

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
        self.history.push(Message::user(text));
        self.trim_history();
        self.model_calls = 0;
        self.actions.clear();
        self.run(model).await
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

    async fn run(&mut self, model: &str) -> Result<Step, AgentError> {
        loop {
            while let Some(call) = self.queue.pop_front() {
                match tools::prepare(&call, &*self.platform) {
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
            messages.push(Message::system(&self.system_prompt));
            messages.extend(self.history.iter().cloned());
            let specs = tools::specs();
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
    }

    impl ScriptedModel {
        fn new(replies: Vec<Message>) -> Arc<Self> {
            Arc::new(Self { replies: Mutex::new(replies.into()), seen: Mutex::new(Vec::new()) })
        }
    }

    #[async_trait]
    impl AiProvider for ScriptedModel {
        fn name(&self) -> &'static str {
            "scripted"
        }
        async fn chat(&self, req: ChatRequest<'_>) -> Result<Message, AiError> {
            self.seen.lock().unwrap().push(req.messages.to_vec());
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
}
