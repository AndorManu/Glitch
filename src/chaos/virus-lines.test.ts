import { describe, expect, it } from "vitest";
import { allCopy, BANNED_WORDS, closeLabel, FOOTER, POPUP_KINDS, POPUP_LIFE_MS, stageAt } from "./virus-lines";

describe("Glitch's fake popups", () => {
  it("never use words that would make them look like a system dialog, a warning or a scam", () => {
    for (const text of allCopy()) {
      const t = text.toLowerCase();
      for (const w of BANNED_WORDS) expect(t.includes(w), `"${text}" contains "${w}"`).toBe(false);
    }
  });

  it("always say whose they are: the footer, and a Close button from the first frame", () => {
    expect(FOOTER).toBe("Glitch is only playing");
    for (const kind of POPUP_KINDS) {
      expect(closeLabel(kind).length).toBeGreaterThan(1);
      expect(stageAt(kind, 0).title.length).toBeGreaterThan(3);
    }
  });

  it("the RAM popup climbs to 37% and ends in just kidding", () => {
    const peak = Math.max(...[...Array(70)].map((_, i) => stageAt("ram", i * 100).progress ?? 0));
    expect(peak).toBeCloseTo(0.37, 2);
    expect(stageAt("ram", 0).title).toBe("GLITCH.EXE is eating your RAM");
    expect(stageAt("ram", 4000).meter).toBe("37%");
    const end = stageAt("ram", 7000);
    expect(end.title).toBe("just kidding!");
    expect(end.done).toBe(true);
    // The bar never jumps up.
    let prev = 0;
    for (let ms = 0; ms <= 3200; ms += 100) {
      const p = stageAt("ram", ms).progress!;
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });

  it("the raccoons arrive one by one, three in all", () => {
    expect(stageAt("raccoons", 0).title).toBe("Installing 3 new raccoons");
    let prev = 0;
    for (let ms = 0; ms <= 6000; ms += 100) {
      const n = stageAt("raccoons", ms).raccoons;
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
    expect(prev).toBe(3);
    expect(stageAt("raccoons", 6000).done).toBe(true);
  });

  it("the cursor adoption has no bar", () => {
    expect(stageAt("adopted", 0).title).toBe("Your cursor has been adopted");
    expect(stageAt("adopted", 0).progress).toBeNull();
  });

  it("closes itself well before Rust's 20 s limit", () => {
    expect(POPUP_LIFE_MS).toBeLessThan(20_000);
  });
});
