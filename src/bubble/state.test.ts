import { describe, expect, it } from "vitest";
import { CLEARED, WELCOME } from "../shared/chat-text";
import { applyProgress, canSend, COLLAPSE_AFTER_MS, initialState, NO_WORK, pendingConfirm, transition, type BubbleState } from "./state";

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

  it("starts fresh after Clear chat, even mid-thought or mid-question", () => {
    const busy = run(initialState(), { type: "send", text: "hi" });
    const s = run(busy, { type: "cleared" });
    expect(s.busy).toBe(false);
    expect(s.speech).toEqual({ kind: "reply", text: CLEARED, actions: [] });
    expect(s.rev).toBeGreaterThan(busy.rev);
    const asking = run(initialState(), { type: "step", step: confirmStep }, { type: "cleared" });
    expect(pendingConfirm(asking)).toBeNull();
    expect(canSend(asking, "x")).toBe(true);
  });

  it("Clear chat keeps a running speech-model download on screen", () => {
    const downloading = run(
      initialState(),
      { type: "voice_setup", model: "base", sizeMb: 142 },
      { type: "voice_download", state: "running", percent: 40, failed: null, ready: "Ready" },
      { type: "cleared" },
    );
    expect(downloading.speech).toMatchObject({ kind: "voice_setup", progress: 40 });
    const done = run(downloading, { type: "voice_download", state: "done", percent: 100, failed: null, ready: "Ready" });
    expect(done.speech).toEqual({ kind: "reply", text: "Ready", actions: [] });
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

describe("live progress", () => {
  const reply = (text: string) => ({ type: "step" as const, step: { type: "reply" as const, text, actions: [] } });

  it("shows the wait for an app with its seconds, then which app it looks at", () => {
    let s = run(initialState(), { type: "send", text: "open spotify and tell me what you see" });
    s = run(
      s,
      { type: "progress", p: { kind: "step", id: 1, tool: "open_app", label: "Opening Spotify" } },
      { type: "progress", p: { kind: "step_done", id: 1, ok: true } },
      { type: "progress", p: { kind: "step", id: 2, tool: "wait_for_app", label: "Waiting for Spotify to load..." } },
      { type: "progress", p: { kind: "step", id: 2, tool: "wait_for_app", label: "Waiting for Spotify to load... 4 s" } },
    );
    // The same step is updated in place, not listed again.
    expect(s.work.steps.map((x) => [x.id, x.label, x.state])).toEqual([
      [1, "Opening Spotify", "done"],
      [2, "Waiting for Spotify to load... 4 s", "running"],
    ]);
    s = run(
      s,
      { type: "progress", p: { kind: "step_done", id: 2, ok: true } },
      { type: "progress", p: { kind: "looking", active: true, target: "app", app: "Spotify" } },
    );
    expect(s.work.looking).toBe("app");
    expect(s.work.lookingApp).toBe("Spotify");
    s = run(s, { type: "progress", p: { kind: "looking", active: false, target: "app", app: "Spotify" } });
    expect(s.work.lookingApp).toBeNull();
  });

  it("lists steps, the looking badge and streamed text while busy", () => {
    let s = run(initialState(), { type: "send", text: "what's on my screen?" });
    s = run(
      s,
      { type: "progress", p: { kind: "step", id: 1, tool: "look_at_screen", label: "Looking at your screen" } },
      { type: "progress", p: { kind: "looking", active: true, target: "screen" } },
    );
    expect(s.work.looking).toBe("screen");
    expect(s.work.steps).toEqual([{ id: 1, tool: "look_at_screen", label: "Looking at your screen", state: "running" }]);
    s = run(
      s,
      { type: "progress", p: { kind: "looking", active: false, target: "screen" } },
      { type: "progress", p: { kind: "step_done", id: 1, ok: true } },
      { type: "progress", p: { kind: "thinking" } },
      { type: "progress", p: { kind: "text", delta: "Glitch: A shopping " } },
      { type: "progress", p: { kind: "text", delta: "list!" } },
    );
    expect(s.work).toEqual({
      looking: null,
      lookingApp: null,
      text: "Glitch: A shopping list!",
      steps: [{ id: 1, tool: "look_at_screen", label: "Looking at your screen", state: "done" }],
      plan: [],
    });
    // The final reply matches what streamed in: shown at once, not retyped.
    s = run(s, reply("A shopping list!"));
    expect(s.speech).toEqual({ kind: "reply", text: "A shopping list!", actions: [], instant: true });
    expect(s.work).toEqual(NO_WORK);
  });

  it("shows an app task's plan, and custom button labels", () => {
    const w = applyProgress(NO_WORK, { kind: "plan", steps: ["Open Spotify", "Find the playlist", "Press Play"] });
    expect(w.plan).toEqual(["Open Spotify", "Find the playlist", "Press Play"]);
    const asked = run(initialState(), { type: "send", text: "x" }, { type: "step", step: { ...confirmStep, allow: "Allow once" } });
    expect(asked.speech).toMatchObject({ kind: "confirm", allow: "Allow once" });
    expect(pendingConfirm(run(initialState(), { type: "step", step: confirmStep }))).not.toHaveProperty("allow");
  });

  it("a new model round or step clears half-streamed text", () => {
    let w = applyProgress(NO_WORK, { kind: "text", delta: "Let me look" });
    w = applyProgress(w, { kind: "step", id: 2, tool: "calculate", label: "Calculating" });
    expect(w.text).toBe("");
    w = applyProgress(applyProgress(w, { kind: "text", delta: "x" }), { kind: "thinking" });
    expect(w.text).toBe("");
    expect(applyProgress(w, { kind: "step_done", id: 2, ok: false }).steps[0].state).toBe("failed");
  });

  it("ignores progress when idle and types replies that didn't stream", () => {
    const idle = initialState();
    expect(transition(idle, { type: "progress", p: { kind: "text", delta: "x" } }).state).toBe(idle);
    const s = run(idle, { type: "send", text: "hi" }, reply("Hey!"));
    expect(s.speech).toEqual({ kind: "reply", text: "Hey!", actions: [] });
  });

  it("reminders speak up when Glitch isn't busy", () => {
    const s = run(initialState(), { type: "reminder", text: "Drink water" });
    expect(s.speech).toMatchObject({ kind: "reply", text: "⏰ Drink water" });
    const busy = run(initialState(), { type: "send", text: "hi" });
    expect(transition(busy, { type: "reminder", text: "x" }).state).toBe(busy);
  });
});
