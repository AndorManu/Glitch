import { describe, expect, it } from "vitest";
import { PLAY_DEFAULTS } from "../../shared/ipc";
import { FEATURES } from "./index";
import { fileSize, PLAY_SWITCHES, playSettingsOf } from "./play";
import { levelLine } from "./wardrobe";

describe("games, play and growth settings", () => {
  it("is registered in the Features list with one switch per feature", () => {
    expect(FEATURES.map((f) => f.id)).toContain("play");
    expect(PLAY_SWITCHES.map((s) => s.key).sort()).toEqual(["feeding", "fetch", "growth", "hide_seek", "levels", "mood"]);
  });

  it("defaults: everything on except feeding", () => {
    const s = playSettingsOf({});
    expect(s).toEqual(PLAY_DEFAULTS);
    expect([s.fetch, s.hide_seek, s.mood, s.growth, s.levels, s.feeding]).toEqual([true, true, true, true, true, false]);
    expect(playSettingsOf({ play: { ...PLAY_DEFAULTS, feeding: true } }).feeding).toBe(true);
  });

  it("level line and sizes", () => {
    expect(levelLine({ level: 3, xp: 200, level_xp: 160, next_level_xp: 320 })).toEqual({ text: "Level 3 · 40 / 160 XP to level 4", percent: 25 });
    expect(levelLine({ level: 12, xp: 5000, level_xp: 3760, next_level_xp: null }).percent).toBe(100);
    expect(fileSize(12)).toBe("12 bytes");
    expect(fileSize(5 * 1024)).toBe("5 KB");
    expect(fileSize(3.5 * 1024 * 1024)).toBe("3.5 MB");
  });
});
