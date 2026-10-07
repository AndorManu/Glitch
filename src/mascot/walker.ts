// Decides when and where Glitch walks. Pure logic (no Tauri / DOM), so it is
// unit-tested; `main.ts` turns it into window moves.

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Walk {
  from: Point;
  to: Point;
  durationMs: number;
}

export interface WalkerOptions {
  /** Walking speed in physical pixels per second. */
  speed: number;
  /** Longest single walk, in physical pixels. */
  maxDistance: number;
  /** Pause between walks: random in [min, max] ms. */
  restMinMs: number;
  restMaxMs: number;
  random?: () => number;
}

export const DEFAULT_WALKER: Omit<WalkerOptions, "speed" | "maxDistance"> = {
  restMinMs: 25_000,
  restMaxMs: 75_000,
};

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

export class Walker {
  private readonly random: () => number;

  constructor(private readonly opts: WalkerOptions) {
    this.random = opts.random ?? Math.random;
  }

  /** How long to rest before the next walk. */
  restMs(): number {
    return this.opts.restMinMs + this.random() * (this.opts.restMaxMs - this.opts.restMinMs);
  }

  /**
   * Pick a destination near `from` that keeps the whole window
   * (`size` x `size`) inside `area`.
   */
  plan(from: Point, area: Rect, size: number): Walk {
    const angle = this.random() * Math.PI * 2;
    const dist = this.opts.maxDistance * (0.3 + 0.7 * this.random());
    const to = {
      x: Math.round(clamp(from.x + Math.cos(angle) * dist, area.x, area.x + area.width - size)),
      y: Math.round(clamp(from.y + Math.sin(angle) * dist, area.y, area.y + area.height - size)),
    };
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    return { from, to, durationMs: Math.round((length / this.opts.speed) * 1000) };
  }
}

/** Position along a walk after `elapsedMs` (linear, ends exactly at `to`). */
export function positionAt(walk: Walk, elapsedMs: number): Point {
  if (walk.durationMs <= 0 || elapsedMs >= walk.durationMs) return walk.to;
  const t = Math.max(0, elapsedMs) / walk.durationMs;
  return {
    x: Math.round(walk.from.x + (walk.to.x - walk.from.x) * t),
    y: Math.round(walk.from.y + (walk.to.y - walk.from.y) * t),
  };
}

/** Sprite faces the way it walks (art faces right by default). */
export function facesLeft(walk: Walk): boolean {
  return walk.to.x < walk.from.x;
}
