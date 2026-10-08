// What Glitch wears and carries on top of his sprite: hats (sliced from the
// hat art, scripts/slice-hats.py), the glitch-eye colour, the fetch ball in
// his mouth, hearts/stars on hover, sinking out of sight behind an edge
// (hide and seek) and being a bit chubbier after a meal.
//
// render.ts calls `draw` at the end of every repaint (and reads `sink` and
// `girth` for the body transform); everything else here is plain state that
// src/mascot/play/ sets. Nothing here runs a timer except while hearts or
// stars float up (a short one, ~1.5 s).

import type { FrameImage } from "../sprites/types";
import { HAT_CELL, HAT_SPRITES, HEAD_DX, HEAD_HALF } from "./hats-data";

/** canvas setTransform matrix [a b c d e f]. */
export type Mat = [number, number, number, number, number, number];

export interface AccessoryFrame {
  ctx: CanvasRenderingContext2D;
  dpr: number;
  /** The sprite's transform: frame box (centre-bottom origin, CSS px) -> window CSS px. */
  css: Mat;
  img: FrameImage;
  /** Drawn frame size in CSS px. */
  w: number;
  h: number;
  frame: string;
  /** The glitch eye as fractions of the frame, if known. */
  eye: [number, number] | null;
  /** Feet point (window CSS px) and body angle. */
  placement: { x: number; y: number; angle: number };
  /** Dissolved away (teleporting): draw nothing. */
  hidden: boolean;
  tick: number;
}

/** What render.ts needs. */
export interface AccessoryLayer {
  readonly sink: number;
  readonly girth: number;
  draw(f: AccessoryFrame): void;
}

/** Art px per frame (the animation sheet; hats only fit frames of this size). */
const ART_W = 104;
const ART_H = 90;

/** Hue (degrees) per eye colour; magenta = as drawn. */
export const EYE_COLOURS: Record<string, string> = {
  magenta: "#ff1fc8",
  cyan: "#29f1ff",
  green: "#3dff6e",
  gold: "#ffc933",
};

const mul = (p: Mat, q: Mat): Mat => [
  p[0] * q[0] + p[2] * q[1],
  p[1] * q[0] + p[3] * q[1],
  p[0] * q[2] + p[2] * q[3],
  p[1] * q[2] + p[3] * q[3],
  p[0] * q[4] + p[2] * q[5] + p[4],
  p[1] * q[4] + p[3] * q[5] + p[5],
];
const apply = (m: Mat, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/**
 * The head top of a frame in art px (unmirrored frame): the topmost opaque
 * pixel within HEAD_HALF columns of the head centre, HEAD_DX art px from the
 * glitch eye. The same rule placed the hats on idle0 (scripts/slice-hats.py),
 * so a hat sits the same way on every pose. Pure; `alpha(x, y)` reads the frame.
 */
export function headTop(alpha: (x: number, y: number) => number, eyeX: number, width = ART_W, height = ART_H): [number, number] | null {
  const cx = Math.round(eyeX + HEAD_DX);
  for (let y = 0; y < height; y++) {
    for (let x = Math.max(0, cx - HEAD_HALF); x <= Math.min(width - 1, cx + HEAD_HALF); x++) {
      if (alpha(x, y) > 0) return [cx, y];
    }
  }
  return null;
}

/** Recolour one pixel of the magenta glitch eye: keep its brightness, change the hue. Pure. */
export function recolour(r: number, g: number, b: number, target: [number, number, number]): [number, number, number] | null {
  // The eye's magentas and purples (#df10f3, #bf0de8, #9015ba, #510f68): strong blue+red, almost no green.
  if (!(b >= 90 && r >= 60 && g < 70 && b > 2.5 * g)) return null;
  const k = Math.min(1, Math.max(r, b) / 243);
  return [Math.round(target[0] * k), Math.round(target[1] * k), Math.round(target[2] * k)];
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const HEART = [".##.##.", "#######", "#######", ".#####.", "..###..", "...#..."];
const STAR = ["...#...", "...#...", "#######", ".#####.", "..#.#..", ".#...#."];

export class Accessories implements AccessoryLayer {
  /** CSS px he is pushed down past the surface (hiding behind it); the part below is cut off. */
  sink = 0;
  /** Horizontal body scale (1.1 = chubby after a meal). */
  girth = 1;
  hat: string | null = null;
  eye = "magenta";
  /** The fetch ball in his mouth. */
  carrying = false;
  private floaters: { kind: "heart" | "star"; t0: number; x: number; drift: number }[] = [];
  private floatTimer: ReturnType<typeof setTimeout> | null = null;
  private hats: HTMLImageElement | null = null;
  private readonly tops = new WeakMap<object, Map<number, [number, number] | null>>();

  constructor(
    /** Repaint the current pose (hearts floating up, sinking). */
    private readonly repaint: () => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Load the hat overlays (public/sprites/hats.png). Without them: no hats. */
  async load(url = "/sprites/hats.png"): Promise<void> {
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      this.hats = img;
    } catch {
      this.hats = null;
    }
  }

  /** A few hearts (happy) or stars float up from his head for ~1.5 s. */
  sparkle(kind: "heart" | "star", n = 3): void {
    const t = this.now();
    for (let i = 0; i < n; i++) this.floaters.push({ kind, t0: t + i * 220, x: (i - (n - 1) / 2) * 16, drift: (Math.random() - 0.5) * 10 });
    if (this.floatTimer === null) this.tickFloaters();
  }

  get floating(): boolean {
    return this.floaters.length > 0;
  }

  private tickFloaters(): void {
    const t = this.now();
    this.floaters = this.floaters.filter((f) => t - f.t0 < 1500);
    this.repaint();
    this.floatTimer = this.floaters.length ? setTimeout(() => this.tickFloaters(), 110) : null;
  }

  dispose(): void {
    if (this.floatTimer !== null) clearTimeout(this.floatTimer);
    this.floatTimer = null;
    this.floaters = [];
  }

  draw(f: AccessoryFrame): void {
    const { ctx } = f;
    if (!f.hidden) {
      // The frame's art grid: art px -> window CSS px.
      const art: Mat = mul(f.css, [f.w / ART_W, 0, 0, f.h / ART_H, -f.w / 2, -f.h]);
      const fits = f.img.width % ART_W === 0 && f.img.height % ART_H === 0 && f.eye !== null;
      if (fits && this.eye !== "magenta") this.drawEye(f, art);
      if (fits && this.hat && this.hats) this.drawHat(f, art);
      if (fits && this.carrying) this.drawBall(f, art);
    }
    if (this.sink > 0) this.cutBelowSurface(f);
    if (this.floaters.length) this.drawFloaters(f);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
  }

  private head(f: AccessoryFrame): [number, number] | null {
    const eyeX = Math.round(f.eye![0] * ART_W);
    let byEye = this.tops.get(f.img);
    if (!byEye) this.tops.set(f.img, (byEye = new Map()));
    if (byEye.has(eyeX)) return byEye.get(eyeX)!;
    let top: [number, number] | null = null;
    try {
      const k = f.img.width / ART_W;
      const c = document.createElement("canvas");
      c.width = f.img.width;
      c.height = f.img.height;
      const t = c.getContext("2d", { willReadFrequently: true } as CanvasRenderingContext2DSettings)!;
      t.drawImage(f.img, 0, 0);
      const data = t.getImageData(0, 0, c.width, c.height).data;
      // Sample the centre of each art pixel.
      top = headTop((x, y) => data[(Math.floor((y + 0.5) * k) * c.width + Math.floor((x + 0.5) * k)) * 4 + 3], eyeX);
    } catch {
      top = null;
    }
    byEye.set(eyeX, top);
    return top;
  }

  private drawHat(f: AccessoryFrame, art: Mat): void {
    const spec = HAT_SPRITES[this.hat!];
    const top = this.head(f);
    if (!spec || !top) return;
    const m = mul([f.dpr, 0, 0, f.dpr, 0, 0], art);
    f.ctx.setTransform(...m);
    f.ctx.imageSmoothingEnabled = false;
    f.ctx.drawImage(this.hats!, spec.cell * HAT_CELL.w, 0, HAT_CELL.w, HAT_CELL.h, top[0] - spec.anchor[0], top[1] - spec.anchor[1], HAT_CELL.w, HAT_CELL.h);
  }

  /** The magenta glitch eye in another colour (a small patch around it, pixel by pixel). */
  private drawEye(f: AccessoryFrame, art: Mat): void {
    const target = rgb(EYE_COLOURS[this.eye] ?? EYE_COLOURS.magenta);
    const [ex, ey] = apply(art, f.eye![0] * ART_W, f.eye![1] * ART_H);
    const r = 12 * f.dpr;
    const x0 = Math.max(0, Math.floor(ex * f.dpr - r));
    const y0 = Math.max(0, Math.floor(ey * f.dpr - r));
    const w = Math.min(f.ctx.canvas.width - x0, Math.ceil(2 * r));
    const h = Math.min(f.ctx.canvas.height - y0, Math.ceil(2 * r));
    if (w <= 0 || h <= 0) return;
    try {
      const img = f.ctx.getImageData(x0, y0, w, h);
      const d = img.data;
      let changed = false;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const c = recolour(d[i], d[i + 1], d[i + 2], target);
        if (!c) continue;
        [d[i], d[i + 1], d[i + 2]] = c;
        changed = true;
      }
      if (changed) f.ctx.putImageData(img, x0, y0);
    } catch {
      // No pixel access: keep the drawn colour.
    }
  }

  /** The glowing glitch ball in his mouth (just under and in front of the eye). */
  private drawBall(f: AccessoryFrame, art: Mat): void {
    const [x, y] = apply(art, f.eye![0] * ART_W + 3, f.eye![1] * ART_H + 9);
    drawBallAt(f.ctx, x * f.dpr, y * f.dpr, 6 * f.dpr, f.tick);
  }

  /** Hiding behind an edge: nothing below the surface line shows. */
  private cutBelowSurface(f: AccessoryFrame): void {
    const p = f.placement;
    const a = (p.angle * Math.PI) / 180;
    f.ctx.setTransform(Math.cos(a) * f.dpr, Math.sin(a) * f.dpr, -Math.sin(a) * f.dpr, Math.cos(a) * f.dpr, p.x * f.dpr, p.y * f.dpr);
    f.ctx.clearRect(-400, 1, 800, 800);
  }

  private drawFloaters(f: AccessoryFrame): void {
    const t = this.now();
    const p = f.placement;
    const unit = 2 * f.dpr;
    for (const fl of this.floaters) {
      const age = (t - fl.t0) / 1500;
      if (age < 0) continue;
      const rows = fl.kind === "heart" ? HEART : STAR;
      const x = (p.x + fl.x + fl.drift * age) * f.dpr;
      const y = (p.y - 96 - 40 * age + this.sink) * f.dpr;
      f.ctx.setTransform(1, 0, 0, 1, 0, 0);
      f.ctx.globalAlpha = Math.max(0, 1 - age * age);
      f.ctx.fillStyle = fl.kind === "heart" ? "#ff4fa8" : "#ffd84a";
      rows.forEach((row, ry) => [...row].forEach((ch, rx) => ch === "#" && f.ctx.fillRect(Math.round(x + (rx - 3) * unit), Math.round(y + ry * unit), unit, unit)));
    }
    f.ctx.globalAlpha = 1;
  }
}

/** The fetch ball: a glowing glitch orb (also drawn by the ball window). */
export function drawBallAt(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, tick: number): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const glow = ctx.createRadialGradient(x, y, r * 0.3, x, y, r * 2);
  glow.addColorStop(0, "rgba(255, 60, 220, 0.55)");
  glow.addColorStop(1, "rgba(255, 60, 220, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(x - r * 2, y - r * 2, r * 4, r * 4);
  const px = Math.max(1, Math.round(r / 3));
  // A pixel disc: magenta body, pale highlight, a cyan glitch row now and then.
  for (let gy = -3; gy <= 3; gy++) {
    for (let gx = -3; gx <= 3; gx++) {
      if (gx * gx + gy * gy > 10) continue;
      let c = "#c000f0";
      if (gx * gx + gy * gy <= 4) c = "#ff3fd6";
      if (gx === -1 && gy === -1) c = "#ffe6fb";
      if (gy === ((tick >> 1) % 7) - 3 && tick % 3 === 0) c = "#29f1ff";
      ctx.fillStyle = c;
      ctx.fillRect(Math.round(x + gx * px - px / 2), Math.round(y + gy * px - px / 2), px, px);
    }
  }
}
