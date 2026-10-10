//! "Does this window look like it holds work the user has not saved?"
//!
//! One pure rule shared by chaos mode (never drag such a window) and Hands
//! (never focus, click or type into one). Everything here reads only a
//! window title or the names of UI elements; the OS side just reports them.
//!
//! The rule errs on the side of refusing: a false positive costs a skipped
//! prank or a "do this one yourself", a false negative can cost a document.
//! Titles can only show what the app chooses to show (Word and Excel never
//! put a marker in the title), which is why the Hands side also looks for a
//! Save prompt in the window's UI tree ([`tree_has_save_prompt`]).

/// Why a window looks like it has unsaved work.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unsaved {
    /// `*notes.txt - Notepad`, `main.rs* - Notepad++`, `... @ 100% *`.
    Star,
    /// `● main.ts - Visual Studio Code`, `notes.txt • - Sublime Text`.
    Bullet,
    /// `Untitled - Notepad`, `Untitled 1 - LibreOffice Writer`.
    Untitled,
    /// A brand-new document that was never saved: `Document1 - Word`, `Book1 - Excel`.
    NewDocument,
    /// `[modified]`, `(unsaved)`, `[+]`...
    Tag,
    /// The window is itself a Save dialog or a "save changes?" prompt.
    SaveDialog,
    /// A Save prompt is open in the app's UI tree.
    SavePrompt,
}

impl Unsaved {
    /// A sentence for the user or the model (why Glitch kept its paws off).
    pub fn why(self) -> &'static str {
        match self {
            Unsaved::Star | Unsaved::Bullet | Unsaved::Tag => "its title shows unsaved changes",
            Unsaved::Untitled | Unsaved::NewDocument => "it is a document that was never saved",
            Unsaved::SaveDialog | Unsaved::SavePrompt => "a Save prompt is open",
        }
    }
}

/// Dots that editors put in front of (or after) a file name when it has changes.
const BULLETS: &[char] =
    &['\u{25CF}', '\u{2022}', '\u{25CB}', '\u{2B24}', '\u{25E6}', '\u{00B7}', '\u{26AB}', '\u{2981}'];

/// Phrases that mean "modified" when they appear anywhere in a title.
const TAGS: &[&str] = &[
    "[modified]",
    "(modified)",
    "[unsaved]",
    "(unsaved)",
    "[changed]",
    "(changed)",
    "[edited]",
    "(edited)",
    "[not saved]",
    "(not saved)",
    "[+]",
    "unsaved changes",
    "unsaved document",
    "unsaved file",
];

/// Names Office gives a document before it is first saved.
const NEW_DOC_STEMS: &[&str] = &["document", "book", "presentation", "sheet", "workbook", "drawing", "publication"];

/// Segments of a title: apps join file, folder and app name with a dash or bar.
fn segments(title: &str) -> Vec<&str> {
    let mut out = vec![title];
    for sep in [" - ", " \u{2013} ", " \u{2014} ", " | "] {
        out = out.into_iter().flat_map(|s| s.split(sep)).collect();
    }
    out.into_iter().map(str::trim).filter(|s| !s.is_empty()).collect()
}

/// `Document1`, `Book12`, `Presentation3`, `Sheet2` (what Office calls an unsaved new file).
fn is_new_doc_name(seg: &str) -> bool {
    let lower = seg.to_lowercase();
    // "Document1 [Compatibility Mode]": look at the first word only.
    let first = lower.split_whitespace().next().unwrap_or("");
    NEW_DOC_STEMS.iter().any(|stem| {
        first.strip_prefix(stem).is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()))
    })
}

fn has_word(lower: &str, word: &str) -> bool {
    lower.split(|c: char| !c.is_alphanumeric()).any(|w| w == word)
}

/// Is this window itself a Save dialog or a "save your changes?" prompt?
pub fn is_save_dialog_title(title: &str) -> bool {
    let lower = title.trim().to_lowercase();
    if lower.is_empty() {
        return false;
    }
    let exact = ["save as", "save", "save file", "save copy", "save a copy", "confirm save as", "save changes"];
    exact.iter().any(|e| lower == *e)
        || lower.starts_with("save as ")
        || lower.starts_with("save changes")
        || lower.starts_with("do you want to save")
        || lower.starts_with("save your changes")
        || lower.ends_with(" save as")
        || lower.contains("want to save")
}

/// Does the title of a window suggest unsaved work?
pub fn title_unsaved(title: &str) -> Option<Unsaved> {
    let title = title.trim();
    if title.is_empty() {
        return None;
    }
    if is_save_dialog_title(title) {
        return Some(Unsaved::SaveDialog);
    }
    let lower = title.to_lowercase();
    if TAGS.iter().any(|t| lower.contains(t)) {
        return Some(Unsaved::Tag);
    }
    let segs = segments(title);
    // A marker at the edge of the whole title or of any segment ("*a.txt - Notepad",
    // "a.txt* - Notepad++", "Untitled-1 @ 100% *"). A star in the middle of a
    // segment ("5 * 3 - Calculator") is not an edge.
    let starred = |s: &str| s.chars().count() > 1 && (s.starts_with('*') || s.ends_with('*'));
    if starred(title) || segs.iter().any(|s| starred(s)) {
        return Some(Unsaved::Star);
    }
    for s in std::iter::once(&title).chain(segs.iter()) {
        if s.starts_with(BULLETS) || s.ends_with(BULLETS) {
            return Some(Unsaved::Bullet);
        }
    }
    if has_word(&lower, "untitled") {
        return Some(Unsaved::Untitled);
    }
    if segs.iter().any(|s| is_new_doc_name(s)) {
        return Some(Unsaved::NewDocument);
    }
    None
}

/// Names of UI elements (buttons, labels, dialog text) that only appear in a
/// "save your changes?" prompt. Deliberately narrow: "Save as" alone is also
/// a menu item in every editor, so it doesn't count.
const PROMPT_PHRASES: &[&str] = &[
    "do you want to save",
    "want to save",
    "save changes",
    "save your changes",
    "unsaved changes",
    "don't save",
    "dont save",
    "don\u{2019}t save",
    "discard changes",
    "save before closing",
    "save before exiting",
];

/// Does any element of a window's UI tree belong to a Save prompt?
pub fn tree_has_save_prompt<'a>(names: impl IntoIterator<Item = &'a str>) -> bool {
    names.into_iter().any(|n| {
        let n = n.to_lowercase();
        PROMPT_PHRASES.iter().any(|p| n.contains(p))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dirty_titles_of_common_apps() {
        let dirty = [
            ("*reddit-posts.md - Notepad", Unsaved::Star),
            ("*new 1 - Notepad++", Unsaved::Star),
            ("*C:\\work\\main.rs - Notepad++", Unsaved::Star),
            ("main.rs* - Notepad++", Unsaved::Star),
            ("\u{25CF} main.ts - glitch - Visual Studio Code", Unsaved::Bullet),
            ("\u{25CF} main.ts - Visual Studio Code [Administrator]", Unsaved::Bullet),
            ("notes.txt \u{2022} - Sublime Text", Unsaved::Bullet),
            ("\u{2022} notes.txt - Sublime Text", Unsaved::Bullet),
            ("Untitled - Notepad", Unsaved::Untitled),
            ("Untitled-1 @ 100% (RGB/8) *", Unsaved::Star),
            ("Untitled 1 - LibreOffice Writer", Unsaved::Untitled),
            ("Untitled - vault - Obsidian v1.5.3", Unsaved::Untitled),
            ("untitled document - gedit", Unsaved::Untitled),
            ("Document1 - Word", Unsaved::NewDocument),
            ("Book3 - Excel", Unsaved::NewDocument),
            ("Presentation2 - PowerPoint", Unsaved::NewDocument),
            ("report.docx [modified] - Editor", Unsaved::Tag),
            ("notes.txt (unsaved) - Editor", Unsaved::Tag),
            ("[No Name] [+] - NVIM", Unsaved::Tag),
            ("MyProject \u{2013} Main.kt [app] \u{2013} Android Studio *", Unsaved::Star),
            ("*Scratch.java - Eclipse IDE", Unsaved::Star),
            ("Save As", Unsaved::SaveDialog),
            ("Do you want to save changes to x?", Unsaved::SaveDialog),
            ("Save changes to Document1?", Unsaved::SaveDialog),
        ];
        for (t, why) in dirty {
            assert_eq!(title_unsaved(t), Some(why), "{t}");
        }
    }

    #[test]
    fn clean_titles_of_common_apps() {
        for t in [
            "reddit-posts.md - Notepad",
            "main.rs - Notepad++",
            "main.ts - glitch - Visual Studio Code",
            "notes.txt - Sublime Text",
            "Quarterly report.docx - Word",
            "Budget 2026.xlsx - Excel",
            "Deck.pptx - PowerPoint",
            "daily - vault - Obsidian v1.5.3",
            "Spotify Premium",
            "Artist \u{2022} Song - Spotify",
            "5 * 3 - Calculator",
            "Calculator",
            "Inbox (3) - andor@example.com - Gmail - Google Chrome",
            "Glitch - Pull request #12 - Mozilla Firefox",
            "Settings",
            "File Explorer",
            "Documents - File Explorer",
            "Book of Mormon.pdf - Adobe Acrobat",
            "Sheets and Giggles - YouTube",
            "Project Documentation - Notion",
            "",
            "   ",
        ] {
            assert_eq!(title_unsaved(t), None, "{t:?}");
        }
    }

    #[test]
    fn star_only_counts_at_the_edge_of_a_segment() {
        assert_eq!(title_unsaved("a*b - App"), None);
        assert_eq!(title_unsaved("a* - App"), Some(Unsaved::Star));
        assert_eq!(title_unsaved("App - *a"), Some(Unsaved::Star));
        assert_eq!(title_unsaved("*"), None, "a lone star is not a document");
    }

    #[test]
    fn save_dialogs_are_recognised_by_title() {
        for t in ["Save As", "save as", "Save", "Save changes", "Notepad: Save As", "Do you want to save changes to x?"]
        {
            assert!(is_save_dialog_title(t), "{t}");
        }
        for t in ["Saved games", "Notepad", "Safe mode", "Save the date - Mail", ""] {
            assert!(!is_save_dialog_title(t), "{t}");
        }
    }

    #[test]
    fn save_prompts_in_a_ui_tree() {
        assert!(tree_has_save_prompt(["File", "Do you want to save changes to Untitled?", "Cancel"]));
        assert!(tree_has_save_prompt(["Save", "Don't Save", "Cancel"]));
        assert!(tree_has_save_prompt(["Don\u{2019}t save"]));
        assert!(tree_has_save_prompt(["You have unsaved changes"]));
        // A normal editor's menu is not a prompt.
        assert!(!tree_has_save_prompt(["File", "Save", "Save As...", "Edit", "Text editor"]));
        assert!(!tree_has_save_prompt([]));
    }

    #[test]
    fn every_reason_has_a_sentence() {
        for r in [
            Unsaved::Star,
            Unsaved::Bullet,
            Unsaved::Untitled,
            Unsaved::NewDocument,
            Unsaved::Tag,
            Unsaved::SaveDialog,
            Unsaved::SavePrompt,
        ] {
            assert!(!r.why().is_empty());
        }
    }
}
