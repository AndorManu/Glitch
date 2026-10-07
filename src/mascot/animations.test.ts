import { describe, expect, it } from "vitest";
import { GLITCH } from "../sprites/glitch";
import { RACCOON } from "../sprites/raccoon";
import { ANIMATIONS, Animator, type Clock, frameDelay, MAX_FPS } from "./animations";

/** Manual clock: tracks pending timers so we can assert there is never more than one. */
function fakeClock() {
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  const clock: Clock = {
    setTimeout: (fn, ms) => {
      timers.set(next, { fn, ms });
      return next++;
    },
    clearTimeout: (id) => void timers.delete(id as number),
  };
  const fire = () => {
    const [id, t] = [...timers.entries()][0];
    timers.delete(id);
    t.fn();
    return t.ms;
  };
  return { clock, timers, fire };
}

describe("animations", () => {
  it("every frame used by an animation exists in both sprite sets", () => {
    for (const [name, anim] of Object.entries(ANIMATIONS)) {
      for (const f of anim.frames) {
        expect(RACCOON.frames, `raccoon: ${name} uses ${f}`).toHaveProperty(f);
        expect(GLITCH.frames, `fallback: ${name} uses ${f}`).toHaveProperty(f);
      }
    }
  });

  it("raccoon frames point inside the 4x4 sheet", () => {
    for (const i of Object.values(RACCOON.frames)) expect(i >= 0 && i < 16).toBe(true);
  });

  it("frame rates are capped", () => {
    for (const anim of Object.values(ANIMATIONS)) {
      expect(anim.fps).toBeLessThanOrEqual(MAX_FPS);
      expect(frameDelay(anim)).toBeGreaterThanOrEqual(1000 / MAX_FPS - 1);
    }
    expect(frameDelay({ frames: ["a", "b"], fps: 240 })).toBe(Math.round(1000 / MAX_FPS));
  });

  it("sleeping wakes the CPU at most every two seconds", () => {
    expect(frameDelay(ANIMATIONS.sleep)).toBeGreaterThanOrEqual(2000);
  });
});

describe("Animator", () => {
  it("cycles frames with exactly one pending timer", () => {
    const drawn: string[] = [];
    const { clock, timers, fire } = fakeClock();
    const a = new Animator((f) => drawn.push(f), { ...ANIMATIONS, walk: { frames: ["w0", "w1"], fps: 5 } }, clock);
    a.play("walk");
    expect(drawn).toEqual(["w0"]);
    expect(timers.size).toBe(1);
    expect(fire()).toBe(200);
    fire();
    expect(drawn).toEqual(["w0", "w1", "w0"]);
    a.play("walk"); // same animation: no restart, no extra timer
    expect(timers.size).toBe(1);
    a.stop();
    expect(timers.size).toBe(0);
  });

  it("holds repeated frames: one timer, no redundant redraws", () => {
    const drawn: string[] = [];
    const { clock, timers, fire } = fakeClock();
    const a = new Animator((f) => drawn.push(f), { ...ANIMATIONS, idle: { frames: ["a", "a", "a", "b"], fps: 1 } }, clock);
    a.play("idle");
    expect(drawn).toEqual(["a"]);
    expect(fire()).toBe(3000);
    expect(drawn).toEqual(["a", "b"]);
    expect(fire()).toBe(1000);
    expect(drawn).toEqual(["a", "b", "a"]);
    expect(timers.size).toBe(1);
  });

  it("idle: under one repaint and one timer wakeup per second on average", () => {
    let draws = 0;
    let wakeups = 0;
    let elapsed = 0;
    const { clock, fire } = fakeClock();
    const a = new Animator(() => draws++, ANIMATIONS, clock);
    a.play("idle");
    while (elapsed < 60_000) {
      elapsed += fire();
      wakeups++;
    }
    expect(draws / (elapsed / 1000)).toBeLessThan(1);
    expect(wakeups / (elapsed / 1000)).toBeLessThan(1);
  });

  it("one-shot animations return to idle", () => {
    const drawn: string[] = [];
    const { clock, fire } = fakeClock();
    const anims = { ...ANIMATIONS, happy: { frames: ["h"], fps: 4, once: true }, idle: { frames: ["i0", "i1"], fps: 2 } };
    const a = new Animator((f) => drawn.push(f), anims, clock);
    a.play("happy");
    fire();
    expect(a.animation).toBe("idle");
    expect(drawn).toEqual(["h", "i0"]);
  });

  it("single-frame looping animations schedule no timer at all", () => {
    const { clock, timers } = fakeClock();
    const a = new Animator(() => {}, { ...ANIMATIONS, sleep: { frames: ["z"], fps: 1 } }, clock);
    a.play("sleep");
    expect(timers.size).toBe(0);
  });
});
