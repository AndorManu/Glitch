//! Voice commands: the pure, testable half.
//!
//! The app shell (`src-tauri/src/voice/`) records the microphone (cpal) and
//! runs whisper.cpp; everything that can be decided without a microphone or
//! a model lives here so it is unit-tested headlessly:
//!
//! * [`audio`]: mono mix-down, resampling to 16 kHz, trimming and padding
//! * [`vad`]: a tiny energy-based voice detector (auto-stop on silence)
//! * [`transcript`]: cleaning up whisper output
//! * [`models`]: which speech model to use, where to download it from
//! * [`languages`](LANGUAGES): the language setting
//!
//! Push-to-talk only: nothing records unless the user holds the mic button or
//! the hotkey (or taps it for one hands-free sentence).

pub mod audio;
pub mod models;
pub mod transcript;
pub mod vad;

/// Whisper wants 16 kHz mono f32.
pub const SAMPLE_RATE: u32 = 16_000;

/// Language setting values: "auto" (detect) or an ISO 639-1 code whisper knows.
/// Labels are shown in Settings → Voice.
pub const LANGUAGES: &[(&str, &str)] = &[
    ("auto", "Detect automatically"),
    ("en", "English"),
    ("de", "Deutsch"),
    ("fr", "Français"),
    ("es", "Español"),
    ("it", "Italiano"),
    ("pt", "Português"),
    ("nl", "Nederlands"),
    ("pl", "Polski"),
    ("hu", "Magyar"),
    ("cs", "Čeština"),
    ("ro", "Română"),
    ("sv", "Svenska"),
    ("da", "Dansk"),
    ("no", "Norsk"),
    ("fi", "Suomi"),
    ("el", "Ελληνικά"),
    ("tr", "Türkçe"),
    ("uk", "Українська"),
    ("ru", "Русский"),
    ("ar", "العربية"),
    ("hi", "हिन्दी"),
    ("ja", "日本語"),
    ("ko", "한국어"),
    ("zh", "中文"),
];

pub fn valid_language(code: &str) -> bool {
    LANGUAGES.iter().any(|(c, _)| *c == code)
}

/// What to pass to whisper: `None` = auto-detect.
pub fn whisper_language(setting: &str) -> Option<&'static str> {
    LANGUAGES.iter().find(|(c, _)| *c == setting && *c != "auto").map(|(c, _)| *c)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn languages() {
        assert!(valid_language("auto"));
        assert!(valid_language("hu"));
        assert!(!valid_language("xx"));
        assert!(!valid_language(""));
        assert_eq!(whisper_language("auto"), None);
        assert_eq!(whisper_language("de"), Some("de"));
        // Unknown values (e.g. a hand-edited settings file) fall back to auto.
        assert_eq!(whisper_language("klingon"), None);
        let mut codes: Vec<_> = LANGUAGES.iter().map(|(c, _)| c).collect();
        codes.sort();
        codes.dedup();
        assert_eq!(codes.len(), LANGUAGES.len());
    }
}
