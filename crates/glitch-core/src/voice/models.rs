//! Speech-to-text models (whisper.cpp "ggml" files) and which one to use.
//!
//! Files are the official ones from the whisper.cpp project on Hugging Face.
//! SHA-256 checksums are the Git LFS object ids of these files on Hugging
//! Face (a finished download must match exactly); byte sizes are as listed on Hugging Face and
//! are only used for the UI and a sanity check of the server's answer.
//! All three are multilingual. To change the choice, edit [`MODELS`].

use serde::Serialize;

pub const DEFAULT_BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct SpeechModel {
    /// Setting value: "tiny", "base" or "small".
    pub id: &'static str,
    pub label: &'static str,
    /// Short description for Settings → Voice.
    pub blurb: &'static str,
    /// File name on the server and on disk.
    pub file: &'static str,
    /// Download size in bytes (approximate: the SHA-256 is what's checked).
    pub size_bytes: u64,
    /// Lower-case hex SHA-256 of the file.
    #[serde(skip)]
    pub sha256: &'static str,
}

impl SpeechModel {
    /// Megabytes (MiB, rounded up like the whisper.cpp docs), for the UI.
    pub fn size_mb(&self) -> u64 {
        self.size_bytes.div_ceil(1 << 20)
    }
}

pub const MODELS: &[SpeechModel] = &[
    SpeechModel {
        id: "tiny",
        label: "Tiny",
        blurb: "Fastest, fine for short commands",
        file: "ggml-tiny.bin",
        size_bytes: 77_691_713,
        sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
    },
    SpeechModel {
        id: "base",
        label: "Base",
        blurb: "Good balance (recommended)",
        file: "ggml-base.bin",
        size_bytes: 147_951_465,
        sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    },
    SpeechModel {
        id: "small",
        label: "Small",
        blurb: "Most accurate, slower and bigger",
        file: "ggml-small.bin",
        size_bytes: 487_601_967,
        sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    },
];

pub fn find(id: &str) -> Option<&'static SpeechModel> {
    MODELS.iter().find(|m| m.id == id)
}

const GIB: u64 = 1024 * 1024 * 1024;

/// Base on 8 GB machines and up, tiny below. The OS reports a bit less than
/// the sticker size (an "8 GB" PC shows ~7.6 GiB), hence the 7 GiB cut.
pub fn recommended(total_ram_bytes: u64) -> &'static SpeechModel {
    let id = if total_ram_bytes >= 7 * GIB { "base" } else { "tiny" };
    find(id).expect("model table has tiny and base")
}

/// The model to use: the user's choice if valid, otherwise the recommendation.
pub fn resolve(setting: Option<&str>, total_ram_bytes: u64) -> &'static SpeechModel {
    setting.and_then(find).unwrap_or_else(|| recommended(total_ram_bytes))
}

pub fn url(base: &str, model: &SpeechModel) -> String {
    format!("{}/{}", base.trim_end_matches('/'), model.file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_is_sane() {
        for m in MODELS {
            // SHA-256, not SHA-1 (review 2026-10-08, L5).
            assert_eq!(m.sha256.len(), 64, "{}", m.id);
            assert!(m.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
            assert_eq!(m.file, format!("ggml-{}.bin", m.id));
        }
        // Same numbers as whisper.cpp's models/README.md.
        assert_eq!(find("tiny").unwrap().size_mb(), 75);
        assert_eq!(find("base").unwrap().size_mb(), 142);
        assert_eq!(find("small").unwrap().size_mb(), 466);
        // Ordered small to big for the settings list.
        assert!(MODELS.windows(2).all(|w| w[0].size_bytes < w[1].size_bytes));
    }

    #[test]
    fn pick_by_ram() {
        assert_eq!(recommended(4 * GIB).id, "tiny");
        assert_eq!(recommended(6 * GIB).id, "tiny");
        // An "8 GB" machine as the OS reports it.
        assert_eq!(recommended(7_800_000_000).id, "base");
        assert_eq!(recommended(32 * GIB).id, "base");
    }

    #[test]
    fn resolve_setting() {
        assert_eq!(resolve(None, 16 * GIB).id, "base");
        assert_eq!(resolve(Some("small"), 4 * GIB).id, "small");
        assert_eq!(resolve(Some("tiny"), 64 * GIB).id, "tiny");
        assert_eq!(resolve(Some("huge"), 4 * GIB).id, "tiny");
    }

    #[test]
    fn urls() {
        let base = find("base").unwrap();
        assert_eq!(
            url(DEFAULT_BASE_URL, base),
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"
        );
        assert_eq!(url("http://127.0.0.1:9/m/", base), "http://127.0.0.1:9/m/ggml-base.bin");
    }
}
