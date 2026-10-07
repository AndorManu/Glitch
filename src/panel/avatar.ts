// The little raccoon portrait in the panel header.

import { GLITCH } from "../sprites/glitch";
import { loadSprites } from "../sprites/load";
import { RACCOON } from "../sprites/raccoon";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A square inside a w×h frame (`zoom` 1 = as big as fits), centred horizontally
 * on `focusX` (0 = left edge, 1 = right edge) and anchored to the top. Used to
 * crop a wide sprite frame (raccoon + tail) down to a portrait of Glitch.
 */
export function squareCrop(w: number, h: number, focusX = 0.5, zoom = 1): Rect {
  const side = Math.round(Math.min(w, h) / Math.max(1, zoom));
  const x = Math.round(Math.min(Math.max(focusX * w - side / 2, 0), w - side));
  return { x, y: 0, w: side, h: side };
}

/** Draw Glitch's portrait into a square canvas of `size` CSS px. */
export async function drawAvatar(c: HTMLCanvasElement, size: number): Promise<void> {
  const sprites = await loadSprites(RACCOON).catch(() => loadSprites(GLITCH)); // portrait: the smooth 2x sheet
  const img = sprites.frame("idle0");
  const dpr = window.devicePixelRatio || 1;
  c.width = c.height = Math.round(size * dpr);
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = !sprites.pixelated;
  ctx.imageSmoothingQuality = "high";
  // The sheet frames are wide (the tail sits on the left); the face is a bit right of centre.
  const src = img.width > img.height ? squareCrop(img.width, img.height, 0.62, 1.15) : squareCrop(img.width, img.height);
  ctx.drawImage(img, src.x, src.y, src.w, src.h, 0, 0, c.width, c.height);
}
