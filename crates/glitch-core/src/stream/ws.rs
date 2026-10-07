//! A minimal WebSocket *client* (RFC 6455), enough to listen to Streamer.bot
//! on localhost: the opening handshake, masked client frames, and decoding
//! server frames (with fragments reassembled). No extensions, no TLS.

use base64::Engine;

const GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/// Biggest message we accept from the server.
pub const MAX_MESSAGE: usize = 1024 * 1024;

pub const OP_CONT: u8 = 0x0;
pub const OP_TEXT: u8 = 0x1;
pub const OP_BINARY: u8 = 0x2;
pub const OP_CLOSE: u8 = 0x8;
pub const OP_PING: u8 = 0x9;
pub const OP_PONG: u8 = 0xA;

/// Where to connect, from a `ws://host:port/path` URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub host: String,
    pub port: u16,
    pub path: String,
}

/// Only plain `ws://` to this computer: Glitch never opens a socket to the
/// internet on behalf of a settings field.
pub fn parse_local_url(s: &str) -> Result<Target, String> {
    let u = url::Url::parse(s.trim()).map_err(|_| "that isn't a ws:// address".to_string())?;
    if u.scheme() != "ws" {
        return Err("use a ws:// address (Streamer.bot's WebSocket server)".into());
    }
    let host = u.host_str().unwrap_or("").to_string();
    if !matches!(host.as_str(), "127.0.0.1" | "localhost" | "[::1]") {
        return Err("only this computer (127.0.0.1 or localhost)".into());
    }
    let mut path = u.path().to_string();
    if let Some(q) = u.query() {
        path = format!("{path}?{q}");
    }
    Ok(Target { host, port: u.port().unwrap_or(80), path })
}

pub fn handshake(t: &Target, key: &str) -> String {
    format!(
        "GET {} HTTP/1.1\r\nHost: {}:{}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n",
        t.path, t.host, t.port
    )
}

/// The `Sec-WebSocket-Accept` the server must answer for `key`.
pub fn accept_for(key: &str) -> String {
    let digest = sha1_smol::Sha1::from(format!("{key}{GUID}")).digest().bytes();
    base64::engine::general_purpose::STANDARD.encode(digest)
}

pub fn new_key() -> String {
    let mut b = [0u8; 16];
    let _ = getrandom::fill(&mut b);
    base64::engine::general_purpose::STANDARD.encode(b)
}

/// Check the server's handshake response (the head up to the blank line).
pub fn check_response(head: &str, key: &str) -> Result<(), String> {
    let mut lines = head.split("\r\n");
    let status = lines.next().unwrap_or("");
    if !status.starts_with("HTTP/1.1 101") {
        return Err(format!("the server said \"{}\"", super::clean(status, 60)));
    }
    let want = accept_for(key);
    let ok = lines
        .filter_map(|l| l.split_once(':'))
        .any(|(n, v)| n.trim().eq_ignore_ascii_case("sec-websocket-accept") && v.trim() == want);
    if ok {
        Ok(())
    } else {
        Err("not a WebSocket server".into())
    }
}

/// A client frame (always masked, always final).
pub fn encode(opcode: u8, payload: &[u8], mask: [u8; 4]) -> Vec<u8> {
    let mut out = vec![0x80 | opcode];
    let n = payload.len();
    if n < 126 {
        out.push(0x80 | n as u8);
    } else if n <= u16::MAX as usize {
        out.push(0x80 | 126);
        out.extend_from_slice(&(n as u16).to_be_bytes());
    } else {
        out.push(0x80 | 127);
        out.extend_from_slice(&(n as u64).to_be_bytes());
    }
    out.extend_from_slice(&mask);
    out.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
    out
}

pub fn random_mask() -> [u8; 4] {
    let mut m = [0u8; 4];
    let _ = getrandom::fill(&mut m);
    m
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub fin: bool,
    pub opcode: u8,
    pub payload: Vec<u8>,
}

/// Decode one frame from the front of `buf`: the frame and how many bytes it
/// used, `Ok(None)` if more bytes are needed.
pub fn decode(buf: &[u8]) -> Result<Option<(Frame, usize)>, String> {
    if buf.len() < 2 {
        return Ok(None);
    }
    let fin = buf[0] & 0x80 != 0;
    if buf[0] & 0x70 != 0 {
        return Err("unexpected extension bits".into());
    }
    let opcode = buf[0] & 0x0F;
    let masked = buf[1] & 0x80 != 0;
    let mut len = (buf[1] & 0x7F) as u64;
    let mut at = 2;
    if len == 126 {
        let Some(b) = buf.get(2..4) else { return Ok(None) };
        len = u16::from_be_bytes([b[0], b[1]]) as u64;
        at = 4;
    } else if len == 127 {
        let Some(b) = buf.get(2..10) else { return Ok(None) };
        len = u64::from_be_bytes(b.try_into().unwrap());
        at = 10;
    }
    if len > MAX_MESSAGE as u64 {
        return Err("message too large".into());
    }
    let mask = if masked {
        let Some(m) = buf.get(at..at + 4) else { return Ok(None) };
        at += 4;
        Some([m[0], m[1], m[2], m[3]])
    } else {
        None
    };
    let end = at + len as usize;
    let Some(data) = buf.get(at..end) else { return Ok(None) };
    let payload = match mask {
        Some(m) => data.iter().enumerate().map(|(i, b)| b ^ m[i % 4]).collect(),
        None => data.to_vec(),
    };
    Ok(Some((Frame { fin, opcode, payload }, end)))
}

/// Joins fragmented messages. Control frames come out at once.
#[derive(Default)]
pub struct Assembler {
    opcode: u8,
    parts: Vec<u8>,
    open: bool,
}

impl Assembler {
    /// A whole message (`opcode`, payload), or `None` while fragments arrive.
    pub fn push(&mut self, f: Frame) -> Result<Option<(u8, Vec<u8>)>, String> {
        if f.opcode >= 0x8 {
            return Ok(Some((f.opcode, f.payload)));
        }
        if f.opcode == OP_CONT {
            if !self.open {
                return Err("continuation without a start".into());
            }
        } else {
            self.opcode = f.opcode;
            self.parts.clear();
            self.open = true;
        }
        if self.parts.len() + f.payload.len() > MAX_MESSAGE {
            return Err("message too large".into());
        }
        self.parts.extend_from_slice(&f.payload);
        if !f.fin {
            return Ok(None);
        }
        self.open = false;
        Ok(Some((self.opcode, std::mem::take(&mut self.parts))))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc_accept_example() {
        // RFC 6455 section 1.3.
        assert_eq!(accept_for("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
        let ok = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";
        assert!(check_response(ok, "dGhlIHNhbXBsZSBub25jZQ==").is_ok());
        assert!(check_response("HTTP/1.1 404 Not Found", "x").is_err());
        assert_eq!(new_key().len(), 24);
    }

    #[test]
    fn local_urls_only() {
        let t = parse_local_url("ws://127.0.0.1:8080/").unwrap();
        assert_eq!((t.host.as_str(), t.port, t.path.as_str()), ("127.0.0.1", 8080, "/"));
        assert!(handshake(&t, "k").starts_with("GET / HTTP/1.1\r\nHost: 127.0.0.1:8080\r\n"));
        assert!(parse_local_url("ws://example.com:8080/").is_err());
        assert!(parse_local_url("http://127.0.0.1:8080/").is_err());
        assert!(parse_local_url("wss://localhost/").is_err());
    }

    #[test]
    fn frames_round_trip() {
        for n in [0usize, 5, 125, 126, 300, 70_000] {
            let payload: Vec<u8> = (0..n).map(|i| i as u8).collect();
            let bytes = encode(OP_TEXT, &payload, [1, 2, 3, 4]);
            let (f, used) = decode(&bytes).unwrap().unwrap();
            assert_eq!(used, bytes.len());
            assert_eq!((f.fin, f.opcode, f.payload), (true, OP_TEXT, payload.clone()));
            // Partial input asks for more.
            assert_eq!(decode(&bytes[..bytes.len() - 1]).unwrap(), None);
        }
        // An unmasked server frame.
        let (f, used) = decode(&[0x81, 2, b'h', b'i', 0xFF]).unwrap().unwrap();
        assert_eq!((f.payload.as_slice(), used), (&b"hi"[..], 4));
        assert!(decode(&[0x81, 127, 0xFF, 0, 0, 0, 0, 0, 0, 0]).is_err());
    }

    #[test]
    fn fragments_are_joined() {
        let mut a = Assembler::default();
        assert_eq!(a.push(Frame { fin: false, opcode: OP_TEXT, payload: b"he".to_vec() }).unwrap(), None);
        assert_eq!(a.push(Frame { fin: true, opcode: OP_PING, payload: vec![] }).unwrap(), Some((OP_PING, vec![])));
        assert_eq!(
            a.push(Frame { fin: true, opcode: OP_CONT, payload: b"llo".to_vec() }).unwrap(),
            Some((OP_TEXT, b"hello".to_vec()))
        );
        assert!(a.push(Frame { fin: true, opcode: OP_CONT, payload: vec![] }).is_err());
    }
}
