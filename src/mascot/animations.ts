// Glitch's animations as keyframes (pose + procedural transform + effects),
// and a timer that plays them without ever using requestAnimationFrame
// (rAF would wake the CPU 60+ times/second even when nothing moves).
//
// Units: dx/dy and prop positions in CSS px, +dx = the way Glitch faces
// (mirrored when walking left), +dy = down. rot in degrees, + = lean forward.
// sx/sy scale around the feet (or `pivot`). glitch 0..1 drives render.ts.

import type { GridPropName } from "./props";

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
/** Walk keys: 12 fps drawn frames (the window itself moves at 30 Hz, see creature.ts). */
const WALK_MS = 83;
/** Run keys: ~14 fps. */
const RUN_MS = 70;

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

/** Sits down for a calm moment (sit0-7): blinks, looks around. */
function fidgetSit(rand: () => number = Math.random): Keyframe[] {
  return [k("sit0", 1800 + rand() * 1200), k("sit1", 160), k("sit0", 1200), k("sit3", 1500), k("sit4", 800), k("sit5", 1200), k("sit0", 700)];
}

function fidget(rand: () => number): Keyframe[] {
  switch (Math.floor(rand() * 7)) {
    case 0: // now and then a sneeze: itch, ah... ah... (anticipation), CHOO, rub the nose
      if (rand() < 0.5) return [k("idle1", 1800 + rand() * 1500)];
      return [
        k("sneeze0", 150),
        k("sneeze1", 260),
        k("sneeze2", 300),
        k("sneeze3", 380),
        k("sneeze4", 140, { glitch: 0.45, fx: "eye" }),
        k("sneeze5", 220),
        k("sneeze6", 360),
        k("sneeze7", 220),
      ];
    case 6:
      return fidgetSit(rand);
    case 1: // glance sideways (sometimes both ways)
      return rand() < 0.5 ? [k("side", 1400 + rand() * 900)] : [k("side", 1100), k("side", 1000, { flip: true })];
    case 2:
      return hop("idle0", 6 + rand() * 4);
    case 3: // the glitch eye twitches
      return [k("idle0", 60, { glitch: 0.2, fx: "eye" }), k("idle0", 120, { fx: "eye" }), k("idle0", 60, { glitch: 0.35, fx: "eye" })];
    case 4: // swish the tail
      return [k("idle1", 1800 + rand() * 1500)];
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
  let nextBlink = 2000 + rand() * 4000;
  while (t < until) {
    // Breathing: out (idle0, long hold), in (idle1). Two repaints per breath keeps idle under budget.
    const breath = [k("idle0", 4800 + rand() * 1500), k("idle1", 1800 + rand() * 300)];
    keys.push(...breath);
    t += sum(breath);
    if (t >= nextBlink) {
      // Blink: half, closed, half (eye lids drawn in idle4-6).
      const blink = [k("idle4", 60), k("idle5", 90), k("idle6", 60)];
      if (rand() < 0.12) blink.push(k("idle0", 140), k("idle4", 60), k("idle5", 80), k("idle6", 60)); // double blink
      keys.push(...blink);
      t += sum(blink);
      nextBlink = t + 6000 + rand() * 5000;
    } else if (rand() < 0.1) {
      // Ear twitch (idle2): flick, back, flick.
      const ear = [k("idle2", 120), k("idle0", 90), k("idle2", 110)];
      keys.push(...ear);
      t += sum(ear);
    }
    if (!fidgeted && t >= fidgetAt) {
      fidgeted = true;
      const extra = fidget(rand);
      keys.push(...extra);
      t += sum(extra);
    }
  }
  return [...keys, ...burst(rand)];
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

function grabCursorKeys(rand: () => number): Keyframe[] {
  const ground = { name: "cursor" as const, x: 40, y: -22, rot: 0 };
  const lying = { props: [ground] };
  return [
    // Spot it (surprised), crouch, wiggle...
    k("surprised2", 260, { dx: -16, ...lying }),
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
  // Held by the scruff: the drawn dangle (legs kicking, tail swinging) with a gentle pendulum.
  const swing = [-5, -3, 0, 3, 5, 3, 0, -3];
  const keys = swing.map((rot, i) => k(`dangle${i}`, 120, { rot, pivot: 1, dy: -6, fx: i % 4 === 0 ? "eye" : undefined }));
  if (rand() < 0.4) keys[3] = { ...keys[3], glitch: 0.35 };
  return keys;
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
  const keys: Keyframe[] = [];
  const until = 5000 + rand() * 8000;
  let t = 0;
  while (t < until) {
    const rest = 2000 + rand() * 1800;
    keys.push(k("walk0", rest, { sy: 0.97 }));
    t += rest;
    const r = rand();
    const extra =
      r < 0.3
        ? [k("side", 900 + rand() * 700, { flip: true, sy: 0.98 })] // over the shoulder
        : r < 0.5
          ? [k("walk1", 140, { sy: 0.95, dx: 2 }), k("walk0", 160, { sy: 0.96, dx: 1 })] // shift the grip
          : [k("walk0", 650, { sy: 0.995, dy: -1 })]; // breathe
    keys.push(...extra);
    t += sum(extra);
  }
  return [...keys, ...burst(rand, { frame: "walk0", sy: 0.97 })];
}

/** Climbing (walls) and crawling (ceiling): a slower, flatter gait than walking. */
function climbKeys(rand: () => number): Keyframe[] {
  const reach = (o: Omit<Keyframe, "frame" | "ms"> = {}) => [
    k("walk0", 80, { sx: 1.05, sy: 0.93, ...o }),
    k("walk0", 80, { dy: -1, sy: 0.96, ...o }),
    k("walk1", 80, { dy: -3, sx: 0.96, sy: 1.04, rot: 3, ...o }),
    k("walk1", 80, { dy: -2, sy: 1.0, rot: 1, ...o }),
  ];
  const keys = [...reach(), ...reach({ dx: 1 })];
  if (rand() < 0.25) keys[6] = { ...keys[6], glitch: 0.35, fx: "eye" };
  return keys;
}

/** Running: faster strides, deep lean, big bob, dust and glitch pixels flying. */
function runKeys(rand: () => number): Keyframe[] {
  // The drawn 6-frame run (with its flight phase), pixels trailing behind.
  const all = [0, 1, 2, 3, 4, 5].map((i) => k(`run${i}`, RUN_MS, { fx: "trail" }));
  if (rand() < 0.35) all[4] = { ...all[4], glitch: 0.4 };
  return all;
}

/** Anticipation before a jump: the drawn crouch, held, a spark in the eye. */
const CROUCH: Keyframe[] = [k("jump0", 70), k("jump1", 110), k("jump1", 90, { glitch: 0.2, fx: "eye" })];

/** Thrown and spinning: the purple swirl pose, crackling. */
function tumbleKeys(rand: () => number): Keyframe[] {
  return [
    k("chaos", 70, { glitch: 0.2 + 0.3 * rand(), fx: "eye", pivot: 0.45 }),
    k("glitch", 70, { glitch: 0.15, pivot: 0.45 }),
    k("chaos", 70, { glitch: 0.35, fx: "eye", pivot: 0.45, sx: 1.04 }),
    k("glitch", 70, { pivot: 0.45, sy: 1.05 }),
  ];
}

/** Falling in a panic: legs going, looking both ways, the eye sparking. */
function flailKeys(rand: () => number): Keyframe[] {
  return [
    k("walk1", 60, { rot: -9, sy: 1.07, pivot: 0.5 }),
    k("walk0", 60, { rot: 7, flip: true, sy: 1.06, pivot: 0.5 }),
    k("walk1", 60, { rot: -6, flip: true, sy: 1.07, pivot: 0.5, fx: "eye" }),
    k("walk0", 60, { rot: 9, sy: 1.05, pivot: 0.5, glitch: rand() < 0.35 ? 0.45 : 0, fx: "eye" }),
  ];
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

/** Sitting on the very edge of a window, legs over the side, swinging. */
function sitEdgeKeys(rand: () => number): Keyframe[] {
  const keys: Keyframe[] = [];
  const over = { dy: 14 };
  for (let i = 0; i < 6; i++) {
    keys.push(k("sit0", 700 + rand() * 500, { ...over, rot: i % 2 ? 2 : -1, pivot: 0.3 }));
    if (rand() < 0.25) keys.push(k("sit0", 1400, { ...over, rot: 7, pivot: 0.1 })); // look down
    if (rand() < 0.15) keys.push(k("side", 1200, { dy: 10, flip: rand() < 0.5 }));
  }
  return [...keys, ...burst(rand, { frame: "sit0", ...over })];
}

/** At a window's edge: lean right over it to look down, eye flickering. */
function peekEdgeKeys(): Keyframe[] {
  // The feet stay put; the body shifts back a little so the leaning head stays inside the window.
  return [
    k("side", 300),
    k("side", 120, { rot: 10, dx: -6, sx: 1.02, sy: 0.98 }),
    k("side", 900, { rot: 27, dx: -20, dy: 3 }),
    k("side", 60, { rot: 29, dx: -20, dy: 3, glitch: 0.45, fx: "eye" }),
    k("side", 700, { rot: 29, dx: -20, dy: 3, fx: "eye" }),
    k("side", 500, { rot: 24, dx: -18, dy: 2 }),
    k("side", 110, { rot: 8, dx: -5 }),
    k("idle0", 200, { sx: 1.03, sy: 0.97 }),
  ];
}

/** A look around, ending with turning his back to stare at your screen. */
function lookAroundKeys(rand: () => number): Keyframe[] {
  const first = rand() < 0.5;
  return [
    k("side", 800, { flip: first }),
    k("side", 900, { flip: !first }),
    k("idle0", 120, { sx: 1.02, sy: 0.98 }),
    k("back", 1500 + rand() * 800),
    k("back", 60, { glitch: 0.35, fx: "eye" }),
    k("back", 500),
    k("idle0", 140, { sx: 1.03, sy: 0.97 }),
  ];
}

/** On a wall: stop and look back down at where he came from. */
const LOOK_BACK: Keyframe[] = [k("walk0", 200, { sy: 0.97 }), k("side", 1000, { flip: true }), k("side", 60, { flip: true, glitch: 0.3, fx: "eye" }), k("walk0", 300, { sy: 0.97 })];

/** Conjuring a platform out of glitch pixels. */
function buildKeys(rand: () => number): Keyframe[] {
  return [
    k("wave", 90, { glitch: 0.5, fx: "eye" }),
    k("happy", 120, { glitch: 0.3, fx: "sparkle" }),
    k("wave", 150, { fx: "sparkle", glitch: rand() < 0.5 ? 0.25 : 0 }),
    k("happy", 250, { fx: "sparkle" }),
    k("wave", 300, { fx: "sparkle" }),
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
      frame: rand() < 0.25 ? "glitch" : base.frame,
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
  k("wake0", 60, { glitch: 0.2, fx: "eye" }),
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
  const keys = [
    k("idle0", 700 + rand() * 500, { sx: 0.93, sy: 1.1 }),
    k("idle0", 500, { sx: 0.92, sy: 1.12 }),
    k("idle0", 60, { sx: 0.92, sy: 1.12, glitch: 0.3, fx: "eye" }),
    k("idle0", 600 + rand() * 400, { sx: 0.93, sy: 1.1, fx: "eye" }),
  ];
  // Looks around, a bit worried.
  if (rand() < 0.5) keys.push(k("side", 700, { sx: 0.93, sy: 1.1, flip: rand() < 0.5 }));
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
  | "point"
  | "typing"
  | "sit";

export const ANIMATIONS: Record<AnimationName, Animation> = {
  // moods
  idle: { keys: idleKeys },
  walk: { keys: (r) => walkCycle(r) },
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
      k("idle0", 60, { dy: -18, sx: 0.88, sy: 1.12 }),
      k("idle0", 60, { dy: -9, sx: 0.9, sy: 1.1 }),
      k("idle0", 50, { dy: -2, sx: 0.94, sy: 1.06 }),
    ],
    once: true,
    next: "land",
  },
  land: {
    keys: [k("jump6", 90, { glitch: 0.35, fx: "dust" }), k("jump6", 90, { fx: "dust" }), k("jump7", 110, { fx: "dust" }), k("idle0", 150)],
    once: true,
  },
  glitchOut: { keys: glitchOutKeys, once: true, next: "gone" },
  // Invisible for a moment (the window can move now), then glitch back in.
  gone: { keys: [k("idle0", 900, { dissolve: 1 })], once: true, next: "glitchIn" },
  glitchIn: { keys: glitchInKeys, once: true },
  chaosSpin: { keys: chaosSpinKeys, once: true },
  napRock: { keys: [k("nap_rock", 2400, { sx: 1.01, sy: 0.98 }), k("nap_rock", 2400)] },
  // living in the world (creature.ts)
  cling: { keys: clingKeys },
  climb: { keys: climbKeys },
  run: { keys: runKeys },
  crouch: { keys: CROUCH, once: true },
  // Single still keys: the window flight repaints them (with spin, stretch, trail).
  // Launch stretch then the tuck, held while the window flies (it repaints them with spin, stretch, trail).
  airUp: { keys: [k("jump2", 120), k("jump3", 1000)] },
  airDown: { keys: [k("jump4", 120), k("jump5", 1000)] },
  talk: { keys: talkKeys },
  wave: { keys: waveKeys, once: true },
  tumble: { keys: tumbleKeys },
  flail: { keys: flailKeys },
  splat: { keys: splatKeys, once: true, next: "dizzy" },
  dizzy: { keys: dizzyKeys, once: true },
  sitEdge: { keys: sitEdgeKeys },
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
  play(name: AnimationName, then?: AnimationName): void {
    const anim = this.animations[name];
    if (name === this.current && !anim.once && this.keys.length > 0) return;
    this.current = name;
    this.then = then ?? anim.next ?? "idle";
    this.keys = this.resolve(anim);
    this.index = 0;
    this.lastPose = null; // always draw the first key of a new animation
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
