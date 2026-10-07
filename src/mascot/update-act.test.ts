import { describe, expect, it } from "vitest";
import { ACT_FALLBACKS, playFirst, signLines, UpdateActor } from "./update-act";

describe("update act", () => {
  it("falls back to animations that exist", () => {
    const known = new Set(["happy", "startled", "run"]);
    const tried: string[] = [];
    const play = (n: string) => (tried.push(n), known.has(n));
    expect(playFirst("hold_sign", play)).toBe("happy");
    expect(playFirst("knock_screen", play)).toBe("startled");
    expect(tried).toEqual(["hold_sign", "happy", "knock_screen", "chaos:knock", "startled"]);
    // Once the real art exists it is used first.
    expect(playFirst("hold_sign", () => true)).toBe("hold_sign");
    expect(playFirst("nothing", () => false)).toBeNull();
    expect(Object.keys(ACT_FALLBACKS)).toEqual(["run", "knock_screen", "hold_sign"]);
  });

  it("fits sign text on two short lines", () => {
    expect(signLines("Claude Code is done")).toEqual(["Claude Code is", "done"]);
    expect(signLines("3 WhatsApp, 1 Teams")).toEqual(["3 WhatsApp, 1", "Teams"]);
    expect(signLines("a very long sign text that goes on and on")).toEqual(["a very long sign", "text that goes…"]);
    expect(signLines("Supercalifragilisticexpialidocious")).toEqual(["Supercalifragil…"]);
  });

  it("plays the steps in order and shows the sign, then takes it down", () => {
    const timers: { fn: () => void; ms: number }[] = [];
    const played: string[] = [];
    let shown: string[] | null = null;
    const actor = new UpdateActor(
      { play: (n) => (played.push(n), n !== "knock_screen"), setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout: () => {} },
      (lines) => ((shown = lines), () => (shown = null)),
    );
    actor.run({ steps: ["run", "knock_screen", "hold_sign"], sign: "Claude Code is done", sign_ms: 5000 });
    expect(timers.map((t) => t.ms)).toEqual([0, 2400, 3900]);
    for (const t of timers.splice(0)) t.fn();
    expect(played).toEqual(["run", "knock_screen", "chaos:knock", "hold_sign"]);
    expect(shown).toEqual(["Claude Code is", "done"]);
    expect(timers.map((t) => t.ms)).toEqual([5000]);
    timers[0].fn();
    expect(shown).toBeNull();
  });
});
