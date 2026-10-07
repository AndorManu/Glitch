//! Ollama implementation of [`AiProvider`] plus the Ollama-specific calls the
//! first-run wizard needs (version check, installed models, pull, unload).
//!
//! API reference: <https://github.com/ollama/ollama/blob/main/docs/api.md>
//! (`/api/chat`, `/api/tags`, `/api/show`, `/api/pull`, `/api/version`) and
//! `docs/capabilities/tool-calling.mdx` for the tool message format.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{AiError, AiProvider, ChatRequest, Message, Role, ToolCall};

pub const DEFAULT_URL: &str = "http://127.0.0.1:11434";
/// How long Ollama keeps the model in RAM after the last message.
/// Short on purpose: Glitch should give memory back quickly.
pub const DEFAULT_KEEP_ALIVE: &str = "2m";
/// Context window we ask for. Smaller context = less RAM. A desktop
/// companion's chats are short, so 4096 tokens is plenty.
pub const DEFAULT_NUM_CTX: u32 = 4096;

const QUICK_TIMEOUT: Duration = Duration::from_secs(3);
/// First message may need to load the model from disk; slow PCs need time.
const CHAT_TIMEOUT: Duration = Duration::from_secs(300);

pub struct OllamaClient {
    base_url: String,
    keep_alive: String,
    num_ctx: u32,
    http: reqwest::Client,
    /// `/api/show` capabilities per model, e.g. ["completion", "tools", "thinking"].
    capabilities: Mutex<HashMap<String, Vec<String>>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LocalModel {
    pub name: String,
    /// Size on disk in bytes.
    pub size: u64,
    /// e.g. "3.2B" (may be empty).
    pub parameter_size: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PullProgress {
    pub status: String,
    pub completed: Option<u64>,
    pub total: Option<u64>,
}

impl OllamaClient {
    pub fn new(base_url: &str, keep_alive: &str) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(QUICK_TIMEOUT)
            // Never route localhost traffic through a system proxy.
            .no_proxy()
            .build()
            .expect("building an HTTP client without TLS cannot fail");
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            keep_alive: keep_alive.to_string(),
            num_ctx: DEFAULT_NUM_CTX,
            http,
            capabilities: Mutex::new(HashMap::new()),
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    /// `GET /api/version`. Succeeds only if the Ollama server is running.
    pub async fn version(&self) -> Result<String, AiError> {
        #[derive(Deserialize)]
        struct V {
            version: String,
        }
        let resp =
            self.http.get(self.url("/api/version")).timeout(QUICK_TIMEOUT).send().await.map_err(transport_error)?;
        let v: V = parse_json(resp, None).await?;
        Ok(v.version)
    }

    /// `GET /api/tags`: models already downloaded on this machine.
    pub async fn list_models(&self) -> Result<Vec<LocalModel>, AiError> {
        #[derive(Deserialize)]
        struct Tags {
            #[serde(default)]
            models: Vec<TagModel>,
        }
        #[derive(Deserialize)]
        struct TagModel {
            name: String,
            #[serde(default)]
            size: u64,
            #[serde(default)]
            details: Option<TagDetails>,
        }
        #[derive(Deserialize)]
        struct TagDetails {
            #[serde(default)]
            parameter_size: String,
        }
        let resp = self.http.get(self.url("/api/tags")).timeout(QUICK_TIMEOUT).send().await.map_err(transport_error)?;
        let tags: Tags = parse_json(resp, None).await?;
        Ok(tags
            .models
            .into_iter()
            .map(|m| LocalModel {
                name: m.name,
                size: m.size,
                parameter_size: m.details.map(|d| d.parameter_size).unwrap_or_default(),
            })
            .collect())
    }

    /// `POST /api/show` → `capabilities` (cached per model name).
    pub async fn capabilities(&self, model: &str) -> Result<Vec<String>, AiError> {
        if let Some(c) = self.capabilities.lock().unwrap().get(model) {
            return Ok(c.clone());
        }
        #[derive(Deserialize)]
        struct Show {
            #[serde(default)]
            capabilities: Vec<String>,
        }
        let resp = self
            .http
            .post(self.url("/api/show"))
            .json(&json!({ "model": model }))
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(transport_error)?;
        let show: Show = parse_json(resp, Some(model)).await?;
        self.capabilities.lock().unwrap().insert(model.to_string(), show.capabilities.clone());
        Ok(show.capabilities)
    }

    /// `POST /api/pull` (streaming). Calls `on_progress` for every status line.
    pub async fn pull(&self, model: &str, mut on_progress: impl FnMut(PullProgress) + Send) -> Result<(), AiError> {
        #[derive(Deserialize)]
        struct Line {
            #[serde(default)]
            status: String,
            completed: Option<u64>,
            total: Option<u64>,
            error: Option<String>,
        }
        let mut resp = self
            .http
            .post(self.url("/api/pull"))
            .json(&json!({ "model": model, "stream": true }))
            .send()
            .await
            .map_err(transport_error)?;
        if !resp.status().is_success() {
            return Err(error_from_response(resp, Some(model)).await);
        }
        let mut buf: Vec<u8> = Vec::new();
        let mut handle_line = |line: &[u8]| -> Result<bool, AiError> {
            if line.iter().all(u8::is_ascii_whitespace) {
                return Ok(false);
            }
            let l: Line = serde_json::from_slice(line).map_err(|e| AiError::InvalidResponse(e.to_string()))?;
            if let Some(err) = l.error {
                return Err(AiError::Api { status: 200, message: err });
            }
            let done = l.status == "success";
            on_progress(PullProgress { status: l.status, completed: l.completed, total: l.total });
            Ok(done)
        };
        let mut success = false;
        while let Some(chunk) = resp.chunk().await.map_err(transport_error)? {
            buf.extend_from_slice(&chunk);
            while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = buf.drain(..=pos).collect();
                success |= handle_line(&line)?;
            }
        }
        success |= handle_line(&buf)?;
        if success {
            Ok(())
        } else {
            Err(AiError::InvalidResponse("download ended before it finished".into()))
        }
    }

    /// Ask Ollama to drop the model from memory right now
    /// (empty `messages` + `keep_alive: 0`, as documented for `/api/chat`).
    pub async fn unload(&self, model: &str) -> Result<(), AiError> {
        let resp = self
            .http
            .post(self.url("/api/chat"))
            .json(&json!({ "model": model, "messages": [], "keep_alive": 0 }))
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(transport_error)?;
        let _: Value = parse_json(resp, Some(model)).await?;
        Ok(())
    }

    /// Builds the `/api/chat` body. Public for tests.
    pub fn chat_body(&self, req: &ChatRequest<'_>, disable_thinking: bool) -> Value {
        let messages: Vec<Value> = req.messages.iter().map(wire_message).collect();
        let mut body = json!({
            "model": req.model,
            "messages": messages,
            "stream": false,
            "keep_alive": self.keep_alive,
            "options": { "num_ctx": self.num_ctx },
        });
        if !req.tools.is_empty() {
            body["tools"] = req
                .tools
                .iter()
                .map(|t| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": t.name,
                            "description": t.description,
                            "parameters": t.parameters,
                        }
                    })
                })
                .collect();
        }
        if disable_thinking {
            // Thinking makes small models much slower; a desktop buddy should be snappy.
            body["think"] = json!(false);
        }
        body
    }
}

#[async_trait]
impl AiProvider for OllamaClient {
    fn name(&self) -> &'static str {
        "Ollama"
    }

    async fn chat(&self, req: ChatRequest<'_>) -> Result<Message, AiError> {
        // Only send `think` to models that support it. If /api/show fails we
        // just leave it out rather than failing the whole chat.
        let thinking = self.capabilities(req.model).await.map(|c| c.iter().any(|c| c == "thinking")).unwrap_or(false);
        let body = self.chat_body(&req, thinking);
        let resp = self
            .http
            .post(self.url("/api/chat"))
            .json(&body)
            .timeout(CHAT_TIMEOUT)
            .send()
            .await
            .map_err(transport_error)?;
        let parsed: ChatResponse = parse_json(resp, Some(req.model)).await?;
        let msg = parsed.message.ok_or_else(|| AiError::InvalidResponse("no message".into()))?;
        let tool_calls = msg
            .tool_calls
            .into_iter()
            .map(|c| ToolCall { name: c.function.name, arguments: normalise_arguments(c.function.arguments) })
            .collect();
        Ok(Message {
            role: Role::Assistant,
            content: strip_think_tags(&msg.content).trim().to_string(),
            tool_calls,
            tool_name: None,
        })
    }
}

#[derive(Deserialize)]
struct ChatResponse {
    message: Option<WireMessage>,
}

#[derive(Deserialize)]
struct WireMessage {
    #[serde(default)]
    content: String,
    #[serde(default)]
    tool_calls: Vec<WireToolCall>,
}

#[derive(Deserialize)]
struct WireToolCall {
    function: WireFunction,
}

#[derive(Deserialize)]
struct WireFunction {
    name: String,
    #[serde(default)]
    arguments: Value,
}

fn wire_message(m: &Message) -> Value {
    let mut v = json!({ "role": m.role, "content": m.content });
    if !m.tool_calls.is_empty() {
        v["tool_calls"] = m
            .tool_calls
            .iter()
            .map(|c| json!({ "type": "function", "function": { "name": c.name, "arguments": c.arguments } }))
            .collect();
    }
    if let Some(name) = &m.tool_name {
        v["tool_name"] = json!(name);
    }
    v
}

/// Ollama documents `arguments` as an object, but be forgiving if a model
/// produces a JSON string instead.
fn normalise_arguments(v: Value) -> Value {
    match v {
        Value::Object(_) => v,
        Value::String(s) => match serde_json::from_str::<Value>(&s) {
            Ok(obj @ Value::Object(_)) => obj,
            _ => json!({}),
        },
        _ => json!({}),
    }
}

/// Some models leak their reasoning as `<think>…</think>` in `content`.
fn strip_think_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find("<think>") {
        out.push_str(&rest[..start]);
        match rest[start..].find("</think>") {
            Some(end) => rest = &rest[start + end + "</think>".len()..],
            None => return out,
        }
    }
    out.push_str(rest);
    out
}

fn transport_error(e: reqwest::Error) -> AiError {
    if e.is_decode() {
        AiError::InvalidResponse(e.to_string())
    } else if e.is_timeout() {
        AiError::Unreachable("timed out waiting for the AI service".into())
    } else {
        AiError::Unreachable(e.to_string())
    }
}

async fn error_from_response(resp: reqwest::Response, model: Option<&str>) -> AiError {
    #[derive(Deserialize)]
    struct ErrBody {
        error: String,
    }
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    let message = serde_json::from_str::<ErrBody>(&text).map(|b| b.error).unwrap_or(text);
    match (status, model) {
        (404, Some(m)) => AiError::ModelNotFound(m.to_string()),
        _ => AiError::Api { status, message },
    }
}

async fn parse_json<T: for<'de> Deserialize<'de>>(resp: reqwest::Response, model: Option<&str>) -> Result<T, AiError> {
    if !resp.status().is_success() {
        return Err(error_from_response(resp, model).await);
    }
    let text = resp.text().await.map_err(transport_error)?;
    serde_json::from_str(&text).map_err(|e| AiError::InvalidResponse(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_think_blocks() {
        assert_eq!(strip_think_tags("<think>hmm</think>Hello"), "Hello");
        assert_eq!(strip_think_tags("a<think>x</think>b<think>y</think>c"), "abc");
        assert_eq!(strip_think_tags("no tags"), "no tags");
        assert_eq!(strip_think_tags("cut <think>never closed"), "cut ");
    }

    #[test]
    fn string_arguments_are_parsed() {
        assert_eq!(normalise_arguments(json!("{\"url\":\"https://a.b\"}")), json!({"url": "https://a.b"}));
        assert_eq!(normalise_arguments(json!("garbage")), json!({}));
        assert_eq!(normalise_arguments(Value::Null), json!({}));
    }
}
