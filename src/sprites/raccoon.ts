// Glitch the raccoon: frames in public/sprites/glitch.png, built from
// art/glitch-raccoon-source.webp by scripts/make-sprites.py.
// Indices are positions in the 4x4 sheet (0 = top-left, row by row).

import type { SheetSpriteSource } from "./types";

export const RACCOON: SheetSpriteSource = {
  kind: "sheet",
  url: "/sprites/glitch.png",
  frameWidth: 276,
  frameHeight: 180,
  frames: {
    // Names used by the keyframe animations in src/mascot/animations.ts
    idle0: 0, // front, glitch eye
    idle1: 3, // front, tail swapped to the other side
    blink: 0, // (no blink pose yet)
    side: 1, // side view: glancing around
    walk0: 4,
    walk1: 5, // mid-stride, with its own motion pixels
    wave: 6,
    glitch: 7, // crouched, glitching: bursts, dangling while dragged
    sit: 8, // idle fidget
    sleep0: 9, // curled up, Zzz
    sleep1: 9,
    happy: 10, // waving, mouth open
    laugh: 11,
    think0: 14, // "?"
    think1: 14,
    chaos: 15, // spinning in a purple swirl
    nap_rock: 13,
    // in the sheet, reserved for later
    back: 2,
    notify: 12, // peeking at a window (Claude Code notifications)
  },
};
