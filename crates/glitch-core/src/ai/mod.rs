//! Provider-neutral chat types and the [`AiProvider`] trait.
//!
//! Everything above this module (the agent loop, the UI) only talks to
//! `dyn AiProvider`. Ollama is the only implementation today; an API-key based
//! provider can be added later by implementing the same trait.

pub mod ollama;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

/// A request from the model to run one of our tools.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub name: String,
    /// Always a JSON object (providers that send a string are normalised).
    pub arguments: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    pub content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    /// For `Role::Tool` messages: which tool produced this result.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    /// Base64 JPEG/PNG images for vision models (a screenshot). Never
    /// serialised: they only live in RAM for the turn that needed them.
    #[serde(skip)]
    pub images: Vec<String>,
    /// Built from something private (the screen, the clipboard): kept in the
    /// live chat, but never written to disk or folded into memory.
    #[serde(skip)]
    pub private: bool,
}

impl Message {
    fn new(role: Role, content: impl Into<String>) -> Self {
        Self {
            role,
            content: content.into(),
            tool_calls: Vec::new(),
            tool_name: None,
            images: Vec::new(),
            private: false,
        }
    }
    pub fn system(content: impl Into<String>) -> Self {
        Self::new(Role::System, content)
    }
    pub fn user(content: impl Into<String>) -> Self {
        Self::new(Role::User, content)
    }
    pub fn assistant(content: impl Into<String>) -> Self {
        Self::new(Role::Assistant, content)
    }
    pub fn tool_result(tool_name: impl Into<String>, content: impl Into<String>) -> Self {
        Self { tool_name: Some(tool_name.into()), ..Self::new(Role::Tool, content) }
    }
}

/// Description of a tool the model may call (JSON-schema parameters).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub parameters: Value,
}

/// Receives the reply's text piece by piece while it streams in.
pub type OnText<'a> = dyn Fn(&str) + Send + Sync + 'a;

pub struct ChatRequest<'a> {
    pub model: &'a str,
    pub messages: &'a [Message],
    pub tools: &'a [ToolSpec],
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum AiError {
    /// The provider could not be reached at all (e.g. Ollama is not running).
    #[error("could not reach the AI service: {0}")]
    Unreachable(String),
    /// Reachable but too slow (e.g. a big model still loading from disk).
    #[error("the AI service is taking too long to answer")]
    TimedOut,
    #[error("the model \"{0}\" is not installed")]
    ModelNotFound(String),
    #[error("the AI service returned an error ({status}): {message}")]
    Api { status: u16, message: String },
    #[error("unexpected response from the AI service: {0}")]
    InvalidResponse(String),
}

#[async_trait]
pub trait AiProvider: Send + Sync {
    /// Human readable name, e.g. "Ollama".
    fn name(&self) -> &'static str;

    /// Send the conversation and get the assistant's next message
    /// (which may contain tool calls instead of / in addition to text).
    async fn chat(&self, request: ChatRequest<'_>) -> Result<Message, AiError>;

    /// Like [`chat`](Self::chat), but calls `on_text` with each piece of the
    /// reply's text as it is generated (for showing it while it streams in).
    /// Providers that can't stream just answer at once.
    async fn chat_streaming(&self, request: ChatRequest<'_>, on_text: &OnText<'_>) -> Result<Message, AiError> {
        let _ = on_text;
        self.chat(request).await
    }

    /// Can this model look at images? `None` = unknown.
    async fn supports_vision(&self, model: &str) -> Option<bool> {
        let _ = model;
        None
    }

    /// Load the model now and keep it loaded for `keep_alive` (e.g. "10m"),
    /// so the next message doesn't wait for it. Best effort.
    async fn warm_up(&self, model: &str, keep_alive: &str) -> Result<(), AiError> {
        let _ = (model, keep_alive);
        Ok(())
    }
}
