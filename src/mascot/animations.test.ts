import { describe, expect, it } from "vitest";
import { GLITCH } from "../sprites/glitch";
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
  it("every frame used by an animation exists in the sprite", () => {
    for (const [name, anim] of Object.entries(ANIMATIONS)) {
      for (const f of anim.frames) expect(GLITCH.frames, `${name} uses ${f}`).toHaveProperty(f);
    }
  });

  it("frame rates are capped", () => {
    for (const anim of Object.values(ANIMATIONS)) {
      expect(anim.fps).toBeLessThanOrEqual(MAX_FPS);
      expect(frameDelay(anim)).toBeGreaterThanOrEqual(1000 / MAX_FPS - 1);
    }
    expect(frameDelay({ frames: ["a", "b"], fps: 240 })).toBe(Math.round(1000 / MAX_FPS));
  });

  it("idle animation wakes the CPU at most a few times per second", () => {
    expect(1000 / frameDelay(ANIMATIONS.idle)).toBeLessThanOrEqual(4);
    expect(1000 / frameDelay(ANIMATIONS.sleep)).toBeLessThanOrEqual(1);
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
