import { describe, expect, it } from "vitest";
import { BEHAVIOURS, type BehaviourName, Brain } from "./brain";
import { Creature, type CreatureClock, FLOAT_FALL, type Host, type View } from "./creature";
import { mulberry32 } from "./glitchfx";
import { HALF, type World } from "./physics";
import { CALM } from "./render";

const AREA = { x: 0, y: 0, w: 1920, h: 1040 };

function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { fn: () => void; due: number }>();
  const clock: CreatureClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      timers.set(next, { fn, due: now + Math.max(0, ms) });
      return next++;
    },
    clearTimeout: (id) => void timers.delete(id as number),
  };
  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  const run = async (ms: number, each?: () => void) => {
    const end = now + ms;
    await flush();
    for (;;) {
      let id = -1;
      let due = Infinity;
      for (const [k, t] of timers) if (t.due < due) [id, due] = [k, t.due];
      if (id < 0 || due > end) break;
      const t = timers.get(id)!;
      timers.delete(id);
      now = due;
      t.fn();
      each?.();
      await flush();
    }
    now = end;
  };
  return { clock, run };
}

/** Two windows with a 300 px gap, both reaching down near the taskbar; a third high up. */
const FRAMES = [
  { id: 1, x: 300, y: 520, w: 500, h: 500 },
  { id: 2, x: 1100, y: 420, w: 500, h: 600 },
];
const WORLD: World = {
  area: AREA,
  scale: 1,
  ledges: FRAMES.map(({ id, x, y, w }) => ({ id, x, y, w })),
  frames: FRAMES,
};

function setup(seed = 3) {
  const fc = fakeClock();
  const events: string[] = [];
  const host: Host = {
    moveWindow: () => {},
    world: async () => WORLD,
    cursor: () => ({ x: 5, y: 5 }),
    setHitbox: () => {},
    clicked: () => {},
  };
  const view: View = { facingLeft: false, placement: { x: 80, y: 156, angle: 0 }, motion: CALM, platform: null, bodyRect: null, render: () => {} };
  const c = new Creature(host, view, { clock: fc.clock, random: mulberry32(seed) });
  c.onEvent = (e) => events.push(e);
  return { c, fc, events };
}

const onFloorAt = (x: number) => ({ x: x - 80, y: 1040 - 156 });
const onLedge = (id: number, x: number) => ({ x: x - 80, y: WORLD.ledges.find((l) => l.id === id)!.y - 156 });

async function act(name: BehaviourName, at: { x: number; y: number }, seed = 3) {
  const t = setup(seed);
  await t.c.start(at);
  expect(t.c.force(name), name).toBe(true);
  let maxFall = 0;
  let minY = Infinity;
  await t.fc.run(40_000, () => {
    if (t.c.mode === "air") maxFall = Math.max(maxFall, t.c.body.vy);
    minY = Math.min(minY, t.c.body.y);
  });
  return { ...t, maxFall, minY };
}

describe("playful moves", () => {
  it("all are rate-limited moves the dice can pick", () => {
    for (const n of ["copter", "hangOn", "slideDown", "trampoline", "fish", "wallJump"] as const) {
      expect(BEHAVIOURS[n].weight).toBeGreaterThan(0);
      expect(BEHAVIOURS[n].cooldown).toBeGreaterThanOrEqual(90);
      expect(BEHAVIOURS[n].moves).toBe(true);
    }
  });

  it("copter / glide: climbs to the top of a screen edge, floats down slowly, lands on his feet", async () => {
    for (const seed of [1, 2]) {
      const t = await act("copter", onFloorAt(1700), seed);
      expect(t.minY).toBeLessThan(150); // up at the top
      expect(t.maxFall).toBeLessThanOrEqual(FLOAT_FALL + 1); // floating, not falling
      expect(t.events.some((e) => e.startsWith("land:"))).toBe(true);
      expect(t.c.mode).toBe("stand");
      expect(t.c.plan).toBeNull();
    }
  });

  it("hangs off the edge of a window top, then pulls himself back up", async () => {
    const t = setup();
    await t.c.start(onLedge(2, 1300));
    expect(t.c.force("hangOn")).toBe(true);
    let lowest = -Infinity;
    await t.fc.run(15_000, () => (lowest = Math.max(lowest, t.c.body.y)));
    expect(t.events).toContain("hang");
    expect(lowest).toBeGreaterThan(420 - HALF + 50); // hanging below the edge
    expect(t.c.surface.kind).toBe("ledge");
    expect(t.c.body.y + HALF).toBe(420); // back on top
  });

  it("slides down a window's side to the taskbar", async () => {
    const t = await act("slideDown", onLedge(2, 1300));
    expect(t.events).toContain("slide");
    expect(t.c.surface.kind).toBe("floor");
    // Next to the window, not inside it.
    expect(t.c.body.x < 1100 || t.c.body.x > 1600).toBe(true);
  });

  it("bounces on the taskbar like a trampoline (higher each time) and lands", async () => {
    const t = await act("trampoline", onFloorAt(900));
    expect(t.events.filter((e) => e.startsWith("land:floor")).length).toBeGreaterThanOrEqual(4);
    expect(1040 - HALF - t.minY).toBeGreaterThan(200);
    expect(t.c.mode).toBe("stand");
  });

  it("fishes from a window top", async () => {
    const t = setup();
    await t.c.start(onLedge(1, 500));
    expect(t.c.force("fish")).toBe(true);
    await t.fc.run(30_000);
    expect(t.c.surface.kind).toBe("ledge");
    expect(t.c.mode).toBe("stand");
  });

  it("wall-jumps up between two windows and lands on the lower top", async () => {
    const t = await act("wallJump", onFloorAt(950));
    expect(t.events.filter((e) => e === "kick").length).toBeGreaterThanOrEqual(2);
    expect(t.c.surface.kind).toBe("ledge");
    expect(t.c.mode).toBe("stand");
  });

  it("can't be planned where they don't fit", () => {
    const brain = new Brain(mulberry32(1));
    const ctx = { now: 0, world: WORLD, surface: { kind: "floor" } as const, s: 900, movement: true, sleepy: false, excited: false };
    expect(brain.plan("fish", ctx)).toBeNull();
    expect(brain.plan("hangOn", ctx)).toBeNull();
    expect(brain.plan("slideDown", ctx)).toBeNull();
    expect(brain.plan("wallJump", { ...ctx, world: { ...WORLD, frames: [] } })).toBeNull();
  });

  it("an interrupted wall jump or hang never leaves him stuck in the air", async () => {
    const t = setup();
    await t.c.start(onFloorAt(950));
    t.c.force("wallJump");
    for (let i = 0; i < 200 && !t.events.includes("kick"); i++) await t.fc.run(20);
    expect(t.events).toContain("kick");
    t.c.setPanelOpen(true); // the chat opens mid-kick
    await t.fc.run(4000);
    expect(t.c.mode).toBe("stand");
  });
});
