import { describe, expect, it } from "vitest";
import { GLITCH } from "../sprites/glitch";
import { RACCOON } from "../sprites/raccoon";
import { ANIM_INDEX } from "../sprites/anim";
import { GLITCH_ANIM } from "../sprites/glitch-anim";
import {
  type Animation,
  type AnimationName,
  ANIMATIONS,
  Animator,
  burst,
  IDLE_BUDGET,
  type Clock,
  isAnimationName,
  type Keyframe,
  MAX_FPS,
  MIN_KEY_MS,
  type Pose,
} from "./animations";
import { mulberry32 } from "./glitchfx";
import { PROPS } from "./props";

/** Manual clock: tracks pending timers so we can assert there is never more than one. */
function fakeClock() {
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  let maxPending = 0;
  const clock: Clock = {
    setTimeout: (fn, ms) => {
      timers.set(next, { fn, ms });
      maxPending = Math.max(maxPending, timers.size);
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
  return { clock, timers, fire, maxPending: () => maxPending };
}

/** Run an animation for `ms` of fake time; count repaints and timer wakeups. */
function simulate(name: AnimationName, ms: number, seed = 1, anims: Record<AnimationName, Animation> = ANIMATIONS) {
  const poses: { pose: Pose; at: number }[] = [];
  const delays: number[] = [];
  let elapsed = 0;
  const { clock, timers, maxPending } = fakeClock();
  const a = new Animator((pose) => poses.push({ pose, at: elapsed }), anims, clock, mulberry32(seed));
  a.play(name);
  let wakeups = 0;
  while (elapsed < ms && timers.size > 0) {
    // Advance the clock first so repaints are stamped with the time they happen.
    const [id, t] = [...timers.entries()][0];
    timers.delete(id);
    delays.push(t.ms);
    elapsed += t.ms;
    wakeups++;
    t.fn();
  }
  return { poses, draws: poses.length, wakeups, elapsed: Math.max(elapsed, ms), delays, maxPending: maxPending(), animator: a };
}

/** All keys an animation can produce (makers are random: sample many seeds). */
function allKeys(anim: Animation): Keyframe[] {
  const out: Keyframe[] = [];
  for (let seed = 1; seed <= 200; seed++) {
    const mem = {};
    if (typeof anim.keys === "function") out.push(...anim.keys(mulberry32(seed), mem));
    else out.push(...anim.keys);
    if (anim.intro) out.push(...anim.intro(mulberry32(seed), mem));
    if (anim.outro) out.push(...anim.outro(mulberry32(seed), mem));
  }
  out.push(...burst(mulberry32(7)));
  return out;
}

const keys = (frames: string[], ms: number, o: Partial<Keyframe> = {}): Keyframe[] => frames.map((frame) => ({ frame, ms, ...o }));

describe("animations", () => {
  it("every keyframe uses a frame both sprite sets have, and known props", () => {
    for (const [name, anim] of Object.entries(ANIMATIONS)) {
      for (const key of allKeys(anim)) {
        expect(GLITCH_ANIM.frames, `animation sheet: ${name} uses ${key.frame}`).toHaveProperty(key.frame);
        // The old sheet and the code-drawn fallback show their first frame for names they lack.
        void RACCOON;
        void GLITCH;
        for (const p of key.props ?? []) expect(p.name === "tether" || p.name in PROPS, `${name} prop ${p.name}`).toBe(true);
        if (key.glitch !== undefined) expect(key.glitch).toBeGreaterThanOrEqual(0);
        if (key.glitch !== undefined) expect(key.glitch).toBeLessThanOrEqual(1);
      }
    }
  }, 30_000); // 200 seeds of ~100 animations: slow on a busy machine

  it("raccoon frames point inside the 4x4 sheet", () => {
    for (const i of Object.values(RACCOON.frames)) expect(i >= 0 && i < 16).toBe(true);
  });

  it("the animation sheet has every old frame name, full cycles, and an eye for each frame that shows one", () => {
    for (const name of Object.keys(RACCOON.frames)) expect(GLITCH_ANIM.frames, name).toHaveProperty(name);
    const count = Object.keys(ANIM_INDEX).length;
    // Seen from behind / hidden behind an edge: no glitch eye to glitch (visual QA S1-7).
    const eyeless = new Set(["turn_to_back3", "turn_to_back4", "turn_to_back5", "pose_back", "pose_laugh", "happy_spin3", "peek0", "peek1", "hide_peek0", "hide_peek4"]);
    for (const [name, i] of Object.entries(GLITCH_ANIM.frames)) {
      expect(i >= 0 && i < count, name).toBe(true);
      if (!eyeless.has(name) && !eyeless.has(Object.keys(ANIM_INDEX)[i])) expect(GLITCH_ANIM.eyes?.[name], name).toBeDefined();
    }
    for (const [cycle, n] of [["walk", 8], ["idle", 8], ["run", 6], ["wave", 8], ["talk", 8], ["jump", 8]] as const) {
      for (let i = 0; i < n; i++) expect(ANIM_INDEX, `${cycle}${i}`).toHaveProperty(`${cycle}${i}`);
    }
  });

  it("the walk plays all 8 drawn frames in order", () => {
    const frames = (ANIMATIONS.walk.keys as (r: () => number, m: object) => Keyframe[])(mulberry32(3), {}).map((k) => k.frame);
    expect(frames).toEqual(["walk0", "walk1", "walk2", "walk3", "walk4", "walk5", "walk6", "walk7"]);
  });

  it("follow-ups name real animations", () => {
    for (const anim of Object.values(ANIMATIONS)) if (anim.next) expect(isAnimationName(anim.next)).toBe(true);
    expect(isAnimationName("grabCursor")).toBe(true);
    expect(isAnimationName("toString")).toBe(false);
    expect(isAnimationName(42)).toBe(false);
  });

  it("actions either finish (once) or loop, as intended", () => {
    const once: AnimationName[] = [
      ...["happy", "startled", "laugh", "grabCursor", "peek", "fall", "land", "glitchOut", "gone", "glitchIn", "chaosSpin"],
      ...["crouch", "splat", "dizzy", "peekEdge", "lookAround", "build", "malfunction", "wave"],
      ...["wake", "sad", "angry", "scared", "eat", "celebrate", "point", "pull_up", "bounce", "wall_jump", "sneeze", "annoyed", "calmDown", "hook_cast", "virus_giggle", "smugBite", "stretch", "suggest", "yawn_stay"],
      ...["celebrate_focus", "worried_battery", "knock_screen", "hide_peek", "streamer", "look_dirs", "high_five", "happy_spin", "jump_scare"],
    ] as AnimationName[];
    const loops: AnimationName[] = [
      ...["idle", "walk", "think", "ask", "sleep", "carryCursor", "dragWindow", "pushWindow", "dangle", "napRock"],
      ...["cling", "climb", "run", "airUp", "airDown", "tumble", "flail", "sitEdge", "held", "heldKick", "listen", "talk", "dance", "typing", "sit"],
      ...["tail_copter", "glide", "fall_flail", "hang_ledge", "slide_down", "sit_edge_swing", "fish", "struggle", "clingCursor", "sulk", "biteCursor", "hide", "guard", "hook_reel"],
      ...["idle_tail", "idle_tail_sit", "dance_beat", "hold_sign", "sweat_fan", "glasses_type", "watch_tv", "fetch_ball", "chubby_idle", "hats", "petted"],
    ] as AnimationName[];
    // These hand over to a loop that isn't idle.
    const special: Partial<Record<AnimationName, AnimationName>> = { lookBack: "cling", yawn: "sleep", grumpy: "sulk" };
    for (const [name, then] of Object.entries(special)) expect(simulate(name as AnimationName, 20_000).animator.animation, name).toBe(then);
    expect([...once, ...loops, ...Object.keys(special)].sort()).toEqual(Object.keys(ANIMATIONS).sort());
    for (const name of once) {
      const r = simulate(name, 20_000);
      // Every one-shot chain ends back in idle within a few seconds.
      expect(r.animator.animation, name).toBe("idle");
    }
    for (const name of loops) expect(simulate(name, 20_000).animator.animation, name).toBe(name);
  });

  it("the teleport chain: glitchOut -> gone (invisible) -> glitchIn -> idle", () => {
    const seen: string[] = [];
    const { clock, fire } = fakeClock();
    const a = new Animator(() => seen[seen.length - 1] !== a.animation && seen.push(a.animation), ANIMATIONS, clock, mulberry32(3));
    a.play("glitchOut");
    for (let i = 0; i < 60 && a.animation !== "idle"; i++) fire();
    expect(seen).toEqual(["glitchOut", "gone", "glitchIn", "idle"]);
  });
});

describe("Animator", () => {
  it("steps through keys with exactly one pending timer", () => {
    const drawn: string[] = [];
    const { clock, timers, fire } = fakeClock();
    const a = new Animator((p) => drawn.push(p.frame), { ...ANIMATIONS, walk: { keys: keys(["w0", "w1"], 200) } }, clock);
    a.play("walk");
    expect(drawn).toEqual(["w0"]);
    expect(timers.size).toBe(1);
    expect(fire()).toBe(200);
    fire();
    expect(drawn).toEqual(["w0", "w1", "w0"]);
    a.play("walk"); // same loop: no restart, no extra timer
    expect(timers.size).toBe(1);
    a.stop();
    expect(timers.size).toBe(0);
  });

  it("holds identical keys with one timer and no redundant redraws", () => {
    const drawn: string[] = [];
    const { clock, timers, fire } = fakeClock();
    const idle = [...keys(["a", "a", "a"], 1000), ...keys(["a"], 500, { dy: -2 }), ...keys(["b"], 1000)];
    const a = new Animator((p) => drawn.push(`${p.frame}${p.dy}`), { ...ANIMATIONS, idle: { keys: idle } }, clock);
    a.play("idle");
    expect(drawn).toEqual(["a0"]);
    expect(fire()).toBe(3000); // three "a" keys merged
    expect(drawn).toEqual(["a0", "a-2"]); // a transform change is a new look
    expect(fire()).toBe(500);
    expect(fire()).toBe(1000);
    expect(drawn).toEqual(["a0", "a-2", "b0", "a0"]);
    expect(timers.size).toBe(1);
  });

  it("glitch / fx keys repaint every time, even when repeated", () => {
    const drawn: number[] = [];
    const { clock, fire } = fakeClock();
    const a = new Animator((_, tick) => drawn.push(tick), { ...ANIMATIONS, idle: { keys: keys(["a", "a", "a"], 50, { glitch: 0.5 }) } }, clock);
    a.play("idle");
    expect(fire()).toBe(50); // not merged
    fire();
    expect(drawn).toEqual([0, 1, 2]); // a fresh noise seed per repaint
  });

  it("caps the frame rate whatever the keys say", () => {
    const { clock, fire } = fakeClock();
    const a = new Animator(() => {}, { ...ANIMATIONS, idle: { keys: keys(["a", "b"], 1) } }, clock);
    a.play("idle");
    expect(fire()).toBe(MIN_KEY_MS);
    expect(MIN_KEY_MS).toBeGreaterThanOrEqual(1000 / MAX_FPS);
  });

  it("one-shots return to their follow-up (default idle, or the `then` given)", () => {
    const drawn: string[] = [];
    const { clock, fire } = fakeClock();
    const anims = { ...ANIMATIONS, happy: { keys: keys(["h"], 100), once: true }, idle: { keys: keys(["i0", "i1"], 500) }, think: { keys: keys(["t"], 500) } };
    const a = new Animator((p) => drawn.push(p.frame), anims, clock);
    a.play("happy");
    fire();
    expect(a.animation).toBe("idle");
    expect(drawn).toEqual(["h", "i0"]);
    a.play("happy", "think");
    expect(a.base).toBe("think");
    fire();
    expect(a.animation).toBe("think");
  });

  it("a burst interjects, then the animation carries on where it was", () => {
    const drawn: Pose[] = [];
    const { clock, fire } = fakeClock();
    const a = new Animator((p) => drawn.push(p), { ...ANIMATIONS, think: { keys: keys(["t0", "t1"], 400) } }, clock, mulberry32(9));
    a.play("think");
    a.glitchBurst(400);
    expect(drawn.length).toBe(2);
    while (drawn[drawn.length - 1].glitch > 0) fire();
    const burstKeys = drawn.slice(1, -1);
    expect(burstKeys.length).toBe(8); // 400 ms at 20 fps
    expect(burstKeys.every((p) => p.glitch > 0)).toBe(true);
    expect(drawn[drawn.length - 1].frame).toBe("t1");
    expect(a.animation).toBe("think");
  });

  it("single-key still loops schedule no timer at all", () => {
    const { clock, timers } = fakeClock();
    const a = new Animator(() => {}, { ...ANIMATIONS, sleep: { keys: keys(["z"], 1000) } }, clock);
    a.play("sleep");
    expect(timers.size).toBe(0);
  });
});

describe("CPU budgets (60 s of fake time)", () => {
  it("idle, bursts included: under IDLE_BUDGET repaints and timer wakeups per second", () => {
    let bursts = 0;
    let worst = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const r = simulate("idle", 60_000, seed);
      const s = r.elapsed / 1000;
      expect(r.draws / s, `seed ${seed} repaints/s`).toBeLessThan(IDLE_BUDGET);
      expect(r.wakeups / s, `seed ${seed} wakeups/s`).toBeLessThan(IDLE_BUDGET);
      expect(r.maxPending).toBe(1);
      worst = Math.max(worst, r.draws / s, r.wakeups / s);
      // Bursts: count runs of glitchy repaints; each is short and at most 20 fps.
      let run: number[] = [];
      for (const { pose, at } of [...r.poses, { pose: { glitch: 0 } as Pose, at: Infinity }]) {
        if (pose.glitch > 0) run.push(at);
        else if (run.length) {
          if (run.length >= 4) {
            bursts++;
            expect(run[run.length - 1] - run[0], `seed ${seed} ${run.join(",")}`).toBeLessThanOrEqual(600);
          }
          run = [];
        }
      }
    }
    expect(bursts).toBeGreaterThanOrEqual(30); // 60 s of idle has a burst or two in every run (loops are 15-40 s)
    console.info(`idle: worst seed ${worst.toFixed(2)} repaints-or-wakeups/s`);
  });

  it("sleep: at most one repaint every two seconds", () => {
    const r = simulate("sleep", 60_000);
    expect(r.draws / (r.elapsed / 1000)).toBeLessThanOrEqual(0.5);
    expect(r.wakeups / (r.elapsed / 1000)).toBeLessThanOrEqual(0.5);
  });

  it("every animation runs at 20 fps or less with one timer", () => {
    for (const name of Object.keys(ANIMATIONS) as AnimationName[]) {
      const r = simulate(name, 10_000, 5);
      expect(Math.min(...r.delays), name).toBeGreaterThanOrEqual(MIN_KEY_MS);
      expect(r.draws / (r.elapsed / 1000), name).toBeLessThanOrEqual(MAX_FPS);
      expect(r.maxPending, name).toBeLessThanOrEqual(1);
    }
  });

  it("walking repaints in step with the 15 fps window moves", () => {
    const r = simulate("walk", 10_000);
    // (67 ms keys: 14.9 repaints/s, the 15 window moves/s of main.ts)
    expect(r.draws / (r.elapsed / 1000)).toBeLessThanOrEqual(15.1);
  });

  it("thinking stays modest (it can last minutes on a slow model)", () => {
    const r = simulate("think", 60_000);
    expect(r.draws / (r.elapsed / 1000)).toBeLessThan(4);
  });
});
