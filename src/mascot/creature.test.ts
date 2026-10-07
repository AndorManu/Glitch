import { describe, expect, it } from "vitest";
import { IDLE_BUDGET, type Pose } from "./animations";
import { Creature, type CreatureClock, type Host, LEDGE_WATCH_MS, SLEEP_AFTER_MS, type View, WORLD_MIN_MS } from "./creature";
import { mulberry32 } from "./glitchfx";
import { HALF, type Vec, type World } from "./physics";
import { type BodyRect, CALM } from "./render";

/** Fake clock: timers fire in due order; promises settle between timers. */
function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { fn: () => void; due: number }>();
  let wakeups = 0;
  const clock: CreatureClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      timers.set(next, { fn, due: now + Math.max(0, ms) });
      return next++;
    },
    clearTimeout: (id) => void timers.delete(id as number),
  };
  const flush = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  /** Run fake time forward by `ms`. */
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
      wakeups++;
      t.fn();
      await flush();
    }
    now = end;
  };
  return { clock, run, timers, get now() { return now; }, get wakeups() { return wakeups; } };
}

interface Rec {
  moves: number[];
  renders: number[];
  polls: number[];
  hitboxes: (BodyRect | null)[];
  clicks: number;
}

function setup(o: { world?: World; window?: Vec; seed?: number } = {}) {
  const fc = fakeClock();
  let world: World = o.world ?? { area: { x: 0, y: 0, w: 1920, h: 1040 }, scale: 1, ledges: [] };
  const rec: Rec = { moves: [], renders: [], polls: [], hitboxes: [], clicks: 0 };
  let cursor: Vec = { x: 0, y: 0 };
  let win: Vec = o.window ?? { x: 1700, y: 1040 - 160 };
  const host: Host = {
    moveWindow: (x, y) => {
      win = { x, y };
      rec.moves.push(fc.now);
    },
    world: () => {
      rec.polls.push(fc.now);
      return Promise.resolve(world);
    },
    cursor: () => cursor,
    setHitbox: (r) => void rec.hitboxes.push(r),
    clicked: () => void rec.clicks++,
  };
  const view: View & { last: Pose | null } = {
    facingLeft: false,
    placement: { x: 80, y: 156, angle: 0 },
    motion: CALM,
    platform: null,
    bodyRect: { x: 15, y: 70, w: 125, h: 86 },
    last: null,
    render(pose) {
      this.last = pose;
      rec.renders.push(fc.now);
    },
  };
  const c = new Creature(host, view, { clock: fc.clock, random: mulberry32(o.seed ?? 1) });
  return {
    c,
    fc,
    rec,
    view,
    get win() {
      return win;
    },
    setWorld: (w: World) => (world = w),
    setCursor: (p: Vec) => (cursor = p),
  };
}

/** Events per second inside [from, to). */
const rate = (times: number[], from: number, to: number) => times.filter((t) => t >= from && t < to).length / ((to - from) / 1000);

/** The highest number of events in any 1 s window. */
function peak(times: number[]): number {
  let best = 0;
  let j = 0;
  for (let i = 0; i < times.length; i++) {
    while (times[i] - times[j] >= 1000) j++;
    best = Math.max(best, i - j + 1);
  }
  return best;
}

describe("creature: standing, resting, budgets", () => {
  it("starts on the floor where the window is, feet on the bottom of the work area", async () => {
    const t = setup();
    await t.c.start({ x: 1700, y: 1040 - 160 - 24 }); // Rust's home spot (24 px margin)
    expect(t.c.surface.kind).toBe("floor");
    expect(t.c.body.y + HALF).toBe(1040);
    expect(t.win.y + 156).toBe(1040);
    expect(t.c.moving).toBe(false); // no movement timer while standing still
    expect(t.rec.hitboxes.at(-1)).toEqual({ x: 15, y: 70, w: 125, h: 86 });
  });

  it("dropped from high up at start, he falls onto the floor", async () => {
    const t = setup();
    await t.c.start({ x: 900, y: 200 });
    expect(t.c.mode).toBe("air");
    await t.fc.run(2000);
    expect(t.c.mode).toBe("stand");
    expect(t.c.surface.kind).toBe("floor");
  });

  it("resting: under IDLE_BUDGET repaints and timer wakeups per second, no window moves, no polling", async () => {
    for (let seed = 1; seed <= 8; seed++) {
      const t = setup({ seed });
      await t.c.start({ x: 1700, y: 880 });
      t.c.setPanelOpen(true); // chat open: he stays put
      await t.fc.run(1000);
      const w0 = t.fc.wakeups;
      const from = t.fc.now;
      await t.fc.run(120_000);
      const secs = 120;
      expect(rate(t.rec.renders, from, from + 120_000), `seed ${seed} repaints/s`).toBeLessThan(IDLE_BUDGET);
      expect((t.fc.wakeups - w0) / secs, `seed ${seed} wakeups/s`).toBeLessThan(IDLE_BUDGET);
      expect(rate(t.rec.moves, from, from + 120_000)).toBe(0);
      expect(rate(t.rec.polls, from, from + 120_000)).toBe(0);
      console.info(`resting seed ${seed}: ${rate(t.rec.renders, from, from + 120_000).toFixed(2)} repaints/s, ${((t.fc.wakeups - w0) / secs).toFixed(2)} wakeups/s`);
      expect(t.c.moving).toBe(false);
      t.c.dispose();
    }
  });

  it("resting on a window top: still under budget with the ledge watch", async () => {
    const top = { id: 4, x: 1500, y: 700, w: 400 };
    const t = setup({ world: { area: { x: 0, y: 0, w: 1920, h: 1040 }, scale: 1, ledges: [top] } });
    await t.c.start({ x: 1620, y: 700 - 156 });
    expect(t.c.surface.kind).toBe("ledge");
    t.c.setPanelOpen(true);
    await t.fc.run(1000);
    const w0 = t.fc.wakeups;
    const from = t.fc.now;
    await t.fc.run(120_000);
    expect(rate(t.rec.renders, from, from + 120_000)).toBeLessThan(IDLE_BUDGET);
    expect((t.fc.wakeups - w0) / 120).toBeLessThan(IDLE_BUDGET);
    console.info(`resting on a window top: ${rate(t.rec.renders, from, from + 120_000).toFixed(2)} repaints/s, ${((t.fc.wakeups - w0) / 120).toFixed(2)} wakeups/s`);
    const polls = t.rec.polls.filter((p) => p >= from);
    expect(polls.length).toBeGreaterThan(30); // it does keep an eye on the window under him
    expect(polls.length / 120).toBeLessThanOrEqual(1000 / LEDGE_WATCH_MS + 0.01);
  });

  it("an hour awake: mostly resting, polls spaced >= 1.5 s, moves/repaints within the walking/flying caps", async () => {
    const ledges = [
      { id: 1, x: 200, y: 640, w: 520 },
      { id: 2, x: 900, y: 500, w: 600 },
    ];
    for (const seed of [1, 2, 3]) {
      const t = setup({ seed, world: { area: { x: 0, y: 0, w: 1920, h: 1040 }, scale: 1, ledges } });
      await t.c.start({ x: 1700, y: 880 });
      const plans: string[] = [];
      t.c.onEvent = (e) => e.startsWith("plan:") && plans.push(e);
      // Someone wiggles the mouse over him every 9 minutes so he doesn't fall asleep.
      for (let m = 0; m < 60; m += 3) {
        await t.fc.run(3 * 60_000);
        if (m % 9 === 0) t.c.wake();
      }
      const hour = 3_600_000;
      expect(t.c.stats.movingMs / hour, `seed ${seed} moving fraction`).toBeLessThanOrEqual(0.25);
      expect(plans.length, `seed ${seed}`).toBeGreaterThan(40);
      const gaps = t.rec.polls.slice(1).map((p, i) => p - t.rec.polls[i]);
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(WORLD_MIN_MS);
      // Window moves: never above 60/s in any second (that's only in the air / held); repaints likewise.
      expect(peak(t.rec.moves)).toBeLessThanOrEqual(60);
      expect(peak(t.rec.renders)).toBeLessThanOrEqual(60);
      // Average over the hour stays tiny.
      expect(t.rec.renders.length / 3600, `seed ${seed} average repaints/s`).toBeLessThan(5);
      console.info(
        `hour seed ${seed}: moving ${((100 * t.c.stats.movingMs) / hour).toFixed(1)}%, ${plans.length} plans, ` +
          `avg ${(t.rec.renders.length / 3600).toFixed(2)} repaints/s, ${(t.rec.moves.length / 3600).toFixed(2)} moves/s, ` +
          `${t.rec.polls.length} polls (min gap ${Math.min(...gaps)} ms), peak ${peak(t.rec.moves)} moves/s ${peak(t.rec.renders)} repaints/s, wakeups ${(t.fc.wakeups / 3600).toFixed(2)}/s`,
      );
      t.c.dispose();
    }
  });

  it("walking / climbing: at most 30 window moves and 30 repaints per second", async () => {
    const t = setup({ seed: 4 });
    await t.c.start({ x: 1700, y: 880 });
    expect(t.c.playAction("climb")).toBe(true);
    const from = t.fc.now;
    let walkingMs = 0;
    const moves: number[] = [];
    const renders: number[] = [];
    // Sample: only seconds where he's on a surface (walking/climbing), not flying.
    for (let i = 0; i < 400; i++) {
      const m0 = t.rec.moves.length;
      const r0 = t.rec.renders.length;
      const stand = t.c.mode === "stand" || t.c.mode === "corner";
      await t.fc.run(100);
      if (stand && (t.c.mode === "stand" || t.c.mode === "corner") && t.c.moving) {
        walkingMs += 100;
        moves.push(...t.rec.moves.slice(m0));
        renders.push(...t.rec.renders.slice(r0));
      }
    }
    expect(walkingMs).toBeGreaterThan(10_000);
    expect(moves.length / (walkingMs / 1000)).toBeLessThanOrEqual(30.5);
    expect(renders.length / (walkingMs / 1000)).toBeLessThanOrEqual(30.5);
    // The window carries a walking sprite: far fewer repaints than moves.
    expect(renders.length).toBeLessThan(moves.length * 0.8);
    console.info(`walking/climbing: ${(moves.length / (walkingMs / 1000)).toFixed(1)} moves/s, ${(renders.length / (walkingMs / 1000)).toFixed(1)} repaints/s over ${walkingMs} ms`);
    void from;
  });

  it("flying: at most 60 moves and 60 repaints per second, and the timer stops after landing", async () => {
    const t = setup();
    await t.c.start({ x: 900, y: 100 });
    const from = t.fc.now;
    await t.fc.run(1500);
    expect(t.c.mode).toBe("stand");
    expect(peak(t.rec.moves.filter((m) => m >= from))).toBeLessThanOrEqual(60);
    console.info(`flying: peak ${peak(t.rec.moves.filter((m) => m >= from))} moves/s, ${peak(t.rec.renders.filter((m) => m >= from))} repaints/s`);
    expect(peak(t.rec.renders.filter((m) => m >= from))).toBeLessThanOrEqual(60);
    t.c.setPanelOpen(true);
    await t.fc.run(1000);
    expect(t.c.moving).toBe(false);
    const n = t.rec.moves.length;
    await t.fc.run(30_000);
    expect(t.rec.moves.length).toBe(n);
  });
});

describe("creature: the world changes", () => {
  const area = { x: 0, y: 0, w: 1920, h: 1040 };
  const top = { id: 4, x: 1400, y: 700, w: 450 };

  it("rides along when the window he stands on moves a little", async () => {
    const t = setup({ world: { area, scale: 1, ledges: [top] } });
    await t.c.start({ x: 1620, y: 700 - 156 });
    t.c.setPanelOpen(true);
    const x0 = t.c.body.x;
    t.setWorld({ area, scale: 1, ledges: [{ ...top, x: top.x - 100, y: top.y - 30 }] });
    // The window then eases after the body over ~0.1-0.2 s (no jump).
    await t.fc.run(LEDGE_WATCH_MS + 500);
    expect(t.c.surface.kind).toBe("ledge");
    expect(t.c.body.x).toBe(x0 - 100);
    expect(t.c.body.y + HALF).toBe(670);
    expect(t.win.y + 156).toBe(670);
  });

  it("falls when the window under him disappears (or jumps far away)", async () => {
    const t = setup({ world: { area, scale: 1, ledges: [top] } });
    await t.c.start({ x: 1620, y: 700 - 156 });
    t.c.setPanelOpen(true);
    t.setWorld({ area, scale: 1, ledges: [] });
    await t.fc.run(LEDGE_WATCH_MS + 100);
    expect(t.c.mode).toBe("air");
    await t.fc.run(2000);
    expect(t.c.mode).toBe("stand");
    expect(t.c.surface.kind).toBe("floor");
  });

  it("asleep: no polling at all; wakes on hover", async () => {
    const t = setup({ world: { area, scale: 1, ledges: [top] } });
    await t.c.start({ x: 1700, y: 880 });
    t.c.setMovement(false); // keep him in place
    await t.fc.run(SLEEP_AFTER_MS + 90_000);
    expect(t.c.asleep).toBe(true);
    expect(t.c.animation).toBe("sleep");
    const polls = t.rec.polls.length;
    const w0 = t.fc.wakeups;
    await t.fc.run(600_000);
    expect(t.rec.polls.length).toBe(polls);
    expect((t.fc.wakeups - w0) / 600).toBeLessThanOrEqual(0.5);
    t.c.setHovered(true);
    expect(t.c.asleep).toBe(false);
  });
});

describe("creature: reactions", () => {
  it("thinking stops a walk on the spot; listening perks up; unknown moods mean idle", async () => {
    const t = setup({ seed: 5 });
    await t.c.start({ x: 1700, y: 880 });
    t.c.playAction("stroll");
    await t.fc.run(400);
    expect(t.c.moving).toBe(true);
    t.c.setMood("thinking");
    expect(t.c.plan).toBeNull();
    expect(t.c.animation).toBe("think");
    await t.fc.run(200);
    expect(t.c.moving).toBe(false);
    t.c.setMood("listening");
    expect(t.c.animation).toBe("listen");
    await t.fc.run(30_000);
    expect(t.c.plan).toBeNull(); // doesn't wander off while you talk
    t.c.setMood("bogus-mood");
    expect(t.c.mood).toBe("idle");
    expect(t.c.animation).toBe("idle");
  });

  it("talks while a reply appears, then goes back to idle; not while thinking", async () => {
    const t = setup({ seed: 3 });
    await t.c.start({ x: 1700, y: 880 });
    await t.fc.run(500);
    t.c.talk(60); // 60 chars: 2.7 s
    expect(t.c.animation).toBe("talk");
    await t.fc.run(2000);
    expect(t.c.animation).toBe("talk");
    await t.fc.run(1000);
    expect(t.c.mood).toBe("idle");
    expect(t.c.animation).not.toBe("talk");
    t.c.setMood("thinking");
    t.c.talk(60);
    expect(t.c.animation).toBe("think");
    t.c.dispose();
  });

  it("listening: at most ~10 repaints per second", async () => {
    const t = setup();
    await t.c.start({ x: 1700, y: 880 });
    t.c.setMood("listening");
    const from = t.fc.now;
    await t.fc.run(20_000);
    expect(rate(t.rec.renders, from, from + 20_000)).toBeLessThanOrEqual(10.5);
  });

  it("movement off: gets down from the ceiling, then stays put on the floor", async () => {
    const t = setup({ seed: 2 });
    await t.c.start({ x: 1700, y: 880 });
    expect(t.c.playAction("teleport")).toBe(true);
    // Find a seed-independent way onto the ceiling: keep teleporting until he's there.
    const kind = () => t.c.surface.kind as string;
    for (let i = 0; i < 20 && kind() !== "ceiling"; i++) {
      await t.fc.run(4000);
      if (kind() !== "ceiling") t.c.playAction("teleport");
    }
    expect(t.c.surface.kind).toBe("ceiling");
    t.c.setMovement(false);
    await t.fc.run(5000);
    expect(t.c.surface.kind).toBe("floor");
    const n = t.rec.moves.length;
    await t.fc.run(10 * 60_000);
    expect(t.rec.moves.length).toBe(n);
  });

  it("a plain click calls mascotClicked; the hitbox opens up while a drag could start", async () => {
    const t = setup();
    await t.c.start({ x: 1700, y: 880 });
    t.c.pointerDown({ x: 80, y: 110 });
    expect(t.rec.hitboxes.at(-1)).toBeNull();
    t.c.pointerMove({ x: 82, y: 111 }); // under the threshold
    t.c.pointerUp();
    expect(t.rec.clicks).toBe(1);
    expect(t.rec.hitboxes.at(-1)).not.toBeNull();
    expect(t.c.mode).toBe("stand");
  });

  it("drag & throw: follows the cursor, swings, flies with the cursor's velocity, lands", async () => {
    const t = setup();
    await t.c.start({ x: 1000, y: 880 });
    const grab = { x: t.win.x + 80, y: t.win.y + 100 };
    t.setCursor(grab);
    t.c.pointerDown({ x: 80, y: 100 });
    t.c.pointerMove({ x: 90, y: 100 });
    expect(t.c.mode).toBe("held");
    expect(t.c.held).toBe(true);
    expect(t.rec.clicks).toBe(0);
    // Carry him up and to the left over 1 s...
    for (let i = 1; i <= 60; i++) {
      t.setCursor({ x: grab.x - i * 8, y: grab.y - i * 8 });
      await t.fc.run(17);
    }
    expect(t.c.body.y).toBeLessThan(grab.y - 400); // hanging just under the cursor
    // ...then fling right fast.
    for (let i = 1; i <= 6; i++) {
      t.setCursor({ x: grab.x - 480 + i * 40, y: grab.y - 480 });
      await t.fc.run(17);
    }
    t.c.pointerUp();
    expect(t.c.mode).toBe("air");
    expect(t.c.body.vx).toBeGreaterThan(1000);
    const moves0 = t.rec.moves.length;
    await t.fc.run(1000);
    expect(t.rec.moves.length - moves0).toBeLessThanOrEqual(60);
    await t.fc.run(5000);
    expect(t.c.mode).toBe("stand");
    expect(t.rec.clicks).toBe(0);
  });

  it("caught in mid-air", async () => {
    const t = setup();
    await t.c.start({ x: 900, y: 100 });
    await t.fc.run(200);
    expect(t.c.mode).toBe("air");
    t.setCursor({ x: t.win.x + 80, y: t.win.y + 80 });
    t.c.pointerDown({ x: 80, y: 80 });
    expect(t.c.mode).toBe("held");
    t.c.pointerUp();
    expect(t.c.mode).toBe("air");
  });

  it("actions: animations and behaviours by name; unknown names ignored", async () => {
    const t = setup();
    await t.c.start({ x: 1700, y: 880 });
    expect(t.c.playAction("nonsense")).toBe(false);
    expect(t.c.playAction("grabCursor")).toBe(true);
    expect(t.c.animation).toBe("grabCursor");
    expect(t.c.playAction("dragWindow")).toBe(true);
    await t.fc.run(9000);
    expect(t.c.animation).not.toBe("dragWindow"); // loops stop by themselves
    expect(t.c.playAction("climb")).toBe(true);
    expect(t.c.plan?.name).toBe("climb");
  });
});
