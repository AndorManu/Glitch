// Pure planning for Glitch's glitch effects: where to cut slices, where to
// sprinkle corrupted pixels. No DOM here, so it is unit-tested; `render.ts`
// turns the plans into a handful of canvas calls.
//
// Everything is driven by a small seeded PRNG so a given draw always looks
// the same (deterministic tests, and a redraw after a DPI change doesn't
// reshuffle the noise).

/** mulberry32: tiny, fast, good enough for visual noise. Returns [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mix a draw counter into a well-spread seed (consecutive ticks look unrelated). */
export function seedFor(tick: number, salt = 0): number {
  return (Math.imul(tick + 1, 2654435761) ^ Math.imul(salt + 7, 40503)) >>> 0;
}

export interface Slice {
  /** Band top and height (CSS px, inside [0, height)). */
  y: number;
  h: number;
  /** Sideways shift of the band (CSS px). */
  dx: number;
}

/** Largest sideways shift for a glitch intensity (CSS px). */
export function maxShift(intensity: number): number {
  return Math.ceil(2 + 10 * clamp01(intensity));
}

/**
 * Cut [0, height) into horizontal bands and shift a few of them sideways.
 * The bands tile the area exactly (no gaps, no overlap); neighbouring
 * unshifted bands are merged so drawing costs one drawImage per band.
 * Band edges snap to `unit` (one art pixel) so cuts land on the pixel grid.
 */
export function planSlices(rand: () => number, height: number, intensity: number, unit = 3): Slice[] {
  const g = clamp01(intensity);
  const max = maxShift(g);
  const out: Slice[] = [];
  let y = 0;
  while (y < height) {
    const h = Math.min(height - y, unit * (1 + Math.floor(rand() * (g > 0.6 ? 4 : 7))));
    let dx = 0;
    if (rand() < 0.15 + 0.45 * g) {
      const mag = Math.max(1, Math.round(max * (0.3 + 0.7 * rand())));
      dx = rand() < 0.5 ? -mag : mag;
    }
    const prev = out[out.length - 1];
    if (prev && prev.dx === dx) prev.h += h;
    else out.push({ y, h, dx });
    y += h;
  }
  return out;
}

export interface Block {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Index into the glitch palette (render.ts decides the colours). */
  color: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Corrupted pixel blocks inside `box` (on the sprite: drawn source-atop so
 * they only recolour Glitch) or loose debris pixels around it. Blocks are
 * whole art pixels and always lie fully inside `box`.
 */
export function planBlocks(rand: () => number, box: Rect, intensity: number, count: number, unit = 3): Block[] {
  const g = clamp01(intensity);
  const n = Math.round(count * g);
  const out: Block[] = [];
  const cols = Math.floor(box.width / unit);
  const rows = Math.floor(box.height / unit);
  if (cols < 1 || rows < 1) return out;
  for (let i = 0; i < n; i++) {
    // Mostly single pixels, sometimes a wide "torn scanline" strip.
    const wide = rand() < 0.3 * g;
    const wc = Math.min(cols, wide ? 3 + Math.floor(rand() * 8) : 1);
    const hc = Math.min(rows, rand() < 0.25 ? 2 : 1);
    const cx = Math.floor(rand() * (cols - wc + 1));
    const cy = Math.floor(rand() * (rows - hc + 1));
    out.push({ x: box.x + cx * unit, y: box.y + cy * unit, w: wc * unit, h: hc * unit, color: Math.floor(rand() * 3) });
  }
  return out;
}

export interface Particle {
  x: number;
  y: number;
  size: number;
  alpha: number;
  color: number;
}

/**
 * The dust / glitch-pixel trail behind a walking Glitch, in anchor space
 * (origin at the feet, +x = forward). Stateless: particles "born" on earlier
 * ticks are re-derived from their birth tick, so they drift backwards
 * consistently while the window walks forward. `perTick` is how far the
 * world slides back between two draws.
 */
export function planTrail(tick: number, perTick = 4.5, life = 6): Particle[] {
  const out: Particle[] = [];
  for (let age = 0; age < life; age++) {
    const r = mulberry32(seedFor(tick - age, 31));
    const n = 1 + Math.floor(r() * 2);
    for (let i = 0; i < n; i++) {
      const glitchy = r() < 0.45;
      out.push({
        x: -8 - r() * 22 - age * perTick,
        y: -1 - r() * (glitchy ? 26 : 5) - age * (glitchy ? 1.5 : 0.6),
        size: glitchy ? 3 : 2 + Math.round(r()),
        alpha: Math.max(0, 1 - age / life) * (glitchy ? 1 : 0.7),
        color: glitchy ? Math.floor(r() * 2) : 3,
      });
    }
  }
  return out;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
