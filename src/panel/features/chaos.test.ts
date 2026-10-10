import { describe, expect, it } from "vitest";
import { CONFIRM_TEXT, LEVELS, levelOf, needsConfirm, SAFETY_LINE } from "./chaos";

describe("chaos mode level picker", () => {
  it("has the four levels in order, each explained", () => {
    expect(LEVELS.map((l) => l.id)).toEqual(["off", "gentle", "mischief", "full_virus"]);
    for (const l of LEVELS) expect(l.blurb.length).toBeGreaterThan(10);
  });

  it("reads the level from old and new settings (the old switch off = Off, missing = Gentle)", () => {
    expect(levelOf({ chaos_enabled: false, chaos_level: "full_virus" })).toBe("off");
    expect(levelOf({})).toBe("gentle");
    expect(levelOf({ chaos_enabled: true, chaos_level: "mischief" })).toBe("mischief");
  });

  it("asks once before Full Virus, never for the others", () => {
    expect(needsConfirm("full_virus", {})).toBe(true);
    expect(needsConfirm("full_virus", { chaos_full_confirmed: false })).toBe(true);
    expect(needsConfirm("full_virus", { chaos_full_confirmed: true })).toBe(false);
    for (const l of ["off", "gentle", "mischief"] as const) expect(needsConfirm(l, {})).toBe(false);
  });

  it("the confirmation says what Full Virus does", () => {
    for (const w of ["mouse pointer", "windows", "popups", "fake", "stops"]) expect(CONFIRM_TEXT.toLowerCase()).toContain(w);
    expect(SAFETY_LINE).toContain("Esc");
  });
});
