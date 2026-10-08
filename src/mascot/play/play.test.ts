import { describe, expect, it } from "vitest";
import type { PetEventKind, PetView } from "../../shared/ipc";
import { PLAY_DEFAULTS } from "../../shared/ipc";
import { Accessories, headTop, recolour } from "../accessories";
import type { Pose } from "../animations";
import { Creature, type CreatureClock, type Host, type View } from "../creature";
import { mulberry32 } from "../glitchfx";
import { HALF, type Surface, type Vec, type World } from "../physics";
import { CALM } from "../render";
import { GIVE_UP_MS, Play, type PlayEnv } from "./games";
import { type Ball, BALL_R, HIDE_SINK, hideSpot, playAnim, route, stepBall, surfaceNear } from "./rules";

const WORLD: World = { area: { x: 0, y: 0, w: 1920, h: 1040 }, scale: 1, ledges: [{ id: 7, x: 400, y: 500, w: 600 }] };

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
    for (let i = 0; i < 6; i++) await Promise.resolve();
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
  let cursor: Vec = { x: 300, y: 900 };
  const host: Host = {
    moveWindow: () => {},
    world: () => Promise.resolve(WORLD),
    cursor: () => cursor,
    setHitbox: () => {},
    clicked: () => {},
  };
  const view: View = {
    facingLeft: false,
    placement: { x: 80, y: 156, angle: 0 },
    motion: CALM,
    platform: null,
    bodyRect: { x: 15, y: 70, w: 125, h: 86 },
    render: (_p: Pose) => {},
  };
  const c = new Creature(host, view, { clock: fc.clock, random: mulberry32(3) });
  const events: PetEventKind[] = [];
  const ball: { open: number; closed: number; at: Vec | null } = { open: 0, closed: 0, at: null };
  const acc = new Accessories(() => {}, fc.clock.now);
  const env: PlayEnv = {
    creature: c,
    acc,
    clock: fc.clock,
    rand: mulberry32(9),
    cursor: () => Promise.resolve(cursor),
    ballOpen: async (x, y) => {
      ball.open++;
      ball.at = { x, y };
      return 44;
    },
    ballMove: (x, y) => void (ball.at = { x, y }),
    ballClose: () => void ball.closed++,
    petEvent: (k) => void events.push(k),
    settings: () => PLAY_DEFAULTS,
  };
  const play = new Play(env);
  return { c, fc, play, acc, events, ball, setCursor: (p: Vec) => (cursor = p) };
}

describe("play rules", () => {
  it("asks for new art by name and falls back until it exists", () => {
    const none = () => false;
    expect(playAnim("fetch_ball", (n) => n === "walk")).toBe("walk");
    expect(playAnim("fetch_ball", (n) => n === "fetch_ball")).toBe("fetch_ball");
    expect(playAnim("hide_peek", (n) => n === "listen")).toBe("listen");
    expect(playAnim("anything", none)).toBe("idle");
    // With the real animation table: present ones are used as they are.
    expect(playAnim("dance")).toBe("dance");
    expect(playAnim("eat")).toBe("eat");
  });

  it("a thrown ball bounces and comes to rest on the floor, its bottom on the taskbar line", () => {
    const b: Ball = { x: 1500, y: 300, vx: 400, vy: -200 };
    let rest: Surface | null = null;
    let landedHigh = 0;
    for (let i = 0; i < 2000 && !rest; i++) {
      rest = stepBall(b, WORLD, 1 / 60);
      if (b.vy < 0 && b.y > 900) landedHigh++;
    }
    expect(rest?.kind).toBe("floor");
    expect(b.y + BALL_R).toBeCloseTo(1040, 5);
    expect(landedHigh).toBeGreaterThan(0); // it bounced on the way
    expect(b.x).toBeGreaterThan(1500); // kept going the way it was thrown
    expect(b.x).toBeLessThanOrEqual(1920 - BALL_R);
  });

  it("a ball dropped over a window top lands on it", () => {
    const b: Ball = { x: 700, y: 100, vx: 0, vy: 0 };
    let rest: Surface | null = null;
    for (let i = 0; i < 2000 && !rest; i++) rest = stepBall(b, WORLD, 1 / 60);
    expect(rest).toEqual({ kind: "ledge", ledge: WORLD.ledges[0] });
    expect(b.y + BALL_R).toBeCloseTo(500, 5);
  });

  it("routes: walk on the same surface, jump when in reach, glitch there otherwise", () => {
    const floor: Surface = { kind: "floor" };
    const ledge: Surface = { kind: "ledge", ledge: WORLD.ledges[0] };
    const onFloor = { surface: floor, body: { x: 700, y: 1040 - HALF }, s: 700 };
    expect(route(onFloor, floor, 1200, WORLD)).toEqual([{ do: "walk", to: 1200, gait: "run", anim: undefined }]);
    const up = route(onFloor, ledge, 700, WORLD);
    expect(up.map((s) => s.do)).toEqual(["face", "jump"]);
    const far: World = { ...WORLD, ledges: [{ id: 8, x: 400, y: 120, w: 600 }] };
    expect(route(onFloor, { kind: "ledge", ledge: far.ledges[0] }, 700, far)[0].do).toBe("teleport");
    expect(route({ surface: { kind: "left" }, body: { x: 40, y: 500 }, s: 500 }, floor, 900, WORLD)[0].do).toBe("teleport");
  });

  it("brings the ball to the window top under the cursor, else the floor", () => {
    expect(surfaceNear(WORLD, { x: 700, y: 450 }).surface.kind).toBe("ledge");
    expect(surfaceNear(WORLD, { x: 700, y: 700 }).surface.kind).toBe("floor");
    expect(surfaceNear(WORLD, { x: 1500, y: 450 })).toEqual({ surface: { kind: "floor" }, s: 1500 });
  });

  it("hides away from the cursor", () => {
    const rand = mulberry32(5);
    for (let i = 0; i < 20; i++) {
      const spot = hideSpot(WORLD, { x: 1900, y: 1000 }, rand);
      expect(spot.surface.kind).not.toBe("right");
    }
  });
});

describe("accessories", () => {
  it("finds the head top near the eye", () => {
    // A 10x8 blob: a head whose top row is y=3 around x=20, an ear at x=40 higher up.
    const alpha = (x: number, y: number) => ((x >= 15 && x <= 25 && y >= 3) || (x === 40 && y >= 0) ? 255 : 0);
    expect(headTop(alpha, 29)).toEqual([20, 3]); // eye at 29 -> head centre 20
    expect(headTop(() => 0, 29)).toBeNull();
  });

  it("recolours only the magenta glitch eye, keeping its brightness", () => {
    expect(recolour(223, 16, 243, [0, 255, 0])).toEqual([0, 255, 0]);
    expect(recolour(144, 21, 186, [0, 255, 0])).toEqual([0, 195, 0]);
    expect(recolour(81, 15, 104, [0, 255, 0])).toEqual([0, 109, 0]);
    expect(recolour(120, 100, 90, [0, 255, 0])).toBeNull(); // fur
    expect(recolour(250, 240, 230, [0, 255, 0])).toBeNull(); // cream
  });
});

describe("games on the creature", () => {
  it("fetch: the ball drops, a throw lands, he runs for it, carries it back and drops it near the cursor", async () => {
    const t = setup();
    await t.c.start({ x: 1500, y: 1040 - 156 - 4 });
    await t.fc.run(500);
    t.setCursor({ x: 1200, y: 800 });
    await t.play.fetch.start();
    expect(t.play.fetch.active).toBe(true);
    expect(t.ball.open).toBe(1);
    await t.fc.run(3000);
    expect(t.play.fetch.mode).toBe("rest"); // fell to the floor; no fetch for that
    expect(t.events).toEqual([]);
    // The user grabs it and flicks it to the left.
    t.play.fetch.grab();
    for (let i = 0; i < 6; i++) {
      t.setCursor({ x: 1200 - i * 25, y: 800 - i * 4 });
      await t.fc.run(16);
    }
    t.play.fetch.release();
    expect(t.play.fetch.ball.vx).toBeLessThan(0);
    let carried = false;
    for (let i = 0; i < 400 && !t.events.includes("fetch"); i++) {
      await t.fc.run(100);
      carried ||= t.acc.carrying;
    }
    expect(carried).toBe(true);
    expect(t.events).toContain("fetch");
    expect(t.acc.carrying).toBe(false);
    expect(t.ball.closed).toBeGreaterThan(0); // hidden while in his mouth
    expect(t.ball.open).toBe(2); // and back out when he drops it
    // He stays around while the game is on.
    expect(t.c.hooks.nextPlan!({ now: 0, world: WORLD, surface: { kind: "floor" }, s: 0, movement: true, sleepy: false, excited: false })).toBe("wait");
    // Nobody throws: the game ends, the ball goes.
    await t.fc.run(60_000);
    expect(t.play.fetch.active).toBe(false);
  });

  it("hide and seek: he hides (only his head shows), pointing at him finds him", async () => {
    const t = setup();
    await t.c.start({ x: 1500, y: 1040 - 156 - 4 });
    await t.fc.run(500);
    await t.play.hide.start();
    await t.fc.run(4000);
    expect(t.play.hide.hidden).toBe(true);
    expect(t.acc.sink).toBe(HIDE_SINK);
    t.play.hover(true);
    expect(t.events).toEqual(["found"]);
    await t.fc.run(1000);
    expect(t.acc.sink).toBe(0);
    expect(t.play.hide.active).toBe(false);
  });

  it("hide and seek: nobody looks, he gives up and comes out", async () => {
    const t = setup();
    await t.c.start({ x: 1500, y: 1040 - 156 - 4 });
    await t.fc.run(500);
    await t.play.hide.start();
    await t.fc.run(GIVE_UP_MS + 10_000);
    expect(t.events).toEqual(["gave_up"]);
    expect(t.acc.sink).toBe(0);
  });

  it("mood: wardrobe and chubbiness from the pet state; dances when happy, hearts on hover", async () => {
    const t = setup();
    const v: PetView = {
      energy: 90,
      mood: "happy",
      mood_on: true,
      level: 4,
      xp: 400,
      level_xp: 320,
      next_level_xp: 540,
      suspicion: 0,
      chubby: true,
      hat: "party",
      eye: "cyan",
      season_hat: null,
      levels_on: true,
      unlocks: [],
    };
    t.play.mood.apply(v);
    expect([t.acc.hat, t.acc.eye, t.acc.girth]).toEqual(["party", "cyan", 1.1]);
    t.play.mood.apply({ ...v, levels_on: false, chubby: false });
    expect([t.acc.hat, t.acc.eye, t.acc.girth]).toEqual([null, "magenta", 1]);
    t.play.hover(true);
    expect(t.acc.floating).toBe(true);
    expect(t.events).toEqual(["pet"]);
    t.play.hover(true);
    expect(t.events).toEqual(["pet"]); // not again right away
    const ctx = { now: 0, world: WORLD, surface: { kind: "floor" } as Surface, s: 900, movement: true, sleepy: false, excited: false };
    await t.fc.run(61_000);
    let dance = null;
    for (let i = 0; i < 40 && !dance; i++) dance = t.c.hooks.nextPlan!(ctx);
    expect(dance).toMatchObject({ name: "play", steps: [{ do: "anim", name: "dance" }, { do: "anim", name: "happy" }] });
    t.acc.dispose();
  });

  it("throws count (for tomorrow's suspicion), gentle drops don't", () => {
    const t = setup();
    t.c.hooks.event!("throw:120");
    t.c.hooks.event!("throw:1400");
    expect(t.events).toEqual(["thrown"]);
  });
});
