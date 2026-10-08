// Glitch's animations as keyframes (pose + procedural transform + effects),
// and a timer that plays them without ever using requestAnimationFrame
// (rAF would wake the CPU 60+ times/second even when nothing moves).
//
// Units: dx/dy and prop positions in CSS px, +dx = the way Glitch faces
// (mirrored when walking left), +dy = down. rot in degrees, + = lean forward.
// sx/sy scale around the feet (or `pivot`). glitch 0..1 drives render.ts.

import type { GridPropName } from "./props";
import { bridge, clip, edges, familyOf, glanceFrames, has, pickVariant, toFront, toSide } from "./transitions";

/** Animations that are a way of moving along: walking hands over to these without stopping first. */
const GAITS = ["walk", "run", "climb", "carryCursor", "dragWindow", "pushWindow", "cling"];

export type Fx = "trail" | "sparkle" | "zzz" | "eye" | "dust" | "dizzy" | "eq";

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

/** Per-animator memory makers can use (cooldowns, last variant picked...). */
export type Memory = Record<string, unknown>;
export type KeyMaker = (rand: () => number, mem: Memory) => Keyframe[];

export interface Animation {
  /** Fixed keys, or a maker called again on every loop (random variation). */
  keys: Keyframe[] | KeyMaker;
  /** Play once then switch to `next` (default "idle") instead of looping. */
  once?: boolean;
  next?: AnimationName;
  /** Played once before the first loop (e.g. walk_start). */
  intro?: KeyMaker;
  /** Played when switching to a different animation (e.g. walk_stop). */
  outro?: KeyMaker;
  /**
   * false: start right away, never through a transition clip (physics-driven
   * and urgent animations: falling, being held, startled...).
   */
  bridge?: boolean;
}

/** Hard cap so no animation can ever burn CPU, whatever its keys say. */
export const MAX_FPS = 20;
export const MIN_KEY_MS = Math.ceil(1000 / MAX_FPS);
/**
 * Average repaints (and timer wakeups) per second allowed while resting.
 * Raised from 1.5 to 2.5 for the drawn idle life (blinks every 2.5-6 s, ear
 * twitches, one or two drawn fidgets per loop: sneeze, scratch, groom,
 * sitting down and standing up again...): still a tiny cost, one 160x160
 * canvas drawImage per repaint.
 */
export const IDLE_BUDGET = 2.5;
/** Walk keys: 12 fps drawn frames (the window itself moves at 30 Hz, see creature.ts). */
const WALK_MS = 83;
/** Run keys: ~14 fps. */
const RUN_MS = 70;

const k = (frame: string, ms: number, o: Omit<Keyframe, "frame" | "ms"> = {}): Keyframe => ({ frame, ms, ...o });
const sum = (keys: Keyframe[]) => keys.reduce((t, key) => t + key.ms, 0);

// ------------------------------------------------------------ building blocks

/**
 * A glitch burst on top of `base`: 300-600 ms at 20 fps, intensity spikes
 * then decays, sometimes one key tears half apart. The pose itself never
 * changes (no cut to another drawing in the middle of a burst).
 */
export function burst(rand: () => number, base: Omit<Keyframe, "ms"> = { frame: "idle0" }, ms?: number): Keyframe[] {
  const n = Math.max(4, Math.round((ms ?? 300 + rand() * 300) / MIN_KEY_MS));
  const peak = 0.55 + 0.45 * rand();
  const tearAt = rand() < 0.4 ? 1 + Math.floor(rand() * (n - 2)) : -1;
  const tear = 0.2 + 0.2 * rand();
  const keys: Keyframe[] = [];
  for (let i = 0; i < n; i++) {
    const env = i === 0 ? 0.6 : 1 - ((i - 1) / (n - 1)) * 0.75;
    const jitter = rand() < 0.3 ? (rand() < 0.5 ? -2 : 2) : 0;
    keys.push({
      ...base,
      ...(i === tearAt ? { dissolve: tear } : {}),
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

/** Extra key fields per walk frame (e.g. a carried prop that bobs with the body). */
type Extra = (dy: number, frame: string) => Omit<Keyframe, "frame" | "ms">;

/** Body bob of the 8 drawn walk frames (contact, down, passing, up x2), for props. */
const WALK_BOB = [0, 1, -1, -2, 0, 1, -1, -2];

/**
 * The drawn 8-frame walk cycle (walk0-7: contact, down, passing, up for
 * each foot) at 12 fps. The frames carry the bob, arm swing and tail; one
 * cycle (667 ms) covers ~47 CSS px at the walking speed (70 px/s).
 */
function walkCycle(rand: () => number, _lean = 0, extra?: Extra): Keyframe[] {
  const keys = WALK_BOB.map((dy, i) => k(`walk${i}`, WALK_MS, extra ? extra(dy * 1.5, `walk${i}`) : {}));
  // Now and then a stride glitches out for a key.
  if (rand() < 0.3) keys[5] = { ...keys[5], glitch: 0.35 };
  return keys;
}

// ------------------------------------------------------------------- moods

/** A calm sit in the sit family (sit0-7, sit_idle_look when drawn): blinks, looks around. */
function sitLoop(rand: () => number = Math.random): Keyframe[] {
  const keys = [k("sit0", 1800 + rand() * 1200), k("sit1", 160), k("sit0", 1200)];
  if (has("sit_idle_look")) keys.push(...clip("sit_idle_look", 160, { ease: 2, hold: 600 }));
  else keys.push(k("sit3", 1500), k("sit4", 800), k("sit5", 1200));
  keys.push(k("sit0", 700));
  return keys;
}

/** The sit loop on its own (the `sit` animation is entered and left through the transition clips). */
const fidgetSit = sitLoop;

/** A sheet played as an idle fidget: eased in and out, ending back on idle0. */
const sheetFidget = (name: string, ms: number, o: { ease?: number; hold?: number } = {}): Keyframe[] => [...clip(name, ms, { ease: o.ease ?? 2, hold: o.hold }), k("idle0", 200)];

export interface Fidget {
  id: string;
  weight: number;
  /** Idle loops (8-25 s each) before it may come again. */
  cooldown: number;
  make: (rand: () => number, mem: Memory) => Keyframe[] | null;
}

/** Sit down, sit a while, stand up again: each step a drawn clip, a different stand-up each time. */
function sitBreak(rand: () => number, mem: Memory): Keyframe[] | null {
  const down = edges()["front>sit"];
  const up = edges()["sit>front"];
  if (!down || !up) return null;
  const last = ((mem.lastClip as Record<string, string>) ??= {});
  const d = pickVariant(down, rand, last["front>sit"]);
  const u = pickVariant(up, rand, last["sit>front"]);
  last["front>sit"] = d.id;
  last["sit>front"] = u.id;
  return [...d.keys(rand, mem), ...sitLoop(rand), ...u.keys(rand, mem), k("idle0", 200)];
}

export const FIDGETS: Fidget[] = [
  { id: "tail", weight: 2, cooldown: 1, make: (r) => [k("idle1", 1800 + r() * 1500)] },
  { id: "eye", weight: 1, cooldown: 1, make: () => [k("idle0", 60, { glitch: 0.2, fx: "eye" }), k("idle0", 120, { fx: "eye" }), k("idle0", 60, { glitch: 0.35, fx: "eye" })] },
  {
    id: "sneeze",
    weight: 1.5,
    cooldown: 4,
    // itch, ah... ah... (anticipation), CHOO with a spark, rub the nose
    make: () => [k("sneeze0", 150), k("sneeze1", 260), k("sneeze2", 300), k("sneeze3", 380), k("sneeze4", 140, { glitch: 0.45, fx: "eye" }), k("sneeze5", 220), k("sneeze6", 360), k("sneeze7", 220), k("idle0", 200)],
  },
  { id: "sit", weight: 2, cooldown: 2, make: sitBreak },
  { id: "scratch", weight: 2, cooldown: 2, make: () => (has("scratch") ? sheetFidget("scratch", 110) : null) },
  { id: "groom", weight: 2, cooldown: 2, make: () => (has("groom") ? sheetFidget("groom", 120) : null) },
  {
    id: "stretch",
    weight: 1.5,
    cooldown: 3,
    // A side-on stretch: turns side-on, stretches, turns back to you.
    make: (_r, mem) =>
      has("stretch") && has("turn_front_to_side") && has("turn_side_to_front")
        ? [...toSide(mem), ...clip("stretch", 130, { ease: 2, hold: 500 }), ...toFront(mem), k("idle0", 200)]
        : null,
  },
  { id: "shake_off", weight: 1, cooldown: 3, make: () => (has("shake_off") ? sheetFidget("shake_off", 80) : null) },
  { id: "hop", weight: 1.5, cooldown: 2, make: (r) => (has("hop_idle") ? sheetFidget("hop_idle", 85, { ease: 1 }) : hop("idle0", 6 + r() * 4)) },
  { id: "look_back", weight: 2, cooldown: 2, make: () => (has("look_back") ? sheetFidget("look_back", 120, { hold: 700 }) : null) },
  { id: "tail_chase", weight: 0.3, cooldown: 8, make: () => (has("tail_chase") ? [...clip("tail_chase", 85, { ease: 1 }), ...clip("tail_chase", 85, { ease: 0 }), k("idle0", 200)] : null) },
  {
    id: "glance",
    weight: 2,
    cooldown: 1,
    // Turns his head to the side (the first half of the turn), looks, turns back.
    make: (r, mem) => {
      if (!has("turn_front_to_side")) return [k("idle1", 1400 + r() * 900)];
      const half = glanceFrames(mem).slice(0, 3);
      return [...half, k(half[half.length - 1].frame, 900 + r() * 700), ...[...half].reverse(), k("idle0", 200)];
    },
  },
];

/**
 * One idle fidget, weighted, never the same one twice in a row, each with a
 * cooldown in idle loops (per animator, in `mem`).
 */
function fidget(rand: () => number, mem: Memory = {}): Keyframe[] {
  const loop = ((mem.idleLoop as number) ?? 0) + 1;
  mem.idleLoop = loop;
  const used = ((mem.fidgetUsed as Record<string, number>) ??= {});
  const ok = FIDGETS.filter((f) => f.id !== mem.lastFidget && loop - (used[f.id] ?? -99) > f.cooldown);
  let total = ok.reduce((t, f) => t + f.weight, 0);
  while (ok.length) {
    let r = rand() * total;
    const f = ok.find((x) => (r -= x.weight) <= 0) ?? ok[ok.length - 1];
    const keys = f.make(rand, mem);
    if (keys && keys.length) {
      mem.lastFidget = f.id;
      used[f.id] = loop;
      return keys;
    }
    ok.splice(ok.indexOf(f), 1);
    total -= f.weight;
  }
  return [k("idle1", 1800)];
}

/**
 * Idle: mostly the still front pose (held with one long timer), a breath
 * every 4.5-7 s, sometimes a fidget, then a glitch burst. One loop lasts
 * 8-25 s, so bursts come at random intervals.
 */
function idleKeys(rand: () => number, mem: Memory = {}): Keyframe[] {
  // One loop: 7-16 s of breathing with blinks every 2.5-6 s and ear twitches,
  // one or two fidgets (weighted, cooldowns, never the same twice running),
  // and now and then a glitch burst. Varied enough that no two minutes look alike.
  const keys: Keyframe[] = [];
  const until = 7000 + rand() * 9000;
  const fidgets = rand() < 0.85 ? (rand() < 0.35 ? 2 : 1) : 0;
  const fidgetAt = Array.from({ length: fidgets }, (_, i) => until * ((i + 0.3 + 0.5 * rand()) / Math.max(1, fidgets)));
  let t = 0;
  let nextBlink = 1500 + rand() * 3000;
  while (t < until) {
    // Breathing: out (idle0, a long hold), in (idle1).
    const breath = [k("idle0", 2600 + rand() * 1600), k("idle1", 1300 + rand() * 400)];
    keys.push(...breath);
    t += sum(breath);
    if (t >= nextBlink) {
      // Blink: half, closed, half (eye lids drawn in idle4-6), sometimes twice.
      const blink = [k("idle4", 60), k("idle5", 90), k("idle6", 60)];
      if (rand() < 0.15) blink.push(k("idle0", 140), k("idle4", 60), k("idle5", 80), k("idle6", 60));
      keys.push(...blink);
      t += sum(blink);
      nextBlink = t + 2500 + rand() * 3500;
    } else if (rand() < 0.3) {
      // Ear twitch (idle2): flick, back, flick.
      const ear = [k("idle2", 120), k("idle0", 90), k("idle2", 110)];
      keys.push(...ear);
      t += sum(ear);
    }
    if (fidgetAt.length && t >= fidgetAt[0]) {
      fidgetAt.shift();
      const extra = fidget(rand, mem);
      keys.push(...extra);
      t += sum(extra);
    }
  }
  return rand() < 0.6 ? [...keys, ...burst(rand)] : keys;
}

/** Talking (replying in the chat): the drawn mouth shapes in a varied order, ~9 fps, with pauses. */
function talkKeys(rand: () => number): Keyframe[] {
  const keys: Keyframe[] = [];
  for (let word = 0; word < 4; word++) {
    const n = 3 + Math.floor(rand() * 4);
    for (let i = 0; i < n; i++) keys.push(k(`talk${1 + Math.floor(rand() * 6)}`, 90 + rand() * 50));
    keys.push(k("talk0", 160 + rand() * 260)); // between words, mouth shut
  }
  if (rand() < 0.3) keys.push(k("idle4", 60), k("idle5", 90), k("idle6", 60));
  return keys;
}

/** A proper wave: arm up (anticipation), swings with the paw flopping, eased down. */
function waveKeys(rand: () => number): Keyframe[] {
  const swings = 2 + Math.floor(rand() * 2);
  const keys = [k("wave0", 120), k("wave1", 90), k("wave2", 90)];
  for (let i = 0; i < swings; i++) keys.push(k("wave3", 110), k("wave4", 120, { fx: "sparkle" }), k("wave5", 110), k("wave4", 100));
  keys.push(k("wave6", 120), k("wave7", 160), k("idle0", 200));
  return keys;
}

/** Frames `name`0..n-1 (or the listed indices) at `ms` each. */
const cycle = (name: string, idx: number[], ms: number, o: Omit<Keyframe, "frame" | "ms"> = {}): Keyframe[] => idx.map((i) => k(`${name}${i}`, ms, o));

function thinkKeys(rand: () => number): Keyframe[] {
  // Paw comes up to the chin (think0-3), then the "?" bobs and the tail tip taps (think4-7, held longer).
  const keys = [...cycle("think", [0, 1, 2, 3], 130)];
  for (let i = 0; i < 3; i++) keys.push(...cycle("think", [4, 5, 6, 7], 320 + rand() * 80));
  if (rand() < 0.6) keys.push(k("think7", 50, { glitch: 0.5, fx: "eye" }), k("think7", 50, { glitch: 0.25, dx: 1, fx: "eye" }));
  keys.push(...cycle("think", [3, 2, 1], 140)); // paw down again before the next loop
  // A long think: he gets his laptop out and types for a while (typing0-7, ~4.5 fps keys).
  if (rand() < 0.55) {
    const n = 2 + Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) keys.push(...cycle("typing", [0, 1, 2, 3, 4, 5, 6, 7], 220 + rand() * 40));
  }
  return keys;
}

function askKeys(rand: () => number): Keyframe[] {
  // Waiting for the user: calmer, the "?" frames held long.
  const keys = [k("think4", 1600 + rand() * 800), k("think5", 900), k("think6", 1400), k("think7", 900)];
  if (rand() < 0.4) keys.push(k("think7", 50, { glitch: 0.4, fx: "eye" }), k("think7", 100, { fx: "eye" }));
  return keys;
}

function happyKeys(rand: () => number): Keyframe[] {
  const r = rand();
  if (r < 0.3) return laughKeys(rand);
  if (r < 0.6) return celebrateKeys(rand);
  return [...hop("idle0", 8), ...waveKeys(rand)];
}

function laughKeys(rand: () => number): Keyframe[] {
  // Drawn laugh: shoulders shaking, eyes squeezed (laugh0-7), twice, then settle.
  const keys = [...cycle("laugh", [0, 1, 2, 3, 4, 5, 6, 7], 100, {}), ...cycle("laugh", [2, 3, 4, 5, 6, 7], 100)];
  keys[3] = { ...keys[3], fx: "sparkle" };
  return [...keys, ...burst(rand, { frame: "laugh7" }, 200), k("laugh0", 260)];
}

function celebrateKeys(rand: () => number): Keyframe[] {
  const keys = [...cycle("celebrate", [0, 1, 2, 3, 4, 5, 6, 7], 95, { fx: "sparkle" })];
  return rand() < 0.5 ? [...keys, ...cycle("celebrate", [3, 4, 5, 6, 7], 95, { fx: "sparkle" })] : keys;
}

/** A one-shot of a drawn 8-frame sheet: anticipation frames a bit slower, the end held. */
function sheetOnce(name: string, ms = 100, hold = 400): Keyframe[] {
  const keys = cycle(name, [0, 1, 2, 3, 4, 5, 6, 7], ms);
  keys[0] = { ...keys[0], ms: ms * 1.4 };
  keys[7] = { ...keys[7], ms: hold };
  return keys;
}

// ----------------------------------------------------------------- actions
// For "desktop goose" style behaviours. Positions are from the feet (160x160 window).

// Prop positions below are CSS px from the feet, measured on the drawn
// frames (art px x 1.5 from the frame's bottom centre).

/** Cursor gripped in the pointing paw (point3-5: paw at art (72, 66)). */
const CURSOR_IN_PAW = (dy: number): Omit<Keyframe, "frame" | "ms"> => ({ props: [{ name: "cursor", x: 31, y: -40 + dy, rot: -20 }] });
/** Cursor carried at the snout of the walk frames (snout ~ art (73, 63)); dy follows the body bob. */
const CURSOR_IN_MOUTH: Extra = (dy) => ({ props: [{ name: "cursor", x: 40, y: -46 + dy, rot: 35 }] });

function grabCursorKeys(rand: () => number, mem: Memory = {}): Keyframe[] {
  const ground = { name: "cursor" as const, x: 40, y: -22, rot: 0 };
  const lying = { props: [ground] };
  return [
    // Spot it (surprised), turn side-on to it, crouch, wiggle...
    k("surprised2", 260, { dx: -16, ...lying }),
    ...toSide(mem, 60).map((key) => ({ ...key, dx: -16, ...lying })),
    k("jump0", 120, { dx: -16, ...lying }),
    k("jump1", 120, { dx: -16, ...lying }),
    k("jump1", 110, { dx: -15, ...lying }),
    k("jump1", 110, { dx: -17, ...lying }),
    // ...pounce...
    k("jump2", 70, { dx: -10, dy: -10, ...lying }),
    k("jump4", 90, { dx: -2, dy: -16, ...lying }),
    k("jump5", 80, { dx: 4, dy: -8, ...lying }),
    // ...land on it, got it!
    k("jump6", 100, { dx: 6, fx: "dust", props: [{ ...ground, x: 34, y: -14, rot: 25 }] }),
    k("jump7", 90, { dx: 4, props: [{ ...ground, x: 32, y: -24, rot: 10 }] }),
    ...burst(rand, { frame: "point3", props: CURSOR_IN_PAW(0).props }, 250),
    k("point4", 500, { ...CURSOR_IN_PAW(0), fx: "sparkle" }),
    k("point5", 400, { ...CURSOR_IN_PAW(-2), fx: "sparkle" }),
    k("point6", 400, CURSOR_IN_PAW(0)),
  ];
}

function dragWindowKeys(rand: () => number): Keyframe[] {
  // Hauling the tab behind him on a strap over the shoulder (grab_tab0-7), leaning into it.
  const keys: Keyframe[] = [];
  for (let i = 0; i < 8; i++) {
    const up = i % 2 === 0;
    const wy = up ? -3 : 0;
    keys.push(
      k(`grab_tab${i}`, 110, {
        dx: 12,
        fx: "trail",
        props: [
          { name: "tether", x: -40, y: -26, x2: -50, y2: wy - 20, behind: true },
          { name: "window", x: -52, y: wy - 22, rot: up ? -6 : 3, behind: true },
        ],
      }),
    );
  }
  if (rand() < 0.3) keys[2] = { ...keys[2], glitch: 0.3 };
  return keys;
}

function pushWindowKeys(rand: () => number): Keyframe[] {
  // Paws against the tab (push0-7, paws at art x ~75, y ~53): strain, shove, it slides.
  const at = (i: number, wx: number, o: Omit<Keyframe, "frame" | "ms"> = {}, ms = 100): Keyframe =>
    k(`push${i}`, ms, { dx: -18, ...o, props: [{ name: "window", x: wx, y: -54, rot: -2 }] });
  return [
    at(0, 36, {}, 140),
    at(1, 36),
    at(2, 37),
    at(3, 38, { fx: "dust", glitch: rand() < 0.4 ? 0.25 : 0 }),
    at(4, 41, { fx: "dust" }),
    at(5, 44),
    at(6, 45),
    at(7, 44),
  ];
}

function peekKeys(): Keyframe[] {
  // Pop up from the bottom edge (peek0-7: ears, eyes over the edge, look, blink, duck).
  return [
    k("peek0", 260),
    k("peek1", 120),
    k("peek2", 110),
    k("peek3", 600),
    k("peek4", 500),
    k("peek5", 500),
    k("peek6", 110, { glitch: 0.3, fx: "eye" }),
    k("peek5", 400, { fx: "eye" }),
    k("peek7", 120),
    k("peek1", 100),
    k("peek0", 100),
    k("peek0", 600, { dy: 60 }),
  ];
}

function dangleKeys(rand: () => number): Keyframe[] {
  // Held by the scruff: the drawn dangle (legs kicking, tail swinging), upright (the creature sways him a little).
  void rand;
  return cycle("dangle", [0, 1, 2, 3, 4, 5, 6, 7], 120);
}

function glitchOutKeys(): Keyframe[] {
  // Teleport out: the drawn teleport frames, glitch ramping up, then dissolve into a line.
  const keys: Keyframe[] = [];
  const n = 12;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    keys.push(
      k(`teleport${Math.min(7, Math.floor(i * 0.75))}`, MIN_KEY_MS, {
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
  // The drawn spin, three turns, crackling.
  for (let i = 0; i < 24; i++) keys.push(k(`spin${i % 8}`, MIN_KEY_MS, { dy: -4, glitch: i % 3 === 0 ? 0.4 + 0.4 * rand() : 0, fx: "eye" }));
  // Dizzy: the "?" pose wobbling to a stop with stars round the head.
  // Then dizzy: the drawn swaying with stars.
  return [...keys, ...dizzyKeys()];
}

function startledKeys(): Keyframe[] {
  // The drawn surprise: flinch, jump, eyes wide, settle.
  return [...cycle("surprised", [0, 1], 60), k("surprised2", 70, { glitch: 0.5, fx: "eye" }), ...cycle("surprised", [3, 4, 5, 6], 80), k("surprised7", 220, { fx: "eye" })];
}


// ------------------------------------------------------ living in the world
// Played by creature.ts while Glitch climbs, flies, lands... The surface
// orientation (walls, ceiling) and the spin come from the placement in
// render.ts, so these keys are all drawn "upright" relative to the surface.

/** Holding on to a wall or the ceiling: pressed flat, breathing, glancing back. */
function clingKeys(rand: () => number): Keyframe[] {
  // Holding on (the drawn wall crawl, paused): breathing, shifting the grip, glancing back.
  const keys: Keyframe[] = [];
  const until = 5000 + rand() * 8000;
  let t = 0;
  while (t < until) {
    const rest = 2000 + rand() * 1800;
    keys.push(k("climb0", rest));
    t += rest;
    const r = rand();
    const extra =
      r < 0.3
        ? [k("climb7", 900 + rand() * 700), k("climb7", 60, { glitch: 0.25, fx: "eye" })] // a pause, the eye flickers
        : r < 0.5
          ? [k("climb1", 140), k("climb2", 160)] // shift the grip
          : [k("climb7", 650)]; // breathe
    keys.push(...extra);
    t += sum(extra);
  }
  return keys;
}

/** Climbing (walls) and crawling (ceiling): the drawn 8-frame wall crawl, alternating paws, ~10 fps. */
function climbKeys(rand: () => number): Keyframe[] {
  void rand;
  return cycle("climb", [0, 1, 2, 3, 4, 5, 6, 7], 100);
}

/** Running: faster strides, deep lean, big bob, dust and glitch pixels flying. */
function runKeys(rand: () => number): Keyframe[] {
  // The drawn 6-frame run (with its flight phase), pixels trailing behind.
  const all = [0, 1, 2, 3, 4, 5].map((i) => k(`run${i}`, RUN_MS, { fx: "trail" }));
  if (rand() < 0.35) all[4] = { ...all[4], glitch: 0.4 };
  return all;
}

/** Anticipation before a jump: the drawn crouch, held, a spark in the eye. */
const CROUCH: Keyframe[] = [k("jump0", 70), k("jump1", 110), k("jump1", 90, { glitch: 0.2, fx: "eye" }), k("jump2", 60)];

/** Thrown and spinning: the drawn spin, crackling. */
function tumbleKeys(rand: () => number): Keyframe[] {
  return cycle("spin", [0, 1, 2, 3, 4, 5, 6, 7], 70, { pivot: 0.45 }).map((key, i) => (i % 3 === 0 ? { ...key, glitch: 0.2 + 0.3 * rand(), fx: "eye" as const } : key));
}

/** Falling in a panic: the drawn flailing fall, the eye sparking now and then. */
function flailKeys(rand: () => number): Keyframe[] {
  if (!has("fall_flail")) return cycle("dangle", [0, 2, 4, 6], 70);
  const keys = clip("fall_flail", 75, { ease: 0 });
  if (rand() < 0.35) keys[2] = { ...keys[2], glitch: 0.45, fx: "eye" };
  return keys;
}

/** Landed far too hard: flattened, glitching, pops back up. Then `dizzy`. */
function splatKeys(rand: () => number): Keyframe[] {
  // The drawn hard landing (land2-6): impact, flattened (held), pops up, crouch, recover. Then `dizzy`.
  return [
    k("land2", 50, { glitch: 0.95, fx: "dust" }),
    k("land3", 50, { glitch: 0.8, dx: rand() < 0.5 ? -3 : 3, fx: "dust" }),
    k("land3", 60, { glitch: 0.5, fx: "dust" }),
    k("land3", 450),
    k("land3", 50, { glitch: 0.4, fx: "eye" }),
    k("land4", 90, { glitch: 0.35, fx: "eye" }),
    k("land5", 110),
    k("land6", 140),
  ];
}

/** Seeing stars. */
function dizzyKeys(): Keyframe[] {
  const keys: Keyframe[] = [];
  // The drawn dizzy sway (spiral eyes, stars), twice, slowing down at the end.
  for (const i of [0, 1, 2, 3, 4, 5, 6, 7]) keys.push(k(`dizzy${i}`, 130));
  for (const i of [0, 1, 2, 3, 4, 5, 6, 7]) keys.push(k(`dizzy${i}`, 150 + i * 15));
  return [...keys, k("idle0", 60, { glitch: 0.3, fx: "eye" }), k("idle0", 100)];
}

/** A landing squash proportional to impact speed (CSS px/s), for `interject`. */
export function landKeys(impact: number, base: Omit<Keyframe, "ms"> = { frame: "idle0" }): Keyframe[] {
  const s = Math.min(1, Math.max(0, (impact - 150) / 1300));
  const b = { ...base, rot: 0, pivot: 0 };
  return [
    k(b.frame, 60, { ...b, sx: 1 + 0.28 * s, sy: 1 - 0.32 * s, glitch: s > 0.55 ? 0.5 * s : 0, fx: s > 0.15 ? "dust" : undefined }),
    k(b.frame, 70, { ...b, sx: 1 + 0.16 * s, sy: 1 - 0.18 * s, fx: s > 0.15 ? "dust" : undefined }),
    k(b.frame, 70, { ...b, sx: 1 - 0.05 * s, sy: 1 + 0.07 * s, dy: -3 * s }),
    k(b.frame, 80, { ...b, sx: 1 + 0.02 * s, sy: 1 - 0.02 * s }),
  ];
}

/** Sitting on the very edge of a window, legs over the side, swinging (the drawn swing). */
function sitEdgeKeys(rand: () => number): Keyframe[] {
  // Lowered so he sits on the edge with his legs hanging over it.
  const over = { dy: EDGE_DY };
  if (!has("sit_edge_swing")) return [k("sit0", 1500, { dy: 14 })];
  const keys: Keyframe[] = [];
  for (let i = 0; i < 3; i++) keys.push(...cycle("sit_edge_swing", [0, 1, 2, 3, 4, 5, 6, 7], 150 + rand() * 60, over));
  keys.push(k("sit_edge_swing0", 1200 + rand() * 800, over));
  return keys;
}

/**
 * Sitting on a window's edge: the swing frames are drawn with the legs
 * hanging, the head 30 art px higher in the frame than sitting (sit_down7);
 * lowered by that (x1.5 CSS px) the heads line up and his seat is on the edge.
 */
const EDGE_DY = 45;

/** Ramp a clip's dy from a to b (CSS px). */
const slideDy = (keys: Keyframe[], a: number, b: number): Keyframe[] => keys.map((key, i) => ({ ...key, dy: a + ((b - a) * i) / Math.max(1, keys.length - 1) }));

/** Onto the edge: sits down (the drawn sit_down) and slides over the edge into the swing. */
function edgeSitDown(_rand: () => number, mem: Memory): Keyframe[] {
  const fam = familyOf(String(mem.fromFrame ?? ""));
  if (fam !== "front" || !has("sit_down")) return [];
  // Sits down, then slides forward over the edge so his seat ends on it and the legs hang over.
  return [...clip("sit_down", 95, { ease: 2 }), ...slideDy([k("sit_down7", 70), k("sit_down7", 70), k("sit_down7", 70), k("sit_down7", 70), k("sit_down7", 70)], EDGE_DY / 6, (EDGE_DY * 5) / 6)];
}

/** Off the edge: back up onto it and stand (one of the drawn stand-ups). */
function edgeStandUp(rand: () => number, mem: Memory): Keyframe[] {
  const up = edges()["sit>front"];
  if (!up) return [];
  const last = ((mem.lastClip as Record<string, string>) ??= {});
  // stand_up_paws starts from the crouch the slide ends in (the hop would pop).
  const v = up.find((x) => x.id === "stand_up_paws") ?? pickVariant(up, rand, last["sit>front"]);
  last["sit>front"] = v.id;
  return [...edgeSwingBack(mem), ...slideDy([k("sit_down7", 50, { glitch: 0.4, fx: "eye" }), k("sit_down7", 50, { glitch: 0.2 }), k("sit_down7", 70), k("sit_down7", 70), k("sit_down7", 70)], (EDGE_DY * 5) / 6, EDGE_DY / 6), ...v.keys(rand, mem)];
}

/** Off the edge, first the legs swing back to rest (sit_edge_swing back to frame 0 from where it is). */
function edgeSwingBack(mem: Memory): Keyframe[] {
  const m = /^sit_edge_swing(\d)$/.exec(String(mem.fromFrame ?? ""));
  if (!m) return [];
  // The swing is a cycle: the short way round to frame 0 (back down, or on through 7).
  const at = Number(m[1]);
  const path = at === 0 ? [] : at <= 4 ? Array.from({ length: at }, (_, j) => at - 1 - j) : [...Array.from({ length: 7 - at }, (_, j) => at + 1 + j), 0];
  return path.map((i) => k(`sit_edge_swing${i}`, 70, { dy: EDGE_DY }));
}

/** At a window's edge: lean right over it to look down, eye flickering. */
function peekEdgeKeys(): Keyframe[] {
  // Side-on (the turn's last frame, with the glitch eye); the feet stay put, the body shifts back so the head stays inside the window.
  const f = "turn_front_to_side5";
  return [
    k(f, 300),
    k(f, 120, { rot: 10, dx: -6 }),
    k(f, 900, { rot: 27, dx: -20, dy: 3 }),
    k(f, 60, { rot: 29, dx: -20, dy: 3, glitch: 0.45, fx: "eye" }),
    k(f, 700, { rot: 29, dx: -20, dy: 3, fx: "eye" }),
    k(f, 500, { rot: 24, dx: -18, dy: 2 }),
    k(f, 110, { rot: 8, dx: -5 }),
    k(f, 200),
  ];
}

/**
 * A look around: one of several drawn ways (turning his back to stare at
 * your screen, looking over his shoulder, a glance to the side, sitting down
 * for a look), never the same one twice in a row.
 */
function lookAroundKeys(rand: () => number, mem: Memory = {}): Keyframe[] {
  const ways: [string, () => Keyframe[] | null][] = [
    [
      "back",
      () => {
        if (!has("turn_to_back")) return null;
        const toBack = clip("turn_to_back", 90, { ease: 1 });
        const back = toBack[toBack.length - 1].frame;
        return [...toBack, k(back, 1500 + rand() * 800), k(back, 60, { glitch: 0.35, fx: "eye" }), k(back, 500), ...[...toBack].reverse(), k("idle0", 200)];
      },
    ],
    ["shoulder", () => (has("look_back") ? [...clip("look_back", 120, { ease: 2, hold: 900 }), k("idle0", 300)] : null)],
    [
      "glance",
      () => {
        if (!has("turn_front_to_side")) return null;
        const half = glanceFrames(mem);
        const look = half[half.length - 1].frame;
        return [...half, k(look, 900 + rand() * 700), ...[...half].reverse(), k("idle0", 600), ...half, k(look, 700), ...[...half].reverse(), k("idle0", 200)];
      },
    ],
    ["sit", () => sitBreak(rand, mem)],
  ];
  const pool = ways.filter(([id]) => id !== mem.lastLook);
  for (let tries = 0; tries < 6; tries++) {
    const [id, make] = pool[Math.floor(rand() * pool.length)];
    const keys = make();
    if (keys && keys.length) {
      mem.lastLook = id;
      return keys;
    }
  }
  return [k("idle0", 1500)];
}

/** On a wall: stop and look back down at where he came from. */
const LOOK_BACK: Keyframe[] = [k("climb0", 300), k("climb7", 900), k("climb7", 60, { glitch: 0.3, fx: "eye" }), k("climb0", 300)];

/** Conjuring a platform out of glitch pixels: points at the spot, it builds, a little cheer. */
function buildKeys(rand: () => number): Keyframe[] {
  return [
    ...cycle("point", [0, 1, 2], 90),
    k("point3", 150, { glitch: 0.5, fx: "eye" }),
    k("point4", 250, { fx: "sparkle", glitch: rand() < 0.5 ? 0.25 : 0 }),
    k("point5", 200, { fx: "sparkle" }),
    // Into the cheer through a glitch key, and all the way down again (5-7 land the hop) before idle.
    k("celebrate2", 60, { glitch: 0.45, fx: "eye" }),
    ...cycle("celebrate", [2, 3, 4, 5, 6, 7], 110, { fx: "sparkle" }),
    k("idle0", 200),
  ];
}

/**
 * A malfunction: the picture skips around, tears, freezes on a corrupted
 * frame, half-dissolves and reboots. For `interject` over any pose.
 */
export function stutter(rand: () => number, base: Omit<Keyframe, "ms"> = { frame: "idle0" }): Keyframe[] {
  const keys: Keyframe[] = [];
  const jumps = [0, -7, 6, -3, 9, -5, 2, 0];
  for (let i = 0; i < jumps.length; i++) {
    keys.push({
      ...base,
      ...(rand() < 0.25 ? { dissolve: 0.25 } : {}),
      ms: MIN_KEY_MS,
      dx: (base.dx ?? 0) + jumps[i],
      dy: (base.dy ?? 0) + (rand() < 0.3 ? -3 : 0),
      glitch: 0.6 + 0.4 * rand(),
      fx: "eye",
    });
  }
  keys.push({ ...base, ms: 320, dx: (base.dx ?? 0) + 2, glitch: 0.12 }); // frozen
  keys.push({ ...base, ms: MIN_KEY_MS, dissolve: 0.45, glitch: 0.9 });
  keys.push({ ...base, ms: MIN_KEY_MS, dissolve: 0.2, glitch: 0.6, fx: "eye" });
  keys.push({ ...base, ms: 150, fx: "eye" });
  return keys;
}

/** Getting sleepy: a big stretch, sit down, curl up (then `sleep`). */
const YAWN: Keyframe[] = [
  // The drawn wake-up, backwards: stand, big yawn and stretch, then curl up.
  k("wake7", 300),
  k("wake6", 250),
  k("wake3", 500),
  k("wake4", 900),
  k("wake3", 300),
  k("wake2", 400),
  k("wake1", 700),
  k("wake0", 500),
  k("sleep0", 1500),
];

/** Woken up: the drawn wake-up (stretch, yawn, blink awake). */
const WAKE: Keyframe[] = [
  k("wake0", 400),
  k("wake1", 250),
  k("wake2", 200),
  k("wake3", 350),
  k("wake4", 600),
  k("wake5", 250),
  k("wake6", 200),
  k("wake7", 300, { fx: "eye" }),
];

/**
 * Listening (push-to-talk held): facing you, ears up, leaning in with a small
 * bob in time, a purple pixel equalizer by his head. 100 ms keys: 10 repaints/s.
 */
function listenKeys(rand: () => number): Keyframe[] {
  // The drawn listening loop (ears up, leaning in), the equalizer by his head.
  const keys = [...cycle("listen", [0, 1, 2, 3, 4, 5, 6, 7], 130, { fx: "eq" }), ...cycle("listen", [4, 5, 6, 7], 130, { fx: "eq" })];
  if (rand() < 0.3) keys[9] = { ...keys[9], glitch: 0.3 };
  return keys;
}

/** Held up by the cursor: hanging limp, stretched by his own weight (the swing itself is physics, in creature.ts). */
function heldKeys(rand: () => number): Keyframe[] {
  const keys = [k("dangle0", 700 + rand() * 500), k("dangle1", 500), k("dangle1", 60, { glitch: 0.3, fx: "eye" }), k("dangle0", 600 + rand() * 400, { fx: "eye" })];
  // Looks around, a bit worried (the drawn dangle, a kick or two).
  if (rand() < 0.5) keys.push(...cycle("dangle", [0, 1, 2, 3], 140));
  return keys;
}

/** Carried around fast: legs running in the air. */
function heldKickKeys(rand: () => number): Keyframe[] {
  // Carried fast: the dangle frames played quickly (legs pedalling).
  const keys = cycle("dangle", [0, 1, 2, 3, 4, 5, 6, 7], 70, { pivot: 0.9 });
  if (rand() < 0.3) keys[1] = { ...keys[1], glitch: 0.4, fx: "eye" };
  return keys;
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
  | "napRock"
  | "cling"
  | "climb"
  | "run"
  | "crouch"
  | "airUp"
  | "airDown"
  | "tumble"
  | "flail"
  | "splat"
  | "dizzy"
  | "sitEdge"
  | "peekEdge"
  | "lookAround"
  | "lookBack"
  | "build"
  | "malfunction"
  | "yawn"
  | "held"
  | "heldKick"
  | "listen"
  | "talk"
  | "wave"
  | "wake"
  | "sad"
  | "angry"
  | "scared"
  | "dance"
  | "eat"
  | "celebrate"
  | "tail_copter"
  | "glide"
  | "fall_flail"
  | "hang_ledge"
  | "pull_up"
  | "slide_down"
  | "sit_edge_swing"
  | "fish"
  | "bounce"
  | "wall_jump"
  | "sneeze"
  | "struggle"
  | "clingCursor"
  | "annoyed"
  | "grumpy"
  | "sulk"
  | "calmDown"
  | "point"
  | "typing"
  | "sit";

export const ANIMATIONS: Record<AnimationName, Animation> = {
  // moods
  idle: { keys: idleKeys },
  walk: {
    keys: (r) => walkCycle(r),
    // From standing facing you: the drawn first steps (turns side-on as he sets off).
    // Facing left the drawn turn to the left comes first (front frames never mirror, see transitions.ts toSide).
    intro: (_r, mem) => (familyOf(String(mem.fromFrame ?? "")) !== "front" ? [] : mem.facingLeft ? toSide(mem, 85) : has("walk_start") ? clip("walk_start", 85, { ease: 1 }) : []),
    // Stopping (unless he goes straight into another gait): the drawn stop, settling side-on.
    outro: (_r, mem) => (has("walk_stop") && !GAITS.includes(String(mem.next)) ? clip("walk_stop", 90, { ease: 1, hold: 200 }) : []),
  },
  think: { keys: thinkKeys },
  ask: { keys: askKeys },
  happy: { keys: happyKeys, once: true },
  // 2.4 s per key: under 0.5 repaints per second while asleep.
  // The drawn curled-up breathing (sleep0-7), one frame per 2.4 s.
  sleep: { keys: cycle("sleep", [0, 1, 2, 3, 4, 5, 6, 7], 2400, { fx: "zzz" }) },
  wake: { keys: WAKE, once: true },
  sad: { keys: () => [...sheetOnce("sad", 140, 900)], once: true },
  angry: { keys: () => [...sheetOnce("angry", 90, 500), ...cycle("angry", [5, 6, 7], 90)], once: true },
  scared: { keys: () => sheetOnce("scared", 80, 500), once: true },
  dance: { keys: () => [...cycle("dance", [0, 1, 2, 3, 4, 5, 6, 7], 120, { fx: "sparkle" })] },
  eat: { keys: () => [...sheetOnce("eat", 140, 500)], once: true },
  celebrate: { keys: celebrateKeys, once: true },
  // Air and ledge behaviours (started by the physics: never bridged).
  tail_copter: { keys: () => clip("tail_copter", 70, { ease: 0 }), bridge: false },
  glide: { keys: () => clip("glide", 110, { ease: 0 }), bridge: false },
  fall_flail: { keys: (r) => flailKeys(r), bridge: false },
  hang_ledge: { keys: (r) => [...clip("hang_ledge", 160, { ease: 0 }), k("hang_ledge0", 600 + r() * 600)], bridge: false },
  pull_up: { keys: () => clip("pull_up", 95, { ease: 1, hold: 200 }), once: true, bridge: false },
  slide_down: { keys: () => clip("slide_down", 90, { ease: 0 }), bridge: false },
  sit_edge_swing: { keys: sitEdgeKeys, intro: (r, mem) => edgeSitDown(r, mem), outro: (r, mem) => edgeStandUp(r, mem) },
  // Fishing off a window edge: casts (skipping the first frame, its line encloses
  // some sheet background), waits, a bite, catches one.
  fish: { keys: (r) => [k("fish1", 300), k("fish2", 1500 + r() * 1500), k("fish3", 1800 + r() * 2000), k("fish4", 260), k("fish5", 260), k("fish6", 500), k("fish7", 900), k("fish6", 400)] },
  bounce: { keys: () => clip("bounce", 85, { ease: 1, hold: 150 }), once: true, bridge: false },
  wall_jump: { keys: () => clip("wall_jump", 80, { ease: 0 }), once: true, bridge: false },
  // A sneeze on cue (chaos mode): the same drawn sneeze as the idle fidget.
  sneeze: { keys: (r, mem) => FIDGETS.find((f) => f.id === "sneeze")!.make(r, mem) ?? [k("idle0", 300)], once: true },
  // Annoyed (creature.ts annoyance): wriggling while held, clinging to the
  // cursor, arms crossed and foot tapping, biting the cursor, sulking with his
  // back turned, calming down with a little hop.
  struggle: { keys: () => (has("struggle") ? clip("struggle", 85, { ease: 0 }) : cycle("dangle", [0, 1, 2, 3, 4, 5, 6, 7], 70)), bridge: false },
  clingCursor: { keys: () => (has("cling_cursor") ? clip("cling_cursor", 110, { ease: 0 }) : cycle("dangle", [0, 1, 2, 3], 130)), bridge: false },
  annoyed: {
    keys: () => (has("annoyed") ? [...clip("annoyed", 120, { ease: 1 }), ...clip("annoyed", 120, { ease: 0, hold: 600 }), k("idle0", 200)] : [...sheetOnce("angry", 90, 600), k("idle0", 200)]),
    once: true,
  },
  grumpy: {
    keys: () => [
      ...(has("bite_cursor") ? clip("bite_cursor", 90, { ease: 1, hold: 300 }) : sheetOnce("angry", 90, 400)),
      ...(has("turn_to_back") ? clip("turn_to_back", 100, { ease: 1 }) : []),
    ],
    once: true,
    next: "sulk",
  },
  sulk: {
    // Back turned; now and then a look back over his shoulder (the turn's 3/4 frame).
    keys: (r) => (has("turn_to_back") ? [k("turn_to_back5", 1400 + r() * 900), k("turn_to_back4", 140), k("turn_to_back3", 700), k("turn_to_back4", 140)] : [k("idle0", 1500)]),
  },
  calmDown: {
    keys: () => [...(has("turn_to_back") ? clip("turn_to_back", 100, { ease: 1, reverse: true }) : []), ...(has("hop_idle") ? clip("hop_idle", 85, { ease: 1 }) : []), k("idle0", 200)],
    once: true,
  },
  // "There you go!" when he opened a website or an app.
  point: { keys: () => [...cycle("point", [0, 1, 2], 90), k("point3", 140), k("point4", 500, { fx: "sparkle" }), k("point5", 300), k("point6", 200), k("point7", 250)], once: true },
  typing: { keys: () => cycle("typing", [0, 1, 2, 3, 4, 5, 6, 7], 220) },
  sit: { keys: fidgetSit },
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
      // The drawn fall (arms up) dropping in, then the landing.
      k("jump5", 170),
    ],
    once: true,
    next: "land",
  },
  land: {
    // Landing squash and recover (side-on); the turn back to facing you is the bridge into what follows.
    keys: [k("jump6", 90, { fx: "dust" }), k("jump6", 90, { fx: "dust" }), k("jump7", 110, { fx: "dust" }), k("jump7", 120)],
    once: true,
  },
  glitchOut: { keys: glitchOutKeys, once: true, next: "gone" },
  // Invisible for a moment (the window can move now), then glitch back in.
  gone: { keys: [k("idle0", 900, { dissolve: 1 })], once: true, next: "glitchIn" },
  glitchIn: { keys: glitchInKeys, once: true },
  chaosSpin: { keys: chaosSpinKeys, once: true },
  // Dozing off sitting up (the end of the drawn sit-down: eyes closing), sat into and stood out of through the clips.
  napRock: { keys: [k("sit_down7", 2400), k("sit_down6", 2400)] },
  // living in the world (creature.ts)
  cling: { keys: clingKeys },
  climb: { keys: climbKeys },
  run: { keys: runKeys },
  crouch: { keys: CROUCH, once: true },
  // One still key each (the flight repaints them with spin, stretch, trail; a second key would add repaints in the air):
  // the launch stretch is the end of the crouch, then the tuck rising and arms up falling.
  airUp: { keys: [k("jump3", 1000)] },
  airDown: { keys: [k("jump5", 1000)] },
  talk: { keys: talkKeys },
  wave: { keys: waveKeys, once: true },
  tumble: { keys: tumbleKeys },
  flail: { keys: flailKeys },
  splat: { keys: splatKeys, once: true, next: "dizzy" },
  dizzy: { keys: dizzyKeys, once: true },
  sitEdge: { keys: sitEdgeKeys, intro: (r, mem) => edgeSitDown(r, mem), outro: (r, mem) => edgeStandUp(r, mem) },
  peekEdge: { keys: peekEdgeKeys, once: true },
  lookAround: { keys: lookAroundKeys, once: true },
  lookBack: { keys: LOOK_BACK, once: true, next: "cling" },
  build: { keys: buildKeys, once: true },
  malfunction: { keys: (r) => stutter(r), once: true },
  yawn: { keys: YAWN, once: true, next: "sleep" },
  held: { keys: heldKeys },
  heldKick: { keys: heldKickKeys },
  listen: { keys: listenKeys },
};

/**
 * Started by the physics or by surprise: these begin at once, never through a
 * transition clip (a fall can't wait for him to stand up first).
 */
const NO_BRIDGE: AnimationName[] = [
  "startled", "dangle", "fall", "land", "glitchOut", "gone", "glitchIn", "chaosSpin", "cling", "climb", "crouch", "airUp",
  "airDown", "tumble", "flail", "splat", "dizzy", "lookBack", "malfunction", "held", "heldKick", "peek", "peekEdge",
];
for (const n of NO_BRIDGE) ANIMATIONS[n].bridge = false;

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
  /** Memory for key makers and transition variants (per animator, so runs stay reproducible). */
  readonly mem: Memory = {};
  /**
   * Playback speed of the current animation (1 = as keyed). The creature sets
   * it from the ground speed while walking, so the drawn stride matches the
   * distance covered. Reset to 1 by play().
   */
  rate = 1;
  /** Called after every switch of animation (also when a one-shot hands over to its follow-up). */
  onChange: ((name: AnimationName) => void) | null = null;

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
  play(name: AnimationName, then?: AnimationName, lead: Keyframe[] = []): void {
    const anim = this.animations[name];
    if (name === this.current && !anim.once && this.keys.length > 0 && lead.length === 0) return;
    // Leaving the running animation: finish a transition clip it was in the middle of, then its outro.
    const outro = name !== this.current && this.keys.length > 0 && anim.bridge !== false ? this.exitKeys(name) : [];
    this.mem.next = name;
    this.current = name;
    this.then = then ?? anim.next ?? "idle";
    // What is on screen once the outro and the lead-in have played.
    const shown = [...outro, ...lead].at(-1)?.frame ?? this.lastPose?.frame ?? null;
    this.mem.fromFrame = shown;
    const body = [...(anim.intro && anim.bridge !== false ? anim.intro(this.random, this.mem) : []), ...this.resolve(anim)];
    // Never cut between pose families: bridge to the first frame of the new animation.
    const glue = anim.bridge === false || body.length === 0 ? [] : bridge(shown, body[0].frame, this.random, this.mem as { lastClip?: Record<string, string> });
    this.keys = [...outro, ...lead, ...glue, ...body];
    this.index = 0;
    this.lastPose = null; // always draw the first key of a new animation
    this.rate = 1;
    this.step();
    // Last, so a handler that switches again sees a consistent animator.
    if (this.current === name) this.onChange?.(name);
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

  /**
   * What to play before leaving the running animation for `next`: the rest of
   * a transition clip cut off mid-way at double speed and an ease out of a
   * lean or offset (settleKeys), then the animation's outro. play() leads
   * every bridged switch with these; callers starting an unbridged animation
   * on purpose (a startle) can lead with them too.
   */
  exitKeys(next?: AnimationName): Keyframe[] {
    const prev = this.animations[this.current];
    if (next) this.mem.next = next;
    this.mem.fromFrame = this.lastPose?.frame ?? null;
    const settle = settleKeys(this.lastPose, this.keys.slice(this.index), !prev?.outro);
    if (settle.length) this.mem.fromFrame = settle[settle.length - 1].frame;
    return [...settle, ...(prev?.outro && this.keys.length > 0 ? prev.outro(this.random, this.mem) : [])];
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
    return typeof anim.keys === "function" ? anim.keys(this.random, this.mem) : anim.keys;
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
    // `rate` speeds walking cycles up or down with the actual ground speed (no foot sliding).
    if (!still) this.timer = this.clock.setTimeout(this.step, Math.max(MIN_KEY_MS, Math.round(ms / this.rate)));
  };
}

/** Transition clips: cut off mid-way, they finish at double speed first (settleKeys). */
const TRANSITION_CLIP = /^(sit_down|stand_up_paws|stand_up_hop|stand_up_glitch|turn_front_to_side|turn_side_to_front|turn_to_back|turn_around|walk_start|lie_down|get_up|wake)\d+$/;

/**
 * Keys that get him from `shown` to a clean pose before something new
 * starts: the rest of the transition clip he is in the middle of (from the
 * keys still `upcoming`, at double speed, so a stand-up or a turn is never
 * cut in half), and with `ease`, a lean or offset (peekEdge leans 27 degrees,
 * 20 px back) eased back to upright over three keys instead of snapping.
 */
export function settleKeys(shown: Pose | null, upcoming: Keyframe[], ease = true): Keyframe[] {
  if (!shown) return [];
  const out: Keyframe[] = [];
  if (TRANSITION_CLIP.test(shown.frame)) {
    const base = shown.frame.replace(/\d+$/, "");
    let last = shown.frame;
    for (const key of upcoming) {
      if (!TRANSITION_CLIP.test(key.frame) || key.frame.replace(/\d+$/, "") !== base) break;
      if (key.frame === last) continue; // held keys, glitch keys over the same drawing
      last = key.frame;
      out.push({ ...key, ms: Math.max(MIN_KEY_MS, Math.min(80, Math.round(key.ms / 2))), glitch: 0, fx: undefined });
    }
  }
  const end = out.length ? toPose(out[out.length - 1]) : shown;
  if (ease && (Math.abs(end.rot) > 2 || Math.abs(end.dx) > 3 || Math.abs(end.dy) > 3)) {
    for (const f of [0.6, 0.3, 0.1]) out.push(k(end.frame, 60, { flip: end.flip, pivot: end.pivot, rot: end.rot * f, dx: Math.round(end.dx * f), dy: Math.round(end.dy * f) }));
  }
  return out;
}
