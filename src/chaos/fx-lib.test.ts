import { describe, expect, it } from "vitest";
import {
  cloneFrame,
  FLASHES,
  flashesOk,
  ghostCopies,
  lineAt,
  MAX_RAIN_ALPHA,
  MAX_SCAN_ALPHA,
  MELT_COLUMN,
  meltColumns,
  meltOffset,
  rainAlpha,
  rainColumns,
  scanAlpha,
  scanSweepY,
  snapHalves,
  spawnBugs,
  spawnClones,
  stepBug,
  stepClone,
  SWARM_MS,
} from "./fx-lib";

describe("hook line", () => {
  const rod = { x: 100, y: 300 };
  const cursor = { x: 400, y: 200 };

  it("starts exactly at the rod tip and the reeled line ends on the cursor", () => {
    for (const [phase, t] of [
      ["cast", 300],
      ["reel", 1000],
      ["release", 100],
    ] as const) {
      const l = lineAt(phase, t, rod, cursor, 900);
      expect(l.pts[0]).toEqual(rod);
    }
    const reel = lineAt("reel", 500, rod, cursor, 900);
    expect(reel.pts.at(-1)).toEqual(cursor);
    expect(reel.hook).toEqual(cursor);
  });

  it("the cast flies out and arrives; the release reels it back in", () => {
    expect(lineAt("cast", 0, rod, cursor, 900).reach).toBeCloseTo(0, 1);
    expect(lineAt("cast", 900, rod, cursor, 900).reach).toBe(1);
    const mid = lineAt("cast", 400, rod, cursor, 900);
    expect(mid.reach).toBeGreaterThan(0.2);
    expect(mid.reach).toBeLessThan(0.95);
    expect(lineAt("release", 0, rod, cursor, 900).reach).toBeCloseTo(1, 1);
    expect(lineAt("release", 450, rod, cursor, 900).reach).toBeLessThan(0.05);
    expect(lineAt("release", 450, rod, cursor, 900).hook).toBeNull();
  });

  it("a snapped line falls in two halves that still start at the rod and the cursor side", () => {
    const h = snapHalves(rod, cursor, 300);
    expect(h.a[0]).toEqual(rod);
    expect(h.b.at(-1)!.x).toBe(cursor.x);
    expect(h.a.at(-1)!.y).toBeGreaterThan(h.at.y - 1);
  });
});

describe("ghost cursor trail", () => {
  it("draws fainter copies further back and merges copies that sit on each other", () => {
    const hist = Array.from({ length: 40 }, (_, i) => ({ p: { x: i * 10, y: 100 }, t: i * 25 }));
    const g = ghostCopies(hist, 1000);
    expect(g.length).toBeGreaterThan(3);
    for (let i = 1; i < g.length; i++) expect(g[i].alpha).toBeLessThan(g[i - 1].alpha);
    expect(Math.max(...g.map((x) => x.alpha))).toBeLessThanOrEqual(0.5);
    const still = Array.from({ length: 40 }, (_, i) => ({ p: { x: 50, y: 50 }, t: i * 25 }));
    expect(ghostCopies(still, 1000).length).toBe(1);
    expect(ghostCopies([], 1000)).toEqual([]);
  });
});

describe("screen effects stay gentle", () => {
  it("matrix rain is low opacity, fades in and out, and is sparse", () => {
    const total = 5000;
    let peak = 0;
    for (let t = 0; t <= total; t += 50) peak = Math.max(peak, rainAlpha(t, total));
    expect(peak).toBeLessThanOrEqual(MAX_RAIN_ALPHA);
    expect(peak).toBeGreaterThan(0.1);
    expect(rainAlpha(0, total)).toBe(0);
    expect(rainAlpha(total, total)).toBe(0);
    const cols = rainColumns(1920, 3);
    expect(cols.length).toBeGreaterThan(10);
    expect(cols.length).toBeLessThan(1920 / 16);
  });

  it("the scanline sweep is faint, passes once top to bottom and never jumps", () => {
    const total = 3500;
    let prev = scanSweepY(0, total, 1000);
    for (let t = 50; t <= total; t += 50) {
      const y = scanSweepY(t, total, 1000);
      expect(y).toBeGreaterThanOrEqual(prev);
      expect(y - prev).toBeLessThan(40);
      expect(scanAlpha(t, total)).toBeLessThanOrEqual(MAX_SCAN_ALPHA);
      prev = y;
    }
    expect(scanSweepY(0, total, 1000)).toBeLessThan(0);
    expect(scanSweepY(total, total, 1000)).toBeGreaterThan(1000);
  });

  it("the melt drips every column a different bit, smoothly, and never off the screen", () => {
    const n = Math.ceil(1920 / MELT_COLUMN);
    const cols = meltColumns(n, 4);
    expect(new Set(cols.map((c) => c.delay)).size).toBeGreaterThan(n / 4);
    const total = 5500;
    for (const c of cols) {
      let prev = 0;
      for (let t = 0; t <= total; t += 100) {
        const o = meltOffset(c, t, 1000, total);
        expect(o).toBeGreaterThanOrEqual(prev);
        expect(o).toBeLessThanOrEqual(0.62 * 1000 + 1);
        prev = o;
      }
      expect(meltOffset(c, 0, 1000, total)).toBe(0);
    }
  });
});

describe("bugs and clones", () => {
  it("bugs crawl from the window's ends towards its middle and stay on its top", () => {
    const top = { x0: 200, x1: 800, y: 300 };
    const bugs = spawnBugs(top, 5);
    expect(bugs.length).toBe(5);
    for (const b of bugs) {
      expect(b.y).toBe(300);
      expect(b.x).toBeGreaterThanOrEqual(200);
      expect(b.x).toBeLessThanOrEqual(800);
    }
    for (let t = 0; t < 12_000; t += 50) for (const b of bugs) stepBug(b, 500, 0.05, t);
    for (const b of bugs) expect(Math.abs(b.x - 500)).toBeLessThan(40);
  });

  it("clones bounce inside the screen, pop-in then run then pop, and are gone by the end", () => {
    const cs = spawnClones(1920, 9);
    expect(cs.length).toBeGreaterThanOrEqual(5);
    for (let i = 0; i < 400; i++) for (const c of cs) stepClone(c, 1920, 0.02);
    for (const c of cs) {
      expect(c.x).toBeGreaterThanOrEqual(20);
      expect(c.x).toBeLessThanOrEqual(1900);
      expect(c.popAt).toBeLessThan(SWARM_MS);
      expect(cloneFrame(c.popAt + 400, c.popAt).alpha).toBe(0);
    }
    expect(cloneFrame(-5, 7000).name).toBe("");
    expect(cloneFrame(100, 7000).name).toMatch(/^clone_pop/);
    expect(cloneFrame(2000, 7000).name).toMatch(/^walk[0-7]$/);
    expect(cloneFrame(7100, 7000).name).toMatch(/^clone_pop/);
  });
});

describe("flash rate (WCAG 2.3.1)", () => {
  it("nothing flashes more than three times in any second", () => {
    expect(flashesOk([0, 333, 666])).toBe(true);
    expect(flashesOk([0, 200, 400, 600])).toBe(false);
    for (const [name, times] of Object.entries(FLASHES)) expect(flashesOk(times), name).toBe(true);
    // Even every flash of every effect laid end to end, as long as each effect is spaced by its own schedule.
    expect(flashesOk([...FLASHES.hops])).toBe(true);
    expect(flashesOk([...FLASHES.swarmPops])).toBe(true);
  });

  it("the hop sparks match the cursor hops Rust schedules", () => {
    // crates/glitch-core/src/chaos2.rs HOP_TIMES
    expect([...FLASHES.hops]).toEqual([500, 1300, 2200, 3000, 3900]);
  });
});
