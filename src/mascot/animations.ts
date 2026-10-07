// Glitch's animations as keyframes (pose + procedural transform + effects),
// and a timer that plays them without ever using requestAnimationFrame
// (rAF would wake the CPU 60+ times/second even when nothing moves).
//
// Units: dx/dy and prop positions in CSS px, +dx = the way Glitch faces
// (mirrored when walking left), +dy = down. rot in degrees, + = lean forward.
// sx/sy scale around the feet (or `pivot`). glitch 0..1 drives render.ts.

import type { GridPropName } from "./props";

export type Fx = "trail" | "sparkle" | "zzz" | "eye" | "dust" | "dizzy";

/** A prop drawn with Glitch, positioned from the feet anchor (not bobbing with the sprite). */
export type PropPlacement =
  | { name: GridPropName; x: number; y: number; rot?: number; behind?: boolean }
  | { name: "tether"; x: number; y: number; x2: number; y2: number; behind?: boolean };

export interface Keyframe {
  /** Frame name in the sprite set (src/sprites/raccoon.ts). */
  frame: string;
  /** How long this key stays on screen. */
  ms: number;
  dx?: number;
  dy?: number;
  sx?: number;
  sy?: number;
  rot?: number;
  /** Rotation/scale pivot as a fraction of the art height: 0 feet (default), 0.5 middle, 1 top. */
  pivot?: number;
  /** Mirror relative to the facing direction (look the other way). */
  flip?: boolean;
  /** Glitch effect intensity 0..1 (slices, RGB split, corrupted pixels). */
  glitch?: number;
  /** 0..1: fraction of the sprite dissolved into pixels (1 = invisible). */
  dissolve?: number;
  fx?: Fx;
  props?: PropPlacement[];
}

/** A keyframe with every field filled in: what the renderer draws. */
export interface Pose {
  frame: string;
  dx: number;
  dy: number;
  sx: number;
  sy: number;
  rot: number;
  pivot: number;
  flip: boolean;
  glitch: number;
  dissolve: number;
  fx: Fx | null;
  props: PropPlacement[];
}

export type KeyMaker = (rand: () => number) => Keyframe[];

export interface Animation {
  /** Fixed keys, or a maker called again on every loop (random variation). */
  keys: Keyframe[] | KeyMaker;
  /** Play once then switch to `next` (default "idle") instead of looping. */
  once?: boolean;
  next?: AnimationName;
}

/** Hard cap so no animation can ever burn CPU, whatever its keys say. */
export const MAX_FPS = 20;
export const MIN_KEY_MS = Math.ceil(1000 / MAX_FPS);
/** Walk keys match the 15 fps window moves in main.ts. */
const WALK_MS = 67;

const k = (frame: string, ms: number, o: Omit<Keyframe, "frame" | "ms"> = {}): Keyframe => ({ frame, ms, ...o });
const sum = (keys: Keyframe[]) => keys.reduce((t, key) => t + key.ms, 0);

// ------------------------------------------------------------ building blocks

/**
 * A glitch burst on top of `base`: 300-600 ms at 20 fps, intensity spikes
 * then decays, sometimes one key swaps to the glitch/chaos pose.
 */
export function burst(rand: () => number, base: Omit<Keyframe, "ms"> = { frame: "idle0" }, ms?: number): Keyframe[] {
  const n = Math.max(4, Math.round((ms ?? 300 + rand() * 300) / MIN_KEY_MS));
  const peak = 0.55 + 0.45 * rand();
  const swapAt = rand() < 0.4 ? 1 + Math.floor(rand() * (n - 2)) : -1;
  const swapTo = rand() < 0.6 ? "glitch" : "chaos";
  const keys: Keyframe[] = [];
  for (let i = 0; i < n; i++) {
    const env = i === 0 ? 0.6 : 1 - ((i - 1) / (n - 1)) * 0.75;
    const jitter = rand() < 0.3 ? (rand() < 0.5 ? -2 : 2) : 0;
    keys.push({
      ...base,
      frame: i === swapAt ? swapTo : base.frame,
      ms: MIN_KEY_MS,
      dx: (base.dx ?? 0) + jitter,
      glitch: Math.max(0.1, peak * env * (0.7 + 0.3 * rand())),
      fx: "eye",
    });
  }
  return keys;
}

/** A little hop: anticipation squash, stretch up, land squash, settle. */
function hop(frame: string, height = 8, o: Omit<Keyframe, "frame" | "ms"> = {}): Keyframe[] {
  return [
    k(frame, 90, { ...o, sx: 1.06, sy: 0.92 }),
    k(frame, 70, { ...o, dy: -height * 0.5, sx: 0.95, sy: 1.07 }),
    k(frame, 110, { ...o, dy: -height, sx: 0.97, sy: 1.04 }),
    k(frame, 80, { ...o, dy: -height * 0.5, sx: 0.98, sy: 1.03 }),
    k(frame, 90, { ...o, sx: 1.07, sy: 0.92 }),
    k(frame, 80, { ...o, sx: 1.02, sy: 0.98 }),
  ];
}

/** One walk stride (4 keys = 268 ms): contact squash, push-off stretch, airborne. */
type Extra = (dy: number, frame: string) => Omit<Keyframe, "frame" | "ms">;

function stride(lean: number, extra: Extra = () => ({})): Keyframe[] {
  return [
    k("walk0", WALK_MS, { sx: 1.04, sy: 0.96, rot: lean * 0.4, fx: "trail", ...extra(0, "walk0") }),
    k("walk0", WALK_MS, { dy: -1, rot: lean * 0.7, fx: "trail", ...extra(-1, "walk0") }),
    k("walk1", WALK_MS, { dy: -3, sx: 0.97, sy: 1.04, rot: lean, fx: "trail", ...extra(-3, "walk1") }),
    k("walk1", WALK_MS, { dy: -2, rot: lean * 0.7, fx: "trail", ...extra(-2, "walk1") }),
  ];
}

function walkCycle(rand: () => number, lean = 3, extra?: Extra): Keyframe[] {
  const keys = [...stride(lean, extra), ...stride(lean, extra)];
  // Now and then a stride glitches out for a key.
  if (rand() < 0.3) keys[5] = { ...keys[5], glitch: 0.35 };
  return keys;
}

// ------------------------------------------------------------------- moods

function fidget(rand: () => number): Keyframe[] {
  switch (Math.floor(rand() * 6)) {
    case 0: // swish the tail to the other side and back
      return [k("idle1", 1800 + rand() * 1500)];
    case 1: // glance sideways (sometimes both ways)
      return rand() < 0.5 ? [k("side", 1400 + rand() * 900)] : [k("side", 1100), k("side", 1000, { flip: true })];
    case 2:
      return hop("idle0", 6 + rand() * 4);
    case 3: // the glitch eye twitches
      return [k("idle0", 60, { glitch: 0.2, fx: "eye" }), k("idle0", 120, { fx: "eye" }), k("idle0", 60, { glitch: 0.35, fx: "eye" })];
    case 4:
      return [k("sit", 3000 + rand() * 3000)];
    default: // a slow stretch
      return [k("idle0", 400, { sx: 0.96, sy: 1.05 }), k("idle0", 500, { sx: 0.95, sy: 1.06, dy: -1 }), k("idle0", 300, { sx: 1.03, sy: 0.97 })];
  }
}

/**
 * Idle: mostly the still front pose (held with one long timer), a breath
 * every 4.5-7 s, sometimes a fidget, then a glitch burst. One loop lasts
 * 8-25 s, so bursts come at random intervals.
 */
function idleKeys(rand: () => number): Keyframe[] {
  const keys: Keyframe[] = [];
  const until = 8000 + rand() * 17000;
  const fidgetAt = rand() < 0.65 ? until * (0.25 + 0.5 * rand()) : Infinity;
  let t = 0;
  let fidgeted = false;
  while (t < until) {
    const rest = Math.min(until - t, 4500 + rand() * 2500);
    keys.push(k("idle0", rest));
    t += rest;
    if (t >= until) break;
    const extra = !fidgeted && t >= fidgetAt ? fidget(rand) : [k("idle0", 650, { sx: 0.99, sy: 1.02 })]; // breathe in
    fidgeted ||= t >= fidgetAt;
    keys.push(...extra);
    t += sum(extra);
  }
  return [...keys, ...burst(rand)];
}

function thinkKeys(rand: () => number): Keyframe[] {
  // A thoughtful bob with the "?" floating; the eye flickers now and then.
  const bob = [k("think0", 450), k("think0", 250, { dy: -1 }), k("think0", 450, { dy: -2, sy: 1.01 }), k("think0", 250, { dy: -1 })];
  const keys = [...bob, ...bob];
  if (rand() < 0.6) keys.push(k("think0", 50, { glitch: 0.5, fx: "eye" }), k("think0", 50, { glitch: 0.25, dx: 1, fx: "eye" }));
  return keys;
}

function askKeys(rand: () => number): Keyframe[] {
  // Waiting for the user: calmer, a curious head tilt.
  const keys = [k("think0", 1600 + rand() * 800), k("think0", 900, { rot: -4, pivot: 0.2 }), k("think0", 1400)];
  if (rand() < 0.4) keys.push(k("think0", 50, { glitch: 0.4, fx: "eye" }), k("think0", 100, { fx: "eye" }));
  return keys;
}

function happyKeys(rand: () => number): Keyframe[] {
  if (rand() < 0.35) return laughKeys(rand);
  const s = { fx: "sparkle" as const };
  return [
    ...hop("wave", 10),
    k("happy", 300, s),
    k("wave", 300, s),
    k("happy", 300, { ...s, dy: -1 }),
    k("wave", 300, s),
    k("happy", 250, { ...s, glitch: 0.2 }),
    k("wave", 400),
  ];
}

function laughKeys(rand: () => number): Keyframe[] {
  const keys: Keyframe[] = [k("laugh", 80, { sx: 1.05, sy: 0.95 })];
  for (let i = 0; i < 12; i++) {
    keys.push(k("laugh", 100, { dx: i % 2 ? 1.5 : -1.5, dy: i % 4 < 2 ? -1 : 0, fx: i % 3 === 0 ? "sparkle" : undefined }));
  }
  return [...keys, ...burst(rand, { frame: "laugh" }, 200), k("laugh", 300)];
}

// ----------------------------------------------------------------- actions
// For "desktop goose" style behaviours. Positions assume the 160x110 window.

/** Cursor gripped in the raised paw of the waving pose. */
const CURSOR_IN_PAW = (dy: number): Omit<Keyframe, "frame" | "ms"> => ({ props: [{ name: "cursor", x: 30, y: -72 + dy, rot: -10 }] });
/** Cursor carried at the snout of the side walk poses (walk1's head is further forward). */
const CURSOR_IN_MOUTH: Extra = (dy, frame) => ({ props: [{ name: "cursor", x: frame === "walk1" ? 62 : 56, y: -62 + dy, rot: 35 }] });

function grabCursorKeys(rand: () => number): Keyframe[] {
  const ground = { name: "cursor" as const, x: 58, y: -24, rot: 0 };
  const lying = { props: [ground] };
  return [
    // Spot it, wiggle, crouch...
    k("walk0", 300, { dx: -16, ...lying }),
    k("walk0", 120, { dx: -17, sx: 1.06, sy: 0.92, rot: -3, ...lying }),
    k("walk0", 120, { dx: -15, sx: 1.08, sy: 0.9, rot: -4, ...lying }),
    k("walk0", 120, { dx: -17, sx: 1.09, sy: 0.89, rot: -4, ...lying }),
    // ...pounce...
    k("walk1", 60, { dx: -10, dy: -6, sx: 0.94, sy: 1.08, rot: 6, ...lying }),
    k("walk1", 80, { dx: -3, dy: -15, sx: 0.95, sy: 1.07, rot: 8, ...lying }),
    k("walk1", 70, { dx: 4, dy: -8, sx: 0.97, sy: 1.04, rot: 5, ...lying }),
    // ...land on it, got it!
    k("walk0", 90, { dx: 6, sx: 1.1, sy: 0.88, fx: "dust", props: [{ ...ground, x: 48, y: -16, rot: 25 }] }),
    ...burst(rand, { frame: "wave", props: CURSOR_IN_PAW(0).props }, 250),
    k("wave", 500, { ...CURSOR_IN_PAW(0), fx: "sparkle" }),
    k("wave", 400, { ...CURSOR_IN_PAW(-2), fx: "sparkle" }),
    k("wave", 400, CURSOR_IN_PAW(0)),
  ];
}

function dragWindowKeys(rand: () => number): Keyframe[] {
  // Smaller Glitch leaning into a rope, the tab bumping along behind.
  const small = { dx: 18, sx: 0.8, sy: 0.8 };
  const keys: Keyframe[] = [];
  for (let i = 0; i < 4; i++) {
    const up = i % 2 === 0;
    const wy = up ? -4 : -1;
    keys.push(
      k(up ? "walk1" : "walk0", 110, {
        ...small,
        dy: up ? -2 : 0,
        sx: small.sx * (up ? 0.98 : 1.03),
        sy: small.sy * (up ? 1.03 : 0.97),
        rot: up ? 9 : 6,
        fx: "trail",
        props: [
          { name: "tether", x: 4, y: -34 + (up ? -2 : 0), x2: -56, y2: wy - 20, behind: true },
          { name: "window", x: -60, y: wy - 22, rot: up ? -6 : 3, behind: true },
        ],
      }),
    );
  }
  if (rand() < 0.3) keys[2] = { ...keys[2], glitch: 0.3 };
  return keys;
}

function pushWindowKeys(rand: () => number): Keyframe[] {
  // Shoulder into the tab: strain (shaking), shove (it slides), step after it.
  const at = (dx: number, wx: number, o: Omit<Keyframe, "frame" | "ms"> = {}): Omit<Keyframe, "frame" | "ms"> => ({
    sx: 0.82,
    sy: 0.82,
    rot: 8,
    dx,
    ...o,
    props: [{ name: "window", x: wx, y: -24, rot: o.rot !== undefined ? 0 : -2 }],
  });
  return [
    k("walk0", 100, at(-22, 38)),
    k("walk0", 60, at(-21, 39, { sx: 0.84, sy: 0.8 })),
    k("walk0", 60, at(-23, 38)),
    k("walk0", 60, at(-21, 39, { sx: 0.84, sy: 0.8 })),
    k("walk1", 80, at(-18, 43, { rot: 12, fx: "dust", glitch: rand() < 0.4 ? 0.25 : 0 })),
    k("walk1", 80, at(-15, 47, { rot: 10, fx: "dust" })),
    k("walk0", 120, at(-15, 48)),
    k("walk1", 110, at(-19, 44, { rot: 5, dy: -2 })),
    k("walk0", 110, at(-22, 40)),
  ];
}

function peekKeys(rand: () => number): Keyframe[] {
  // Pop up from the bottom edge, look around, duck back down.
  const look = rand() < 0.5;
  return [
    k("idle0", 200, { dy: 100 }),
    k("idle0", 70, { dy: 60, sx: 0.95, sy: 1.06 }),
    k("idle0", 70, { dy: 24, sx: 0.96, sy: 1.05 }),
    k("idle0", 80, { dy: -4, sx: 0.98, sy: 1.03 }),
    k("idle0", 90, { dy: 0, sx: 1.03, sy: 0.97 }),
    k("idle0", 500),
    k("side", 600, { flip: look }),
    k("side", 600, { flip: !look }),
    k("idle0", 60, { glitch: 0.4, fx: "eye" }),
    k("idle0", 400, { fx: "eye" }),
    k("idle0", 90, { dy: 4, sx: 1.05, sy: 0.93 }),
    k("idle0", 70, { dy: 40 }),
    k("idle0", 70, { dy: 90 }),
    k("idle0", 600, { dy: 120 }),
  ];
}

function dangleKeys(rand: () => number): Keyframe[] {
  // Held by the scruff: swing like a pendulum around the top of the head.
  const swing = [-11, -6, 3, 10, 6, -3];
  const keys = swing.map((rot, i) =>
    k("glitch", 250, { rot, pivot: 1, dy: -8, sx: i % 2 ? 0.97 : 0.95, sy: i % 2 ? 1.04 : 1.07, fx: i % 3 === 0 ? "eye" : undefined }),
  );
  if (rand() < 0.4) keys[3] = { ...keys[3], glitch: 0.35 };
  return keys;
}

function glitchOutKeys(): Keyframe[] {
  // Teleport out: glitch ramps up, slices scatter, then dissolve into a line.
  const keys: Keyframe[] = [];
  const n = 12;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    keys.push(
      k(i === 4 ? "chaos" : "idle0", MIN_KEY_MS, {
        glitch: 0.3 + 0.7 * t,
        dissolve: Math.max(0, (t - 0.3) / 0.7),
        sx: 1 + 0.35 * t * t,
        sy: 1 - 0.85 * t * t,
        pivot: 0.4,
        fx: "eye",
      }),
    );
  }
  return keys;
}

function glitchInKeys(): Keyframe[] {
  // The same, backwards, then a little landing squash.
  const keys = glitchOutKeys().reverse();
  return [...keys, k("idle0", 80, { sx: 1.06, sy: 0.94, glitch: 0.15 }), k("idle0", 100, { fx: "eye" })];
}

function chaosSpinKeys(rand: () => number): Keyframe[] {
  const keys: Keyframe[] = [];
  for (let i = 0; i < 24; i++) {
    keys.push(k("chaos", MIN_KEY_MS, { rot: i * 30, pivot: 0.45, sx: 0.78, sy: 0.78, dy: -6, glitch: 0.5 + 0.4 * rand(), fx: "eye" }));
  }
  // Dizzy: the "?" pose wobbling to a stop with stars round the head.
  for (const rot of [10, -8, 6, -4, 2, 0]) keys.push(k("think0", 180, { rot, pivot: 0.1, fx: "dizzy" }));
  keys.push(k("think0", 600, { fx: "dizzy" }));
  return keys;
}

function startledKeys(): Keyframe[] {
  return [
    k("idle0", 50, { sx: 1.06, sy: 0.93 }),
    k("idle0", 60, { dy: -7, sx: 0.94, sy: 1.08, glitch: 0.55, fx: "eye" }),
    k("idle0", 70, { dy: -9, glitch: 0.3, fx: "eye" }),
    k("idle0", 60, { dy: -4, sy: 1.03 }),
    k("idle0", 70, { sx: 1.06, sy: 0.94 }),
    k("idle0", 120, { fx: "eye" }),
  ];
}

export type AnimationName =
  | "idle"
  | "walk"
  | "think"
  | "ask"
  | "happy"
  | "sleep"
  | "startled"
  | "laugh"
  | "grabCursor"
  | "carryCursor"
  | "dragWindow"
  | "pushWindow"
  | "peek"
  | "dangle"
  | "fall"
  | "land"
  | "glitchOut"
  | "gone"
  | "glitchIn"
  | "chaosSpin"
  | "napRock";

export const ANIMATIONS: Record<AnimationName, Animation> = {
  // moods
  idle: { keys: idleKeys },
  walk: { keys: (r) => walkCycle(r) },
  think: { keys: thinkKeys },
  ask: { keys: askKeys },
  happy: { keys: happyKeys, once: true },
  // 2.4 s per key: under 0.5 repaints per second while asleep.
  sleep: { keys: [k("sleep0", 2400, { sx: 1.012, sy: 0.975, fx: "zzz" }), k("sleep0", 2400, { fx: "zzz" })] },
  // actions
  startled: { keys: startledKeys, once: true },
  laugh: { keys: laughKeys, once: true },
  grabCursor: { keys: grabCursorKeys, once: true },
  carryCursor: { keys: (r) => walkCycle(r, 2, CURSOR_IN_MOUTH) },
  dragWindow: { keys: dragWindowKeys },
  pushWindow: { keys: pushWindowKeys },
  peek: { keys: peekKeys, once: true, next: "glitchIn" },
  dangle: { keys: dangleKeys },
  fall: {
    keys: [
      k("idle0", 60, { dy: -18, sx: 0.88, sy: 1.12 }),
      k("idle0", 60, { dy: -9, sx: 0.9, sy: 1.1 }),
      k("idle0", 50, { dy: -2, sx: 0.94, sy: 1.06 }),
    ],
    once: true,
    next: "land",
  },
  land: {
    keys: [
      k("idle0", 90, { sx: 1.15, sy: 0.84, glitch: 0.35, fx: "dust" }),
      k("idle0", 90, { sx: 1.06, sy: 0.93, fx: "dust" }),
      k("idle0", 80, { sx: 0.97, sy: 1.03, fx: "dust" }),
      k("idle0", 150, { fx: "dust" }),
    ],
    once: true,
  },
  glitchOut: { keys: glitchOutKeys, once: true, next: "gone" },
  // Invisible for a moment (the window can move now), then glitch back in.
  gone: { keys: [k("idle0", 1500, { dissolve: 1 })], once: true, next: "glitchIn" },
  glitchIn: { keys: glitchInKeys, once: true },
  chaosSpin: { keys: chaosSpinKeys, once: true },
  napRock: { keys: [k("nap_rock", 2400, { sx: 1.01, sy: 0.98 }), k("nap_rock", 2400)] },
};

export function isAnimationName(name: unknown): name is AnimationName {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(ANIMATIONS, name);
}

/** Fill in defaults so poses compare and render uniformly. */
export function toPose(key: Keyframe): Pose {
  return {
    frame: key.frame,
    dx: key.dx ?? 0,
    dy: key.dy ?? 0,
    sx: key.sx ?? 1,
    sy: key.sy ?? 1,
    rot: key.rot ?? 0,
    pivot: key.pivot ?? 0,
    flip: key.flip ?? false,
    glitch: key.glitch ?? 0,
    dissolve: key.dissolve ?? 0,
    fx: key.fx ?? null,
    props: key.props ?? [],
  };
}

/** Effects that change on every draw, so such a key must repaint even if repeated. */
function isLive(p: Pose): boolean {
  return p.glitch > 0 || (p.dissolve > 0 && p.dissolve < 1) || p.fx !== null;
}

export function samePose(a: Pose | null, b: Pose): boolean {
  if (!a) return false;
  return (
    a.frame === b.frame &&
    a.dx === b.dx &&
    a.dy === b.dy &&
    a.sx === b.sx &&
    a.sy === b.sy &&
    a.rot === b.rot &&
    a.pivot === b.pivot &&
    a.flip === b.flip &&
    a.glitch === b.glitch &&
    a.dissolve === b.dissolve &&
    a.fx === b.fx &&
    JSON.stringify(a.props) === JSON.stringify(b.props)
  );
}

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const realClock: Clock = {
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id as number),
};

/** Draw callback: the pose, plus a counter that seeds the frame's glitch noise. */
export type DrawFn = (pose: Pose, tick: number) => void;

/**
 * Plays keyframe animations by calling `draw(pose, tick)` on a timer.
 * - Exactly one timer is pending at any time (none for a still, single-key loop).
 * - Identical consecutive keys are held with one timer and drawn once.
 * - Keys whose look doesn't change are not redrawn; glitch/fx keys always are.
 * - No key is shorter than 1000 / MAX_FPS ms.
 */
export class Animator {
  private current: AnimationName = "idle";
  private then: AnimationName = "idle";
  private keys: Keyframe[] = [];
  private index = 0;
  private timer: unknown = null;
  private lastPose: Pose | null = null;
  private tick = 0;

  constructor(
    private readonly draw: DrawFn,
    private readonly animations: Record<AnimationName, Animation> = ANIMATIONS,
    private readonly clock: Clock = realClock,
    private readonly random: () => number = Math.random,
  ) {}

  get animation(): AnimationName {
    return this.current;
  }

  /** The animation that runs after the current one: itself if looping. */
  get base(): AnimationName {
    return this.animations[this.current].once ? this.then : this.current;
  }

  /** The pose on screen now (or null before the first draw). */
  get pose(): Pose | null {
    return this.lastPose;
  }

  /**
   * Switch animation. A `once` animation then plays `then` (default: its
   * `next`, else "idle"). Re-playing the running loop does nothing.
   */
  play(name: AnimationName, then?: AnimationName): void {
    const anim = this.animations[name];
    if (name === this.current && !anim.once && this.keys.length > 0) return;
    this.current = name;
    this.then = then ?? anim.next ?? "idle";
    this.keys = this.resolve(anim);
    this.index = 0;
    this.lastPose = null; // always draw the first key of a new animation
    this.step();
  }

  /**
   * Insert keys right now (e.g. a glitch burst), then carry on with the
   * current animation from where it was.
   */
  interject(make: (rand: () => number, base: Omit<Keyframe, "ms">) => Keyframe[]): void {
    const p = this.lastPose ?? toPose(k("idle0", 0));
    const base: Omit<Keyframe, "ms"> = { frame: p.frame, dx: p.dx, dy: p.dy, sx: p.sx, sy: p.sy, rot: p.rot, pivot: p.pivot, flip: p.flip, props: p.props };
    this.keys = [...make(this.random, base), ...this.keys.slice(this.index)];
    this.index = 0;
    this.step();
  }

  /** A glitch burst over whatever is showing. */
  glitchBurst(ms?: number): void {
    this.interject((rand, base) => burst(rand, base, ms));
  }

  stop(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private resolve(anim: Animation): Keyframe[] {
    return typeof anim.keys === "function" ? anim.keys(this.random) : anim.keys;
  }

  private step = (): void => {
    this.stop();
    const anim = this.animations[this.current];
    if (this.index >= this.keys.length) {
      if (anim.once) return this.play(this.then);
      this.keys = this.resolve(anim);
      this.index = 0;
    }
    const key = this.keys[this.index];
    const pose = toPose(key);
    const live = isLive(pose);
    // Repaints are the expensive part: skip them when nothing changes.
    if (live || !samePose(this.lastPose, pose)) {
      this.draw(pose, this.tick++);
    }
    this.lastPose = pose;
    // Hold identical consecutive keys with one longer timer.
    let ms = key.ms;
    let next = this.index + 1;
    while (!live && next < this.keys.length && samePose(pose, toPose(this.keys[next]))) {
      ms += this.keys[next].ms;
      next++;
    }
    this.index = next;
    const still = typeof anim.keys !== "function" && this.keys.length === 1 && !anim.once && !live;
    if (!still) this.timer = this.clock.setTimeout(this.step, Math.max(MIN_KEY_MS, Math.round(ms)));
  };
}
