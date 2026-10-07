import { describe, expect, it } from "vitest";
import { initialState, transition, UPDATE_FAILED, updateText, type BubbleState } from "./state";

function run(s: BubbleState, ...events: Parameters<typeof transition>[1][]): BubbleState {
  return events.reduce((acc, e) => transition(acc, e).state, s);
}

describe("new version bubble", () => {
  it("offers once, installs, and says when it failed", () => {
    let s = run(initialState(null), { type: "update_offer", version: "0.2.0" });
    expect(s.speech).toEqual({ kind: "update", version: "0.2.0", installing: false, failed: null });
    const rev = s.rev;
    // The same offer again (daily check, window reload) changes nothing.
    s = run(s, { type: "update_offer", version: "0.2.0" });
    expect(s.rev).toBe(rev);
    s = run(s, { type: "update_state", installing: true, failed: null });
    expect(s.speech).toMatchObject({ installing: true, failed: null });
    expect(s.rev).toBe(rev); // same balloon, no re-typing
    s = run(s, { type: "update_state", installing: false, failed: null });
    expect(s.speech).toMatchObject({ installing: false, failed: UPDATE_FAILED });
  });

  it("waits while Glitch is busy, ignores status without an offer", () => {
    const busy = run(initialState(null), { type: "send", text: "hi" });
    expect(run(busy, { type: "update_offer", version: "0.2.0" }).speech).toBeNull();
    const idle = initialState(null);
    expect(run(idle, { type: "update_state", installing: true, failed: null })).toBe(idle);
  });

  it("a failed check while just offering doesn't show an error", () => {
    const s = run(initialState(null), { type: "update_offer", version: "0.2.0" }, { type: "update_state", installing: false, failed: "offline" });
    expect(s.speech).toMatchObject({ failed: null });
  });

  it("speaks plainly", () => {
    const t = updateText("0.2.0");
    expect(t).toContain("0.2.0");
    expect(t).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`));
  });
});
