// Round-4 interactions: his eyes follow the cursor while he rests, petting,
// high fives, and the jump scare when woken right after dozing off.

import { describe, expect, it } from "vitest";
import type { Pose } from "./animations";
import { Creature, gazeSector, type Host, type View } from "./creature";
import { mulberry32 } from "./glitchfx";
import type { Vec, World } from "./physics";
import { CALM } from "./render";

function fakeClock() {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let id = 1;
  return {
    clock: {
      now: () => now,
      setTimeout: (fn: () => void, ms: number) => {
        timers.set(id, { at: now + ms, fn });
        return id++;
      },
      clearTimeout: (t: unknown) => void timers.delete(t as number),
    },
    async run(ms: number) {
      const end = now + ms;
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | null = null;
        for (const e of timers) if (!next || e[1].at < next[1].at) next = e;
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await Promise.resolve();
        await Promise.resolve();
      }
      now = end;
    },
  };
}

const WORLD: World = { area: { x: 0, y: 0, w: 1920, h: 1040 }, scale: 1, ledges: [] };

async function setup(seed = 3) {
  const fc = fakeClock();
  let cursor: Vec = { x: 0, y: 0 };
  const host: Host = {
    moveWindow: () => {},
    world: () => Promise.resolve(WORLD),
    cursor: () => Promise.resolve(cursor),
    setHitbox: () => {},
    clicked: () => {},
  } as Host;
  const poses: Pose[] = [];
  const view: View = {
    facingLeft: false,
    placement: { x: 80, y: 156, angle: 0 },
    motion: CALM,
    platform: null,
    bodyRect: { x: 15, y: 70, w: 125, h: 86 },
    render(pose) {
      poses.push(pose);
    },
  } as View;
  const c = new Creature(host, view, { clock: fc.clock, random: mulberry32(seed) } as never);
  await c.start({ x: 900, y: 1040 - 40 });
  c.setPanelOpen(true); // no wandering off
  await fc.run(1500);
  return { c, fc, poses, setCursor: (p: Vec) => (cursor = p) };
}

describe("gaze sectors", () => {
  it("maps screen directions to the look_dirs frames, with hysteresis", () => {
    expect([90, 45, 0, -45, -90, -135, 180, 135].map((a) => gazeSector(a, null))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(gazeSector(70, 0)).toBe(0); // 20 deg off up: still up
    expect(gazeSector(62, 0)).toBe(0); // within the 8 deg margin past the edge
    expect(gazeSector(55, 0)).toBe(1); // clearly up-right now
  });
});

describe("his eyes follow the cursor while he rests", () => {
  it("looks up-left at a cursor up-left of him, holds each change >= 300 ms, looks back at you when it goes away", async () => {
    const t = await setup();
    t.setCursor({ x: 900 - 150, y: 1040 - 40 - 170 });
    const seen: { at: number; frame: string }[] = [];
    for (let i = 0; i < 60; i++) {
      await t.fc.run(50);
      const f = t.poses.at(-1)?.frame ?? "";
      if (seen.at(-1)?.frame !== f) seen.push({ at: i * 50, frame: f });
    }
    expect(seen.some((s) => s.frame === "look_dirs7"), seen.map((s) => s.frame).join(" ")).toBe(true);
    // Away (far): back to the normal idle.
    t.setCursor({ x: 100, y: 100 });
    await t.fc.run(2500);
    expect(t.poses.at(-1)?.frame.startsWith("look_dirs")).toBe(false);
    t.c.dispose();
  });
});

describe("petting", () => {
  it("rubbing his head plays petted and calms him down; stopping ends it", async () => {
    const t = await setup();
    // Annoy him a bit first (pokes).
    for (let i = 0; i < 4; i++) {
      t.c.pointerDown({ x: 60, y: 120 });
      await t.fc.run(400);
      t.c.pointerUp();
      await t.fc.run(1500);
    }
    const before = t.c.annoyance;
    expect(before).toBeGreaterThan(1);
    for (let i = 0; i < 40; i++) {
      t.c.pointerMove({ x: 70 + (i % 2 ? 8 : -8), y: 85 });
      await t.fc.run(40);
    }
    expect(t.c.animator.animation).toBe("petted");
    expect(t.c.annoyance).toBeLessThan(before - 0.5); // ~1 level per second of petting
    await t.fc.run(1500);
    expect(t.c.animator.animation).not.toBe("petted");
    t.c.dispose();
  });
});

describe("taps", () => {
  it("a quick tap on his raised-paw side while he's happy: a high five", async () => {
    const t = await setup();
    t.c.pointerDown({ x: 125, y: 90 });
    await t.fc.run(100);
    t.c.pointerUp();
    expect(t.c.animator.animation).toBe("high_five");
    t.c.dispose();
  });

  it("a click right after he dozed off: jump scare", async () => {
    const t = await setup();
    t.c.playAction("sleep");
    // Asleep by the brain's own path: enterSleep marks the time.
    (t.c as unknown as { enterSleep(): void }).enterSleep();
    await t.fc.run(3000);
    t.c.pointerDown({ x: 60, y: 120 });
    expect(t.c.animator.animation).toBe("jump_scare");
    t.c.pointerUp();
    expect(t.c.animator.animation).toBe("jump_scare");
    t.c.dispose();
  });
});
