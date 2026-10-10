// Chaos mode 2's overlay effects, the pure part: geometry, timelines and the
// flash schedule (so it is unit-tested; chaosfx.ts only draws). Everything here
// is in the overlay's CSS px, y down.
//
// Flashing rule (WCAG 2.3.1): nothing may flash more than 3 times in any one
// second, and nothing flashes large and bright. Smooth fades are not flashes;
// the only discrete bursts are the small sparks listed in FLASHES.

export interface P {
  x: number;
  y: number;
}

/** Deterministic hash in [0, 1) (same idea as hash01 in glitch-core chaos2.rs). */
export function hash01(a: number, b: number): number {
  let x = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b)) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) >>> 0;
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  return (x % 1_000_003) / 1_000_003;
}

export const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));
export const smooth = (t: number): number => {
  const k = clamp01(t);
  return k * k * (3 - 2 * k);
};

// ------------------------------------------------------------- the line

export type HookPhase = "cast" | "reel" | "release" | "snap";

export interface Line {
  /** Points from the rod tip to the hook. */
  pts: P[];
  /** The hook sits at the last point (hidden while the line is retracted). */
  hook: P | null;
  /** 0..1: how much of the line exists (casting out / reeling back in). */
  reach: number;
}

/** A sagging line between two points: `sag` px lower in the middle. */
export function sagLine(a: P, b: P, sag: number, n = 18): P[] {
  const out: P[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t + sag * 4 * t * (1 - t) });
  }
  return out;
}

/**
 * The line `t` ms into a phase. Cast: the hook flies from the rod tip to the
 * cursor (a high arc, the line trailing). Reel: taut, a little sag that
 * shrinks and a slight hum. Release: reeled back in. Snap: handled by the drawer.
 */
export function lineAt(phase: HookPhase, t: number, rod: P, cursor: P, castMs: number): Line {
  const dist = Math.hypot(cursor.x - rod.x, cursor.y - rod.y);
  if (phase === "cast") {
    const k = smooth(t / Math.max(1, castMs * 0.8));
    const hook = { x: rod.x + (cursor.x - rod.x) * k, y: rod.y + (cursor.y - rod.y) * k - Math.sin(Math.PI * k) * Math.min(120, dist * 0.35) };
    const pts = sagLine(rod, hook, 22 * (1 - k) + 6, 16);
    return { pts, hook: k > 0.02 ? hook : null, reach: k };
  }
  if (phase === "reel") {
    const hum = Math.sin(t / 55) * 1.2;
    const sag = Math.max(2, 14 - t / 120) + hum;
    return { pts: sagLine(rod, cursor, sag), hook: cursor, reach: 1 };
  }
  // release: reeled back to the rod over 450 ms
  const k = 1 - smooth(t / 450);
  const hook = { x: rod.x + (cursor.x - rod.x) * k, y: rod.y + (cursor.y - rod.y) * k };
  return { pts: sagLine(rod, hook, 10 * k + 2), hook: k > 0.04 ? hook : null, reach: k };
}

/** After a snap: the two halves of the line fall away. `t` ms since the snap. */
export function snapHalves(rod: P, cursor: P, t: number): { a: P[]; b: P[]; at: P } {
  const at = { x: rod.x + (cursor.x - rod.x) * 0.55, y: rod.y + (cursor.y - rod.y) * 0.55 };
  const fall = (t * t) / 2200;
  const a = sagLine(rod, { x: at.x - 8 - t / 40, y: at.y + fall * 0.5 }, 8 + t / 30);
  const b = sagLine({ x: at.x + 8 + t / 40, y: at.y + fall }, { x: cursor.x, y: cursor.y + fall * 1.2 }, 6);
  return { a, b, at };
}

// -------------------------------------------------------------- the trail

/** Ghost copies of the arrow: the cursor's last positions, oldest faintest. */
export interface Ghost {
  p: P;
  alpha: number;
}

export function ghostCopies(history: { p: P; t: number }[], now: number, spanMs = 760, copies = 7): Ghost[] {
  const out: Ghost[] = [];
  let lastKept: P | null = null;
  for (let i = 0; i < copies; i++) {
    const want = now - ((i + 1) * spanMs) / copies;
    const h = history.filter((e) => e.t <= want).at(-1);
    if (!h) break;
    // Copies that sit right on top of each other are one copy.
    if (lastKept && Math.hypot(h.p.x - lastKept.x, h.p.y - lastKept.y) < 3) continue;
    lastKept = h.p;
    out.push({ p: h.p, alpha: 0.5 * (1 - (i + 1) / (copies + 1)) });
  }
  return out;
}

/** The arrow (pixel art, 1 = outline, 2 = fill), tip at (0, 0). */
export const ARROW: readonly string[] = [
  "1",
  "11",
  "121",
  "1221",
  "12221",
  "122221",
  "1222221",
  "12222221",
  "122222221",
  "1222222221",
  "12222211111",
  "1221221",
  "121 1221",
  "11  1221",
  "1    1221",
  "     1221",
  "      11",
];

// ------------------------------------------------------------ matrix rain

export interface RainColumn {
  x: number;
  speed: number;
  len: number;
  delay: number;
  seed: number;
}

export const RAIN_CELL = 16;

export function rainColumns(w: number, seed: number): RainColumn[] {
  const n = Math.max(1, Math.floor(w / RAIN_CELL));
  const cols: RainColumn[] = [];
  for (let i = 0; i < n; i++) {
    // Not every column rains: a sparse, magenta-ish curtain.
    if (hash01(seed, i * 3) > 0.55) continue;
    cols.push({ x: i * RAIN_CELL, speed: 160 + hash01(seed, i * 3 + 1) * 260, len: 6 + Math.floor(hash01(seed, i * 3 + 2) * 12), delay: hash01(seed + 5, i) * 1500, seed: i });
  }
  return cols;
}

/** Overall opacity of the rain: fades in, holds low, fades out. Never above `MAX_RAIN_ALPHA`. */
export const MAX_RAIN_ALPHA = 0.4;
export function rainAlpha(t: number, total: number): number {
  return MAX_RAIN_ALPHA * smooth(t / 700) * smooth((total - t) / 800);
}

// ---------------------------------------------------------------- scanlines

/** The sweep's centre y at `t` of `total` ms (one slow pass top to bottom). */
export function scanSweepY(t: number, total: number, h: number): number {
  return -80 + (h + 160) * clamp01(t / total);
}

export const MAX_SCAN_ALPHA = 0.16;
export function scanAlpha(t: number, total: number): number {
  return MAX_SCAN_ALPHA * smooth(t / 500) * smooth((total - t) / 500);
}

// --------------------------------------------------------------------- melt

export const MELT_COLUMN = 12;

/** Per column: delay (ms) and how far it drips (fraction of the height). */
export function meltColumns(n: number, seed: number): { delay: number; dist: number }[] {
  return Array.from({ length: n }, (_, i) => ({ delay: Math.floor(hash01(seed, i) * 900), dist: 0.12 + hash01(seed ^ 0xab, i) * 0.5 }));
}

/** How far (px) a column has slid down `t` ms in. Accelerates like a drip; never above dist * h. */
export function meltOffset(col: { delay: number; dist: number }, t: number, h: number, total: number): number {
  const run = Math.max(0, t - col.delay);
  const span = Math.max(1, total - 900 - col.delay);
  const k = clamp01(run / span);
  return k * k * col.dist * h * 1.0;
}

// -------------------------------------------------------------------- bugs

export interface Bug {
  x: number;
  y: number;
  /** +1 / -1 */
  dir: number;
  speed: number;
  seed: number;
  alive: boolean;
}

/** Bugs start at the ends of a window top and crawl towards its middle. */
export function spawnBugs(top: { x0: number; x1: number; y: number }, seed: number, n = 5): Bug[] {
  return Array.from({ length: n }, (_, i) => {
    const left = i % 2 === 0;
    return {
      x: left ? top.x0 + hash01(seed, i) * 40 : top.x1 - hash01(seed, i) * 40,
      y: top.y,
      dir: left ? 1 : -1,
      speed: 26 + hash01(seed + 1, i) * 24,
      seed: seed * 31 + i,
      alive: true,
    };
  });
}

/** Advance a bug: crawl towards the middle, then mill about it. */
export function stepBug(b: Bug, mid: number, dt: number, t: number): void {
  if (!b.alive) return;
  const d = mid - b.x;
  if (Math.abs(d) > 6) b.x += Math.sign(d) * Math.min(Math.abs(d), b.speed * dt);
  else b.x += Math.sin(t / 220 + b.seed) * 8 * dt;
}

// --------------------------------------------------------------- the swarm

export interface Clone {
  x: number;
  dir: number;
  speed: number;
  born: number;
  /** ms after the start when it pops. */
  popAt: number;
  seed: number;
}

export const SWARM_MS = 8000;
export const SWARM_SCALE = 0.55;

export function spawnClones(w: number, seed: number, n = 6): Clone[] {
  return Array.from({ length: n }, (_, i) => ({
    x: hash01(seed, i) * w,
    dir: hash01(seed + 2, i) < 0.5 ? -1 : 1,
    speed: 90 + hash01(seed + 3, i) * 150,
    born: i * 140,
    popAt: SWARM_MS - 900 + hash01(seed + 4, i) * 700,
    seed: i,
  }));
}

export function stepClone(c: Clone, w: number, dt: number): void {
  c.x += c.dir * c.speed * dt;
  if (c.x < 20) {
    c.x = 20;
    c.dir = 1;
  } else if (c.x > w - 20) {
    c.x = w - 20;
    c.dir = -1;
  }
}

/** Sprite frame of a clone at `age` ms: pop-in frames, then running, then the pop. */
export function cloneFrame(age: number, popAt: number): { name: string; alpha: number } {
  if (age < 0) return { name: "", alpha: 0 };
  if (age < 360) return { name: `clone_pop${[7, 6, 5, 0][Math.min(3, Math.floor(age / 90))]}`, alpha: 1 };
  if (age >= popAt + 330) return { name: "", alpha: 0 };
  if (age >= popAt) return { name: `clone_pop${[4, 5, 6, 7][Math.min(3, Math.floor((age - popAt) / 83))]}`, alpha: 1 - (age - popAt) / 360 };
  return { name: `walk${Math.floor(age / 90) % 8}`, alpha: 1 };
}

// ------------------------------------------------------------------ flashes

/**
 * Every discrete flash the effects can make, in ms from the start of the
 * worst case where they all fire together: the hook snap spark, one spark
 * per cursor hop (spaced like HOP_TIMES in chaos2.rs), the squash splat, the
 * window-pop sparkle and a clone pop each 83 ms frame... The point of listing
 * them is the test: at most 3 in any second.
 */
export const FLASHES = {
  snap: [0, 380],
  hops: [500, 1300, 2200, 3000, 3900],
  squash: [0],
  pop: [0, 420],
  /** Clones pop one after another, spaced. */
  swarmPops: [7100, 7450, 7800, 8150, 8500, 8850],
} as const;

/** At most `limit` flash times in any `windowMs`. */
export function flashesOk(times: readonly number[], limit = 3, windowMs = 1000): boolean {
  const t = [...times].sort((a, b) => a - b);
  return t.every((x, i) => t.slice(i).filter((y) => y < x + windowMs).length <= limit);
}
