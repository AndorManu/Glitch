// Drawing the fetch ball on the play overlay: shadow, trail, glow, the ball
// (a rolling pixel orb in Glitch's palette, or the drawn ball sheet once
// public/sprites/ball.png exists), squash and stretch, sparks, the glitch
// flicker and the final pop into pixels.

import type { BallPicture } from "../mascot/play/ballsim";
import { BALL_ART, ballGrid, BODY, GLINT, LIGHT, SEAM, toCanvas } from "../mascot/play/ballart";

export { BALL_ART };

/** Drawn at 1.5 CSS px per art px, like Glitch. */
export const ART_PX = 1.5;

export interface BallArt {
  roll: CanvasImageSource[];
  glitch: CanvasImageSource;
  /** Art px per frame side. */
  size: number;
}

/** The code-drawn ball (until the drawn ball sheet is there). */
export function codeBall(): BallArt {
  return { roll: Array.from({ length: 8 }, (_, i) => toCanvas(ballGrid(i))), glitch: toCanvas(ballGrid(2, true)), size: BALL_ART };
}

/**
 * The drawn ball sheet (scripts/slice-ball.py -> public/sprites/ball.png):
 * one row, frames 0-7 the roll loop, 8 squash, 9 stretch, 10 glitch, 11 glow.
 * Null if it isn't there.
 */
export async function sheetBall(url = "/sprites/ball.png"): Promise<BallArt | null> {
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const size = img.naturalHeight;
    if (img.naturalWidth < size * 11) return null;
    const cut = (i: number) => {
      const c = document.createElement("canvas");
      c.width = c.height = size;
      c.getContext("2d")!.drawImage(img, i * size, 0, size, size, 0, 0, size, size);
      return c;
    };
    return { roll: Array.from({ length: 8 }, (_, i) => cut(i)), glitch: cut(10), size };
  } catch {
    return null;
  }
}

/** Draw everything for one picture (canvas cleared by the caller). CSS px, `dpr` device px per CSS px. */
export function drawBall(ctx: CanvasRenderingContext2D, art: BallArt, p: BallPicture, dpr: number): void {
  if (p.hidden) return;
  const px = (v: number) => Math.round(v * dpr);
  const unit = Math.max(1, px(ART_PX));
  ctx.imageSmoothingEnabled = false;
  // Ground shadow: a soft 2-3 px pixel smudge that shrinks as it rises.
  if (p.height !== null) {
    const k = Math.max(0, 1 - p.height / 220);
    if (k > 0.05) {
      const w = (p.r * 1.7 * (0.45 + 0.55 * k)) / 2;
      ctx.fillStyle = `rgba(20, 8, 32, ${(0.34 * k).toFixed(3)})`;
      ctx.fillRect(px(p.x - w), px(p.groundY - 2), px(w * 2), px(2));
      ctx.fillStyle = `rgba(20, 8, 32, ${(0.16 * k).toFixed(3)})`;
      ctx.fillRect(px(p.x - w - 3), px(p.groundY - 1.5), px(w * 2 + 6), px(1));
    }
  }
  // Trail: a few fading magenta pixels behind it.
  p.trail.forEach((t, i) => {
    if (i === 0) return;
    ctx.globalAlpha = Math.max(0, 0.55 - i * 0.08);
    ctx.fillStyle = i % 2 ? "#ff3fd6" : "#c000f0";
    const s = Math.max(1, unit * (i < 3 ? 2 : 1));
    ctx.fillRect(px(t.x) - s / 2, px(t.y) - s / 2, s, s);
  });
  ctx.globalAlpha = 1;
  // Glow: resting pulse, or hovered.
  if (p.glow > 0) {
    const g = ctx.createRadialGradient(px(p.x), px(p.y), px(p.r * 0.4), px(p.x), px(p.y), px(p.r * 2.6));
    g.addColorStop(0, `rgba(255, 63, 214, ${(0.38 * p.glow).toFixed(3)})`);
    g.addColorStop(1, "rgba(255, 63, 214, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(px(p.x - p.r * 3), px(p.y - p.r * 3), px(p.r * 6), px(p.r * 6));
  }
  // The ball: squash on impact (flattened onto what it hit), stretch along the motion at speed.
  const img = p.glitch ? art.glitch : art.roll[p.frame % art.roll.length];
  const size = art.size * ART_PX;
  ctx.save();
  ctx.translate(px(p.x), px(p.y));
  if (p.stretch > 0) {
    ctx.rotate(p.dir);
    ctx.scale(1 + 0.32 * p.stretch, 1 - 0.18 * p.stretch);
    ctx.rotate(-p.dir);
  }
  if (p.squash > 0.02) {
    const s = p.squash;
    ctx.translate(0, px(p.r * 0.32 * s));
    ctx.scale(1 + 0.34 * s, 1 - 0.3 * s);
  }
  const half = px(size / 2);
  ctx.drawImage(img, -half, -half, half * 2, half * 2);
  ctx.restore();
  // Sparks on hard bounces.
  for (const s of p.sparks) {
    ctx.globalAlpha = Math.max(0, s.a);
    ctx.fillStyle = s.a > 0.6 ? "#ffffff" : s.a > 0.3 ? SEAM : "#ff3fd6";
    ctx.fillRect(px(s.x), px(s.y), unit, unit);
  }
  ctx.globalAlpha = 1;
}

/** The end of the game: the ball pops into pixels (t 0..1). */
export function drawPop(ctx: CanvasRenderingContext2D, x: number, y: number, t: number, dpr: number): void {
  const unit = Math.max(1, Math.round(ART_PX * dpr));
  const n = 14;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (i % 3) * 0.3;
    const r = 4 + t * (22 + (i % 4) * 6);
    ctx.globalAlpha = Math.max(0, 1 - t);
    ctx.fillStyle = [BODY, LIGHT, SEAM, GLINT][i % 4];
    ctx.fillRect(Math.round((x + Math.cos(a) * r) * dpr), Math.round((y + Math.sin(a) * r - t * 6) * dpr), unit, unit);
  }
  ctx.globalAlpha = 1;
}
