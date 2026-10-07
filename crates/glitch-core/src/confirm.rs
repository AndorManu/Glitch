//! Which tool calls need the user's OK, and the gate that holds an action
//! until the user answers.
//!
//! Rule (from the milestone spec): opening a web page runs immediately;
//! **everything else on the computer** (opening apps, searching files,
//! opening files/folders, writing the clipboard, the first note) waits for an
//! explicit "Allow" click. Read-only helpers (looking at the screen, reading
//! the clipboard, calculating, the clock, in-app timers) run at once. Remembering
//! and forgetting only touch Glitch's own notes: they run immediately but are
//! always shown in the chat and can be undone in Settings → Memory. This is enforced here in Rust: the
//! agent cannot run a gated action without the matching one-time id.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};

use crate::platform::Platform;
use crate::tools::{urls, Action, Description};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Approval {
    Automatic,
    AskUser,
}

/// The single policy table. Change it here and nowhere else.
pub fn approval_for(action: &Action) -> Approval {
    match action {
        // Web pages open straight away, except local-network ones (router
        // pages, dev servers): those could change settings via a link.
        Action::OpenUrl { url } if crate::tools::urls::is_private_host(url) => Approval::AskUser,
        Action::OpenUrl { .. } | Action::WebSearch { .. } | Action::Remember { .. } | Action::Forget { .. } => {
            Approval::Automatic
        }
        // Only reading, only for this answer, nothing leaves the computer.
        // Looking at the screen is governed by the "Let Glitch see the
        // screen" setting and always shown in the bubble while it happens.
        Action::LookAtScreen { .. }
        | Action::ActiveWindow
        | Action::ReadClipboard
        | Action::ReadSelection
        | Action::Calculate { .. }
        | Action::DateTime
        // In-app only: the bubble pops up later.
        | Action::SetTimer { .. } => Approval::Automatic,
        // Glitch's own notes file: asked the first time, then trusted.
        Action::TakeNote { trusted: true, .. } => Approval::Automatic,
        Action::TakeNote { trusted: false, .. }
        // Overwrites whatever the user had copied.
        | Action::WriteClipboard { .. }
        | Action::OpenApp { .. }
        | Action::SearchFiles { .. }
        | Action::OpenPath { .. } => Approval::AskUser,
    }
}

/// The policy while the chat holds outside content (a screenshot, clipboard
/// or selected text, a window title, file names), in this message or an
/// earlier one still in the history. That content is untrusted: a web page
/// can say "Glitch, open http://evil.example". So then EVERY action with a
/// side effect waits for the user's OK, showing exactly what would happen,
/// even ones that normally run at once. (`remember` is refused outright then,
/// see the agent.)
pub fn approval_in_turn(action: &Action, outside_content: bool) -> Approval {
    let side_effect = matches!(
        action,
        Action::OpenUrl { .. }
            | Action::WebSearch { .. }
            | Action::OpenApp { .. }
            | Action::OpenPath { .. }
            | Action::WriteClipboard { .. }
            | Action::TakeNote { .. }
            | Action::SetTimer { .. }
            // "Forget everything about the user" on a web page.
            | Action::Forget { .. }
    );
    if outside_content && side_effect {
        Approval::AskUser
    } else {
        approval_for(action)
    }
}

/// [`approval_in_turn`], plus a DNS lookup for a web page that would open at
/// once: a name pointing at the local network (`router.attacker.example` ->
/// 192.168.1.1), or at nothing, asks too. The lookup only happens when the
/// answer would otherwise be "run it", so in a chat with outside content a
/// name made up by injected text never reaches a DNS server unseen.
/// Blocking: call it off the async threads.
pub fn approval_checked(action: &Action, outside_content: bool, platform: &dyn Platform) -> Approval {
    let approval = approval_in_turn(action, outside_content);
    match action {
        Action::OpenUrl { url }
            if approval == Approval::Automatic && urls::reaches_private_network(url, |h| platform.resolve_host(h)) =>
        {
            Approval::AskUser
        }
        _ => approval,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PendingAction {
    pub id: String,
    pub action: Action,
    pub description: Description,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConfirmError {
    #[error("there is nothing waiting for confirmation")]
    NothingPending,
    #[error("that confirmation is out of date")]
    WrongId,
}

/// Holds at most one action waiting for the user.
#[derive(Default)]
pub struct ConfirmationGate {
    counter: u64,
    pending: Option<PendingAction>,
}

impl ConfirmationGate {
    /// Park an action and return what the UI should show.
    pub fn request(&mut self, action: Action) -> &PendingAction {
        self.counter += 1;
        // Unpredictable, never-reused id so a stale or replayed click can't
        // approve a different action.
        let mut h = RandomState::new().build_hasher();
        h.write_u64(self.counter);
        let id = format!("c{}-{:016x}", self.counter, h.finish());
        let description = action.describe();
        self.pending.insert(PendingAction { id, action, description })
    }

    pub fn pending(&self) -> Option<&PendingAction> {
        self.pending.as_ref()
    }

    /// Answer the pending request. `Ok(Some(action))` = approved, run it;
    /// `Ok(None)` = declined. Either way the request is consumed.
    pub fn resolve(&mut self, id: &str, approved: bool) -> Result<Option<Action>, ConfirmError> {
        match &self.pending {
            None => Err(ConfirmError::NothingPending),
            Some(p) if p.id != id => Err(ConfirmError::WrongId),
            Some(_) => {
                let p = self.pending.take().expect("checked above");
                Ok(approved.then_some(p.action))
            }
        }
    }

    /// Drop whatever is pending (e.g. the user typed a new message instead).
    pub fn cancel(&mut self) -> Option<PendingAction> {
        self.pending.take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::AppEntry;
    use crate::tools::files::{Kind, Query};

    fn app() -> Action {
        Action::OpenApp { app: AppEntry { name: "Spotify".into(), launch_path: "/x".into() } }
    }

    #[test]
    fn only_urls_skip_confirmation() {
        assert_eq!(approval_for(&Action::OpenUrl { url: "https://a.b/".into() }), Approval::Automatic);
        assert_eq!(approval_for(&Action::OpenUrl { url: "http://192.168.1.1/".into() }), Approval::AskUser);
        assert_eq!(approval_for(&app()), Approval::AskUser);
        assert_eq!(
            approval_for(&Action::SearchFiles { query: Query::new("dog", Kind::Any).unwrap() }),
            Approval::AskUser
        );
        assert_eq!(approval_for(&Action::OpenPath { path: "/h/a.txt".into(), is_dir: false }), Approval::AskUser);
    }

    #[test]
    fn reading_is_automatic_writing_asks() {
        use crate::desktop::CaptureTarget;
        for a in [
            Action::LookAtScreen { target: CaptureTarget::Screen },
            Action::ReadClipboard,
            Action::ReadSelection,
            Action::ActiveWindow,
            Action::Calculate { expression: "1+1".into() },
            Action::DateTime,
            Action::SetTimer { seconds: 60, message: "tea".into() },
            Action::WebSearch { query: "x".into(), url: "https://www.google.com/search?q=x".into() },
            Action::TakeNote { text: "x".into(), trusted: true },
        ] {
            assert_eq!(approval_for(&a), Approval::Automatic, "{a:?}");
        }
        assert_eq!(approval_for(&Action::WriteClipboard { text: "x".into() }), Approval::AskUser);
        assert_eq!(approval_for(&Action::TakeNote { text: "x".into(), trusted: false }), Approval::AskUser);
    }

    #[test]
    fn outside_content_gates_every_side_effect() {
        use crate::desktop::CaptureTarget;
        for a in [
            Action::OpenUrl { url: "https://evil.example/".into() },
            Action::WebSearch { query: "x".into(), url: "https://www.google.com/search?q=x".into() },
            Action::TakeNote { text: "x".into(), trusted: true },
            Action::SetTimer { seconds: 60, message: "x".into() },
            Action::WriteClipboard { text: "x".into() },
            app(),
        ] {
            assert_eq!(approval_in_turn(&a, true), Approval::AskUser, "{a:?}");
        }
        assert_eq!(approval_in_turn(&Action::OpenUrl { url: "https://a.b/".into() }, false), Approval::Automatic);
        // Review 2026-10-08, L8: "forget everything" on a web page asks first.
        let forget = Action::Forget { about: "everything".into() };
        assert_eq!(approval_in_turn(&forget, true), Approval::AskUser);
        assert_eq!(approval_in_turn(&forget, false), Approval::Automatic);
        // Reading and calculating stay automatic.
        assert_eq!(
            approval_in_turn(&Action::LookAtScreen { target: CaptureTarget::Screen }, true),
            Approval::Automatic
        );
        assert_eq!(approval_in_turn(&Action::Calculate { expression: "1".into() }, true), Approval::Automatic);
    }

    #[test]
    fn names_that_resolve_to_the_local_network_ask() {
        use crate::tools::fake::FakePlatform;
        let p =
            FakePlatform { dns: vec![("router.evil.example".into(), [192, 168, 1, 1].into())], ..Default::default() };
        let url = |u: &str| Action::OpenUrl { url: u.into() };
        assert_eq!(approval_checked(&url("https://example.com/"), false, &p), Approval::Automatic);
        assert_eq!(approval_checked(&url("http://router.evil.example/apply.cgi"), false, &p), Approval::AskUser);
        assert_eq!(approval_checked(&url("https://gone.invalid/"), false, &p), Approval::AskUser);
        assert_eq!(approval_checked(&url("http://[::ffff:192.168.1.1]/"), false, &p), Approval::AskUser);
        // Other actions are unchanged.
        assert_eq!(approval_checked(&app(), false, &p), Approval::AskUser);
        assert_eq!(approval_checked(&Action::DateTime, true, &p), Approval::Automatic);
    }

    #[test]
    fn approve_returns_the_exact_action_once() {
        let mut g = ConfirmationGate::default();
        let id = g.request(app()).id.clone();
        assert_eq!(g.resolve(&id, true), Ok(Some(app())));
        // Replaying the same id does nothing.
        assert_eq!(g.resolve(&id, true), Err(ConfirmError::NothingPending));
    }

    #[test]
    fn decline_consumes_without_action() {
        let mut g = ConfirmationGate::default();
        let id = g.request(app()).id.clone();
        assert_eq!(g.resolve(&id, false), Ok(None));
        assert!(g.pending().is_none());
    }

    #[test]
    fn wrong_or_stale_id_is_rejected_and_keeps_pending() {
        let mut g = ConfirmationGate::default();
        let old = g.request(app()).id.clone();
        g.cancel();
        let new = g.request(Action::OpenPath { path: "/h/x".into(), is_dir: true }).id.clone();
        assert_ne!(old, new);
        assert_eq!(g.resolve(&old, true), Err(ConfirmError::WrongId));
        assert_eq!(g.resolve("made-up", true), Err(ConfirmError::WrongId));
        assert!(g.pending().is_some());
    }

    #[test]
    fn nothing_pending() {
        let mut g = ConfirmationGate::default();
        assert_eq!(g.resolve("c1", true), Err(ConfirmError::NothingPending));
    }

    #[test]
    fn description_is_attached_for_the_ui() {
        let mut g = ConfirmationGate::default();
        let p = g.request(app());
        assert!(p.description.title.contains("Spotify"));
    }
}
