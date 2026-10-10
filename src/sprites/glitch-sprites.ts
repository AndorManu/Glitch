// Load Glitch's art: the animation sheet, else the old 16-pose sheet, else
// the tiny code-drawn fallback.

import { GLITCH } from "./glitch";
import { GLITCH_ANIM, glitchAnimFor } from "./glitch-anim";
import { loadSprites } from "./load";
import { RACCOON } from "./raccoon";
import type { SpriteSet } from "./types";

export async function loadGlitchSprites(dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1): Promise<SpriteSet> {
  try {
    return await loadSprites(glitchAnimFor(dpr));
  } catch (e) {
    console.error("display sheet failed to load, using the art-grid sheet", e);
  }
  try {
    return await loadSprites(GLITCH_ANIM);
  } catch (e) {
    console.error("animation sheet failed to load, using the old sheet", e);
  }
  try {
    return await loadSprites(RACCOON);
  } catch (e) {
    console.error("sprite sheet failed to load, using fallback art", e);
  }
  return loadSprites(GLITCH);
}
