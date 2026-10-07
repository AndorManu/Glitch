// Small pixel-art props Glitch can hold, drag or push (cursor, browser tab).
// Drawn as text grids like src/sprites/glitch.ts: one character per pixel,
// '.' = transparent. Each prop pixel is PROP_PX CSS px on screen.
//
// Animations place props per keyframe (see `PropPlacement` in animations.ts);
// render.ts pre-renders every grid once and draws it with one drawImage.

export const PROP_PX = 2;

export const PROP_PALETTE: Record<string, string> = {
  k: "#1d1424", // outline (same near-black as the raccoon's)
  w: "#ffffff",
  s: "#c9c3d6", // light shade
  t: "#4a3f5c", // title bar
  r: "#ff5f57", // window buttons
  y: "#febc2e",
  n: "#28c840",
  l: "#b9b2c8", // "text" lines
  p: "#9a00f5", // glitch purple
  q: "#c000f0", // bright glitch purple
};

export interface PropGrid {
  rows: string[];
  /** The prop's handle point in grid pixels (cursor tip, window title bar...). */
  origin: [number, number];
}

export const PROPS = {
  // The classic arrow pointer; origin = its tip.
  cursor: {
    origin: [0, 0],
    rows: [
      "k.......",
      "kk......",
      "kwk.....",
      "kwwk....",
      "kwwwk...",
      "kwwwwk..",
      "kwwwwwk.",
      "kwwwwwwk",
      "kwwwkkkk",
      "kwkwwk..",
      "kk.kwwk.",
      "....kk..",
    ],
  },
  // A mini browser tab, like the window in pose 12; origin = middle of the title bar.
  window: {
    origin: [8, 2],
    rows: [
      ".kkkkkkkkkkkkkk.",
      "kttttttttttttttk",
      "ktrtytnttttttttk",
      "kttttttttttttttk",
      "kkkkkkkkkkkkkkkk",
      "kwwwwwwwwwwwwwwk",
      "kwllllllllwwwwwk",
      "kwwwwwwwwwwwwwwk",
      "kwlllllwwwwqqwwk",
      "kwwwwwwwwwwqqwwk",
      "kwllllwwwwwwwwsk",
      ".kkkkkkkkkkkkkk.",
    ],
  },
} satisfies Record<string, PropGrid>;

export type GridPropName = keyof typeof PROPS;
