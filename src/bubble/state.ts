// The chat bubble's state machine: pure, no DOM, unit-tested.
//
// The bubble only ever shows the latest exchange: Glitch's current "speech"
// (a reply, a confirmation question or an error) above the compose pill, or
// a thought cloud while the model is working.

import { CLEARED, EMPTY_REPLY, WELCOME, explainError } from "../shared/chat-text";
import type { Step, UiError } from "../shared/ipc";

export type Answer = "allowed" | "denied" | "stale";

export type Speech =
  | { kind: "reply"; text: string; actions: string[] }
  | { kind: "confirm"; id: string; title: string; detail: string; actions: string[]; answer: Answer | null }
  | { kind: "error"; text: string; offerSetup: boolean }
  /** Voice: a hint or a microphone problem (optionally with an "Open settings" button). */
  | { kind: "notice"; text: string; tone: "info" | "error"; action: "mic-settings" | null }
  /** Voice: offer to download the speech model, then its progress. */
  | { kind: "voice_setup"; model: string; sizeMb: number; progress: number | null; failed: string | null };

export interface BubbleState {
  /** Waiting for the model: the thought cloud is up and sending is off. */
  busy: boolean;
  /** What Glitch is saying right now (null: just the compose pill). */
  speech: Speech | null;
  /** Bumped whenever `speech` is replaced, so the view knows to redraw it. */
  rev: number;
  /** The current speech has been fully shown on screen at least once. */
  seen: boolean;
}

export type BubbleEvent =
  | { type: "send"; text: string }
  | { type: "answer"; approved: boolean }
  | { type: "step"; step: Step }
  | { type: "failed"; error: UiError }
  | { type: "seen" }
  /** The bubble window became visible after `awayMs` hidden (null: unknown). */
  | { type: "shown"; awayMs: number | null }
  /** Voice wants to say something (ignored while Glitch is thinking). */
  | { type: "notice"; text: string; tone: "info" | "error"; action: "mic-settings" | null }
  /** Voice needs the speech model: show the download offer. */
  | { type: "voice_setup"; model: string; sizeMb: number }
  /** "Clear chat" in Settings: a fresh start (drops anything in flight). */
  | { type: "cleared" }
  /** Speech-model download progress (percent), or its end. */
  | { type: "voice_download"; state: "running" | "done" | "failed" | "cancelled"; percent: number | null; failed: string | null; ready: string };

/** Work for the caller to start after a transition. */
export type Request = { kind: "send"; text: string } | { kind: "confirm"; id: string; approved: boolean };

export interface Transition {
  state: BubbleState;
  request: Request | null;
}

/** Reopening the bubble after this long shows just the pill again. */
export const COLLAPSE_AFTER_MS = 90_000;

/** `greeting` null = open on just the input pill (nothing said). */
export function initialState(greeting: string | null = WELCOME): BubbleState {
  return { busy: false, speech: greeting ? { kind: "reply", text: greeting, actions: [] } : null, rev: 1, seen: false };
}

export function pendingConfirm(s: BubbleState): Extract<Speech, { kind: "confirm" }> | null {
  return s.speech?.kind === "confirm" && s.speech.answer === null ? s.speech : null;
}

export function canSend(s: BubbleState, text: string): boolean {
  return !s.busy && text.trim().length > 0;
}

function speak(s: BubbleState, speech: Speech | null): BubbleState {
  return { ...s, busy: false, speech, rev: s.rev + 1, seen: false };
}

function fromStep(step: Step): Speech {
  if (step.type === "confirm") {
    const { id, title, detail, actions } = step;
    return { kind: "confirm", id, title, detail, actions, answer: null };
  }
  const text = step.text.trim();
  return { kind: "reply", text: text || (step.actions.length ? "" : EMPTY_REPLY), actions: step.actions };
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
      return { state: { ...s, busy: true, speech }, request: { kind: "send", text } };
    }
    case "answer": {
      const pending = pendingConfirm(s);
      if (!pending || s.busy) return none(s);
      const speech: Speech = { ...pending, answer: e.approved ? "allowed" : "denied" };
      return { state: { ...s, busy: true, speech }, request: { kind: "confirm", id: pending.id, approved: e.approved } };
    }
    case "step":
      return none(speak(s, fromStep(e.step)));
    case "failed": {
      const { text, offerSetup } = explainError(e.error);
      return none(speak(s, { kind: "error", text, offerSetup }));
    }
    case "seen":
      return none(s.seen ? s : { ...s, seen: true });
    case "shown": {
      const stale = e.awayMs !== null && e.awayMs >= COLLAPSE_AFTER_MS;
      if (stale && !s.busy && s.speech && s.seen && !pendingConfirm(s) && s.speech.kind !== "voice_setup") {
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
