import { describe, expect, it } from "vitest";
import { maxShift, mulberry32, planBlocks, planSlices, planTrail, seedFor } from "./glitchfx";

describe("glitch effects", () => {
  it("the PRNG is deterministic per seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(mulberry32(43)()).not.toBe(xs[0]);
    expect(seedFor(1)).not.toBe(seedFor(2));
  });

  it("slices are deterministic for a seed", () => {
    expect(planSlices(mulberry32(seedFor(7)), 110, 0.8)).toEqual(planSlices(mulberry32(seedFor(7)), 110, 0.8));
    expect(planSlices(mulberry32(seedFor(7)), 110, 0.8)).not.toEqual(planSlices(mulberry32(seedFor(8)), 110, 0.8));
  });

  it("slices tile the canvas exactly and shift within bounds", () => {
    for (let seed = 0; seed < 300; seed++) {
      const g = (seed % 11) / 10;
      const slices = planSlices(mulberry32(seed), 110, g);
      let y = 0;
      for (const s of slices) {
        expect(s.y).toBe(y); // no gaps or overlaps
        expect(s.h).toBeGreaterThan(0);
        expect(Math.abs(s.dx)).toBeLessThanOrEqual(maxShift(g));
        y += s.h;
      }
      expect(y).toBe(110); // nothing below the canvas
      // Few drawImage calls: unshifted neighbours are merged.
      expect(slices.length).toBeLessThanOrEqual(40);
    }
  });

  it("stronger glitches shift more of the sprite", () => {
    const shifted = (g: number) => {
      let rows = 0;
      for (let seed = 0; seed < 200; seed++) for (const s of planSlices(mulberry32(seed), 110, g)) if (s.dx) rows += s.h;
      return rows;
    };
    expect(shifted(0.9)).toBeGreaterThan(shifted(0.1) * 1.5);
  });

  it("corrupted blocks stay inside their box, snapped to art pixels", () => {
    const box = { x: 11, y: 16, width: 138, height: 90 };
    for (let seed = 0; seed < 200; seed++) {
      for (const b of planBlocks(mulberry32(seed), box, 1, 16)) {
        expect(b.x).toBeGreaterThanOrEqual(box.x);
        expect(b.y).toBeGreaterThanOrEqual(box.y);
        expect(b.x + b.w).toBeLessThanOrEqual(box.x + box.width);
        expect(b.y + b.h).toBeLessThanOrEqual(box.y + box.height);
        expect((b.x - box.x) % 3).toBe(0);
      }
    }
    expect(planBlocks(mulberry32(1), box, 0, 16)).toEqual([]);
  });

  it("trail particles drift backwards consistently from tick to tick", () => {
    const now = planTrail(10);
    const later = planTrail(11);
    // The particles born on tick 10 (age 0 now) are age 1 one tick later, 4.5 px further back.
    const born = now.filter((_, i) => i < now.length && now[i].alpha === now[0].alpha);
    const moved = later.find((p) => Math.abs(p.x - (born[0].x - 4.5)) < 1e-9);
    expect(moved).toBeDefined();
    expect(now.every((p) => p.x < 0)).toBe(true); // always behind Glitch
  });
});
