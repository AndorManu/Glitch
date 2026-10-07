//! Which tool calls need the user's OK, and the gate that holds an action
//! until the user answers.
//!
//! Rule (from the milestone spec): opening a web page runs immediately;
//! **everything else on the computer** (opening apps, searching files,
//! opening files/folders) waits for an explicit "Allow" click. Remembering
//! and forgetting only touch Glitch's own notes: they run immediately but are
//! always shown in the chat and can be undone in Settings → Memory. This is enforced here in Rust: the
//! agent cannot run a gated action without the matching one-time id.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};

use crate::tools::{Action, Description};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Approval {
    Automatic,
    AskUser,
}

/// The single policy table. Change it here and nowhere else.
pub fn approval_for(action: &Action) -> Approval {
    match action {
        Action::OpenUrl { .. } | Action::Remember { .. } | Action::Forget { .. } => Approval::Automatic,
        Action::OpenApp { .. } | Action::SearchFiles { .. } | Action::OpenPath { .. } => Approval::AskUser,
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
        assert_eq!(approval_for(&app()), Approval::AskUser);
        assert_eq!(
            approval_for(&Action::SearchFiles { query: Query::new("dog", Kind::Any).unwrap() }),
            Approval::AskUser
        );
        assert_eq!(approval_for(&Action::OpenPath { path: "/h/a.txt".into(), is_dir: false }), Approval::AskUser);
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
