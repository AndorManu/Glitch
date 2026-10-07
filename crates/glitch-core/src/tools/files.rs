//! `search_files`: find files by name in the user's standard folders.
//!
//! Read-only and bounded: limited depth, number of entries visited and wall
//! time, so a search can never hog the disk/CPU for long. It only looks at
//! file *names*; it cannot see what is inside a photo or document.

use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;
use walkdir::WalkDir;

use super::ToolError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Any,
    Image,
    Document,
    Video,
    Audio,
    Folder,
}

impl Kind {
    pub const NAMES: [&'static str; 6] = ["any", "image", "document", "video", "audio", "folder"];

    pub fn parse(s: &str) -> Option<Kind> {
        Some(match s.trim().to_lowercase().as_str() {
            "any" | "" => Kind::Any,
            "image" | "photo" | "picture" => Kind::Image,
            "document" | "doc" => Kind::Document,
            "video" => Kind::Video,
            "audio" | "music" => Kind::Audio,
            "folder" | "directory" => Kind::Folder,
            _ => return None,
        })
    }

    fn label(self) -> &'static str {
        Self::NAMES[self as usize]
    }

    fn extensions(self) -> &'static [&'static str] {
        match self {
            Kind::Image => &[
                "jpg", "jpeg", "png", "gif", "heic", "heif", "webp", "bmp", "tif", "tiff", "raw", "cr2", "nef", "arw",
                "dng", "svg",
            ],
            Kind::Document => &[
                "pdf", "doc", "docx", "odt", "rtf", "txt", "md", "pages", "xls", "xlsx", "ods", "csv", "numbers",
                "ppt", "pptx", "odp", "key", "epub",
            ],
            Kind::Video => &["mp4", "mov", "m4v", "avi", "mkv", "webm", "wmv", "flv", "3gp"],
            Kind::Audio => &["mp3", "m4a", "wav", "flac", "aac", "ogg", "opus", "wma", "aiff", "aif"],
            Kind::Any | Kind::Folder => &[],
        }
    }

    /// `ext` must be lower-case.
    pub fn has_extension(self, ext: &str) -> bool {
        self.extensions().contains(&ext)
    }

    fn matches(self, path: &Path, is_dir: bool) -> bool {
        match self {
            Kind::Any => true,
            Kind::Folder => is_dir,
            k => {
                !is_dir
                    && path
                        .extension()
                        .and_then(|e| e.to_str())
                        .is_some_and(|e| k.extensions().contains(&e.to_lowercase().as_str()))
            }
        }
    }
}

/// Words that describe the *kind* of file rather than its name
/// ("a photo of a dog" → just "dog").
const FILLER: &[&str] = &[
    "a",
    "an",
    "the",
    "of",
    "my",
    "me",
    "with",
    "and",
    "file",
    "files",
    "photo",
    "photos",
    "picture",
    "pictures",
    "pic",
    "pics",
    "image",
    "images",
    "document",
    "documents",
    "doc",
    "docs",
    "video",
    "videos",
    "song",
    "songs",
    "music",
    "folder",
    "folders",
    "find",
];

#[derive(Debug, Clone, PartialEq)]
pub struct Query {
    pub words: Vec<String>,
    pub kind: Kind,
}

impl Query {
    pub fn new(text: &str, kind: Kind) -> Result<Query, ToolError> {
        let words: Vec<String> = text
            .split(|c: char| c.is_whitespace() || c == ',' || c == '*')
            .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase())
            .filter(|w| !w.is_empty() && !FILLER.contains(&w.as_str()))
            .collect();
        if words.is_empty() && kind == Kind::Any {
            return Err(ToolError("tell me part of the file name to search for".into()));
        }
        Ok(Query { words, kind })
    }

    /// "dog", or "anything" when only a kind was given.
    pub fn words_text(&self) -> String {
        if self.words.is_empty() {
            "anything".to_string()
        } else {
            self.words.join(" ")
        }
    }

    /// "" or e.g. " (images only)".
    pub fn kind_suffix(&self) -> String {
        match self.kind {
            Kind::Any => String::new(),
            k => format!(" ({}s only)", k.label()),
        }
    }

    fn matches(&self, path: &Path, is_dir: bool) -> bool {
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else { return false };
        let name = name.to_lowercase();
        self.kind.matches(path, is_dir) && self.words.iter().all(|w| name.contains(w.as_str()))
    }
}

#[derive(Debug, Clone)]
pub struct Limits {
    pub max_depth: usize,
    pub max_visited: usize,
    pub max_results: usize,
    pub time_budget: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self { max_depth: 8, max_visited: 200_000, max_results: 15, time_budget: Duration::from_secs(4) }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Hit {
    pub path: PathBuf,
    pub name: String,
    pub is_folder: bool,
    /// Seconds since the Unix epoch (for "newest first").
    #[serde(skip)]
    pub modified: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SearchResult {
    pub hits: Vec<Hit>,
    /// True if a limit stopped the search early.
    pub truncated: bool,
}

/// Folders that are huge, hidden or app-internal: never worth searching.
fn skip_dir(name: &str) -> bool {
    name.starts_with('.')
        || name.starts_with('$')
        || matches!(
            name,
            "node_modules" | "AppData" | "Library" | "__pycache__" | "venv" | "target" | "Caches" | "System Volume Information"
        )
        // macOS app bundles and photo libraries are folders, but opaque to users.
        || [".app", ".photoslibrary", ".musiclibrary", ".bundle", ".framework"].iter().any(|s| name.ends_with(s))
}

/// Drop roots that are inside another root (e.g. Desktop inside a
/// OneDrive-redirected Documents), so nothing is walked twice.
fn distinct_roots(roots: &[PathBuf]) -> Vec<&PathBuf> {
    roots
        .iter()
        .enumerate()
        .filter(|(i, r)| !roots.iter().enumerate().any(|(j, o)| j != *i && r.starts_with(o) && (o != *r || j < *i)))
        .map(|(_, r)| r)
        .collect()
}

pub fn search(query: &Query, roots: &[PathBuf], limits: &Limits) -> SearchResult {
    let started = Instant::now();
    let mut visited = 0usize;
    let mut truncated = false;
    // Min-heap of the newest `max_results` hits: memory stays tiny and
    // nothing is sorted until the end, however many files match.
    let mut best: BinaryHeap<Reverse<(u64, Reverse<PathBuf>, bool)>> = BinaryHeap::new();

    'roots: for root in distinct_roots(roots) {
        let walker = WalkDir::new(root)
            .min_depth(1)
            .max_depth(limits.max_depth)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| !(e.file_type().is_dir() && e.file_name().to_str().is_some_and(skip_dir)));
        for entry in walker.filter_map(Result::ok) {
            visited += 1;
            if visited > limits.max_visited || (visited.is_multiple_of(256) && started.elapsed() > limits.time_budget) {
                truncated = true;
                break 'roots;
            }
            let is_dir = entry.file_type().is_dir();
            if !query.matches(entry.path(), is_dir) {
                continue;
            }
            let modified = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_secs());
            best.push(Reverse((modified, Reverse(entry.path().to_path_buf()), is_dir)));
            if best.len() > limits.max_results {
                best.pop(); // drop the oldest
            }
        }
    }
    let mut hits: Vec<Hit> = best
        .into_iter()
        .map(|Reverse((modified, Reverse(path), is_folder))| Hit {
            name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            path,
            is_folder,
            modified,
        })
        .collect();
    hits.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.path.cmp(&b.path)));
    SearchResult { hits, truncated }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(files: &[&str]) -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        for f in files {
            let p = d.path().join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            if f.ends_with('/') {
                std::fs::create_dir_all(&p).unwrap();
            } else {
                std::fs::write(&p, b"x").unwrap();
            }
        }
        d
    }

    fn names(r: &SearchResult) -> Vec<String> {
        let mut v: Vec<String> = r.hits.iter().map(|h| h.name.clone()).collect();
        v.sort();
        v
    }

    #[test]
    fn query_drops_filler_words() {
        let q = Query::new("a photo of my dog", Kind::Image).unwrap();
        assert_eq!(q.words, ["dog"]);
        assert!(Query::new("the file", Kind::Any).is_err());
        assert!(Query::new("photo", Kind::Image).unwrap().words.is_empty()); // "latest photos" is fine
    }

    #[test]
    fn finds_by_name_and_kind() {
        let d = tree(&[
            "Pictures/Dog_beach.JPG",
            "Pictures/cat.png",
            "Documents/dog-care.pdf",
            "Pictures/old/dogs/",
            "Pictures/old/dogs/x.png",
        ]);
        let roots = [d.path().to_path_buf()];
        let r = search(&Query::new("dog", Kind::Image).unwrap(), &roots, &Limits::default());
        assert_eq!(names(&r), ["Dog_beach.JPG"]);
        let r = search(&Query::new("dog", Kind::Any).unwrap(), &roots, &Limits::default());
        assert_eq!(names(&r), ["Dog_beach.JPG", "dog-care.pdf", "dogs"]);
        let r = search(&Query::new("dog", Kind::Folder).unwrap(), &roots, &Limits::default());
        assert_eq!(names(&r), ["dogs"]);
        assert!(r.hits[0].is_folder);
    }

    #[test]
    fn all_words_must_match() {
        let d = tree(&["tax return 2024.pdf", "tax 2023.pdf"]);
        let r = search(&Query::new("tax 2024", Kind::Document).unwrap(), &[d.path().into()], &Limits::default());
        assert_eq!(names(&r), ["tax return 2024.pdf"]);
    }

    #[test]
    fn skips_hidden_and_heavy_folders() {
        let d = tree(&[
            ".secret/dog.jpg",
            "node_modules/dog.jpg",
            "Library/dog.jpg",
            "Photos.photoslibrary/dog.jpg",
            "ok/dog.jpg",
        ]);
        let r = search(&Query::new("dog", Kind::Any).unwrap(), &[d.path().into()], &Limits::default());
        assert_eq!(r.hits.len(), 1);
        assert!(r.hits[0].path.ends_with("ok/dog.jpg"));
    }

    #[test]
    fn respects_limits() {
        let files: Vec<String> = (0..50).map(|i| format!("dog{i}.png")).collect();
        let refs: Vec<&str> = files.iter().map(String::as_str).collect();
        let d = tree(&refs);
        let roots = [d.path().to_path_buf()];
        let r = search(&Query::new("dog", Kind::Any).unwrap(), &roots, &Limits { max_results: 5, ..Limits::default() });
        assert_eq!(r.hits.len(), 5);
        assert!(!r.truncated);
        let r =
            search(&Query::new("dog", Kind::Any).unwrap(), &roots, &Limits { max_visited: 10, ..Limits::default() });
        assert!(r.truncated);
        let deep = tree(&["a/b/c/d/dog.png"]);
        let r = search(
            &Query::new("dog", Kind::Any).unwrap(),
            &[deep.path().into()],
            &Limits { max_depth: 3, ..Limits::default() },
        );
        assert!(r.hits.is_empty());
    }

    #[test]
    fn newest_first_and_no_duplicates_from_overlapping_roots() {
        let d = tree(&["old_dog.png", "sub/new_dog.png"]);
        let old = d.path().join("old_dog.png");
        let f = std::fs::File::options().write(true).open(&old).unwrap();
        f.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000)).unwrap();
        let roots = [d.path().to_path_buf(), d.path().join("sub")];
        let r = search(&Query::new("dog", Kind::Image).unwrap(), &roots, &Limits::default());
        let got: Vec<_> = r.hits.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(got, ["new_dog.png", "old_dog.png"]);
    }

    #[test]
    fn many_matches_stay_fast_and_keep_the_newest() {
        let d = tempfile::tempdir().unwrap();
        for i in 0..3000 {
            std::fs::write(d.path().join(format!("img{i:04}.png")), b"").unwrap();
        }
        let newest = d.path().join("img2999.png");
        let f = std::fs::File::options().write(true).open(&newest).unwrap();
        f.set_modified(SystemTime::now() + Duration::from_secs(3600)).unwrap();
        let t = Instant::now();
        let r = search(&Query::new("", Kind::Image).unwrap(), &[d.path().into()], &Limits::default());
        assert!(t.elapsed() < Duration::from_secs(2), "took {:?}", t.elapsed());
        assert_eq!(r.hits.len(), Limits::default().max_results);
        assert_eq!(r.hits[0].name, "img2999.png");
    }

    #[test]
    fn nested_roots_are_walked_once() {
        let roots = [PathBuf::from("/h/Documents"), PathBuf::from("/h/Documents/Desktop"), PathBuf::from("/h/Music")];
        assert_eq!(distinct_roots(&roots), [&roots[0], &roots[2]]);
        let dup = [PathBuf::from("/a"), PathBuf::from("/a")];
        assert_eq!(distinct_roots(&dup).len(), 1);
    }

    #[test]
    fn display_text() {
        assert_eq!(Query::new("dog", Kind::Any).unwrap().words_text(), "dog");
        assert_eq!(Query::new("dog", Kind::Image).unwrap().kind_suffix(), " (images only)");
        assert_eq!(Query::new("", Kind::Video).unwrap().words_text(), "anything");
    }
}
