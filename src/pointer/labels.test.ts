import { describe, expect, it } from "vitest";
import { POINTER_KINDS, pointerLabel } from "./labels";

describe("pointer labels", () => {
  it("has a plain label for every kind the overlay is sent", () => {
    // The kinds src-tauri/src/hands_desktop.rs sends.
    for (const k of ["click", "right", "double", "move", "pickup", "drop", "scroll_up", "scroll_down"]) {
      expect(POINTER_KINDS).toContain(k);
      expect(pointerLabel(k).length).toBeGreaterThan(3);
    }
  });
  it("never leaves the tag empty and uses no em dashes", () => {
    expect(pointerLabel("something-new")).toBe("Here");
    for (const k of POINTER_KINDS) expect(pointerLabel(k)).not.toContain("—");
  });
});
