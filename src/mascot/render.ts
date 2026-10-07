// Draws one Pose onto the mascot canvas: the sprite with its transform,
// props, and the procedural glitch effects (slices, RGB split, corrupted
// pixels, eye sparks, dissolve) planned in glitchfx.ts.
//
// Plain canvas 2D only (WKWebView has no ctx.filter): tinting uses cached
// source-in copies made once per frame image; slicing is a few drawImage
// calls from a scratch canvas. A calm frame is a single drawImage.

import { RACCOON } from "../sprites/raccoon";
import type { FrameImage, SpriteSet } from "../sprites/types";
import type { Pose, PropPlacement } from "./animations";
import { mulberry32, planBlocks, planSlices, planTrail, type Rect, seedFor } from "./glitchfx";
import { PROP_PALETTE, PROP_PX, PROPS, type GridPropName } from "./props";

/** Canvas size in CSS px. Must match the mascot window (tauri.conf.json, windows.rs). */
export const VIEW_W = 160;
export const VIEW_H = 110;
/** The art is drawn at this size (the sheet is 2x for sharp high-DPI). */
const ART_W = 138;
const ART_H = 90;
/** Feet sit a little above the bottom edge; the margins leave room for hops and sparks. */
const FEET_Y = VIEW_H - 4;
/** One art pixel of the raccoon sheet in CSS px: glitch blocks snap to it. */
const PX = 3;

// purple, bright purple, pale pink-white, dust grey
const COLORS = ["#9a00f5", "#c000f0", "#f6d2ff", "#7d7285"];
const CYAN = "#00e1ff";
const MAGENTA = "#ff1fc8";

// Where the glowing eye is in each sheet pose (px in the 276x180 frame), for eye sparks.
const EYE_BY_INDEX: Record<number, [number, number]> = {
  0: [188, 92],
  1: [237, 62],
  2: [140, 40],
  3: [152, 90],
  4: [212, 90],
  5: [229, 91],
  6: [176, 68],
  7: [178, 138],
  8: [180, 93],
  9: [205, 145],
  10: [161, 100],
  11: [177, 87],
  12: [148, 100],
  13: [144, 100],
  14: [157, 127],
  15: [116, 133],
};

/** 2D affine matrix [a b c d e f] like canvas setTransform. */
type M = [number, number, number, number, number, number];
const mul = (p: M, q: M): M => [
  p[0] * q[0] + p[2] * q[1],
  p[1] * q[0] + p[3] * q[1],
  p[0] * q[2] + p[2] * q[3],
  p[1] * q[2] + p[3] * q[3],
  p[0] * q[4] + p[2] * q[5] + p[4],
  p[1] * q[4] + p[3] * q[5] + p[5],
];
const translate = (x: number, y: number): M => [1, 0, 0, 1, x, y];
const scale = (x: number, y: number): M => [x, 0, 0, y, 0, 0];
const rotate = (deg: number): M => {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
};
const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function makeCanvas(w = 1, h = 1): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

export interface RendererOptions {
  /** Device pixels per CSS px (default: window.devicePixelRatio). */
  pixelRatio?: () => number;
}

export class Renderer {
  /** Art faces right; mirror everything (sprite, props, sparks) when walking left. */
  facingLeft = false;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly work = makeCanvas();
  private readonly wctx: CanvasRenderingContext2D;
  private readonly tints = new WeakMap<object, Map<string, HTMLCanvasElement>>();
  private readonly propImages = new Map<string, HTMLCanvasElement>();
  private last: { pose: Pose; tick: number } | null = null;
  private readonly pixelRatio: () => number;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly sprites: SpriteSet,
    opts: RendererOptions = {},
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.wctx = this.work.getContext("2d")!;
    this.pixelRatio = opts.pixelRatio ?? (() => window.devicePixelRatio || 1);
  }

  /** Repaint the last pose (e.g. after a DPI change). Same tick, same noise. */
  redraw(): void {
    if (this.last) this.render(this.last.pose, this.last.tick);
  }

  render(pose: Pose, tick: number): void {
    this.last = { pose, tick };
    const dpr = this.pixelRatio();
    const pw = Math.round(VIEW_W * dpr);
    const ph = Math.round(VIEW_H * dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, pw, ph);

    const rand = mulberry32(seedFor(tick));
    const img = this.sprites.frame(pose.frame);
    const { w, h } = this.artSize(img, dpr);
    const face = this.facingLeft ? -1 : 1;
    const mir = pose.flip ? -face : face;
    // Feet anchor -> pivot rotation -> mirrored scale. All in CSS px, then x dpr.
    const py = -pose.pivot * h;
    const m = [
      scale(dpr, dpr),
      translate(VIEW_W / 2 + pose.dx * face, FEET_Y + pose.dy),
      translate(0, py),
      rotate(pose.rot * mir),
      translate(0, -py),
      scale(mir * pose.sx, pose.sy),
    ].reduce(mul);

    this.drawProps(pose.props, true, dpr, face);
    if (pose.dissolve < 1) {
      if (pose.glitch <= 0 && pose.dissolve <= 0) this.drawSprite(ctx, img, m, w, h);
      else this.drawGlitched(img, m, w, h, pose, rand, dpr, face);
    }
    if (pose.dissolve > 0 && pose.dissolve < 1) this.drawScatter(m, h, pose.dissolve, rand, dpr);
    this.drawProps(pose.props, false, dpr, face);
    if (pose.glitch > 0 || pose.fx === "eye") this.drawEyeSparks(img, pose, m, w, h, rand, dpr, mir);
    if (pose.fx) this.drawFx(pose, tick, rand, dpr, face);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------- sprite

  /** Drawn size in CSS px: the sheet at half size; pixel grids by whole numbers. */
  private artSize(img: FrameImage, dpr: number): { w: number; h: number } {
    if (!this.sprites.pixelated) return { w: ART_W, h: ART_H };
    const s = Math.max(1, Math.floor(Math.min((ART_W * dpr) / img.width, (ART_H * dpr) / img.height)));
    return { w: (img.width * s) / dpr, h: (img.height * s) / dpr };
  }

  private drawSprite(c: CanvasRenderingContext2D, img: CanvasImageSource, m: M, w: number, h: number): void {
    c.setTransform(...m);
    c.imageSmoothingEnabled = !this.sprites.pixelated;
    c.imageSmoothingQuality = "high";
    c.drawImage(img, -w / 2, -h, w, h);
    c.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** The sprite's untransformed box in CSS px (good enough to aim noise at). */
  private spriteBox(pose: Pose, w: number, h: number, face: number): Rect {
    const sw = w * pose.sx;
    const sh = h * pose.sy;
    return { x: VIEW_W / 2 + pose.dx * face - sw / 2, y: FEET_Y + pose.dy - sh, width: sw, height: sh };
  }

  private drawGlitched(img: FrameImage, m: M, w: number, h: number, pose: Pose, rand: () => number, dpr: number, face: number): void {
    const ctx = this.ctx;
    const g = pose.glitch;
    const pw = this.canvas.width;
    const ph = this.canvas.height;
    if (this.work.width !== pw || this.work.height !== ph) {
      this.work.width = pw;
      this.work.height = ph;
    }
    const wc = this.wctx;
    wc.setTransform(1, 0, 0, 1, 0, 0);
    wc.globalCompositeOperation = "source-over";
    wc.globalAlpha = 1;
    wc.clearRect(0, 0, pw, ph);
    this.drawSprite(wc, img, m, w, h);

    const box = this.spriteBox(pose, w, h, face);
    const unit = PX * dpr;
    // Corrupted blocks and scanlines only recolour Glitch's own pixels.
    wc.globalCompositeOperation = "source-atop";
    for (const b of planBlocks(rand, box, g, 16)) {
      wc.fillStyle = COLORS[b.color];
      wc.fillRect(Math.round(b.x * dpr), Math.round(b.y * dpr), Math.round(b.w * dpr), Math.round(b.h * dpr));
    }
    if (g > 0.45) {
      wc.fillStyle = "rgba(20, 0, 40, 0.28)";
      for (let y = Math.round(box.y * dpr); y < box.y * dpr + box.height * dpr; y += unit * 2) wc.fillRect(0, y, pw, Math.max(1, Math.round(dpr)));
    }
    // Dissolve: punch out random art pixels.
    if (pose.dissolve > 0) {
      wc.globalCompositeOperation = "destination-out";
      wc.fillStyle = "#000";
      wc.beginPath();
      const x0 = Math.floor((box.x - 20) * dpr);
      const y0 = Math.floor((box.y - 20) * dpr);
      for (let y = y0; y < (box.y + box.height + 20) * dpr; y += unit) {
        for (let x = x0; x < (box.x + box.width + 20) * dpr; x += unit) if (rand() < pose.dissolve) wc.rect(x, y, unit, unit);
      }
      wc.fill();
    }
    wc.globalCompositeOperation = "source-over";

    // RGB split: cyan and magenta ghosts either side (cached tints, not per pixel).
    // A strong glitch sometimes drops to a faint ghost for one frame (flicker).
    const flicker = g > 0.5 && rand() < 0.12;
    const off = (1 + 3.5 * g) * (rand() < 0.5 ? 1 : -1);
    ctx.globalAlpha = (flicker ? 0.2 : 0.5 + 0.35 * g) * (1 - pose.dissolve);
    this.drawSprite(ctx, this.tint(img, CYAN), mul(translate(-off * dpr, 0), m), w, h);
    this.drawSprite(ctx, this.tint(img, MAGENTA), mul(translate(off * dpr, 0), m), w, h);
    ctx.globalAlpha = 1;

    // Slices: the sprite in horizontal bands, a few shoved sideways.
    if (flicker) ctx.globalAlpha = 0.5;
    for (const s of planSlices(rand, VIEW_H, g, PX)) {
      const y = Math.round(s.y * dpr);
      const sh = Math.min(ph, Math.round((s.y + s.h) * dpr)) - y;
      if (sh > 0) ctx.drawImage(this.work, 0, y, pw, sh, Math.round(s.dx * dpr), y, pw, sh);
    }
    ctx.globalAlpha = 1;

    // Loose dead pixels around Glitch.
    const around = { x: box.x - 14, y: Math.max(0, box.y - 6), width: box.width + 28, height: box.height + 6 };
    for (const b of planBlocks(rand, around, g, 7)) {
      ctx.fillStyle = COLORS[b.color % 2];
      ctx.fillRect(Math.round(b.x * dpr), Math.round(b.y * dpr), Math.round(PX * dpr), Math.round(PX * dpr));
    }
  }

  /** Same image, every pixel one colour. Made once per frame and colour. */
  private tint(img: FrameImage, color: string): HTMLCanvasElement {
    let byColor = this.tints.get(img);
    if (!byColor) this.tints.set(img, (byColor = new Map()));
    let c = byColor.get(color);
    if (!c) {
      c = makeCanvas(img.width, img.height);
      const t = c.getContext("2d")!;
      t.drawImage(img, 0, 0);
      t.globalCompositeOperation = "source-in";
      t.fillStyle = color;
      t.fillRect(0, 0, img.width, img.height);
      byColor.set(color, c);
    }
    return c;
  }

  // ------------------------------------------------------------ particles

  private square(x: number, y: number, size: number, color: string, alpha = 1): void {
    this.ctx.globalAlpha = alpha;
    this.ctx.fillStyle = color;
    this.ctx.fillRect(Math.round(x), Math.round(y), Math.max(1, Math.round(size)), Math.max(1, Math.round(size)));
    this.ctx.globalAlpha = 1;
  }

  /** A pixel "+" sparkle (big) or a single pixel (small), centred on x,y. */
  private sparkle(x: number, y: number, unit: number, big: boolean, color: string): void {
    this.square(x - unit / 2, y - unit / 2, unit, color);
    if (!big) return;
    for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) this.square(x - unit / 2 + ox * unit, y - unit / 2 + oy * unit, unit, COLORS[2]);
  }

  private drawEyeSparks(img: FrameImage, pose: Pose, m: M, w: number, h: number, rand: () => number, dpr: number, mir: number): void {
    const index = RACCOON.frames[pose.frame];
    const eye = this.sprites.pixelated || index === undefined ? [0.66, 0.5] : [EYE_BY_INDEX[index][0] / img.width, EYE_BY_INDEX[index][1] / img.height];
    const [ex, ey] = apply(m, (eye[0] - 0.5) * w, (eye[1] - 1) * h);
    const n = pose.glitch > 0 ? 2 + Math.round(5 * pose.glitch) : 3;
    for (let i = 0; i < n; i++) {
      // Sparks fly out on the eye's side of the face (mirrors with facing).
      const ox = (3 + rand() * 15) * mir;
      const oy = (rand() - 0.6) * 16;
      const size = rand() < 0.6 ? PX : 2;
      this.square(ex + ox * dpr, ey + oy * dpr, size * dpr, COLORS[Math.floor(rand() * 3)], 0.6 + 0.4 * rand());
    }
  }

  /** Pixels flying off while dissolving (teleport). */
  private drawScatter(m: M, h: number, d: number, rand: () => number, dpr: number): void {
    const [cx, cy] = apply(m, 0, -h * 0.45);
    for (let i = 0; i < 6 + 22 * d; i++) {
      const a = rand() * Math.PI * 2;
      const r = (8 + rand() * 50) * d;
      this.square(cx + Math.cos(a) * r * 1.4 * dpr, cy + Math.sin(a) * r * 0.6 * dpr, (rand() < 0.5 ? PX : 2) * dpr, COLORS[Math.floor(rand() * 4)], 1 - d * 0.5);
    }
  }

  private drawFx(pose: Pose, tick: number, rand: () => number, dpr: number, face: number): void {
    const ax = VIEW_W / 2;
    const at = (x: number, y: number): [number, number] => [(ax + x * face) * dpr, (FEET_Y + y) * dpr];
    switch (pose.fx) {
      case "trail":
        for (const p of planTrail(tick)) {
          const [x, y] = at(p.x, p.y);
          this.square(x, y, p.size * dpr, COLORS[p.color], p.alpha);
        }
        break;
      case "dust":
        for (let i = 0; i < 6; i++) {
          const side = i % 2 ? 1 : -1;
          const [x, y] = at(side * (14 + rand() * 30), -1 - rand() * 7);
          this.square(x, y, (2 + Math.round(rand() * 2)) * dpr, i < 2 ? COLORS[0] : COLORS[3], 0.55 + 0.4 * rand());
        }
        break;
      case "sparkle":
        for (let i = 0; i < 4; i++) {
          const [x, y] = at((rand() < 0.5 ? -1 : 1) * (26 + rand() * 40), -92 + rand() * 50);
          this.sparkle(x, y, 2 * dpr, rand() < 0.55, COLORS[i % 2]);
        }
        break;
      case "dizzy":
        for (let i = 0; i < 3; i++) {
          const a = tick * 0.9 + (i * Math.PI * 2) / 3;
          const [x, y] = at(Math.cos(a) * 24 + 8, -84 + Math.sin(a) * 5);
          this.sparkle(x, y, 2 * dpr, i === 0, COLORS[i % 2]);
        }
        break;
      case "zzz": {
        // A small "z" drifting up and fading over three repaints (letters never mirror).
        const phase = tick % 3;
        const [x, y] = at(46 + phase * 4, -76 - phase * 8);
        this.zee(x, y, 2 * dpr, [1, 0.75, 0.4][phase]);
        break;
      }
      case "eye":
        break;
    }
  }

  private zee(x: number, y: number, unit: number, alpha: number): void {
    const rows = ["####", "..#.", ".#..", "####"];
    rows.forEach((row, r) => [...row].forEach((ch, c) => ch === "#" && this.square(x + c * unit, y + r * unit, unit, COLORS[1], alpha)));
  }

  // ---------------------------------------------------------------- props

  private drawProps(props: PropPlacement[], behind: boolean, dpr: number, face: number): void {
    for (const p of props) {
      if (!!p.behind !== behind) continue;
      if (p.name === "tether") this.drawTether(p.x, p.y, p.x2, p.y2, dpr, face);
      else this.drawGridProp(p.name, p.x, p.y, p.rot ?? 0, dpr, face);
    }
  }

  private drawGridProp(name: GridPropName, x: number, y: number, rot: number, dpr: number, face: number): void {
    const grid = PROPS[name];
    let img = this.propImages.get(name);
    if (!img) {
      img = makeCanvas(grid.rows[0].length, grid.rows.length);
      const c = img.getContext("2d")!;
      grid.rows.forEach((row, ry) =>
        [...row].forEach((ch, rx) => {
          if (ch === ".") return;
          c.fillStyle = PROP_PALETTE[ch];
          c.fillRect(rx, ry, 1, 1);
        }),
      );
      this.propImages.set(name, img);
    }
    const m = [
      scale(dpr, dpr),
      translate(VIEW_W / 2 + x * face, FEET_Y + y),
      scale(face, 1),
      rotate(rot),
      translate(-grid.origin[0] * PROP_PX, -grid.origin[1] * PROP_PX),
    ].reduce(mul);
    this.ctx.setTransform(...m);
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(img, 0, 0, img.width * PROP_PX, img.height * PROP_PX);
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** A sagging rope drawn as pixel dots along a curve. */
  private drawTether(x1: number, y1: number, x2: number, y2: number, dpr: number, face: number): void {
    const p = (t: number): [number, number] => {
      const sag = 7 * 4 * t * (1 - t);
      return [(VIEW_W / 2 + (x1 + (x2 - x1) * t) * face) * dpr, (FEET_Y + y1 + (y2 - y1) * t + sag) * dpr];
    };
    const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 1.5);
    for (const [color, size] of [["#1d1424", 3], ["#c99a62", 1]] as const) {
      for (let i = 0; i <= steps; i++) {
        const [x, y] = p(i / steps);
        this.square(x - (size * dpr) / 2, y - (size * dpr) / 2, size * dpr, color);
      }
    }
  }
}
