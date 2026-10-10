import { describe, expect, it } from "vitest";
import { Creature, type CreatureClock, type Host, type View } from "./creature";
import { mulberry32 } from "./glitchfx";
import type { Vec } from "./physics";
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
  const run = async (ms: number) => {
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
      await flush();
    }
    now = end;
  };
  return { clock, run };
}

function setup() {
  const fc = fakeClock();
  const frame = { x: 600, y: 500, w: 500, h: 300 };
  let open = true;
  let watching: number | null = null;
  const wins: Vec[] = [];
  const host: Host = {
    moveWindow: (x, y) => void wins.push({ x, y }),
    world: async () => ({ area: AREA, scale: 1, ledges: open ? [{ id: 5, x: frame.x, y: frame.y, w: frame.w }] : [] }),
    cursor: () => ({ x: 10, y: 10 }),
    setHitbox: () => {},
    clicked: () => {},
    watchLedge: async (id) => {
      watching = id;
      return { events: false, frame: id === null || !open ? null : { ...frame } };
    },
    ledgeFrame: async () => (open ? { ...frame } : null),
  };
  const view: View = { facingLeft: false, placement: { x: 80, y: 156, angle: 0 }, motion: CALM, platform: null, bodyRect: null, render: () => {} };
  const c = new Creature(host, view, { clock: fc.clock, random: mulberry32(5) });
  return {
    c,
    fc,
    frame,
    wins,
    close: () => (open = false),
    get watching() {
      return watching;
    },
  };
}

/** Start him standing on the window top. */
async function onTop(t: ReturnType<typeof setup>) {
  await t.c.start({ x: 800 - 80, y: 500 - 156 });
  t.c.setMovement(false); // no wandering off during the test
  expect(t.c.surface.kind).toBe("ledge");
  await t.fc.run(100);
  expect(t.watching).toBe(5);
}

describe("standing on a window that moves", () => {
  it("rides along a slow drag smoothly: his window follows every tick, no jumps", async () => {
    const t = setup();
    await onTop(t);
    const x0 = t.c.body.x;
    const n0 = t.wins.length;
    for (let i = 0; i < 60; i++) {
      t.frame.x += 4; // 120 px/s at 30 Hz
      await t.fc.run(34);
    }
    expect(t.c.mode).toBe("stand");
    expect(t.c.surface.kind).toBe("ledge");
    const moves = t.wins.slice(n0);
    expect(moves.length).toBeGreaterThan(40);
    for (let i = 1; i < moves.length; i++) expect(Math.abs(moves[i].x - moves[i - 1].x)).toBeLessThanOrEqual(12);
    expect(t.c.body.x - x0).toBeGreaterThan(200);
  });

  it("falls with physics (no teleport) when the window jumps out from under him", async () => {
    const t = setup();
    await onTop(t);
    const x0 = t.c.body.x;
    t.frame.x += 600; // now 1200..1700, he's at 800
    await t.fc.run(40);
    expect(t.c.mode).toBe("air");
    expect(Math.abs(t.c.body.x - x0)).toBeLessThan(30); // he stayed where he was, the window left
    await t.fc.run(3000);
    expect(t.c.mode).toBe("stand");
    expect(t.c.surface.kind).toBe("floor");
  });

  it("a fast yank that leaves the window under him: it slides under his feet, he stays put", async () => {
    const t = setup();
    await onTop(t);
    const x0 = t.c.body.x;
    t.frame.x += 60; // ~1800 px/s
    await t.fc.run(40);
    expect(t.c.mode).toBe("stand");
    expect(t.c.surface.kind).toBe("ledge");
    expect(Math.abs(t.c.body.x - x0)).toBeLessThan(2);
    // And then he rides the slow part again.
    for (let i = 0; i < 10; i++) {
      t.frame.x += 3;
      await t.fc.run(34);
    }
    expect(t.c.body.x - x0).toBeGreaterThan(20);
  });

  it("falls when the window closes or is minimised, and stops watching it", async () => {
    const t = setup();
    await onTop(t);
    t.close();
    await t.fc.run(60);
    expect(t.c.mode).toBe("air");
    await t.fc.run(4000);
    expect(t.c.surface.kind).toBe("floor");
    expect(t.watching).toBeNull();
  });

  it("events from Rust: rides small moves, falls on a big one, ignores other windows", async () => {
    const t = setup();
    await onTop(t);
    t.c.setMovement(false);
    const x0 = t.c.body.x;
    t.c.ledgeEvent({ id: 99, kind: "gone", frame: null });
    expect(t.c.mode).toBe("stand");
    await t.fc.run(34);
    t.frame.x += 5;
    t.c.ledgeEvent({ id: 5, kind: "move", frame: { ...t.frame } });
    expect(t.c.mode).toBe("stand");
    expect(t.c.body.x).toBe(x0 + 5);
    t.c.ledgeEvent({ id: 5, kind: "gone", frame: null });
    expect(t.c.mode).toBe("air");
  });
});
