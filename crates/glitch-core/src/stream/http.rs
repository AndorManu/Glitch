//! Just enough HTTP/1.1 for the overlay server: parse a request head, route
//! it, and write responses. Small, strict, and bound to 127.0.0.1 by the
//! caller; every route except static files and `/health` needs the token.

use url::form_urlencoded;

/// Largest request head we read (bytes).
pub const MAX_HEAD: usize = 8 * 1024;
/// Largest request body we accept (bytes): stream events are tiny.
pub const MAX_BODY: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub method: String,
    /// Percent-decoded path, without the query.
    pub path: String,
    pub query: Vec<(String, String)>,
    /// Header names lower-cased.
    pub headers: Vec<(String, String)>,
    /// Bytes of the head (where the body starts in the buffer).
    pub head_len: usize,
    pub content_length: usize,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
    }
    pub fn query(&self, name: &str) -> Option<&str> {
        self.query.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
    }
    /// The token from `?token=`, `X-Glitch-Token:` or `Authorization: Bearer`.
    pub fn token(&self) -> Option<&str> {
        self.query("token")
            .or_else(|| self.header("x-glitch-token"))
            .or_else(|| self.header("authorization").and_then(|v| v.strip_prefix("Bearer ")))
            .map(str::trim)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HttpError {
    TooLarge,
    Bad(&'static str),
}

/// Parse the request head in `buf`. `Ok(None)`: not all of it has arrived yet.
pub fn parse_head(buf: &[u8]) -> Result<Option<Request>, HttpError> {
    let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") else {
        return if buf.len() > MAX_HEAD { Err(HttpError::TooLarge) } else { Ok(None) };
    };
    if end > MAX_HEAD {
        return Err(HttpError::TooLarge);
    }
    let head = std::str::from_utf8(&buf[..end]).map_err(|_| HttpError::Bad("head is not UTF-8"))?;
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or("").split(' ');
    let (method, target, version) =
        (first.next().unwrap_or(""), first.next().unwrap_or(""), first.next().unwrap_or(""));
    if method.is_empty() || !target.starts_with('/') || !version.starts_with("HTTP/1.") || first.next().is_some() {
        return Err(HttpError::Bad("bad request line"));
    }
    let mut headers = Vec::new();
    for line in lines {
        let (name, value) = line.split_once(':').ok_or(HttpError::Bad("bad header"))?;
        headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
    }
    let content_length = match headers.iter().find(|(n, _)| n == "content-length") {
        Some((_, v)) => v.parse::<usize>().map_err(|_| HttpError::Bad("bad content-length"))?,
        None => 0,
    };
    if content_length > MAX_BODY {
        return Err(HttpError::TooLarge);
    }
    if headers.iter().any(|(n, _)| n == "transfer-encoding") {
        return Err(HttpError::Bad("chunked bodies are not supported"));
    }
    let (raw_path, raw_query) = target.split_once('?').unwrap_or((target, ""));
    let path = percent_decode(raw_path).ok_or(HttpError::Bad("bad path"))?;
    let query = form_urlencoded::parse(raw_query.as_bytes()).into_owned().collect();
    Ok(Some(Request { method: method.to_string(), path, query, headers, head_len: end + 4, content_length }))
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Only requests addressed to us by IP or `localhost` (blocks DNS rebinding:
/// a web page on evil.example resolving its name to 127.0.0.1).
pub fn host_allowed(host: Option<&str>, port: u16) -> bool {
    let Some(host) = host else { return false };
    let host = host.trim().to_ascii_lowercase();
    [format!("127.0.0.1:{port}"), format!("localhost:{port}"), format!("[::1]:{port}")].contains(&host)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// The overlay page (index.html of the overlay).
    Page,
    /// Overlay settings as JSON.
    Config,
    /// Server-sent events: mirror state, reactions, settings changes.
    Events,
    /// A stream event (follow/sub/raid/chat) from a bot or webhook.
    StreamEvent,
    /// A built file from the app (`/assets/...`, `/sprites/...`), no token.
    Static(String),
    Health,
    Preflight,
    BadHost,
    Unauthorized,
    MethodNotAllowed,
    NotFound,
}

/// Decide what to do with a request. Token checks happen here, so nothing
/// that needs it can be reached without it.
pub fn route(req: &Request, port: u16, token: &str) -> Route {
    if !host_allowed(req.header("host"), port) {
        return Route::BadHost;
    }
    let path = req.path.as_str();
    let get = req.method == "GET" || req.method == "HEAD";
    if req.method == "OPTIONS" {
        return Route::Preflight;
    }
    if path == "/health" {
        return if get { Route::Health } else { Route::MethodNotAllowed };
    }
    if let Some(file) = static_path(path) {
        return if get { Route::Static(file) } else { Route::MethodNotAllowed };
    }
    let known = matches!(path, "/overlay" | "/overlay/" | "/overlay/config" | "/overlay/events" | "/stream-event");
    if !known {
        return Route::NotFound;
    }
    if !super::token_matches(token, req.token().unwrap_or("")) {
        return Route::Unauthorized;
    }
    match (path, req.method.as_str()) {
        ("/overlay" | "/overlay/", "GET" | "HEAD") => Route::Page,
        ("/overlay/config", "GET" | "HEAD") => Route::Config,
        ("/overlay/events", "GET") => Route::Events,
        ("/stream-event", "POST" | "GET") => Route::StreamEvent,
        _ => Route::MethodNotAllowed,
    }
}

/// `/assets/x.js` -> `assets/x.js`. Only the two folders Vite writes, only
/// plain names (no `..`, no backslashes, no hidden files).
pub fn static_path(path: &str) -> Option<String> {
    let rel = path.strip_prefix('/')?;
    if !(rel.starts_with("assets/") || rel.starts_with("sprites/")) || rel.len() > 200 {
        return None;
    }
    let ok = rel.split('/').all(|seg| !seg.is_empty() && !seg.starts_with('.'))
        && rel.chars().all(|c| c.is_ascii_alphanumeric() || "._-/@".contains(c));
    ok.then(|| rel.to_string())
}

pub fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "png" => "image/png",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

pub fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        503 => "Service Unavailable",
        _ => "Error",
    }
}

/// A complete response. The token travels in the URL, so: never cached,
/// never sent on as a referrer, never sniffed into another type.
pub fn response(status: u16, content_type: &str, body: &[u8], head_only: bool) -> Vec<u8> {
    let mut out = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        reason(status),
        body.len()
    )
    .into_bytes();
    if !head_only {
        out.extend_from_slice(body);
    }
    out
}

/// The head of a server-sent-events stream (the body follows as `event_frame`s).
pub fn sse_head() -> Vec<u8> {
    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nConnection: keep-alive\r\n\r\nretry: 2000\n\n".to_vec()
}

/// One server-sent event; `data` must be one line (JSON is).
pub fn sse_frame(event: &str, data: &str) -> Vec<u8> {
    format!("event: {event}\ndata: {}\n\n", data.replace(['\r', '\n'], " ")).into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: &str = "0123456789abcdef0123456789abcdef";

    fn req(raw: &str) -> Request {
        parse_head(raw.as_bytes()).unwrap().unwrap()
    }

    #[test]
    fn parses_a_request() {
        let raw = "POST /stream-event?token=abc&x=a%20b HTTP/1.1\r\nHost: 127.0.0.1:7799\r\nContent-Length: 12\r\n\r\n{\"type\":\"x\"}";
        let r = req(raw);
        assert_eq!(r.method, "POST");
        assert_eq!(r.path, "/stream-event");
        assert_eq!(r.query("x"), Some("a b"));
        assert_eq!(r.token(), Some("abc"));
        assert_eq!(r.content_length, 12);
        assert_eq!(&raw[r.head_len..], "{\"type\":\"x\"}");
        let r = req("GET / HTTP/1.1\r\nAuthorization: Bearer zz\r\n\r\n");
        assert_eq!(r.token(), Some("zz"));
        let r = req("GET / HTTP/1.1\r\nX-Glitch-Token: yy\r\n\r\n");
        assert_eq!(r.token(), Some("yy"));
    }

    #[test]
    fn incomplete_bad_and_huge() {
        assert_eq!(parse_head(b"GET / HTTP/1.1\r\nHost: x"), Ok(None));
        assert!(parse_head(b"GARBAGE\r\n\r\n").is_err());
        assert!(parse_head(b"GET nope HTTP/1.1\r\n\r\n").is_err());
        assert_eq!(parse_head(&vec![b'a'; MAX_HEAD + 10]), Err(HttpError::TooLarge));
        assert_eq!(parse_head(b"POST / HTTP/1.1\r\nContent-Length: 999999\r\n\r\n"), Err(HttpError::TooLarge));
        assert!(parse_head(b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n").is_err());
    }

    #[test]
    fn host_check_blocks_rebinding() {
        assert!(host_allowed(Some("127.0.0.1:7799"), 7799));
        assert!(host_allowed(Some("LOCALHOST:7799"), 7799));
        assert!(!host_allowed(Some("evil.example:7799"), 7799));
        assert!(!host_allowed(Some("127.0.0.1:80"), 7799));
        assert!(!host_allowed(None, 7799));
    }

    #[test]
    fn routing_needs_the_token() {
        let r = |line: &str| route(&req(&format!("{line} HTTP/1.1\r\nHost: 127.0.0.1:7799\r\n\r\n")), 7799, T);
        assert_eq!(r(&format!("GET /overlay?token={T}")), Route::Page);
        assert_eq!(r("GET /overlay?token=wrong"), Route::Unauthorized);
        assert_eq!(r("GET /overlay"), Route::Unauthorized);
        assert_eq!(r(&format!("GET /overlay/events?token={T}")), Route::Events);
        assert_eq!(r(&format!("GET /overlay/config?token={T}")), Route::Config);
        assert_eq!(r(&format!("POST /stream-event?token={T}")), Route::StreamEvent);
        assert_eq!(r(&format!("DELETE /stream-event?token={T}")), Route::MethodNotAllowed);
        assert_eq!(r("GET /assets/overlay-x1.js"), Route::Static("assets/overlay-x1.js".into()));
        assert_eq!(r("GET /assets/../settings.json"), Route::NotFound);
        assert_eq!(r("GET /assets/%2e%2e/x"), Route::NotFound);
        assert_eq!(r("GET /health"), Route::Health);
        assert_eq!(r("GET /secret"), Route::NotFound);
        let bad = req(&format!("GET /overlay?token={T} HTTP/1.1\r\nHost: evil.example:7799\r\n\r\n"));
        assert_eq!(route(&bad, 7799, T), Route::BadHost);
        // An empty token (not generated yet) never matches.
        assert_eq!(
            route(&req("GET /overlay?token= HTTP/1.1\r\nHost: 127.0.0.1:7799\r\n\r\n"), 7799, ""),
            Route::Unauthorized
        );
    }

    #[test]
    fn static_paths() {
        assert_eq!(static_path("/sprites/glitch.png").as_deref(), Some("sprites/glitch.png"));
        assert_eq!(static_path("/assets/.hidden"), None);
        assert_eq!(static_path("/assets/a\\b"), None);
        assert_eq!(static_path("/panel.html"), None);
        assert_eq!(static_path("/assets//x"), None);
    }

    #[test]
    fn responses() {
        let r = String::from_utf8(response(404, "text/plain", b"nope", false)).unwrap();
        assert!(r.starts_with("HTTP/1.1 404 Not Found\r\n"));
        assert!(r.contains("Cache-Control: no-store") && r.contains("Referrer-Policy: no-referrer"));
        assert!(r.ends_with("\r\n\r\nnope"));
        assert!(String::from_utf8(response(200, "x", b"body", true)).unwrap().ends_with("\r\n\r\n"));
        assert_eq!(sse_frame("e", "a\nb"), b"event: e\ndata: a b\n\n");
        assert_eq!(content_type("x/y.js"), "text/javascript; charset=utf-8");
    }
}
