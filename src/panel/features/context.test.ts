import { describe, expect, it } from "vitest";
import { CONTEXT_DEFAULTS } from "../../shared/context";
import { contextSettings, REACTION_SWITCHES } from "./context";
import { FEATURES } from "./index";

describe("context feature card", () => {
  it("fills in defaults for old settings files", () => {
    expect(contextSettings({})).toEqual(CONTEXT_DEFAULTS);
    expect(contextSettings({ context: { ...CONTEXT_DEFAULTS, music: false } }).music).toBe(false);
  });

  it("defaults: everything on except the focus auto-suggest", () => {
    for (const [k, v] of Object.entries(CONTEXT_DEFAULTS)) if (typeof v === "boolean") expect(v, k).toBe(k !== "focus_suggest");
  });

  it("has a switch for every reaction and is registered", () => {
    const bools = Object.entries(CONTEXT_DEFAULTS).filter(([k, v]) => typeof v === "boolean" && k !== "enabled").map(([k]) => k);
    expect(REACTION_SWITCHES.map((r) => r.key).sort()).toEqual(bools.sort());
    for (const r of REACTION_SWITCHES) expect(r.hint).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`));
    expect(FEATURES.map((f) => f.id)).toContain("context");
  });
});
