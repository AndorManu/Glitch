//! `open_url` validation: only plain http(s) web pages.

use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

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

/// Public DNS names that point at whatever address is written in them
/// (`127.0.0.1.nip.io`, `192-168-1-1.sslip.io`) or always at loopback.
const LOOPBACK_DNS_SUFFIXES: &[&str] =
    &["nip.io", "sslip.io", "xip.io", "localtest.me", "lvh.me", "vcap.me", "lacolhost.com"];

/// Local-network targets (router admin pages, dev servers, NAS...): opening
/// them can trigger actions via GET, so they need the user's OK. This only
/// looks at the URL itself; [`reaches_private_network`] also resolves names.
///
/// IPv4 written as one number, in octal or in hex (`http://2130706433/`,
/// `http://0x7f.1/`) is parsed into a normal address by the `url` crate
/// first, so it is checked like `127.0.0.1`.
pub fn is_private_host(url: &str) -> bool {
    let Ok(u) = Url::parse(url) else { return true };
    match u.host() {
        None => true,
        Some(url::Host::Domain(d)) => {
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            d == "localhost"
                || [".localhost", ".local", ".lan", ".internal", ".home.arpa", ".home", ".intranet", ".corp"]
                    .iter()
                    .any(|s| d.ends_with(s))
                || LOOPBACK_DNS_SUFFIXES.iter().any(|s| d == *s || d.ends_with(&format!(".{s}")))
                || !d.contains('.')
        }
        Some(url::Host::Ipv4(ip)) => ip_is_local(IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => ip_is_local(IpAddr::V6(ip)),
    }
}

/// [`is_private_host`], and also a host name that resolves to a local
/// address (an attacker's own domain pointing at 192.168.1.1) or that can't
/// be resolved at all (it might only exist on the local network).
pub fn reaches_private_network(url: &str, resolve: impl FnOnce(&str) -> io::Result<Vec<IpAddr>>) -> bool {
    if is_private_host(url) {
        return true;
    }
    let Ok(u) = Url::parse(url) else { return true };
    match u.host() {
        Some(url::Host::Domain(d)) => match resolve(d.trim_end_matches('.')) {
            Ok(ips) if !ips.is_empty() => ips.into_iter().any(ip_is_local),
            _ => true,
        },
        _ => false,
    }
}

/// Anything that is not an ordinary public internet address: private,
/// loopback, link-local, CGNAT (Tailscale), benchmarking, documentation,
/// multicast, reserved, and IPv6 forms that carry such an IPv4 address.
pub fn ip_is_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4_is_local(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = embedded_v4(v6) {
                return v4_is_local(v4);
            }
            let s = v6.segments();
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00 // unique local fc00::/7
                || (s[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
                || (s[0] & 0xffc0) == 0xfec0 // old site-local fec0::/10
                || (s[0] == 0x2001 && s[1] == 0x0db8) // documentation
                || (s[0] == 0x2001 && s[1] == 0) // Teredo: tunnels to anything
                || (s[0] == 0x0100 && s[1..4] == [0, 0, 0]) // discard-only 100::/64
        }
    }
}

fn v4_is_local(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || a == 0 // "this network" 0.0.0.0/8
        || (a == 100 && (b & 0xc0) == 64) // CGNAT / Tailscale 100.64.0.0/10
        || (a == 192 && b == 0 && c == 0) // IETF protocol assignments 192.0.0.0/24
        || (a == 198 && (b & 0xfe) == 18) // benchmarking 198.18.0.0/15
        || a >= 240 // reserved 240.0.0.0/4
}

/// The IPv4 address inside an IPv4-mapped (`::ffff:a.b.c.d`), IPv4-compatible
/// (`::a.b.c.d`), NAT64 (`64:ff9b::a.b.c.d`) or 6to4 (`2002:aabb:ccdd::`) one.
fn embedded_v4(v6: Ipv6Addr) -> Option<Ipv4Addr> {
    if let Some(v4) = v6.to_ipv4_mapped() {
        return Some(v4);
    }
    let s = v6.segments();
    let tail = Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8);
    if s[..6] == [0; 6] && !v6.is_loopback() && !v6.is_unspecified() {
        return Some(tail); // IPv4-compatible
    }
    if s[0] == 0x64 && s[1] == 0xff9b && s[2..6] == [0; 4] {
        return Some(tail); // NAT64
    }
    if s[0] == 0x2002 {
        // 6to4
        return Some(Ipv4Addr::new((s[1] >> 8) as u8, s[1] as u8, (s[2] >> 8) as u8, s[2] as u8));
    }
    None
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
    fn private_hosts_in_disguise() {
        // Review 2026-10-08, M1. Checked on the normalised URL, as the gate does.
        for raw in [
            "http://[::ffff:192.168.1.1]/",
            "http://[::ffff:127.0.0.1]:8080/",
            "http://[::ffff:c0a8:101]/",
            "http://[::127.0.0.1]/",
            "http://[64:ff9b::10.0.0.1]/",
            "http://[2002:c0a8:0101::1]/",
            "http://[fec0::1]/",
            "http://100.64.0.1/",
            "http://100.100.100.100/",
            "http://0.1.2.3/",
            "http://198.18.0.1/",
            "http://192.0.0.8/",
            "http://255.255.255.255/",
            "http://240.0.0.1/",
            "http://224.0.0.1/",
            // One number, octal, hex and short forms of 127.0.0.1 / 192.168.1.1.
            "http://2130706433/",
            "http://017700000001/",
            "http://0x7f000001/",
            "http://0x7f.1/",
            "http://0177.0.0.1/",
            "http://127.1/",
            "http://3232235777/",
            "http://0xc0.0xa8.1.1/",
            // Public names that point at the address written in them.
            "http://127.0.0.1.nip.io/",
            "http://192-168-1-1.sslip.io/apply.cgi?x=1",
            "http://localtest.me/",
            "http://app.lvh.me:3000/",
            "http://localhost./",
        ] {
            let url = normalise(raw).unwrap();
            assert!(is_private_host(&url), "{raw} -> {url}");
        }
        for p in ["http://100.128.0.1/", "http://[2606:4700::1111]/", "http://[::ffff:8.8.8.8]/", "http://1.1.1.1/"] {
            assert!(!is_private_host(&normalise(p).unwrap()), "{p}");
        }
    }

    #[test]
    fn names_are_resolved_before_counting_as_public() {
        let public = |_: &str| Ok(vec![IpAddr::from([93, 184, 215, 14])]);
        assert!(!reaches_private_network("https://example.com/", public));
        // An attacker's own domain pointing at the router or at loopback.
        let router = |_: &str| Ok(vec![IpAddr::from([93, 184, 215, 14]), IpAddr::from([192, 168, 1, 1])]);
        assert!(reaches_private_network("https://evil.example/", router));
        let mapped = |_: &str| Ok(vec!["::ffff:127.0.0.1".parse().unwrap()]);
        assert!(reaches_private_network("https://evil.example/", mapped));
        // Names that don't resolve might only exist on the local network.
        let fails = |_: &str| Err(io::Error::new(io::ErrorKind::NotFound, "nope"));
        assert!(reaches_private_network("https://intranet.example/", fails));
        assert!(reaches_private_network("https://nothing.example/", |_: &str| Ok(vec![])));
        // Literal addresses are never looked up.
        let never = |h: &str| -> io::Result<Vec<IpAddr>> { panic!("looked up {h}") };
        assert!(!reaches_private_network("http://8.8.8.8/", never));
        assert!(reaches_private_network("http://[::ffff:10.0.0.1]/", never));
    }

    #[test]
    fn rejects_credentials_empty_and_huge() {
        assert!(normalise("https://user:pw@example.com").is_err());
        assert!(normalise("https://").is_err());
        assert!(normalise(&format!("https://example.com/{}", "a".repeat(3000))).is_err());
    }
}
