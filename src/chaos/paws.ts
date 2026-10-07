// Fading magenta pixel paw prints (chaos mode), pure parts: the pixel
// pattern and the fade. pawprints.ts draws them in the click-through overlay.

export interface PawPrint {
  /** Overlay CSS px: where the feet touched the surface. */
  x: number;
  y: number;
  /** Degrees; 0 = on a floor / window top. */
  angle: number;
  left: boolean;
  /** ms (performance.now) when it was stamped. */
  born: number;
}

/** How long a print stays (ms). */
export const PAW_LIFE_MS = 20_000;
/** Max prints kept (oldest dropped first). */
export const MAX_PAWS = 160;
/** Redraws per second while prints are fading. */
export const PAW_FPS = 4;
/** Size of one "pixel" in CSS px. */
export const PAW_PX = 3;

/** The paw: a pad and four toes, in pixel cells (x right, y down), centred-ish on (0, 0). */
export const PAW_CELLS: readonly (readonly [number, number])[] = [
  // toes
  [-3, -4], [-1, -5], [1, -5], [3, -4],
  // pad
  [-2, -2], [-1, -2], [0, -2], [1, -2], [2, -2],
  [-2, -1], [-1, -1], [0, -1], [1, -1], [2, -1],
  [-1, 0], [0, 0], [1, 0],
];

/** Opacity of a print at `now`: full for a while, then fades out in steps (pixel style). 0 = gone. */
export function pawAlpha(p: Pick<PawPrint, "born">, now: number): number {
  const age = now - p.born;
  if (age < 0) return 0.9;
  if (age >= PAW_LIFE_MS) return 0;
  const hold = PAW_LIFE_MS * 0.35;
  if (age < hold) return 0.9;
  const t = (age - hold) / (PAW_LIFE_MS - hold);
  // 6 steps down to 0.
  return Math.max(0, Math.round((1 - t) * 6) / 6) * 0.9;
}

/** Keep the live prints, newest MAX_PAWS. */
export function prune(paws: PawPrint[], now: number): PawPrint[] {
  const alive = paws.filter((p) => pawAlpha(p, now) > 0);
  return alive.length > MAX_PAWS ? alive.slice(alive.length - MAX_PAWS) : alive;
}
