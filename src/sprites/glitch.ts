// Placeholder pixel art for Glitch, drawn as text grids.
//
// Each frame is 16x16 "pixels"; every character is one pixel and maps to a
// colour in PALETTE ('.' = transparent). Edit the grids to tweak the art.
//
// To use real art instead, see `sheet.ts` (PNG sprite sheet loader) and the
// "Swapping in real art" section of the README. The rest of the app only
// depends on the `SpriteSet` interface in `types.ts`.

import type { GridSpriteSource } from "./types";

export const PALETTE: Record<string, string> = {
  k: "#1b1036", // outline
  b: "#5ce1e6", // body
  d: "#2fa9c4", // body shade
  h: "#c9fbff", // highlight
  w: "#ffffff", // eye white
  p: "#1b1036", // pupil
  m: "#ff4fa3", // magenta accent (antenna, cheeks, tongue)
  z: "#b4a7ff", // sleepy Zzz
};

// The base pose. Rows 7/8 are the eyes, row 10 the mouth, row 14 the feet.
const BASE = [
  "................",
  ".......mm.......",
  "........k.......",
  ".....kkkkkk.....",
  "....kbbbbbbk....",
  "...kbhhbbbbbk...",
  "..kbhbbbbbbbbk..",
  "..kbbwwbbwwbbk..",
  "..kbbwpbbwpbbk..",
  "..kbmbbbbbbmbk..",
  "..kbbbbkkbbbbk..",
  "..kdbbbbbbbbdk..",
  "...kddbbbbddk...",
  "....kkkkkkkk....",
  "....kk....kk....",
  "................",
];

/** Copy BASE with some rows replaced. */
function variant(rows: Record<number, string>): string[] {
  return BASE.map((row, i) => rows[i] ?? row);
}

const EYES_CLOSED = { 7: "..kbbbbbbbbbbk..", 8: "..kbbkkbbkkbbk.." };

export const GLITCH: GridSpriteSource = {
  kind: "grid",
  palette: PALETTE,
  frames: {
    idle0: BASE,
    // Antenna sways.
    idle1: variant({ 1: "........mm......", 2: "........k......." }),
    blink: variant(EYES_CLOSED),
    // Looking up while thinking, with a little thought dot that moves.
    think0: variant({ 0: "............h...", 7: "..kbbwpbbwpbbk..", 8: "..kbbwwbbwwbbk.." }),
    think1: variant({ 0: ".............h..", 1: ".......mm....h..", 7: "..kbbwpbbwpbbk..", 8: "..kbbwwbbwwbbk.." }),
    // Squinty happy eyes, open mouth.
    happy: variant({ 7: "..kbbppbbppbbk..", 8: "..kbbbbbbbbbbk..", 10: "..kbbbkmmkbbbk.." }),
    walk0: variant({ 14: "...kk.....kk...." }),
    walk1: variant({ 1: "........mm......", 14: ".....kk..kk....." }),
    sleep0: variant({ ...EYES_CLOSED, 0: "...........zzz..", 1: ".......mm....z..", 2: "........k..zzz.." }),
    sleep1: variant(EYES_CLOSED),
  },
};
