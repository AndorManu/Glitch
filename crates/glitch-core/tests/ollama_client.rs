//! Ollama client tests against a mock HTTP server (no real Ollama needed).
//! Response shapes are copied from the official API docs.

use glitch_core::ai::ollama::OllamaClient;
use glitch_core::ai::{AiError, AiProvider, ChatRequest, Message, Role, ToolCall, ToolSpec};
use serde_json::{json, Value};
use wiremock::matchers::{body_partial_json, method, path};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

fn tool() -> ToolSpec {
    ToolSpec {
        name: "open_url",
        description: "Open a web page",
        parameters: json!({"type": "object", "required": ["url"], "properties": {"url": {"type": "string"}}}),
    }
}

async fn mock_show(server: &MockServer, capabilities: Value) {
    Mock::given(method("POST"))
        .and(path("/api/show"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "capabilities": capabilities })))
        .mount(server)
        .await;
}

fn chat_reply(message: Value) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({
        "model": "qwen3.5:2b",
        "created_at": "2023-12-12T14:13:43.416799Z",
        "message": message,
        "done": true,
        "total_duration": 5191566416u64,
    }))
}

#[tokio::test]
async fn version_ok_when_running() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/version"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"version": "0.12.3"})))
        .mount(&server)
        .await;
    let client = OllamaClient::new(&server.uri(), "2m");
    assert_eq!(client.version().await.unwrap(), "0.12.3");
}

#[tokio::test]
async fn unreachable_when_nothing_listens() {
    // Port 9 (discard) on localhost: nothing should be listening there.
    let client = OllamaClient::new("http://127.0.0.1:9", "2m");
    assert!(matches!(client.version().await, Err(AiError::Unreachable(_))));
}

#[tokio::test]
async fn chat_sends_keep_alive_tools_and_no_streaming() {
    let server = MockServer::start().await;
    mock_show(&server, json!(["completion", "tools"])).await;
    Mock::given(method("POST"))
        .and(path("/api/chat"))
        .and(body_partial_json(json!({
            "model": "qwen3.5:2b",
            "stream": false,
            "keep_alive": "2m",
            "options": {"num_ctx": 4096},
            "tools": [{"type": "function", "function": {"name": "open_url"}}],
            "messages": [{"role": "user", "content": "hi"}],
        })))
        .respond_with(chat_reply(json!({"role": "assistant", "content": "Hello! How are you today?"})))
        .expect(1)
        .mount(&server)
        .await;

    let client = OllamaClient::new(&server.uri(), "2m");
    let reply = client
        .chat(ChatRequest { model: "qwen3.5:2b", messages: &[Message::user("hi")], tools: &[tool()] })
        .await
        .unwrap();
    assert_eq!(reply.role, Role::Assistant);
    assert_eq!(reply.content, "Hello! How are you today?");
    assert!(reply.tool_calls.is_empty());
}

#[tokio::test]
async fn think_false_only_for_thinking_models() {
    for (caps, expect_think) in [(json!(["completion", "tools", "thinking"]), true), (json!(["completion", "tools"]), false)] {
        let server = MockServer::start().await;
        mock_show(&server, caps).await;
        Mock::given(method("POST"))
            .and(path("/api/chat"))
            .respond_with(chat_reply(json!({"role": "assistant", "content": "ok"})))
            .mount(&server)
            .await;
        let client = OllamaClient::new(&server.uri(), "2m");
        client.chat(ChatRequest { model: "m", messages: &[Message::user("hi")], tools: &[] }).await.unwrap();

        let reqs = server.received_requests().await.unwrap();
        let chat: &Request = reqs.iter().find(|r| r.url.path() == "/api/chat").unwrap();
        let body: Value = serde_json::from_slice(&chat.body).unwrap();
        assert_eq!(body.get("think") == Some(&json!(false)), expect_think, "body: {body}");
        // No tools passed → no "tools" key at all.
        assert!(body.get("tools").is_none());
    }
}

#[tokio::test]
async fn parses_tool_calls_in_documented_format() {
    let server = MockServer::start().await;
    mock_show(&server, json!(["completion", "tools"])).await;
    Mock::given(method("POST"))
        .and(path("/api/chat"))
        .respond_with(chat_reply(json!({
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {"function": {"name": "open_url", "arguments": {"url": "https://x.com/elonmusk"}}},
                {"function": {"index": 1, "name": "open_url", "arguments": "{\"url\": \"https://example.com\"}"}}
            ]
        })))
        .mount(&server)
        .await;
    let client = OllamaClient::new(&server.uri(), "2m");
    let reply = client
        .chat(ChatRequest { model: "m", messages: &[Message::user("open twitter")], tools: &[tool()] })
        .await
        .unwrap();
    assert_eq!(
        reply.tool_calls,
        vec![
            ToolCall { name: "open_url".into(), arguments: json!({"url": "https://x.com/elonmusk"}) },
            ToolCall { name: "open_url".into(), arguments: json!({"url": "https://example.com"}) },
        ]
    );
}

#[tokio::test]
async fn tool_results_are_sent_back_with_tool_name() {
    let server = MockServer::start().await;
    mock_show(&server, json!(["tools"])).await;
    Mock::given(method("POST"))
        .and(path("/api/chat"))
        .and(body_partial_json(json!({
            "messages": [
                {"role": "user", "content": "open example"},
                {"role": "assistant", "tool_calls": [{"type": "function", "function": {"name": "open_url", "arguments": {"url": "https://example.com"}}}]},
                {"role": "tool", "tool_name": "open_url", "content": "{\"ok\":true}"}
            ]
        })))
        .respond_with(chat_reply(json!({"role": "assistant", "content": "<think>internal</think>Done!"})))
        .expect(1)
        .mount(&server)
        .await;
    let client = OllamaClient::new(&server.uri(), "2m");
    let history = vec![
        Message::user("open example"),
        Message {
            tool_calls: vec![ToolCall { name: "open_url".into(), arguments: json!({"url": "https://example.com"}) }],
            ..Message::assistant("")
        },
        Message::tool_result("open_url", "{\"ok\":true}"),
    ];
    let reply = client.chat(ChatRequest { model: "m", messages: &history, tools: &[tool()] }).await.unwrap();
    assert_eq!(reply.content, "Done!");
}

#[tokio::test]
async fn model_not_found_maps_404() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/show"))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({"error": "model 'nope' not found"})))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/chat"))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({"error": "model 'nope' not found"})))
        .mount(&server)
        .await;
    let client = OllamaClient::new(&server.uri(), "2m");
    let err = client.chat(ChatRequest { model: "nope", messages: &[Message::user("x")], tools: &[] }).await;
    assert_eq!(err, Err(AiError::ModelNotFound("nope".into())));
}

#[tokio::test]
async fn api_errors_carry_the_documented_error_message() {
    let server = MockServer::start().await;
    mock_show(&server, json!([])).await;
    Mock::given(method("POST"))
        .and(path("/api/chat"))
        .respond_with(ResponseTemplate::new(500).set_body_json(json!({"error": "the model failed to generate a response"})))
        .mount(&server)
        .await;
    let client = OllamaClient::new(&server.uri(), "2m");
    let err = client.chat(ChatRequest { model: "m", messages: &[Message::user("x")], tools: &[] }).await;
    assert_eq!(err, Err(AiError::Api { status: 500, message: "the model failed to generate a response".into() }));
}

#[tokio::test]
async fn lists_installed_models() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/tags"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "models": [{
                "name": "deepseek-r1:latest", "model": "deepseek-r1:latest",
                "modified_at": "2025-05-10T08:06:48.639712648-07:00", "size": 4683075271u64,
                "digest": "0a8c", "details": {"parent_model": "", "format": "gguf", "family": "qwen2",
                "families": ["qwen2"], "parameter_size": "7.6B", "quantization_level": "Q4_K_M"}
            }]
        })))
        .mount(&server)
        .await;
    let client = OllamaClient::new(&server.uri(), "2m");
    let models = client.list_models().await.unwrap();
    assert_eq!(models.len(), 1);
    assert_eq!(models[0].name, "deepseek-r1:latest");
    assert_eq!(models[0].size, 4683075271);
    assert_eq!(models[0].parameter_size, "7.6B");
}

#[tokio::test]
async fn capabilities_are_cached() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/show"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"capabilities": ["completion", "tools"]})))
        .expect(1)
        .mount(&server)
        .await;
    let client = OllamaClient::new(&server.uri(), "2m");
    for _ in 0..3 {
        assert_eq!(client.capabilities("m").await.unwrap(), vec!["completion", "tools"]);
    }
}

#[tokio::test]
async fn pull_streams_progress_until_success() {
    let server = MockServer::start().await;
    let ndjson = [
        json!({"status": "pulling manifest"}),
        json!({"status": "pulling abc", "digest": "abc", "total": 2142590208u64, "completed": 241970}),
        json!({"status": "verifying sha256 digest"}),
        json!({"status": "writing manifest"}),
        json!({"status": "success"}),
    ]
    .iter()
    .map(|v| v.to_string())
    .collect::<Vec<_>>()
    .join("\n");
    Mock::given(method("POST"))
        .and(path("/api/pull"))
        .and(body_partial_json(json!({"model": "qwen3.5:2b"})))
        .respond_with(ResponseTemplate::new(200).set_body_raw(ndjson, "application/x-ndjson"))
        .mount(&server)
        .await;
    let client = OllamaClient::new(&server.uri(), "2m");
    let mut seen = Vec::new();
    client.pull("qwen3.5:2b", |p| seen.push(p)).await.unwrap();
    assert_eq!(seen.len(), 5);
    assert_eq!(seen[1].total, Some(2142590208));
    assert_eq!(seen[1].completed, Some(241970));
    assert_eq!(seen.last().unwrap().status, "success");
}

#[tokio::test]
async fn pull_reports_mid_stream_errors() {
    let server = MockServer::start().await;
    let ndjson = format!("{}\n{}\n", json!({"status": "pulling manifest"}), json!({"error": "pull model manifest: file does not exist"}));
    Mock::given(method("POST"))
        .and(path("/api/pull"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(ndjson, "application/x-ndjson"))
        .mount(&server)
        .await;
    let client = OllamaClient::new(&server.uri(), "2m");
    let err = client.pull("nope", |_| {}).await.unwrap_err();
    assert!(matches!(err, AiError::Api { ref message, .. } if message.contains("does not exist")), "{err:?}");
}

#[tokio::test]
async fn unload_sends_keep_alive_zero_with_empty_messages() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/chat"))
        .and(body_partial_json(json!({"model": "m", "messages": [], "keep_alive": 0})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "model": "m", "created_at": "2024-09-12T21:33:17.547535Z",
            "message": {"role": "assistant", "content": ""}, "done_reason": "unload", "done": true
        })))
        .expect(1)
        .mount(&server)
        .await;
    OllamaClient::new(&server.uri(), "2m").unload("m").await.unwrap();
}
