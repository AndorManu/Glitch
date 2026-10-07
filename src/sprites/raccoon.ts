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
    // used by the animations in src/mascot/animations.ts
    idle0: 0, // front, glitch eye
    idle1: 3, // front, tail swapped to the other side
    blink: 0, // (no blink pose yet)
    walk0: 4,
    walk1: 5,
    happy: 10, // waving, mouth open
    wave: 6,
    think0: 14, // "?"
    think1: 14,
    sleep0: 9, // curled up, Zzz
    sleep1: 9,
    // in the sheet, reserved for later milestones
    side: 1,
    back: 2,
    glitch: 7,
    sit: 8,
    laugh: 11,
    notify: 12, // peeking at a window (Claude Code notifications)
    nap_rock: 13,
    chaos: 15, // chaos mode
  },
};
