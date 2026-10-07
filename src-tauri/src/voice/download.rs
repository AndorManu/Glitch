//! Downloading a speech model, safely:
//!
//! * streamed to `<file>.part` next to the final file,
//! * resumed with an HTTP `Range` request if an earlier try was cut off
//!   (the part file is kept on errors and on cancel),
//! * the server's size is sanity-checked before anything is written (an HTML
//!   error page or a wrong file is refused early),
//! * the finished file must match the official SHA-1, and only then is it
//!   renamed into place. So a model file that exists is always complete.

use std::fmt;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use reqwest::header::{CONTENT_RANGE, RANGE};
use reqwest::StatusCode;
use tokio::io::AsyncWriteExt;

/// What the finished file must look like.
pub struct Expected<'a> {
    pub sha1: &'a str,
    /// Approximate size; the server's answer must be within [`SIZE_TOLERANCE`].
    pub size: u64,
}

/// The server's size may differ this much (fraction) from the expected one.
const SIZE_TOLERANCE: f64 = 0.05;
/// No data for this long counts as a dropped connection.
const STALL_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, PartialEq)]
pub enum DownloadError {
    /// Couldn't connect, or the connection dropped (the part file is kept).
    Offline(String),
    /// The server answered with an error status.
    Http(u16),
    /// The server's file isn't the size we expect.
    BadSize {
        expected: u64,
        got: u64,
    },
    /// The download finished but doesn't match the official checksum.
    Checksum,
    Cancelled,
    /// Writing the file failed (disk full, no permission, ...).
    Disk(String),
}

impl DownloadError {
    /// Stable code for the UI.
    pub fn code(&self) -> &'static str {
        match self {
            DownloadError::Offline(_) => "download_offline",
            DownloadError::Http(_) => "download_http",
            DownloadError::BadSize { .. } | DownloadError::Checksum => "download_corrupt",
            DownloadError::Cancelled => "download_cancelled",
            DownloadError::Disk(_) => "download_disk",
        }
    }
}

impl fmt::Display for DownloadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DownloadError::Offline(e) => write!(f, "couldn't reach the download server ({e})"),
            DownloadError::Http(s) => write!(f, "the download server answered with error {s}"),
            DownloadError::BadSize { expected, got } => {
                write!(f, "the server's file has the wrong size ({got} bytes, expected about {expected})")
            }
            DownloadError::Checksum => write!(f, "the downloaded file was damaged (checksum mismatch)"),
            DownloadError::Cancelled => write!(f, "download cancelled"),
            DownloadError::Disk(e) => write!(f, "couldn't save the file ({e})"),
        }
    }
}

fn disk(e: std::io::Error) -> DownloadError {
    DownloadError::Disk(e.to_string())
}

fn offline(e: reqwest::Error) -> DownloadError {
    DownloadError::Offline(e.to_string())
}

pub fn part_path(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().unwrap_or_default().to_os_string();
    name.push(".part");
    dest.with_file_name(name)
}

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .user_agent(concat!("Glitch/", env!("CARGO_PKG_VERSION")))
        .build()
        .unwrap_or_default()
}

/// "bytes 100-199/1000" → (100, 1000).
fn parse_content_range(v: &str) -> Option<(u64, u64)> {
    let rest = v.trim().strip_prefix("bytes ")?;
    let (range, total) = rest.split_once('/')?;
    let (start, _end) = range.split_once('-')?;
    Some((start.trim().parse().ok()?, total.trim().parse().ok()?))
}

fn size_ok(got: u64, expected: u64) -> bool {
    (got as f64 - expected as f64).abs() <= expected as f64 * SIZE_TOLERANCE
}

/// SHA-1 of the first part of a file (to continue hashing after a resume).
fn hash_existing(path: &Path, hasher: &mut sha1_smol::Sha1) -> std::io::Result<u64> {
    let mut f = std::fs::File::open(path)?;
    let mut buf = vec![0u8; 1 << 16];
    let mut n = 0u64;
    loop {
        let k = f.read(&mut buf)?;
        if k == 0 {
            return Ok(n);
        }
        hasher.update(&buf[..k]);
        n += k as u64;
    }
}

/// Download `url` to `dest`. `progress(done, total)` is called for every
/// chunk (the caller throttles). Setting `cancel` stops at the next chunk.
pub async fn download(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    expected: &Expected<'_>,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64, u64),
) -> Result<(), DownloadError> {
    if let Some(dir) = dest.parent() {
        tokio::fs::create_dir_all(dir).await.map_err(disk)?;
    }
    let part = part_path(dest);
    // Two tries: if the server can't resume what we have, start over once.
    for attempt in 0..2 {
        let mut hasher = sha1_smol::Sha1::new();
        let mut have = match tokio::fs::metadata(&part).await {
            Ok(m) if attempt == 0 && m.len() > 0 && m.len() < expected.size + expected.size / 10 => {
                let p = part.clone();
                let (n, h) = tokio::task::spawn_blocking(move || {
                    let mut h = sha1_smol::Sha1::new();
                    hash_existing(&p, &mut h).map(|n| (n, h))
                })
                .await
                .map_err(|e| DownloadError::Disk(e.to_string()))?
                .map_err(disk)?;
                hasher = h;
                n
            }
            _ => 0,
        };

        let mut req = client.get(url);
        if have > 0 {
            req = req.header(RANGE, format!("bytes={have}-"));
        }
        let mut resp = req.send().await.map_err(offline)?;
        let status = resp.status();
        let total = match status {
            StatusCode::PARTIAL_CONTENT if have > 0 => {
                match resp.headers().get(CONTENT_RANGE).and_then(|v| v.to_str().ok()).and_then(parse_content_range) {
                    Some((start, total)) if start == have => total,
                    // A range we didn't ask for: start over.
                    _ => {
                        let _ = tokio::fs::remove_file(&part).await;
                        continue;
                    }
                }
            }
            StatusCode::OK => {
                // Fresh download, or the server ignored our Range header.
                have = 0;
                hasher = sha1_smol::Sha1::new();
                resp.content_length().unwrap_or(0)
            }
            StatusCode::RANGE_NOT_SATISFIABLE if have > 0 => {
                // Our part file is as long as (or longer than) the file: it is
                // complete or junk. The checksum decides; else start over.
                if hasher.digest().to_string() == expected.sha1 {
                    progress(have, have);
                    return finish(&part, dest).await;
                }
                let _ = tokio::fs::remove_file(&part).await;
                continue;
            }
            s => return Err(DownloadError::Http(s.as_u16())),
        };
        if !size_ok(total, expected.size) {
            return Err(DownloadError::BadSize { expected: expected.size, got: total });
        }

        let mut file = if have > 0 {
            tokio::fs::OpenOptions::new().append(true).open(&part).await.map_err(disk)?
        } else {
            tokio::fs::File::create(&part).await.map_err(disk)?
        };
        progress(have, total);
        loop {
            if cancel.load(Ordering::Relaxed) {
                let _ = file.flush().await;
                return Err(DownloadError::Cancelled);
            }
            let chunk = match tokio::time::timeout(STALL_TIMEOUT, resp.chunk()).await {
                Ok(Ok(Some(c))) => c,
                Ok(Ok(None)) => break,
                Ok(Err(e)) => {
                    let _ = file.flush().await;
                    return Err(offline(e));
                }
                Err(_) => {
                    let _ = file.flush().await;
                    return Err(DownloadError::Offline("no data for 30 seconds".into()));
                }
            };
            if have + chunk.len() as u64 > total {
                let _ = tokio::fs::remove_file(&part).await;
                return Err(DownloadError::BadSize { expected: total, got: have + chunk.len() as u64 });
            }
            file.write_all(&chunk).await.map_err(disk)?;
            hasher.update(&chunk);
            have += chunk.len() as u64;
            progress(have, total);
        }
        file.flush().await.map_err(disk)?;
        file.sync_all().await.map_err(disk)?;
        drop(file);
        if have < total {
            // The connection ended early: keep what we have for next time.
            return Err(DownloadError::Offline("the connection was interrupted".into()));
        }
        if hasher.digest().to_string() != expected.sha1 {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(DownloadError::Checksum);
        }
        return finish(&part, dest).await;
    }
    Err(DownloadError::Offline("the server couldn't continue the download".into()))
}

async fn finish(part: &Path, dest: &Path) -> Result<(), DownloadError> {
    tokio::fs::rename(part, dest).await.map_err(disk)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use wiremock::matchers::{header, header_exists, method, path};
    use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

    use super::*;

    fn body(n: usize) -> Vec<u8> {
        (0..n).map(|i| (i * 7 % 251) as u8).collect()
    }

    fn sha1(b: &[u8]) -> String {
        sha1_smol::Sha1::from(b).digest().to_string()
    }

    /// Serves `data`, honouring `Range: bytes=N-` like Hugging Face does.
    struct RangeServer(Vec<u8>);
    impl Respond for RangeServer {
        fn respond(&self, req: &Request) -> ResponseTemplate {
            let total = self.0.len();
            match req.headers.get("range").and_then(|v| v.to_str().ok()) {
                Some(r) => {
                    let start: usize = r.trim_start_matches("bytes=").trim_end_matches('-').parse().unwrap();
                    if start >= total {
                        return ResponseTemplate::new(416);
                    }
                    ResponseTemplate::new(206)
                        .insert_header("content-range", format!("bytes {start}-{}/{total}", total - 1))
                        .set_body_bytes(self.0[start..].to_vec())
                }
                None => ResponseTemplate::new(200).set_body_bytes(self.0.clone()),
            }
        }
    }

    async fn server(data: &[u8]) -> MockServer {
        let s = MockServer::start().await;
        Mock::given(method("GET")).and(path("/ggml-test.bin")).respond_with(RangeServer(data.to_vec())).mount(&s).await;
        s
    }

    async fn run(s: &MockServer, dest: &Path, exp: &Expected<'_>) -> (Result<(), DownloadError>, Vec<(u64, u64)>) {
        let seen = Mutex::new(vec![]);
        let r =
            download(&client(), &format!("{}/ggml-test.bin", s.uri()), dest, exp, &AtomicBool::new(false), |d, t| {
                seen.lock().unwrap().push((d, t))
            })
            .await;
        (r, seen.into_inner().unwrap())
    }

    #[tokio::test]
    async fn downloads_checks_and_renames() {
        let data = body(300_000);
        let s = server(&data).await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("models/ggml-test.bin");
        let sum = sha1(&data);
        let (r, seen) = run(&s, &dest, &Expected { sha1: &sum, size: data.len() as u64 }).await;
        r.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), data);
        assert!(!part_path(&dest).exists());
        assert_eq!(seen.first(), Some(&(0, 300_000)));
        assert_eq!(seen.last(), Some(&(300_000, 300_000)));
        assert!(seen.windows(2).all(|w| w[0].0 <= w[1].0));
    }

    #[tokio::test]
    async fn resumes_a_partial_download() {
        let data = body(200_000);
        let s = MockServer::start().await;
        // Only a Range request is answered: proves we resumed.
        Mock::given(method("GET"))
            .and(header("range", "bytes=120000-"))
            .respond_with(RangeServer(data.clone()))
            .expect(1)
            .mount(&s)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("ggml-test.bin");
        std::fs::write(part_path(&dest), &data[..120_000]).unwrap();
        let sum = sha1(&data);
        let (r, seen) = run(&s, &dest, &Expected { sha1: &sum, size: 200_000 }).await;
        r.unwrap();
        assert_eq!(seen.first(), Some(&(120_000, 200_000)));
        assert_eq!(std::fs::read(&dest).unwrap(), data);
    }

    #[tokio::test]
    async fn starts_over_if_the_server_ignores_range() {
        let data = body(50_000);
        let s = MockServer::start().await;
        Mock::given(method("GET"))
            .and(header_exists("range"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(data.clone()))
            .mount(&s)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("ggml-test.bin");
        std::fs::write(part_path(&dest), b"garbage that is not the start of the file").unwrap();
        let sum = sha1(&data);
        let (r, _) = run(&s, &dest, &Expected { sha1: &sum, size: 50_000 }).await;
        r.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), data);
    }

    #[tokio::test]
    async fn complete_part_file_is_just_checked() {
        let data = body(10_000);
        let s = server(&data).await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("ggml-test.bin");
        // Part file already complete (crash right before the rename): 416.
        std::fs::write(part_path(&dest), &data).unwrap();
        let sum = sha1(&data);
        let (r, _) = run(&s, &dest, &Expected { sha1: &sum, size: 10_000 }).await;
        r.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), data);
    }

    #[tokio::test]
    async fn wrong_size_is_refused_before_writing() {
        let s = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_string("<html>Not the model you're looking for</html>"))
            .mount(&s)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("ggml-test.bin");
        let (r, _) = run(&s, &dest, &Expected { sha1: &"0".repeat(40), size: 147_951_465 }).await;
        assert!(matches!(r, Err(DownloadError::BadSize { expected: 147_951_465, .. })), "{r:?}");
        assert_eq!(r.unwrap_err().code(), "download_corrupt");
        assert!(!dest.exists());
        assert!(!part_path(&dest).exists());
    }

    #[tokio::test]
    async fn bad_checksum_deletes_the_file() {
        let data = body(20_000);
        let s = server(&data).await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("ggml-test.bin");
        let (r, _) = run(&s, &dest, &Expected { sha1: &sha1(b"something else"), size: 20_000 }).await;
        assert_eq!(r, Err(DownloadError::Checksum));
        assert!(!dest.exists());
        assert!(!part_path(&dest).exists());
    }

    #[tokio::test]
    async fn http_errors_and_offline() {
        let s = MockServer::start().await;
        Mock::given(method("GET")).respond_with(ResponseTemplate::new(404)).mount(&s).await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("ggml-test.bin");
        let exp = Expected { sha1: "x", size: 1 };
        assert_eq!(run(&s, &dest, &exp).await.0, Err(DownloadError::Http(404)));

        // Nothing listening on this port.
        let closed = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let r = download(
            &client(),
            &format!("http://127.0.0.1:{closed}/x"),
            &dest,
            &exp,
            &AtomicBool::new(false),
            |_, _| {},
        )
        .await;
        assert!(matches!(r, Err(DownloadError::Offline(_))), "{r:?}");
        assert_eq!(r.unwrap_err().code(), "download_offline");
    }

    #[tokio::test]
    async fn cancel_keeps_the_part_for_later() {
        let data = body(400_000);
        let s = server(&data).await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("ggml-test.bin");
        let cancel = AtomicBool::new(false);
        let sum = sha1(&data);
        let exp = Expected { sha1: &sum, size: 400_000 };
        let url = format!("{}/ggml-test.bin", s.uri());
        let r = download(&client(), &url, &dest, &exp, &cancel, |done, _| {
            if done > 0 {
                cancel.store(true, Ordering::Relaxed);
            }
        })
        .await;
        assert_eq!(r, Err(DownloadError::Cancelled));
        assert!(!dest.exists());
        let kept = std::fs::metadata(part_path(&dest)).unwrap().len();
        assert!(kept > 0 && kept < 400_000, "{kept}");
        // ...and the next try picks up from there.
        cancel.store(false, Ordering::Relaxed);
        download(&client(), &url, &dest, &exp, &cancel, |_, _| {}).await.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), data);
    }

    #[test]
    fn content_range() {
        assert_eq!(parse_content_range("bytes 100-199/1000"), Some((100, 1000)));
        assert_eq!(parse_content_range("bytes */1000"), None);
        assert_eq!(parse_content_range("items 1-2/3"), None);
        assert_eq!(part_path(Path::new("/a/ggml-base.bin")), Path::new("/a/ggml-base.bin.part"));
    }
}
