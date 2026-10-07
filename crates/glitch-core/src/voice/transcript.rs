//! Clean up what whisper heard before it becomes a chat message.
//!
//! Whisper marks non-speech with brackets ("[BLANK_AUDIO]", "(music)",
//! "*laughs*", "♪"), sometimes adds subtitle-style dashes, and on near-silence
//! likes to invent YouTube outros ("Thanks for watching!"). None of that should
//! be sent to the model.

/// Phrases whisper invents on silence or noise (compared after lowercasing
/// and stripping punctuation). Only whole transcripts are dropped.
const HALLUCINATIONS: &[&str] = &[
    "thanks for watching",
    "thank you for watching",
    "thanks for watching and see you next time",
    "please subscribe",
    "subscribe to my channel",
    "like and subscribe",
    "subtitles by the amaraorg community",
    "you",
];

/// A cleaned transcript, or `None` if nothing usable was said.
pub fn clean(raw: &str) -> Option<String> {
    let mut out = String::with_capacity(raw.len());
    let mut depth_square = 0u32;
    let mut depth_round = 0u32;
    let mut in_star = false;
    for c in raw.chars() {
        match c {
            '[' => depth_square += 1,
            ']' => depth_square = depth_square.saturating_sub(1),
            '(' => depth_round += 1,
            ')' => depth_round = depth_round.saturating_sub(1),
            '*' => in_star = !in_star,
            '♪' | '♫' | '♬' | '\u{fffd}' => {}
            _ if depth_square == 0 && depth_round == 0 && !in_star => out.push(c),
            _ => {}
        }
        if matches!(c, ']' | ')' | '*') {
            out.push(' ');
        }
    }
    // Collapse whitespace (whisper segments each start with a space).
    let collapsed = out.split_whitespace().collect::<Vec<_>>().join(" ");
    // Subtitle markers and stray punctuation at the start.
    let text = collapsed
        .trim_start_matches(|c: char| c == '-' || c == '>' || c == '–' || c == ',' || c == '.' || c.is_whitespace())
        .trim();
    let text = text.trim_end_matches(|c: char| c == '-' || c == '–' || c == ',' || c.is_whitespace());

    if text.chars().filter(|c| c.is_alphanumeric()).count() < 2 {
        return None;
    }
    let key: String = text.to_lowercase().chars().filter(|c| c.is_alphanumeric() || *c == ' ').collect();
    if HALLUCINATIONS.contains(&key.trim()) {
        return None;
    }
    Some(text.to_string())
}

#[cfg(test)]
mod tests {
    use super::clean;

    #[test]
    fn keeps_normal_speech() {
        assert_eq!(clean(" Open YouTube.").as_deref(), Some("Open YouTube."));
        assert_eq!(
            clean(" What's the weather like?  In Berlin").as_deref(),
            Some("What's the weather like? In Berlin")
        );
        assert_eq!(clean("Öffne den Rechner").as_deref(), Some("Öffne den Rechner"));
        assert_eq!(clean("计算器").as_deref(), Some("计算器"));
        assert_eq!(clean("Thank you.").as_deref(), Some("Thank you."));
        assert_eq!(clean("OK").as_deref(), Some("OK"));
    }

    #[test]
    fn strips_annotations() {
        assert_eq!(clean("[BLANK_AUDIO]"), None);
        assert_eq!(clean(" [Music] (upbeat music) ♪♪"), None);
        assert_eq!(clean("(silence)"), None);
        assert_eq!(clean("[ Silence ]"), None);
        assert_eq!(clean("*laughs* open spotify").as_deref(), Some("open spotify"));
        assert_eq!(clean("open [inaudible] the calculator").as_deref(), Some("open the calculator"));
        assert_eq!(clean("Hello (coughs) there").as_deref(), Some("Hello there"));
    }

    #[test]
    fn strips_markers_and_junk() {
        assert_eq!(clean(" - Open the calculator").as_deref(), Some("Open the calculator"));
        assert_eq!(clean(">> open notes,").as_deref(), Some("open notes"));
        assert_eq!(clean(", . hi there").as_deref(), Some("hi there"));
    }

    #[test]
    fn drops_empty_and_tiny() {
        assert_eq!(clean(""), None);
        assert_eq!(clean("   "), None);
        assert_eq!(clean("."), None);
        assert_eq!(clean(" a."), None);
        assert_eq!(clean("..."), None);
    }

    #[test]
    fn drops_hallucinated_outros() {
        assert_eq!(clean(" Thanks for watching!"), None);
        assert_eq!(clean("Thank you for watching."), None);
        assert_eq!(clean(" you"), None);
        assert_eq!(clean("Subtitles by the Amara.org community"), None);
        // ...but not when they're part of a real request.
        assert!(clean("thanks for watching my cat, open youtube").is_some());
    }

    #[test]
    fn unbalanced_brackets_dont_eat_everything_after() {
        assert_eq!(clean("open notes] please").as_deref(), Some("open notes please"));
    }
}
