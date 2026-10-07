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
}

impl Message {
    fn new(role: Role, content: impl Into<String>) -> Self {
        Self { role, content: content.into(), tool_calls: Vec::new(), tool_name: None }
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
}
