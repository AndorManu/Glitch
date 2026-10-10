// Glitch's animation sheet, built by scripts/slice-generated.py +
// scripts/pack-sprites.py from the generated on-model sheets (art/generated)
// and the original 16 poses.
//
// public/sprites/glitch-anim.png is the art grid (1 px per art pixel); the
// app draws one of the display sheets rendered from it at the exact device
// size, so nothing is ever scaled by a non-integer factor at runtime:
//   glitch-anim@1x.png  1.5 device px per art px (smoothly resampled), DPR < 1.5
//   glitch-anim@2x.png  3 device px per art px (crisp), DPR >= 1.5
// Either way a frame is 1.5 CSS px per art px on screen.
//
// The old sheet's names (blink, side, sit, sleep0, think0...) are aliases of
// the closest frame, so everything that used raccoon.ts keeps working.

import { ANIM_EYES, ANIM_FRAME_H, ANIM_FRAME_W, ANIM_INDEX } from "./anim";
import { mirrorable } from "./families";
import type { SheetSpriteSource } from "./types";

/** CSS px per art px. */
export const ART_SCALE = 1.5;

/** Old frame names -> frames of this sheet. */
export const ALIASES: Record<string, string> = {
  blink: "idle5",
  blink_half: "idle4",
  // Side-on standing (the turn's last frame: drawn with the glitch eye).
  side: "turn_front_to_side5",
  wave: "wave4",
  glitch: "stand_up_glitch2",
  sit: "sit0",
  happy: "celebrate3",
  laugh: "laugh2",
  think0: "think4",
  think1: "think5",
  chaos: "spin2",
  nap_rock: "sit_down7",
  back: "turn_to_back5",
  notify: "point4",
  front_alt: "idle1",
  crouch: "jump1",
  air_up: "jump2",
  air_tuck: "jump3",
  air_apex: "jump4",
  air_down: "jump5",
  land0: "jump6",
  land1: "jump7",
};

const frames: Record<string, number> = { ...ANIM_INDEX };
const eyes: Record<string, [number, number]> = { ...ANIM_EYES };
for (const [alias, target] of Object.entries(ALIASES)) {
  // A drawn cycle frame of the same name (e.g. sleep0, think1) wins over the alias.
  if (alias in ANIM_INDEX || !(target in ANIM_INDEX)) continue;
  frames[alias] = ANIM_INDEX[target];
  eyes[alias] = ANIM_EYES[target];
}

/** The art-grid sheet (1 px per art px): frame names and eye positions in art px. */
export const GLITCH_ANIM: SheetSpriteSource = {
  kind: "sheet",
  url: "/sprites/glitch-anim.png",
  frameWidth: ANIM_FRAME_W,
  frameHeight: ANIM_FRAME_H,
  frames,
  pixelated: true,
  scale: ART_SCALE,
  eyes,
  mirrorable,
};

/**
 * The display sheet for a device pixel ratio: rendered at the device size,
 * drawn 1:1 (smoothing on, for rotations and squash).
 */
export function glitchAnimFor(dpr: number): SheetSpriteSource {
  const hi = dpr >= 1.5;
  // Device px per art px in the sheet, and CSS px per sheet px.
  const k = hi ? 3 : 1.5;
  const scaled: Record<string, [number, number]> = {};
  for (const [n, [x, y]] of Object.entries(eyes)) scaled[n] = [x * k, y * k];
  return {
    ...GLITCH_ANIM,
    url: hi ? "/sprites/glitch-anim@2x.png" : "/sprites/glitch-anim@1x.png",
    frameWidth: ANIM_FRAME_W * k,
    frameHeight: ANIM_FRAME_H * k,
    pixelated: false,
    scale: ART_SCALE / k,
    eyes: scaled,
  };
}
