// The display sheets must build for every devicePixelRatio: if glitchAnimFor throws, loadGlitchSprites
// silently falls back to the art-grid sheet (blocky) and the panel portrait stays empty.

import { describe, expect, it } from "vitest";
import { ANIM_INDEX } from "./anim";
import { ALIASES, GLITCH_ANIM, glitchAnimFor } from "./glitch-anim";

describe("glitchAnimFor", () => {
  it("builds the 1x and 2x display sheets without throwing", () => {
    for (const dpr of [1, 1.25, 1.5, 2, 3]) {
      const s = glitchAnimFor(dpr);
      expect(s.url).toMatch(/glitch-anim@[12]x\.png$/);
      expect(s.frameWidth).toBeGreaterThan(0);
    }
  });

  it("every alias resolves to a frame; an alias has an eye only when its target has one", () => {
    for (const [alias, target] of Object.entries(ALIASES)) {
      expect(ANIM_INDEX[target], `${alias} -> ${target}`).toBeDefined();
    }
    for (const [name, eye] of Object.entries(GLITCH_ANIM.eyes ?? {})) {
      expect(Array.isArray(eye), name).toBe(true);
    }
  });
});
