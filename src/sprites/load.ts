import type { FrameImage, GridSpriteSource, SheetSpriteSource, SpriteSet, SpriteSource } from "./types";

/** Validate a grid sprite and return its size. Throws a helpful error for typos. */
export function checkGrid(src: GridSpriteSource): { width: number; height: number } {
  const names = Object.keys(src.frames);
  if (names.length === 0) throw new Error("sprite has no frames");
  const first = src.frames[names[0]];
  const height = first.length;
  const width = first[0]?.length ?? 0;
  for (const name of names) {
    const rows = src.frames[name];
    if (rows.length !== height) throw new Error(`frame "${name}" has ${rows.length} rows, expected ${height}`);
    rows.forEach((row, y) => {
      if (row.length !== width) throw new Error(`frame "${name}" row ${y} has ${row.length} pixels, expected ${width}`);
      for (const ch of row) {
        if (ch !== "." && !(ch in src.palette)) throw new Error(`frame "${name}" row ${y} uses unknown colour "${ch}"`);
      }
    });
  }
  return { width, height };
}

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function fromGrid(src: GridSpriteSource): SpriteSet {
  const { width, height } = checkGrid(src);
  // Pre-render every frame once at native size; drawing a frame later is a
  // single drawImage call, so animation costs almost nothing.
  const cache = new Map<string, FrameImage>();
  for (const [name, rows] of Object.entries(src.frames)) {
    const c = canvas(width, height);
    const ctx = c.getContext("2d")!;
    rows.forEach((row, y) => {
      [...row].forEach((ch, x) => {
        if (ch === ".") return;
        ctx.fillStyle = src.palette[ch];
        ctx.fillRect(x, y, 1, 1);
      });
    });
    cache.set(name, c);
  }
  return spriteSet(width, height, cache);
}

async function fromSheet(src: SheetSpriteSource): Promise<SpriteSet> {
  const img = new Image();
  img.src = src.url;
  await img.decode();
  const perRow = Math.max(1, Math.floor(img.naturalWidth / src.frameWidth));
  const cache = new Map<string, FrameImage>();
  for (const [name, index] of Object.entries(src.frames)) {
    const c = canvas(src.frameWidth, src.frameHeight);
    const sx = (index % perRow) * src.frameWidth;
    const sy = Math.floor(index / perRow) * src.frameHeight;
    c.getContext("2d")!.drawImage(img, sx, sy, src.frameWidth, src.frameHeight, 0, 0, src.frameWidth, src.frameHeight);
    cache.set(name, c);
  }
  return spriteSet(src.frameWidth, src.frameHeight, cache);
}

function spriteSet(width: number, height: number, cache: Map<string, FrameImage>): SpriteSet {
  const fallback = cache.values().next().value!;
  return { width, height, frame: (name) => cache.get(name) ?? fallback };
}

export async function loadSprites(src: SpriteSource): Promise<SpriteSet> {
  return src.kind === "grid" ? fromGrid(src) : fromSheet(src);
}
