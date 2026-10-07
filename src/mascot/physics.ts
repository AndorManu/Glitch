// Glitch's body in the world: where he is, what he stands on, how he flies.
// Pure (no DOM, no Tauri), so it is unit-tested; creature.ts drives it.
//
// Units: everything here is in PHYSICAL screen px (what `api.world()` and
// `setPosition` use). Tunables are written in CSS px and multiplied by
// `world.scale` (physical px per CSS px), so Glitch feels the same on every
// display. Angles in degrees, y grows downwards.
//
// The body is tracked by its CENTRE (about the middle of the drawn art).
// Its feet are HALF css px from the centre in the direction the body's
// "down" points: angle 0 = upright (floor, window tops), 90 = feet against
// the left screen edge, 180 = upside down on the ceiling, -90 = right edge.

import type { Ledge, ScreenRect, WorldSnapshot } from "../shared/ipc";

export interface Vec {
  x: number;
  y: number;
}

export type World = WorldSnapshot;

/** The mascot window (CSS px, square). Must match tauri.conf.json. */
export const WIN = 160;
/** Feet sit this far inside the window edge they point at. */
export const FEET_MARGIN = 4;
/** Body centre -> feet (CSS px). Also the body's "radius" against walls. */
export const HALF = 40;
/** How far the centre is pushed from the window centre towards the feet when standing. */
export const ANCHOR_K = WIN / 2 - FEET_MARGIN - HALF; // 36
/** The centre keeps this far from a screen corner while walking along an edge (body length). */
export const INSET = 58;
/** The feet may go this close to a window-top's end. */
export const LEDGE_EDGE = 10;

/** Tunables, CSS px and seconds. */
export const PHYS = {
  gravity: 2600,
  /** Air drag for thrown flights (1/s); planned jumps fly drag-free so they land where aimed. */
  drag: 0.35,
  maxSpeed: 4200,
  /** Restitution off the side walls / ceiling / floor-like surfaces. */
  wallBounce: 0.55,
  ceilingBounce: 0.4,
  floorBounce: 0.32,
  /** Landing faster than this bounces a little first (unless it splats). */
  bounceMin: 650,
  /** A thrown body landing faster than this splats (squashed flat, dizzy). */
  splat: 1650,
  /** Sliding friction along a wall / floor during a bounce (keeps this fraction of tangential speed). */
  scrape: 0.85,
  /** Angular drag (1/s) and the spin under which he rights himself like a cat. */
  spinDrag: 1.1,
  rightingSpin: 140,
  /** Longest substep (s): collisions are swept per substep, so nothing tunnels. */
  substep: 1 / 120,
} as const;

// ------------------------------------------------------------------ surfaces

export type SurfaceKind = "floor" | "ceiling" | "left" | "right" | "ledge" | "platform";

/** Where Glitch stands. Ledges are other apps' window tops; a platform is his own glitch block. */
export type Surface =
  | { kind: "floor" | "ceiling" | "left" | "right" }
  | { kind: "ledge" | "platform"; ledge: Ledge };

export const FLOOR: Surface = { kind: "floor" };

export function isTop(s: Surface): s is { kind: "ledge" | "platform"; ledge: Ledge } {
  return s.kind === "ledge" || s.kind === "platform";
}

/** Can he stand (and sleep, sit, idle normally) here? Walls and the ceiling are for clinging. */
export function isStanding(s: Surface): boolean {
  return s.kind === "floor" || isTop(s);
}

/** Body angle on a surface. */
export function surfaceAngle(kind: SurfaceKind): number {
  switch (kind) {
    case "left":
      return 90;
    case "right":
      return -90;
    case "ceiling":
      return 180;
    default:
      return 0;
  }
}

/** Is the coordinate along this surface x (floors, ceiling, tops) or y (walls)? */
export function alongX(kind: SurfaceKind): boolean {
  return kind !== "left" && kind !== "right";
}

/**
 * Which way local +x (the way the art faces) points along the surface, as a
 * sign of the surface coordinate. Walking around the screen edge keeps the
 * same local facing: floor leftwards -> up the left wall -> along the ceiling
 * rightwards -> down the right wall.
 */
export function localSign(kind: SurfaceKind): 1 | -1 {
  return kind === "ceiling" || kind === "right" ? -1 : 1;
}

/** Art facing (mirrored or not) for moving `dir` (+1/-1 along the surface coordinate). */
export function facesLeftFor(kind: SurfaceKind, dir: number): boolean {
  return dir * localSign(kind) < 0;
}

const right = (a: ScreenRect) => a.x + a.w;
const bottom = (a: ScreenRect) => a.y + a.h;

/** The body centre when standing at coordinate `s` along a surface. */
export function restCenter(surface: Surface, s: number, world: World): Vec {
  const u = world.scale;
  const a = world.area;
  switch (surface.kind) {
    case "floor":
      return { x: s, y: bottom(a) - HALF * u };
    case "ceiling":
      return { x: s, y: a.y + HALF * u };
    case "left":
      return { x: a.x + HALF * u, y: s };
    case "right":
      return { x: right(a) - HALF * u, y: s };
    default:
      return { x: s, y: surface.ledge.y - HALF * u };
  }
}

/** Where the centre can be along a surface: [min, max] of the surface coordinate. */
export function surfaceRange(surface: Surface, world: World): [number, number] {
  const u = world.scale;
  const a = world.area;
  const span = (lo: number, hi: number): [number, number] => (lo <= hi ? [lo, hi] : [(lo + hi) / 2, (lo + hi) / 2]);
  switch (surface.kind) {
    case "floor":
    case "ceiling":
      return span(a.x + INSET * u, right(a) - INSET * u);
    case "left":
    case "right":
      return span(a.y + INSET * u, bottom(a) - INSET * u);
    default: {
      const l = surface.ledge;
      // Never further out than the screen edges either.
      return span(Math.max(l.x + LEDGE_EDGE * u, a.x + HALF * u), Math.min(l.x + l.w - LEDGE_EDGE * u, right(a) - HALF * u));
    }
  }
}

export function clampTo(surface: Surface, s: number, world: World): number {
  const [lo, hi] = surfaceRange(surface, world);
  return Math.min(hi, Math.max(lo, s));
}

/** The surface coordinate of a centre point. */
export function coordOf(surface: Surface, c: Vec): number {
  return alongX(surface.kind) ? c.x : c.y;
}

/**
 * The surface you turn onto at one end of the screen-edge loop, and where
 * you are on it. `end` -1 = the low end of the range, +1 = the high end.
 * Window tops have no corners (you hop off their ends instead).
 */
export function cornerAt(surface: Surface, end: -1 | 1, world: World): { surface: Surface; s: number } | null {
  const pick = (kind: "floor" | "ceiling" | "left" | "right", hi: boolean) => {
    const next: Surface = { kind };
    const [lo, h] = surfaceRange(next, world);
    return { surface: next, s: hi ? h : lo };
  };
  switch (surface.kind) {
    case "floor":
      return end < 0 ? pick("left", true) : pick("right", true);
    case "ceiling":
      return end < 0 ? pick("left", false) : pick("right", false);
    case "left":
      return end < 0 ? pick("ceiling", false) : pick("floor", false);
    case "right":
      return end < 0 ? pick("ceiling", true) : pick("floor", true);
    default:
      return null;
  }
}

// ------------------------------------------------------------ window mapping

/**
 * Where the body centre sits inside the window (CSS px) for a body angle.
 * `k` = 1 when standing: the feet sit FEET_MARGIN from the window edge they
 * point at (on the floor the sprite is at the bottom of the window, on the
 * left wall against the left edge, on the ceiling at the top...). `k` = 0 in
 * the air: centred, so a spinning body never leaves the window.
 */
export function anchor(angle: number, k: number): Vec {
  const r = (angle * Math.PI) / 180;
  return { x: WIN / 2 - k * ANCHOR_K * Math.sin(r), y: WIN / 2 + k * ANCHOR_K * Math.cos(r) };
}

/** Unit vector from the centre towards the feet. */
export function feetDir(angle: number): Vec {
  const r = (angle * Math.PI) / 180;
  return { x: -Math.sin(r), y: Math.cos(r) };
}

/** Window top-left (physical px, whole pixels) for a body centre. */
export function windowFor(center: Vec, angle: number, k: number, scale: number): Vec {
  const a = anchor(angle, k);
  return { x: Math.round(center.x) - Math.round(a.x * scale), y: Math.round(center.y) - Math.round(a.y * scale) };
}

/** The inverse: body centre for a window position. */
export function centerFor(win: Vec, angle: number, k: number, scale: number): Vec {
  const a = anchor(angle, k);
  return { x: win.x + Math.round(a.x * scale), y: win.y + Math.round(a.y * scale) };
}

/** Feet point inside the window (CSS px): what the renderer anchors the sprite to. */
export function feetInWindow(center: Vec, win: Vec, angle: number, scale: number): Vec {
  const f = feetDir(angle);
  return { x: (Math.round(center.x) - win.x) / scale + HALF * f.x, y: (Math.round(center.y) - win.y) / scale + HALF * f.y };
}

// ------------------------------------------------------------------- flight

export interface Body {
  /** Centre, physical px. */
  x: number;
  y: number;
  /** Velocity, physical px / s. */
  vx: number;
  vy: number;
  /** Degrees; 0 upright. */
  angle: number;
  /** Degrees / s. */
  spin: number;
}

export interface FlightOptions {
  /** Air drag on (thrown) or off (planned jumps). */
  drag?: boolean;
  /** Bodies landing faster than PHYS.splat stop dead in a splat instead of bouncing. */
  canSplat?: boolean;
  /** Extra one-way tops (his own glitch platform). */
  extra?: Ledge[];
  /** Ignore this top (the one he just jumped off) while still rising out of it. */
  ignoreLedge?: number;
  /** Seconds in the air so far (the cat-righting reflex waits a moment). */
  airTime?: number;
  /** Planned flips: spin exactly as launched (no drag, no righting). */
  keepSpin?: boolean;
}

export type Contact =
  | { kind: "land"; surface: Surface; speed: number }
  | { kind: "bounce"; side: "left" | "right" | "ceiling" | "floor" | "top"; speed: number };

const clampAbs = (v: number, max: number) => Math.max(-max, Math.min(max, v));

/** Nearest upright angle (a multiple of 360) to `a`. */
export function uprightNear(a: number): number {
  return Math.round(a / 360) * 360;
}

/**
 * Advance a flying body by `dt` seconds: gravity, drag, spin, bounces off
 * the screen edges and landings on the floor or on window tops (one-way:
 * only when coming down onto them from above, within their x-range).
 * Collisions are swept along each substep, so no speed tunnels through a
 * thin window top. Returns what it hit; after a "land" the body is at rest
 * on that surface (centre on it, zero velocity) and the caller should stop
 * flying it.
 */
export function stepAir(body: Body, world: World, dt: number, opts: FlightOptions = {}): Contact[] {
  const u = world.scale;
  const a = world.area;
  const g = PHYS.gravity * u;
  const max = PHYS.maxSpeed * u;
  const half = HALF * u;
  const out: Contact[] = [];
  const tops = opts.extra ? [...world.ledges, ...opts.extra] : world.ledges;
  let airTime = opts.airTime ?? 0;
  let left = Math.max(0, dt);
  while (left > 1e-9) {
    const h = Math.min(PHYS.substep, left);
    left -= h;
    airTime += h;
    const vy0 = body.vy;
    body.vy += g * h;
    if (opts.drag) {
      const d = Math.exp(-PHYS.drag * h);
      body.vx *= d;
      body.vy *= d;
    }
    body.vx = clampAbs(body.vx, max);
    body.vy = clampAbs(body.vy, max);
    // Spin decays; once slow, he turns himself upright (a cat-righting reflex).
    body.angle += body.spin * h;
    if (!opts.keepSpin) body.spin *= Math.exp(-PHYS.spinDrag * h);
    if (!opts.keepSpin && Math.abs(body.spin) < PHYS.rightingSpin && airTime > 0.12) {
      const target = uprightNear(body.angle);
      body.angle += (target - body.angle) * (1 - Math.exp(-7 * h));
      body.spin *= Math.exp(-6 * h);
    }

    const x0 = body.x;
    const y0 = body.y;
    const x1 = x0 + body.vx * h;
    // Average of old and new vertical speed: exact under constant gravity (planned jumps land where aimed).
    const y1 = y0 + ((Math.max(-max, Math.min(max, vy0)) + body.vy) / 2) * h;

    // Earliest landing along the segment: the floor, or a window top crossed from above.
    let hitT = Infinity;
    let hit: Surface | null = null;
    const floorY = bottom(a) - half;
    if (body.vy > 0 && y1 >= floorY) {
      hitT = y1 === y0 ? 0 : Math.max(0, (floorY - y0) / (y1 - y0));
      hit = FLOOR;
    }
    if (body.vy > 0) {
      for (const l of tops) {
        if (l.id === opts.ignoreLedge) continue;
        const ty = l.y - half; // centre height when standing on it
        if (y0 > ty + 0.5 || y1 < ty) continue; // must start above (or on) and end below
        const t = y1 === y0 ? 0 : (ty - y0) / (y1 - y0);
        const xt = x0 + (x1 - x0) * t;
        if (xt < l.x || xt > l.x + l.w) continue;
        if (t < hitT) {
          hitT = t;
          hit = { kind: l.id < 0 ? "platform" : "ledge", ledge: l };
        }
      }
    }
    if (hit) {
      const speed = body.vy / u;
      // (A wall may have been crossed earlier in the same substep: stay inside.)
      body.x = Math.min(right(a) - half, Math.max(a.x + half, x0 + (x1 - x0) * hitT));
      const c = restCenter(hit, body.x, world);
      body.y = c.y;
      const tooFast = opts.canSplat && speed > PHYS.splat;
      if (speed > PHYS.bounceMin && !tooFast) {
        // A little bounce, scraping speed off.
        body.vy = -body.vy * PHYS.floorBounce;
        body.vx *= PHYS.scrape;
        body.spin += body.vx * 0.05;
        out.push({ kind: "bounce", side: hit.kind === "floor" ? "floor" : "top", speed });
        continue;
      }
      body.vx = 0;
      body.vy = 0;
      body.spin = 0;
      out.push({ kind: "land", surface: hit, speed });
      return out;
    }

    body.x = x1;
    body.y = y1;
    // Side walls and the ceiling: reflect, damp, scrape, kick the spin.
    const lo = a.x + half;
    const hi = right(a) - half;
    if (body.x < lo || body.x > hi) {
      const side = body.x < lo ? "left" : "right";
      const speed = Math.abs(body.vx) / u;
      body.x = side === "left" ? lo + (lo - body.x) * PHYS.wallBounce : hi - (body.x - hi) * PHYS.wallBounce;
      body.x = Math.min(hi, Math.max(lo, body.x));
      body.vx = -body.vx * PHYS.wallBounce;
      body.vy *= PHYS.scrape;
      body.spin = -body.spin * 0.6 + (side === "left" ? -1 : 1) * body.vy * 0.04;
      out.push({ kind: "bounce", side, speed });
    }
    const top = a.y + half;
    if (body.y < top && body.vy < 0) {
      const speed = -body.vy / u;
      body.y = top + (top - body.y) * PHYS.ceilingBounce;
      body.vy = -body.vy * PHYS.ceilingBounce;
      body.vx *= PHYS.scrape;
      out.push({ kind: "bounce", side: "ceiling", speed });
    }
  }
  return out;
}

// ------------------------------------------------------------ jump planning

export interface JumpPlan {
  vx: number;
  vy: number;
  /** Flight time, seconds. */
  t: number;
}

export const JUMP = {
  /** Highest jump (CSS px from takeoff to apex): a glitchy super-raccoon jump. */
  maxHeight: 620,
  /** Apex clearance above the higher of takeoff and target. */
  clearance: 46,
  /** Fastest sideways jump speed (CSS px/s). */
  maxVx: 1100,
} as const;

/**
 * A drag-free ballistic arc from centre `from` to centre `to` that rises at
 * least `clearance` above both (so he arcs onto a window top, not through
 * its edge), or null if it is too high, too far or would hit the ceiling.
 */
export function planJump(from: Vec, to: Vec, world: World, clearance: number = JUMP.clearance): JumpPlan | null {
  const u = world.scale;
  const g = PHYS.gravity * u;
  const apexY = Math.min(from.y, to.y) - clearance * u;
  if (from.y - apexY > JUMP.maxHeight * u) return null;
  if (apexY < world.area.y + HALF * u + 2) return null;
  const vy = -Math.sqrt(2 * g * (from.y - apexY));
  const t = -vy / g + Math.sqrt((2 * (to.y - apexY)) / g);
  const vx = (to.x - from.x) / t;
  if (Math.abs(vx) > JUMP.maxVx * u) return null;
  return { vx, vy, t };
}

/** Is the top still there (same window, roughly where it was)? Returns the fresh ledge or null. */
export function findLedge(world: World, id: number, x: number): Ledge | null {
  let best: Ledge | null = null;
  for (const l of world.ledges) {
    if (l.id !== id) continue;
    if (x >= l.x && x <= l.x + l.w) return l;
    best ??= l;
  }
  return best;
}
