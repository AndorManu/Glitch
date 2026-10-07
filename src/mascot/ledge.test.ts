import { describe, expect, it } from "vitest";
import { HOLD_ON_PX, reactToMove } from "./ledge";
import type { World } from "./physics";

const world: World = { area: { x: 0, y: 0, w: 1920, h: 1040 }, scale: 1, ledges: [] };
const R = { x: 500, y: 400, w: 600, h: 400 };
const at = (dx: number, dy: number, w = R.w) => ({ ...R, x: R.x + dx, y: R.y + dy, w });

describe("ledge: ride along or fall", () => {
  it("rides along small, slow moves", () => {
    expect(reactToMove(R, at(8, 0), 33, world, 800, null)).toEqual({ kind: "ride", dx: 8, dy: 0 });
    expect(reactToMove(R, at(-5, -4), 33, world, 800, null)).toEqual({ kind: "ride", dx: -5, dy: -4 });
    expect(reactToMove(R, R, 33, world, 800, null).kind).toBe("none");
  });

  it("falls when the window is yanked away sideways, dropped away, or jumps", () => {
    expect(reactToMove(R, at(60, 0), 33, world, 800, null)).toMatchObject({ kind: "fall", why: "slip" });
    expect(reactToMove(R, at(0, 40), 33, world, 800, null)).toMatchObject({ kind: "fall", why: "drop" });
    expect(reactToMove(R, at(0, -120), 33, world, 800, null)).toMatchObject({ kind: "fall", why: "jump" });
    // Snapshots seconds apart: a slow 100 px move is ridden, a 600 px one is not.
    expect(reactToMove(R, at(-100, -30), 2500, world, 800, null).kind).toBe("ride");
    expect(reactToMove(R, at(600, 0), 2500, world, 800, null)).toMatchObject({ kind: "fall", why: "jump" });
    // Moving up he holds on (pushed up), unless it's a jump.
    expect(reactToMove(R, at(0, -20), 33, world, 800, null).kind).toBe("ride");
  });

  it("holds on for a while when the user drags it slowly, then slips off", () => {
    expect(reactToMove(R, at(10, 0), 33, world, 800, 0).kind).toBe("ride");
    expect(reactToMove(R, at(10, 0), 33, world, 800, HOLD_ON_PX - 5)).toMatchObject({ kind: "fall", why: "dragged" });
  });

  it("falls when there's no room above any more, or it got too narrow under him", () => {
    expect(reactToMove({ ...R, y: 70 }, { ...R, y: 50 }, 33, world, 800, null)).toMatchObject({ kind: "fall", why: "no-room" });
    expect(reactToMove(R, at(0, 0, 200), 33, world, 800, null)).toMatchObject({ kind: "fall", why: "off" });
  });

  it("a fall carries a little of the window's motion, never wild", () => {
    const r = reactToMove(R, at(80, 0), 16, world, 800, null);
    expect(r.kind).toBe("fall");
    if (r.kind === "fall") {
      expect(r.v.x).toBeGreaterThan(0);
      expect(r.v.x).toBeLessThanOrEqual(600);
      expect(r.v.y).toBe(0);
    }
  });
});
