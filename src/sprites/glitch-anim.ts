// Glitch's animation sheet: public/sprites/glitch-anim.png, built by
// scripts/slice-generated.py + scripts/pack-sprites.py from the generated
// on-model sheets (art/generated) and the original 16 poses. Pixel art at
// its own pixel size, drawn crisp at 1.5 CSS px per art px (the same size
// the old 2x sheet had on screen).
//
// Cycles (8 frames unless noted): idle, talk, wave, walk, run (6), jump,
// think, sleep, wake, dangle, climb, laugh, sad, angry, surprised, scared,
// peek, push, spin, teleport, listen, celebrate, dance, eat, grab_tab.
// The old sheet's names (blink, side, sit, sleep0, think0...) are aliases
// of the closest frame, so everything that used raccoon.ts keeps working.

import { ANIM_EYES, ANIM_FRAME_H, ANIM_FRAME_W, ANIM_INDEX } from "./anim";
import type { SheetSpriteSource } from "./types";

/** Old frame names -> frames of this sheet. */
export const ALIASES: Record<string, string> = {
  blink: "idle5",
  blink_half: "idle4",
  side: "pose_side",
  wave: "wave4",
  glitch: "pose_glitch",
  sit: "pose_sit",
  sleep0: "pose_sleep",
  sleep1: "pose_sleep",
  happy: "pose_happy",
  laugh: "pose_laugh",
  think0: "pose_think",
  think1: "pose_think",
  chaos: "pose_chaos",
  nap_rock: "pose_push",
  back: "pose_back",
  notify: "pose_notify",
  front_alt: "pose_front_alt",
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

export const GLITCH_ANIM: SheetSpriteSource = {
  kind: "sheet",
  url: "/sprites/glitch-anim.png",
  frameWidth: ANIM_FRAME_W,
  frameHeight: ANIM_FRAME_H,
  frames,
  pixelated: true,
  scale: 1.5,
  eyes,
};
