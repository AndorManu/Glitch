// Regression tests for the interaction findings of the visual QA report
// (docs/testing/visual-qa-2026-10-07.md): clicks on walls, rapid clicks,
// clicks while sitting / waking, transitions cut short, the edge peek and
// edge sit, re-landing on a yanked window, varied pick-ups. Real Creature and
// Animator on a fake clock; what is checked is the sequence of drawn poses.

import { describe, expect, it } from "vitest";
import { ANIMATIONS, Animator, type Clock, type Pose, settleKeys } from "./animations";
import { ANNOY_HIGH, ANNOY_MEDIUM, CLICK_DEBOUNCE_MS, Creature, type CreatureClock, type Host, PRESS_NOTICE_MS, RELAND_MS, type View, WALL_CUE_MS } from "./creature";
import { mulberry32 } from "./glitchfx";
import { familyOf } from "./transitions";
import { HALF, type Vec, type World } from "./physics";
import { CALM } from "./render";

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
  return { clock, run, get now() { return now; } };
}

interface Drawn {
  t: number;
  pose: Pose;
  anim: string;
}

const AREA = { x: 0, y: 0, w: 1920, h: 1040 };

function setup(o: { world?: World; seed?: number } = {}) {
  const fc = fakeClock();
  let world: World = o.world ?? { area: AREA, scale: 1, ledges: [] };
  let cursor: Vec = { x: 0, y: 0 };
  const events: string[] = [];
  const drawn: Drawn[] = [];
  const host: Host = {
    moveWindow: () => {},
    world: () => Promise.resolve(world),
    cursor: () => cursor,
    setHitbox: () => {},
    clicked: () => {},
  };
  let c: Creature | null = null;
  const view: View = {
    facingLeft: false,
    placement: { x: 80, y: 156, angle: 0 },
    motion: CALM,
    platform: null,
    bodyRect: { x: 15, y: 70, w: 125, h: 86 },
    render(pose) {
      drawn.push({ t: fc.now, pose, anim: c?.animation ?? "" });
    },
  };
  c = new Creature(host, view, { clock: fc.clock, random: mulberry32(o.seed ?? 1) });
  c.onEvent = (e) => events.push(e);
  const click = async () => {
    c!.pointerDown({ x: 80, y: 110 });
    await fc.run(40);
    c!.pointerUp();
  };
  return { c, fc, drawn, events, click, setWorld: (w: World) => (world = w), setCursor: (p: Vec) => (cursor = p) };
}

/** Frames drawn since time t. */
const since = (d: Drawn[], t: number) => d.filter((x) => x.t >= t);
/** Consecutive pairs of distinct drawn frames. */
function cuts(d: Drawn[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 1; i < d.length; i++) if (d[i].pose.frame !== d[i - 1].pose.frame) out.push([d[i - 1].pose.frame, d[i].pose.frame]);
  return out;
}
// Reach into the creature for setups the public API only reaches by chance (a wall, a ledge slip).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const inner = (c: Creature) => c as any;

describe("clicks", () => {
  it("on a wall: a wall-pose flinch, never the front-facing startle turned with the surface (S3-1)", async () => {
    const t = setup();
    await t.c.start({ x: 1700, y: 880 });
    t.c.setMovement(false);
    inner(t.c).settle({ kind: "right" });
    t.c.animator.play("cling");
    await t.fc.run(500);
    const t0 = t.fc.now;
    await t.click();
    await t.fc.run(1500);
    const after = since(t.drawn, t0);
    expect(after.some((d) => d.pose.frame === "climb7")).toBe(true); // the glance back
    expect(after.every((d) => familyOf(d.pose.frame) === "wall")).toBe(true);
    expect(after.some((d) => d.anim === "startled")).toBe(false);
  });

  it("rapid clicking: no restart within the debounce, escalates startled -> annoyed -> grumpy -> sulk (S3-2, S1-17)", async () => {
    const t = setup();
    await t.c.start({ x: 1700, y: 880 });
    t.c.setMovement(false);
    await t.fc.run(1000);
    const t0 = t.fc.now;
    const seen: string[] = [];
    for (let i = 0; i < 30; i++) {
      await t.click();
      await t.fc.run(60);
      if (seen.at(-1) !== t.c.animation) seen.push(t.c.animation);
    }
    // Every start of the startle (surprised0 after something else) at least the debounce apart.
    const starts = since(t.drawn, t0).filter((d, i, a) => d.pose.frame === "surprised0" && a[i - 1]?.pose.frame !== "surprised0").map((d) => d.t);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(CLICK_DEBOUNCE_MS);
    expect(starts.length).toBeLessThanOrEqual(3);
    // Up the ladder, in order.
    const ladder = seen.filter((a) => ["startled", "annoyed", "grumpy", "sulk"].includes(a));
    expect(ladder.indexOf("startled")).toBeLessThan(ladder.indexOf("annoyed"));
    expect(ladder.indexOf("annoyed")).toBeLessThan(ladder.indexOf("grumpy"));
    expect(t.c.annoyance).toBeGreaterThan(ANNOY_HIGH);
    expect(t.c.sulking).toBe(true);
  });

  it("a single calm click is still the plain startle", async () => {
    const t = setup();
    await t.c.start({ x: 1700, y: 880 });
    t.c.setMovement(false);
    await t.fc.run(1000);
    await t.click();
    expect(t.c.animation).toBe("startled");
    expect(t.c.annoyance).toBeLessThan(ANNOY_MEDIUM);
  });

  it("while sitting: stands up (the hop) before the flinch, no sit -> surprised cut (S2-2)", async () => {
    const t = setup({ seed: 3 });
    await t.c.start({ x: 1700, y: 880 });
    t.c.setMovement(false);
    t.c.playAction("sit");
    await t.fc.run(3000);
    expect(familyOf(t.c.animator.pose!.frame)).toBe("sit");
    const t0 = t.fc.now;
    await t.click();
    await t.fc.run(1500);
    const frames = since(t.drawn, t0).map((d) => d.pose.frame);
    const firstSurprised = frames.findIndex((f) => f.startsWith("surprised"));
    expect(firstSurprised).toBeGreaterThan(0);
    expect(frames.slice(0, firstSurprised).some((f) => f.startsWith("stand_up_hop"))).toBe(true);
    for (const [a, b] of cuts(since(t.drawn, t0))) expect(`${familyOf(a)}>${b}`).not.toMatch(/^sit>surprised/);
  });

  it("right after waking: the wake-up plays on, no cut from curled to the standing startle (S2-3)", async () => {
    const t = setup();
    await t.c.start({ x: 1700, y: 880 });
    t.c.setMovement(false);
    t.c.playAction("sleep");
    await t.fc.run(30_000); // past the jump-scare window (SCARE_AFTER_SLEEP_MS)
    expect(t.c.asleep).toBe(true);
    const t0 = t.fc.now;
    await t.click(); // the press wakes him
    await t.fc.run(2600);
    const after = since(t.drawn, t0);
    expect(after.some((d) => d.pose.frame.startsWith("surprised"))).toBe(false);
    expect(after.some((d) => d.pose.frame === "wake7")).toBe(true);
  });
});

describe("transitions are finished, not cut", () => {
  /** A bare Animator on the fake clock, recording what it draws. */
  function animator() {
    const fc = fakeClock();
    const drawn: Drawn[] = [];
    const a = new Animator((pose) => drawn.push({ t: fc.now, pose, anim: a.animation }), ANIMATIONS, fc.clock as Clock, mulberry32(2));
    return { a, fc, drawn };
  }

  it("interrupting the wake clip finishes it at double speed first (S2-12)", async () => {
    const { a, fc, drawn } = animator();
    a.play("wake");
    await fc.run(1000); // wake3 / wake4
    const shown = Number(a.pose!.frame.replace("wake", ""));
    expect(shown).toBeGreaterThan(1);
    expect(shown).toBeLessThan(7);
    const t0 = fc.now;
    a.play("dance");
    await fc.run(1500);
    const after = since(drawn, t0);
    const rest = after.slice(0, 7 - shown).map((d) => d.pose.frame);
    expect(rest).toEqual(Array.from({ length: 7 - shown }, (_, i) => `wake${shown + 1 + i}`));
    // At double speed: the rest of the clip is over within ~80 ms per frame.
    const end = after.findIndex((d) => !d.pose.frame.startsWith("wake"));
    expect(after[end].t - t0).toBeLessThanOrEqual(80 * (7 - shown));
  });

  it("settleKeys: nothing to finish on a plain pose, the rest of a clip otherwise", () => {
    const idle = { frame: "idle0", dx: 0, dy: 0, sx: 1, sy: 1, rot: 0, pivot: 0, flip: false, glitch: 0, dissolve: 0, fx: null, props: [] };
    expect(settleKeys(idle, [{ frame: "idle1", ms: 300 }])).toEqual([]);
    const mid = { ...idle, frame: "stand_up_paws3" };
    const keys = settleKeys(mid, [4, 5, 6, 7].map((i) => ({ frame: `stand_up_paws${i}`, ms: 95 })).concat([{ frame: "idle0", ms: 200 }]));
    expect(keys.map((k) => k.frame)).toEqual(["stand_up_paws4", "stand_up_paws5", "stand_up_paws6", "stand_up_paws7"]);
    expect(keys.every((k) => k.ms <= 50)).toBe(true);
  });

  it("the edge peek eases back upright when interrupted, no 27 degree snap (S2-10)", async () => {
    const { a, fc, drawn } = animator();
    a.play("peekEdge");
    await fc.run(1000);
    expect(Math.abs(a.pose!.rot)).toBeGreaterThan(20);
    const t0 = fc.now;
    a.play("wave");
    await fc.run(1200);
    const after = [a.pose ? drawn.filter((d) => d.t < t0).at(-1)! : null, ...since(drawn, t0)].filter(Boolean) as Drawn[];
    for (let i = 1; i < after.length; i++) {
      expect(Math.abs(after[i].pose.rot - after[i - 1].pose.rot)).toBeLessThanOrEqual(12);
      expect(Math.abs(after[i].pose.dx - after[i - 1].pose.dx)).toBeLessThanOrEqual(9);
    }
  });

  it("getting up off a window edge: the swing settles, a glitch accent, then stand_up_paws (S2-6)", async () => {
    const { a, fc, drawn } = animator();
    a.play("sitEdge");
    await fc.run(2600); // mid swing
    expect(a.pose!.frame).toMatch(/^sit_edge_swing[1-7]$/);
    const t0 = fc.now;
    a.play("wave");
    await fc.run(2000);
    const frames = since(drawn, t0).map((d) => d.pose);
    const firstDown = frames.findIndex((p) => p.frame === "sit_down7");
    expect(frames[firstDown - 1].frame).toBe("sit_edge_swing0");
    expect(frames[firstDown].glitch).toBeGreaterThan(0.3);
    expect(frames.some((p) => p.frame.startsWith("stand_up_paws"))).toBe(true);
    expect(frames.some((p) => p.frame.startsWith("stand_up_hop"))).toBe(false);
  });

  it("grabCursor turns side-on through the drawn turn before the pounce (S2-5)", () => {
    for (const facingLeft of [false, true]) {
      const keys = (ANIMATIONS.grabCursor.keys as (r: () => number, m: object) => { frame: string }[])(mulberry32(1), { facingLeft });
      const i = keys.findIndex((k) => k.frame === "surprised2");
      const j = keys.findIndex((k) => k.frame === "jump0");
      expect(j - i).toBeGreaterThan(2);
      expect(keys.slice(i + 1, j).every((k) => k.frame.startsWith("turn_"))).toBe(true);
    }
  });

  it("build lands its cheer (celebrate 5-7) before idle (S2-7)", () => {
    const keys = (ANIMATIONS.build.keys as (r: () => number, m: object) => { frame: string }[])(mulberry32(1), {});
    expect(keys.slice(-4).map((k) => k.frame)).toEqual(["celebrate5", "celebrate6", "celebrate7", "idle0"]);
  });
});

describe("the world under him", () => {
  it("caught again by the window he just slipped off: no flash of the rest pose between two falls (S2-9)", async () => {
    const top = { id: 4, x: 1400, y: 700, w: 450 };
    const t = setup({ world: { area: AREA, scale: 1, ledges: [top] } });
    await t.c.start({ x: 1580, y: 700 - 156 });
    t.c.setPanelOpen(true);
    await t.fc.run(500);
    expect(t.c.surface.kind).toBe("ledge");
    // The window jerks: he loses his footing, but it is still right under him.
    inner(t.c).loseFooting({ x: 0, y: 0 }, "slip", { dx: 0, dy: 0 });
    const t0 = t.fc.now;
    await t.fc.run(150);
    expect(t.events).toContain("reland");
    expect(t.c.mode).toBe("stand");
    expect(since(t.drawn, t0).some((d) => d.anim === "idle" || d.pose.frame.startsWith("idle"))).toBe(false);
    // It held still: now he lands properly.
    await t.fc.run(RELAND_MS + 200);
    expect(t.c.animation).not.toBe("fall_flail");
    expect(t.c.body.y + HALF).toBe(700);
  });
});

describe("small cues (severity 1)", () => {
  it("pressed and held still: he notices after PRESS_NOTICE_MS (S1-14)", async () => {
    const t = setup();
    await t.c.start({ x: 1700, y: 880 });
    t.c.setMovement(false);
    await t.fc.run(1000);
    t.c.pointerDown({ x: 80, y: 110 });
    const t0 = t.fc.now;
    await t.fc.run(PRESS_NOTICE_MS + 150);
    expect(since(t.drawn, t0 + PRESS_NOTICE_MS - 1).some((d) => d.pose.glitch > 0 && d.pose.fx === "eye")).toBe(true);
    t.c.pointerUp();
  });

  it("chatting while on a wall: an eye flicker every WALL_CUE_MS, never a front mood pose (S1-19)", async () => {
    const t = setup();
    await t.c.start({ x: 1700, y: 880 });
    t.c.setMovement(false);
    inner(t.c).settle({ kind: "right" });
    t.c.animator.play("cling");
    await t.fc.run(300);
    const t0 = t.fc.now;
    t.c.setMood("thinking");
    await t.fc.run(4 * WALL_CUE_MS + 100);
    const after = since(t.drawn, t0);
    expect(after.every((d) => familyOf(d.pose.frame) === "wall")).toBe(true);
    const flickers = after.filter((d, i) => d.pose.fx === "eye" && d.pose.glitch > 0 && !(after[i - 1]?.pose.glitch > 0));
    expect(flickers.length).toBeGreaterThanOrEqual(3);
    t.c.setMood("idle");
  });

  it("sad gets back up before idle; pull_up hides its jump; the laptop glitches in and out (S1-8, S1-9, S1-12)", () => {
    const make = (n: keyof typeof ANIMATIONS, seed = 1) => (ANIMATIONS[n].keys as (r: () => number, m: object) => { frame: string; glitch?: number }[])(mulberry32(seed), {});
    expect(make("sad").at(-1)!.frame).toBe("sad0");
    const pull = make("pull_up");
    expect(pull.find((k) => k.frame === "pull_up5")!.glitch).toBeGreaterThan(0.3);
    for (let seed = 1; seed < 40; seed++) {
      const keys = make("think", seed);
      const i = keys.findIndex((k) => k.frame === "typing0");
      if (i < 0) continue;
      expect(keys[i].glitch).toBeGreaterThan(0.3);
      expect(keys.at(-1)!.glitch).toBeGreaterThan(0.3);
    }
  });
});

describe("pick-ups", () => {
  it("repeated pick-ups don't end the same way twice in a row (S2-13)", async () => {
    const t = setup({ seed: 7 });
    await t.c.start({ x: 1000, y: 880 });
    t.c.setMovement(false);
    for (let k = 0; k < 8; k++) {
      await t.fc.run(1500);
      const g = { x: 1080, y: 990 };
      t.setCursor(g);
      t.c.pointerDown({ x: 80, y: 110 });
      t.c.pointerMove({ x: 90, y: 110 });
      expect(t.c.mode).toBe("held");
      for (let i = 1; i <= 20; i++) {
        t.setCursor({ x: g.x, y: g.y - i * 4 });
        await t.fc.run(30);
      }
      await t.fc.run(800);
      t.c.pointerUp();
      await t.fc.run(4000);
      if (t.c.mode === "held") t.c.pointerUp();
      await t.fc.run(2000);
    }
    const paths = t.events.filter((e) => e.startsWith("annoy-path:"));
    expect(paths.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < paths.length; i++) expect(paths[i]).not.toBe(paths[i - 1]);
    expect(new Set(paths).size).toBeGreaterThanOrEqual(3);
  });
});
