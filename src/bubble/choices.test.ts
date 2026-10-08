import { describe, expect, it } from "vitest";
import { ALLOW_GRACE_MS, CONFIRM_CHOICES, allowAccepted, defaultChoice } from "./choices";

describe("confirmation card keyboard safety", () => {
  it("focuses Nope, never Allow, on a confirmation card", () => {
    const i = defaultChoice("confirm", CONFIRM_CHOICES.length);
    expect(i).not.toBeNull();
    expect(CONFIRM_CHOICES[i as number]).toBe("Nope");
  });

  it("focuses the first button on other cards, nothing without buttons", () => {
    expect(defaultChoice("other", 2)).toBe(0);
    expect(defaultChoice("other", 0)).toBeNull();
    expect(defaultChoice("confirm", 0)).toBeNull();
  });

  it("ignores Allow right after the card appears (a double-tapped Enter)", () => {
    expect(allowAccepted(1000, 1000)).toBe(false);
    expect(allowAccepted(1000, 1000 + ALLOW_GRACE_MS - 1)).toBe(false);
    expect(allowAccepted(1000, 1000 + ALLOW_GRACE_MS)).toBe(true);
  });
});
