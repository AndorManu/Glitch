//! `open_url` validation: only plain http(s) web pages.

use url::Url;

use super::ToolError;

const MAX_LEN: usize = 2048;

/// Turn what the model gave us into a safe, absolute http(s) URL.
///
/// * "x.com/elonmusk" → "https://x.com/elonmusk" (missing scheme gets https)
/// * rejects `file:`, `javascript:`, `ms-settings:`, custom app schemes, etc.
/// * rejects URLs with embedded credentials (`https://user:pw@host`)
pub fn normalise(raw: &str) -> Result<String, ToolError> {
    let raw = raw.trim();
    if raw.len() > MAX_LEN {
        return Err(ToolError("that URL is too long".into()));
    }
    let lower = raw.to_ascii_lowercase();
    let has_scheme = lower.starts_with("http://") || lower.starts_with("https://");
    // "localhost:3000" or "x.com/a" have no scheme; anything else with
    // "something:" in front is a non-web scheme we refuse.
    let candidate = if has_scheme {
        raw.to_string()
    } else if looks_like_other_scheme(raw) {
        return Err(ToolError("only http:// and https:// web pages can be opened".into()));
    } else {
        format!("https://{raw}")
    };
    let url = Url::parse(&candidate).map_err(|e| ToolError(format!("that isn't a valid web address ({e})")))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(ToolError("only http:// and https:// web pages can be opened".into()));
    }
    match url.host_str() {
        Some(h) if !h.is_empty() => {}
        _ => return Err(ToolError("that web address has no website name".into())),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ToolError("web addresses with a username or password are not allowed".into()));
    }
    Ok(url.to_string())
}

/// Local-network targets (router admin pages, dev servers, NAS...): opening
/// them can trigger actions via GET, so they need the user's OK.
pub fn is_private_host(url: &str) -> bool {
    use std::net::IpAddr;
    let Ok(u) = Url::parse(url) else { return true };
    match u.host() {
        None => true,
        Some(url::Host::Domain(d)) => {
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            d == "localhost"
                || [".localhost", ".local", ".lan", ".internal", ".home.arpa", ".home"].iter().any(|s| d.ends_with(s))
                || !d.contains('.')
        }
        Some(url::Host::Ipv4(ip)) => {
            let ip = IpAddr::V4(ip);
            match ip {
                IpAddr::V4(v4) => v4.is_private() || v4.is_loopback() || v4.is_link_local() || v4.is_unspecified(),
                _ => unreachable!(),
            }
        }
        Some(url::Host::Ipv6(v6)) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || (v6.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}

/// `scheme:` prefix that is not followed by a port number, e.g. "mailto:a@b",
/// "javascript:alert(1)", "file:///C:/x", "C:\\Windows" (drive letter).
fn looks_like_other_scheme(s: &str) -> bool {
    let Some(colon) = s.find(':') else { return false };
    let (scheme, rest) = (&s[..colon], &s[colon + 1..]);
    let is_scheme = !scheme.is_empty()
        && scheme.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c));
    let port: String = rest.chars().take_while(|c| *c != '/').collect();
    let is_port = !port.is_empty() && port.chars().all(|c| c.is_ascii_digit());
    is_scheme && !scheme.contains('.') && !is_port
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_web_urls() {
        assert_eq!(normalise("https://x.com/elonmusk").unwrap(), "https://x.com/elonmusk");
        assert_eq!(normalise("http://example.com").unwrap(), "http://example.com/");
        assert_eq!(normalise("  HTTPS://Example.com/a?b=c  ").unwrap(), "https://example.com/a?b=c");
        assert_eq!(
            normalise("https://www.youtube.com/results?search_query=lofi beats").unwrap(),
            "https://www.youtube.com/results?search_query=lofi%20beats"
        );
    }

    #[test]
    fn adds_https_when_missing() {
        assert_eq!(normalise("x.com/elonmusk").unwrap(), "https://x.com/elonmusk");
        assert_eq!(normalise("twitter.com").unwrap(), "https://twitter.com/");
        assert_eq!(normalise("localhost:3000/app").unwrap(), "https://localhost:3000/app");
    }

    #[test]
    fn rejects_dangerous_or_non_web_schemes() {
        for bad in [
            "javascript:alert(1)",
            "file:///C:/Windows/System32/cmd.exe",
            "file:///etc/passwd",
            "C:\\Windows\\System32\\cmd.exe",
            "ms-settings:privacy",
            "mailto:someone@example.com",
            "vscode://file/x",
            "data:text/html,<script>alert(1)</script>",
            "ftp://example.com",
            "smb://server/share",
        ] {
            assert!(normalise(bad).is_err(), "should reject {bad}");
        }
    }

    #[test]
    fn private_hosts() {
        for p in [
            "http://localhost:3000/",
            "http://192.168.1.1/",
            "http://10.0.0.5/admin",
            "http://nas.local/",
            "http://[::1]/",
            "http://router/",
        ] {
            assert!(is_private_host(p), "{p}");
        }
        for p in ["https://x.com/elonmusk", "https://www.youtube.com/", "http://8.8.8.8/"] {
            assert!(!is_private_host(p), "{p}");
        }
    }

    #[test]
    fn rejects_credentials_empty_and_huge() {
        assert!(normalise("https://user:pw@example.com").is_err());
        assert!(normalise("https://").is_err());
        assert!(normalise(&format!("https://example.com/{}", "a".repeat(3000))).is_err());
    }
}
