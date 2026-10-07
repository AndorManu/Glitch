// Glitchy pixel paw prints (chaos mode), pure parts: the pixel art, the
// per-print variation and the life cycle (stamp, hold, corrupt, dissolve).
// pawprints.ts draws them in the click-through overlay.

export interface PawPrint {
  /** Overlay CSS px: where the feet touched the surface. */
  x: number;
  y: number;
  /** Degrees; 0 = on a floor / window top. On floors the walk direction tilts it (see creature.maybePaw). */
  angle: number;
  left: boolean;
  /** ms (performance.now) when it was stamped. */
  born: number;
}

/** How long a print stays (ms). */
export const PAW_LIFE_MS = 20_000;
/** Max prints kept (oldest dropped first). */
export const MAX_PAWS = 160;
/** Redraws per second while prints only fade slowly. */
export const PAW_FPS = 4;
/** Redraws per second while a print is being stamped or is dissolving. */
export const PAW_FPS_ACTIVE = 10;
/** Size of one art pixel in CSS px. */
export const PAW_PX = 2;

/** The stamp "pop" (ms): bright, slightly larger, RGB split. */
export const STAMP_MS = 450;
/** Fully there until this fraction of the life, then the pixels start to go. */
const HOLD = 0.45;

/** Pixel art of one paw, toes up. o = outline, d = deep, m = magenta, l = light, h = shine. */
const ART = [
  "....oo....oo....",
  "...ommo..ommo...",
  "...omlo..olmo...",
  ".oo.oo....oo.oo.",
  "ommo........ommo",
  "omlo..oooo..olmo",
  ".oo.oommmmoo.oo.",
  "...ommlhmmmmo...",
  "..ommlmmmmmmmo..",
  "..ommmmmmmmmdo..",
  "..odmmmmmmmddo..",
  "...oddmmmmddo...",
  "....ooddddoo....",
  "......oooo......",
];

export const PAW_COLORS: Record<string, [number, number, number]> = {
  o: [36, 10, 52],
  d: [176, 24, 160],
  m: [255, 59, 214],
  l: [255, 140, 236],
  h: [255, 236, 252],
};

export interface Cell {
  /** Art pixel offset from the paw centre (x right, y down). */
  x: number;
  y: number;
  c: keyof typeof PAW_COLORS;
}

function parse(): Cell[] {
  const cells: Cell[] = [];
  const h = ART.length;
  const w = Math.max(...ART.map((r) => r.length));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < ART[y].length; x++) {
      const ch = ART[y][x];
      if (ch in PAW_COLORS) cells.push({ x: x - Math.floor(w / 2), y: y - (h - 1), c: ch as Cell["c"] });
    }
  }
  return cells;
}

/** The paw as cells, bottom row at y = 0, centred on x = 0. */
export const PAW_ART: readonly Cell[] = parse();

/** Deterministic 0..1 noise for a print (so a print looks the same every redraw). */
export function hash(a: number, b: number, c = 0): number {
  let h = Math.imul(Math.round(a) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(Math.round(b) + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(c + 1, 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return ((h >>> 0) % 100_000) / 100_000;
}

/** Per-print variation: a touch of size, tilt and brightness, never twice the same. */
export function variation(p: Pick<PawPrint, "x" | "y" | "born">): { scale: number; tilt: number; tone: number } {
  const r1 = hash(p.x, p.y, 1);
  const r2 = hash(p.x, p.y, 2);
  const r3 = hash(p.x, p.born, 3);
  return { scale: r1 < 0.2 ? 0.85 : 1, tilt: (r2 - 0.5) * 14, tone: 0.85 + r3 * 0.15 };
}

export type Phase = "stamp" | "hold" | "dissolve" | "gone";

export interface PawState {
  phase: Phase;
  /** 0..1 overall opacity. */
  alpha: number;
  /** Fraction of pixels still there (dissolve). */
  keep: number;
  /** Stamp pop: 0 = settled, 1 = just landed. */
  pop: number;
  /** 0..1 how purple/blue the colours have drifted. */
  drift: number;
}

export function pawState(p: Pick<PawPrint, "born">, now: number): PawState {
  const age = now - p.born;
  if (age >= PAW_LIFE_MS) return { phase: "gone", alpha: 0, keep: 0, pop: 0, drift: 1 };
  if (age < STAMP_MS) {
    const t = Math.max(0, age) / STAMP_MS;
    return { phase: "stamp", alpha: 1, keep: 1, pop: 1 - t, drift: 0 };
  }
  const hold = PAW_LIFE_MS * HOLD;
  if (age < hold) return { phase: "hold", alpha: 0.95, keep: 1, pop: 0, drift: (age / hold) * 0.25 };
  const t = (age - hold) / (PAW_LIFE_MS - hold);
  return { phase: "dissolve", alpha: 0.95 - t * 0.35, keep: 1 - t, pop: 0, drift: 0.25 + t * 0.75 };
}

/** Kept for callers that only need the opacity (0 = gone). */
export function pawAlpha(p: Pick<PawPrint, "born">, now: number): number {
  const s = pawState(p, now);
  return s.phase === "gone" ? 0 : s.alpha * s.keep > 0.02 ? s.alpha : 0;
}

/** True while some print needs the faster redraw rate. */
export function busy(paws: PawPrint[], now: number): boolean {
  return paws.some((p) => {
    const ph = pawState(p, now).phase;
    return ph === "stamp" || ph === "dissolve";
  });
}

/** Keep the live prints, newest MAX_PAWS. */
export function prune(paws: PawPrint[], now: number): PawPrint[] {
  const alive = paws.filter((p) => pawState(p, now).phase !== "gone");
  return alive.length > MAX_PAWS ? alive.slice(alive.length - MAX_PAWS) : alive;
}
