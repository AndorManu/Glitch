// The chat bubble's state machine: pure, no DOM, unit-tested.
//
// The bubble only ever shows the latest exchange: Glitch's current "speech"
// (a reply, a confirmation question or an error) above the compose pill, or
// a thought cloud while the model is working.

import { CLEARED, EMPTY_REPLY, WELCOME, explainError, plainText } from "../shared/chat-text";
import type { AgentProgress, CaptureTarget, Step, UiError, UpdateChoice, UpdateIcon, UpdateSpeech } from "../shared/ipc";

export type Answer = "allowed" | "denied" | "stale";

export type Speech =
  /** `instant`: the text already streamed in live, so it isn't typed again. */
  | { kind: "reply"; text: string; actions: string[]; instant?: boolean }
  | { kind: "confirm"; id: string; title: string; detail: string; actions: string[]; answer: Answer | null; allow?: string; deny?: string }
  | { kind: "error"; text: string; offerSetup: boolean }
  /** Voice: a hint or a microphone problem (optionally with an "Open settings" button). */
  | { kind: "notice"; text: string; tone: "info" | "error"; action: "mic-settings" | null }
  /** Voice: offer to download the speech model, then its progress. */
  | { kind: "voice_setup"; model: string; sizeMb: number; progress: number | null; failed: string | null }
  /** A new version of Glitch: Install / Later (src-tauri/src/autoupdate.rs). */
  | { kind: "app_update"; version: string; installing: boolean; failed: string | null }
  /** "Update me": something Glitch says by himself, with optional buttons (Done / Snooze, Tell me...). */
  | { kind: "update"; id: string; text: string; icon: UpdateIcon; choices: UpdateChoice[]; answered: boolean };

/** One tool step in the live step list ("Reading your clipboard"). */
export interface WorkStep {
  id: number;
  tool: string;
  label: string;
  state: "running" | "done" | "failed";
}

/** What Glitch is doing right now, while busy. */
export interface Work {
  steps: WorkStep[];
  /** Taking a screenshot right now: the "looking at your screen" badge. */
  looking: CaptureTarget | null;
  /** With `looking` "app": which app. */
  lookingApp: string | null;
  /** The reply so far, as it streams in (plain text). */
  text: string;
  /** An app task's plan, shown above the steps. */
  plan: string[];
}

export const NO_WORK: Work = { steps: [], looking: null, lookingApp: null, text: "", plan: [] };

export interface BubbleState {
  /** Waiting for the model: the thought cloud is up and sending is off. */
  busy: boolean;
  /** What Glitch is saying right now (null: just the compose pill). */
  speech: Speech | null;
  /** Bumped whenever `speech` is replaced, so the view knows to redraw it. */
  rev: number;
  /** The current speech has been fully shown on screen at least once. */
  seen: boolean;
  /** Live progress while busy (steps, looking, streamed text). */
  work: Work;
}

export type BubbleEvent =
  | { type: "send"; text: string }
  | { type: "answer"; approved: boolean }
  | { type: "step"; step: Step }
  | { type: "failed"; error: UiError }
  | { type: "seen" }
  /** Progress from Rust while busy ("agent-progress"). */
  | { type: "progress"; p: AgentProgress }
  /** A timer Glitch set has rung. */
  | { type: "reminder"; text: string }
  /** "Update me": a reminder, Claude Code, a script, the digest, the briefing. */
  | { type: "update"; speech: UpdateSpeech }
  /** A button on the update was clicked (the buttons switch off). */
  | { type: "update_answered"; id: string }
  /** The bubble window became visible after `awayMs` hidden (null: unknown). */
  | { type: "shown"; awayMs: number | null }
  /** Voice wants to say something (ignored while Glitch is thinking). */
  | { type: "notice"; text: string; tone: "info" | "error"; action: "mic-settings" | null }
  /** Voice needs the speech model: show the download offer. */
  | { type: "voice_setup"; model: string; sizeMb: number }
  /** "Clear chat" in Settings: a fresh start (drops anything in flight). */
  | { type: "cleared" }
  /** A new version is out (and not snoozed): offer it. */
  | { type: "update_offer"; version: string }
  /** Installing it started / stopped (`failed`: why it stopped). */
  | { type: "update_state"; installing: boolean; failed: string | null }
  /** Speech-model download progress (percent), or its end. */
  | { type: "voice_download"; state: "running" | "done" | "failed" | "cancelled"; percent: number | null; failed: string | null; ready: string };

/** Work for the caller to start after a transition. */
export type Request = { kind: "send"; text: string } | { kind: "confirm"; id: string; approved: boolean };

export interface Transition {
  state: BubbleState;
  request: Request | null;
}

export const UPDATE_FAILED = "The update didn't go through. Try again later?";

/** What Glitch says about a new version. */
export function updateText(version: string): string {
  return `Psst! There's a new me: Glitch ${version}. Want me to update myself? I'll be back in a few seconds.`;
}

/** Reopening the bubble after this long shows just the pill again. */
export const COLLAPSE_AFTER_MS = 90_000;

/** `greeting` null = open on just the input pill (nothing said). */
export function initialState(greeting: string | null = WELCOME): BubbleState {
  return { busy: false, speech: greeting ? { kind: "reply", text: greeting, actions: [] } : null, rev: 1, seen: false, work: NO_WORK };
}

export function pendingConfirm(s: BubbleState): Extract<Speech, { kind: "confirm" }> | null {
  return s.speech?.kind === "confirm" && s.speech.answer === null ? s.speech : null;
}

export function canSend(s: BubbleState, text: string): boolean {
  return !s.busy && text.trim().length > 0;
}

function speak(s: BubbleState, speech: Speech | null): BubbleState {
  return { ...s, busy: false, speech, rev: s.rev + 1, seen: false, work: NO_WORK };
}

function fromStep(step: Step, streamed: string): Speech {
  if (step.type === "confirm") {
    const { id, title, detail, actions, allow, deny } = step;
    const speech: Speech = { kind: "confirm", id, title, detail, actions, answer: null };
    if (allow) speech.allow = allow;
    if (deny) speech.deny = deny;
    return speech;
  }
  const text = step.text.trim();
  // Already on screen word for word (it streamed in): don't type it again.
  const instant = !!text && plainText(streamed) === text;
  const speech: Speech = { kind: "reply", text: text || (step.actions.length ? "" : EMPTY_REPLY), actions: step.actions };
  return instant ? { ...speech, instant } : speech;
}

/** Apply one progress event to the live work view. Unit-tested. */
export function applyProgress(w: Work, p: AgentProgress): Work {
  switch (p.kind) {
    case "thinking":
      // A new model round: text from the previous one is superseded.
      return w.text ? { ...w, text: "" } : w;
    case "step":
      return { ...w, text: "", steps: [...w.steps.filter((x) => x.id !== p.id), { id: p.id, tool: p.tool, label: p.label, state: "running" }] };
    case "step_done":
      return { ...w, steps: w.steps.map((x) => (x.id === p.id ? { ...x, state: p.ok ? "done" : "failed" } : x)) };
    case "looking":
      return { ...w, looking: p.active ? p.target : null, lookingApp: p.active ? (p.app ?? null) : null };
    case "text":
      return { ...w, text: w.text + p.delta };
    case "plan":
      return { ...w, plan: p.steps.slice(0, 6) };
  }
}

export function transition(s: BubbleState, e: BubbleEvent): Transition {
  const none = (state: BubbleState): Transition => ({ state, request: null });
  switch (e.type) {
    case "send": {
      const text = e.text.trim();
      if (!canSend(s, text)) return none(s);
      // A new message cancels a pending confirmation (Rust does the same).
      const pending = pendingConfirm(s);
      const speech: Speech | null = pending ? { ...pending, answer: "stale" } : s.speech;
      return { state: { ...s, busy: true, speech, work: NO_WORK }, request: { kind: "send", text } };
    }
    case "answer": {
      const pending = pendingConfirm(s);
      if (!pending || s.busy) return none(s);
      const speech: Speech = { ...pending, answer: e.approved ? "allowed" : "denied" };
      return { state: { ...s, busy: true, speech, work: { ...s.work, text: "" } }, request: { kind: "confirm", id: pending.id, approved: e.approved } };
    }
    case "step":
      return none(speak(s, fromStep(e.step, s.work.text)));
    case "progress":
      return none(s.busy ? { ...s, work: applyProgress(s.work, e.p) } : s);
    case "reminder":
      // While busy the caller holds it until the answer is in.
      if (s.busy) return none(s);
      return none(speak(s, { kind: "reply", text: `\u23F0 ${e.text}`, actions: [] }));
    case "update": {
      // While busy (or asking for permission) the caller holds it until Glitch is free.
      if (s.busy || pendingConfirm(s)) return none(s);
      // The same update again (live event + the pending fetch): nothing new.
      if (s.speech?.kind === "update" && s.speech.id === e.speech.id) return none(s);
      const { id, text, icon, choices } = e.speech;
      return none(speak(s, { kind: "update", id, text, icon, choices, answered: false }));
    }
    case "update_answered":
      if (s.speech?.kind !== "update" || s.speech.id !== e.id || s.speech.answered) return none(s);
      return none({ ...s, speech: { ...s.speech, answered: true } });
    case "failed": {
      const { text, offerSetup } = explainError(e.error);
      return none(speak(s, { kind: "error", text, offerSetup }));
    }
    case "seen":
      return none(s.seen ? s : { ...s, seen: true });
    case "shown": {
      const stale = e.awayMs !== null && e.awayMs >= COLLAPSE_AFTER_MS;
      const waitingUpdate = s.speech?.kind === "update" && !s.speech.answered && s.speech.choices.length > 0;
      if (stale && !s.busy && s.speech && s.seen && !pendingConfirm(s) && s.speech.kind !== "voice_setup" && !waitingUpdate) {
        return none({ ...speak(s, null), seen: true });
      }
      return none(s);
    }
    case "cleared":
      // A speech-model download keeps running in Rust: keep its progress
      // balloon, or "done" would have nothing to land on.
      if (s.speech?.kind === "voice_setup" && s.speech.progress !== null) return none({ ...s, busy: false });
      return none(speak(s, { kind: "reply", text: CLEARED, actions: [] }));
    case "notice":
      if (s.busy) return none(s);
      return none(speak(s, { kind: "notice", text: e.text, tone: e.tone, action: e.action }));
    case "voice_setup":
      if (s.busy) return none(s);
      return none(speak(s, { kind: "voice_setup", model: e.model, sizeMb: e.sizeMb, progress: null, failed: null }));
    case "update_offer":
      if (s.busy) return none(s);
      // Already offering (or installing) this one: keep it as it is.
      if (s.speech?.kind === "app_update" && s.speech.version === e.version) return none(s);
      return none(speak(s, { kind: "app_update", version: e.version, installing: false, failed: null }));
    case "update_state": {
      const sp = s.speech;
      if (sp?.kind !== "app_update") return none(s);
      // Stopped without restarting: it failed (the restart never comes back here).
      const failed = !e.installing && sp.installing ? (e.failed ?? UPDATE_FAILED) : e.installing ? null : sp.failed;
      if (sp.installing === e.installing && sp.failed === failed) return none(s);
      return none({ ...s, speech: { ...sp, installing: e.installing, failed } });
    }
    case "voice_download": {
      const sp = s.speech;
      if (s.busy || sp?.kind !== "voice_setup") return none(s);
      switch (e.state) {
        case "running":
          // Progress updates the same balloon (no new revision: no re-typing).
          return none({ ...s, speech: { ...sp, progress: e.percent ?? 0, failed: null } });
        case "done":
          return none(speak(s, { kind: "reply", text: e.ready, actions: [] }));
        case "failed":
          return none({ ...s, speech: { ...sp, progress: null, failed: e.failed } });
        case "cancelled":
          return none({ ...s, speech: { ...sp, progress: null, failed: null } });
      }
    }
  }
}

/** Dismiss the voice download offer ("Not now"). */
export function dismissSpeech(s: BubbleState): BubbleState {
  return s.busy ? s : speak(s, null);
}
