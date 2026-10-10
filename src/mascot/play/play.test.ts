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
import { type BallPicture, MAX_THROW, newBall, picture, rollFrame, stepSim, throwBall } from "./ballsim";
import { BALL_R, HIDE_SINK, hideSpot, playAnim, route, surfaceNear } from "./rules";

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
  const ball: { open: number; closed: number; frames: BallPicture[] } = { open: 0, closed: 0, frames: [] };
  const acc = new Accessories(() => {}, fc.clock.now);
  const env: PlayEnv = {
    creature: c,
    acc,
    clock: fc.clock,
    rand: mulberry32(9),
    cursor: () => Promise.resolve(cursor),
    ballOpen: async () => {
      ball.open++;
      return true;
    },
    ballFrame: (f) => void ball.frames.push(f.pic),
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

  it("a thrown ball bounces (squash, sparks), rolls on with friction and comes to rest on the taskbar line", () => {
    const b = newBall(1300, 300);
    throwBall(b, 900, -300, 1);
    let bounces = 0;
    let squashed = 0;
    let sparks = 0;
    let settled = null;
    let rested = null;
    for (let i = 0; i < 3000 && !rested; i++) {
      const r = stepSim(b, WORLD, 1 / 60, () => 0.99);
      if (r.impact) bounces++;
      squashed = Math.max(squashed, b.squash);
      sparks = Math.max(sparks, b.sparks.length);
      settled ??= r.settled ?? null;
      rested = r.rested ?? null;
    }
    expect(bounces).toBeGreaterThan(1);
    expect(squashed).toBeGreaterThan(0.3);
    expect(settled?.kind).toBe("floor");
    expect(rested?.kind).toBe("floor");
    expect(b.mode).toBe("rest");
    expect(b.y + BALL_R).toBeCloseTo(1040, 5);
    expect(b.x).toBeLessThanOrEqual(1920 - BALL_R); // bounced back off the right edge, still on screen
    void sparks;
  });

  it("rolls the right way: the roll frame turns with the distance travelled, both ways", () => {
    const go = (vx: number) => {
      const b = newBall(900, 1040 - BALL_R);
      b.mode = "roll";
      b.surface = { kind: "floor" };
      b.vx = vx;
      const frames: number[] = [];
      for (let i = 0; i < 20; i++) {
        stepSim(b, WORLD, 1 / 60, () => 0.99);
        frames.push(rollFrame(b.angle));
      }
      return { b, frames };
    };
    const right = go(300);
    const left = go(-300);
    expect(right.b.angle).toBeGreaterThan(0);
    expect(left.b.angle).toBeLessThan(0);
    expect(right.b.angle).toBeCloseTo(-left.b.angle, 6);
    expect(new Set(right.frames).size).toBeGreaterThan(2); // it animates
    expect(rollFrame(0.01)).toBe(0);
    expect(rollFrame(-0.01)).toBe(7);
    expect(rollFrame(Math.PI)).toBe(4);
  });

  it("throws are clamped; it falls off the end of a window top", () => {
    const b = newBall(0, 0);
    throwBall(b, 99999, 0, 2);
    expect(Math.hypot(b.vx, b.vy)).toBeCloseTo(MAX_THROW * 2, 6);
    const r = newBall(980, 500 - BALL_R);
    r.mode = "roll";
    r.surface = { kind: "ledge", ledge: WORLD.ledges[0] };
    r.vx = 300;
    for (let i = 0; i < 30; i++) stepSim(r, WORLD, 1 / 60, () => 0.99);
    expect(r.mode).toBe("air");
    for (let i = 0; i < 300 && (r.mode as string) === "air"; i++) stepSim(r, WORLD, 1 / 60, () => 0.99);
    expect(r.surface?.kind).toBe("floor");
  });

  it("a ball dropped over a window top lands on it; the picture has a shadow on it", () => {
    const b = newBall(700, 100);
    for (let i = 0; i < 2000 && b.mode !== "rest"; i++) stepSim(b, WORLD, 1 / 60, () => 0.99);
    expect(b.surface).toEqual({ kind: "ledge", ledge: WORLD.ledges[0] });
    expect(b.y + BALL_R).toBeCloseTo(500, 5);
    const pic = picture(newBall(700, 300), WORLD);
    expect(pic.groundY).toBe(500);
    expect(pic.height).toBeCloseTo(500 - 300 - BALL_R, 6);
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
    await t.fc.run(4000);
    expect(t.play.fetch.sim?.mode).toBe("rest"); // fell to the floor; no fetch for that
    expect(t.events).toEqual([]);
    // The user grabs it and flicks it to the left.
    t.play.fetch.grab();
    for (let i = 0; i < 6; i++) {
      t.setCursor({ x: 1200 - i * 25, y: 800 - i * 4 });
      await t.fc.run(16);
    }
    t.play.fetch.release();
    expect(t.play.fetch.sim!.vx).toBeLessThan(0);
    let carried = false;
    for (let i = 0; i < 600 && !t.events.includes("fetch"); i++) {
      await t.fc.run(100);
      carried ||= t.acc.carrying;
    }
    expect(carried).toBe(true);
    expect(t.events).toContain("fetch");
    expect(t.acc.carrying).toBe(false);
    expect(t.ball.frames.some((f) => f.hidden)).toBe(true); // not drawn while in his mouth
    expect(t.ball.frames.at(-1)!.hidden).toBe(false); // and back out when he drops it
    expect(t.ball.open).toBe(1); // one overlay, no new windows
    // He stays around while the game is on.
    expect(t.c.hooks.nextPlan!({ now: 0, world: WORLD, surface: { kind: "floor" }, s: 0, movement: true, sleepy: false, excited: false })).toBe("wait");
    // Nobody throws for a minute: the game ends, the ball pops away.
    await t.fc.run(70_000);
    expect(t.play.fetch.active).toBe(false);
    expect(t.ball.closed).toBe(1);
  });

  it("fetch: a click without moving tosses it up a little", async () => {
    const t = setup();
    await t.c.start({ x: 1500, y: 1040 - 156 - 4 });
    await t.fc.run(500);
    await t.play.fetch.start();
    await t.fc.run(4000);
    t.play.fetch.grab();
    await t.fc.run(50);
    t.play.fetch.release();
    expect(t.play.fetch.sim!.vy).toBeLessThan(-500);
    expect(Math.abs(t.play.fetch.sim!.vx)).toBeLessThan(100);
    t.play.fetch.end();
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
