import { describe, expect, it } from "vitest";
import type { UpdateSpeech } from "../shared/ipc";
import { initialState, transition, type BubbleState } from "./state";
import { briefingSpeech } from "./update-me";

const reminder: UpdateSpeech = {
  id: "rem:3",
  text: "Reminder: call mum!",
  icon: "reminder",
  choices: [
    { id: "done", label: "Done" },
    { id: "snooze", label: "Snooze 10 min" },
  ],
};

describe("update speeches in the bubble", () => {
  it("shows an update with its buttons, once", () => {
    const s = transition(initialState(null), { type: "update", speech: reminder }).state;
    expect(s.speech).toEqual({ kind: "update", id: "rem:3", text: "Reminder: call mum!", icon: "reminder", choices: reminder.choices, answered: false });
    // The same update again (event + pending fetch): no new revision.
    expect(transition(s, { type: "update", speech: reminder }).state).toBe(s);
  });

  it("waits while Glitch is busy or asking for permission", () => {
    const busy: BubbleState = { ...initialState(null), busy: true };
    expect(transition(busy, { type: "update", speech: reminder }).state).toBe(busy);
    const asking = transition(initialState(null), {
      type: "step",
      step: { type: "confirm", id: "c1", title: "Open the app", detail: "", actions: [] },
    }).state;
    expect(transition(asking, { type: "update", speech: reminder }).state).toBe(asking);
  });

  it("answering switches the buttons off, and an unanswered one doesn't collapse", () => {
    let s = transition(initialState(null), { type: "update", speech: reminder }).state;
    s = transition(s, { type: "seen" }).state;
    // Reopened much later: the question is still there.
    expect(transition(s, { type: "shown", awayMs: 10 * 60_000 }).state.speech?.kind).toBe("update");
    expect(transition(s, { type: "update_answered", id: "other" }).state).toBe(s);
    s = transition(s, { type: "update_answered", id: "rem:3" }).state;
    expect(s.speech?.kind === "update" && s.speech.answered).toBe(true);
    expect(transition(s, { type: "shown", awayMs: 10 * 60_000 }).state.speech).toBeNull();
  });

  it("the briefing is an update without buttons", () => {
    expect(briefingSpeech("Morning!", "Thu Oct 08 2026")).toEqual({ id: "brief:Thu Oct 08 2026", text: "Morning!", icon: "briefing", choices: [] });
  });
});
