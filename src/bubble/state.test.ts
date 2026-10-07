import { describe, expect, it } from "vitest";
import { WELCOME } from "../shared/chat-text";
import { canSend, COLLAPSE_AFTER_MS, initialState, pendingConfirm, transition, type BubbleState } from "./state";

const confirmStep = { type: "confirm" as const, id: "c1", title: "Open the app “Spotify”", detail: "/usr/bin/spotify", actions: [] };

function run(s: BubbleState, ...events: Parameters<typeof transition>[1][]): BubbleState {
  return events.reduce((acc, e) => transition(acc, e).state, s);
}

describe("bubble state", () => {
  it("starts with the welcome", () => {
    const s = initialState();
    expect(s.speech).toEqual({ kind: "reply", text: WELCOME, actions: [] });
    expect(s.busy).toBe(false);
  });

  it("sends trimmed text once and thinks", () => {
    const t = transition(initialState(), { type: "send", text: "  hi  " });
    expect(t.request).toEqual({ kind: "send", text: "hi" });
    expect(t.state.busy).toBe(true);
    // No second message while busy, and no empty ones.
    expect(transition(t.state, { type: "send", text: "again" }).request).toBeNull();
    expect(transition(initialState(), { type: "send", text: "   " }).request).toBeNull();
    expect(canSend(t.state, "x")).toBe(false);
  });

  it("shows replies and bumps the revision", () => {
    const s0 = initialState();
    const s = run(s0, { type: "send", text: "open x" }, { type: "step", step: { type: "reply", text: "Done!", actions: ["Opened https://x.com"] } });
    expect(s.busy).toBe(false);
    expect(s.speech).toEqual({ kind: "reply", text: "Done!", actions: ["Opened https://x.com"] });
    expect(s.rev).toBe(s0.rev + 1);
    expect(s.seen).toBe(false);
  });

  it("fills in empty replies", () => {
    const s = run(initialState(), { type: "step", step: { type: "reply", text: "  ", actions: [] } });
    expect(s.speech?.kind === "reply" && s.speech.text.length).toBeGreaterThan(0);
    const withAction = run(initialState(), { type: "step", step: { type: "reply", text: "", actions: ["Opened Spotify"] } });
    expect(withAction.speech).toEqual({ kind: "reply", text: "", actions: ["Opened Spotify"] });
  });

  it("answers a confirmation exactly once", () => {
    const asked = run(initialState(), { type: "send", text: "open spotify" }, { type: "step", step: confirmStep });
    expect(pendingConfirm(asked)?.id).toBe("c1");
    const t = transition(asked, { type: "answer", approved: true });
    expect(t.request).toEqual({ kind: "confirm", id: "c1", approved: true });
    expect(t.state.busy).toBe(true);
    expect(t.state.speech).toMatchObject({ kind: "confirm", answer: "allowed" });
    expect(transition(t.state, { type: "answer", approved: false }).request).toBeNull();
    expect(transition(asked, { type: "answer", approved: false }).state.speech).toMatchObject({ answer: "denied" });
  });

  it("a new message makes a pending confirmation stale", () => {
    const asked = run(initialState(), { type: "step", step: confirmStep });
    const t = transition(asked, { type: "send", text: "never mind" });
    expect(t.request).toEqual({ kind: "send", text: "never mind" });
    expect(t.state.speech).toMatchObject({ kind: "confirm", answer: "stale" });
    expect(pendingConfirm(t.state)).toBeNull();
    // Late clicks on the old buttons do nothing.
    expect(transition(run(t.state, { type: "step", step: { type: "reply", text: "ok", actions: [] } }), { type: "answer", approved: true }).request).toBeNull();
  });

  it("explains errors", () => {
    const s = run(initialState(), { type: "send", text: "hi" }, { type: "failed", error: { code: "ollama_unreachable", message: "" } });
    expect(s.busy).toBe(false);
    expect(s.speech).toMatchObject({ kind: "error", offerSetup: true });
  });

  it("collapses to the pill when reopened much later, unless something is unread or pending", () => {
    const seen = run(initialState(), { type: "seen" });
    const later = { type: "shown" as const, awayMs: COLLAPSE_AFTER_MS + 1 };
    expect(run(seen, later).speech).toBeNull();
    expect(run(seen, { type: "shown", awayMs: 1000 }).speech).not.toBeNull();
    expect(run(seen, { type: "shown", awayMs: null }).speech).not.toBeNull();
    // Unread welcome stays.
    expect(run(initialState(), later).speech).not.toBeNull();
    // Pending confirmation stays.
    expect(run(initialState(), { type: "step", step: confirmStep }, { type: "seen" }, later).speech?.kind).toBe("confirm");
    // Still thinking: stays.
    expect(run(seen, { type: "send", text: "x" }, later).busy).toBe(true);
  });
});
