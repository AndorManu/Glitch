import { describe, expect, it } from "vitest";
import { facesLeft, positionAt, Walker } from "./walker";

const area = { x: 0, y: 0, width: 1920, height: 1040 };
const seq = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length];
};

describe("Walker", () => {
  it("rests between the configured bounds", () => {
    const w = new Walker({ speed: 70, maxDistance: 400, restMinMs: 1000, restMaxMs: 3000, random: seq(0, 0.5, 0.999) });
    expect(w.restMs()).toBe(1000);
    expect(w.restMs()).toBe(2000);
    expect(w.restMs()).toBeLessThan(3000);
  });

  it("never leaves the work area, whatever the random numbers", () => {
    for (let i = 0; i < 500; i++) {
      const w = new Walker({ speed: 70, maxDistance: 400, restMinMs: 0, restMaxMs: 0 });
      const from = { x: Math.random() * (1920 - 96), y: Math.random() * (1040 - 96) };
      const { to } = w.plan(from, area, { width: 138, height: 90 });
      expect(to.x).toBeGreaterThanOrEqual(0);
      expect(to.y).toBeGreaterThanOrEqual(0);
      expect(to.x + 138).toBeLessThanOrEqual(1920);
      expect(to.y + 90).toBeLessThanOrEqual(1040);
    }
  });

  it("respects monitors with negative coordinates", () => {
    const left = { x: -1920, y: -200, width: 1920, height: 1080 };
    const w = new Walker({ speed: 70, maxDistance: 5000, restMinMs: 0, restMaxMs: 0, random: seq(0.5, 1) });
    const { to } = w.plan({ x: -100, y: 0 }, left, { width: 138, height: 90 });
    expect(to.x).toBeGreaterThanOrEqual(-1920);
    expect(to.x + 138).toBeLessThanOrEqual(0);
  });

  it("walk duration follows speed", () => {
    // angle 0 (to the right), full distance
    const w = new Walker({ speed: 100, maxDistance: 300, restMinMs: 0, restMaxMs: 0, random: seq(0, 1) });
    const walk = w.plan({ x: 100, y: 100 }, area, { width: 138, height: 90 });
    expect(walk.to).toEqual({ x: 400, y: 100 });
    expect(walk.durationMs).toBe(3000);
    expect(facesLeft(walk)).toBe(false);
  });
});

describe("positionAt", () => {
  const walk = { from: { x: 0, y: 0 }, to: { x: 100, y: 50 }, durationMs: 1000 };
  it("interpolates linearly and ends exactly on target", () => {
    expect(positionAt(walk, 0)).toEqual({ x: 0, y: 0 });
    expect(positionAt(walk, 500)).toEqual({ x: 50, y: 25 });
    expect(positionAt(walk, 1000)).toEqual({ x: 100, y: 50 });
    expect(positionAt(walk, 99999)).toEqual({ x: 100, y: 50 });
    expect(positionAt(walk, -5)).toEqual({ x: 0, y: 0 });
  });
  it("handles zero-length walks", () => {
    expect(positionAt({ ...walk, durationMs: 0 }, 0)).toEqual(walk.to);
  });
  it("faces left when walking left", () => {
    expect(facesLeft({ from: { x: 10, y: 0 }, to: { x: 0, y: 0 }, durationMs: 1 })).toBe(true);
  });
});
