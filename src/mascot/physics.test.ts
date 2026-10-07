import { describe, expect, it } from "vitest";
import { mulberry32 } from "./glitchfx";
import {
  anchor,
  type Body,
  centerFor,
  clampTo,
  cornerAt,
  facesLeftFor,
  feetInWindow,
  FEET_MARGIN,
  FLOOR,
  HALF,
  PHYS,
  planJump,
  restCenter,
  stepAir,
  type Surface,
  surfaceAngle,
  surfaceRange,
  WIN,
  windowFor,
  type World,
} from "./physics";

const world = (scale = 1, ledges: World["ledges"] = []): World => ({ area: { x: 0, y: 0, w: 1920 * scale, h: 1040 * scale }, scale, ledges });
const body = (x: number, y: number, vx = 0, vy = 0): Body => ({ x, y, vx, vy, angle: 0, spin: 0 });

/** Fly until something lands (or time runs out). */
function fly(b: Body, w: World, seconds: number, dt = 1 / 60, opts = {}) {
  const contacts = [];
  for (let t = 0; t < seconds; t += dt) {
    const c = stepAir(b, w, dt, { airTime: t, ...opts });
    contacts.push(...c);
    if (c.some((x) => x.kind === "land")) break;
  }
  return contacts;
}

describe("flight", () => {
  it("falls with gravity (y = g t^2 / 2) and drag-free flights keep their sideways speed", () => {
    const w = world();
    const b = body(500, 100, 200, 0);
    stepAir(b, w, 0.2);
    expect(b.y - 100).toBeCloseTo((PHYS.gravity * 0.2 * 0.2) / 2, -1);
    expect(b.vy).toBeCloseTo(PHYS.gravity * 0.2, 5);
    expect(b.x).toBeCloseTo(540, 5);
  });

  it("gravity and speeds scale with the display (physical px)", () => {
    const b1 = body(500, 100);
    const b2 = body(1000, 200);
    stepAir(b1, world(1), 0.25);
    stepAir(b2, world(2), 0.25);
    expect(b2.y - 200).toBeCloseTo(2 * (b1.y - 100), 5);
  });

  it("lands on the floor, at rest, standing", () => {
    const w = world();
    const b = body(800, 300);
    const contacts = fly(b, w, 3);
    const land = contacts.find((c) => c.kind === "land")!;
    expect(land).toBeDefined();
    expect(land.kind === "land" && land.surface.kind).toBe("floor");
    expect(b.y).toBe(restCenter(FLOOR, 800, w).y);
    expect(b.y + HALF).toBe(1040); // feet on the bottom of the work area
    expect(b.vx).toBe(0);
    expect(b.vy).toBe(0);
  });

  it("a hard landing bounces a little first, unless it may splat", () => {
    const w = world();
    const a = body(800, 100, 0, 1500);
    const bounced = fly(a, w, 3);
    expect(bounced[0].kind).toBe("bounce");
    expect(bounced[bounced.length - 1].kind).toBe("land");
    const s = body(800, 100, 0, 3000);
    const splat = fly(s, w, 3, 1 / 60, { canSplat: true });
    expect(splat).toHaveLength(1);
    expect(splat[0].kind === "land" && splat[0].speed).toBeGreaterThan(PHYS.splat);
  });

  it("bounces off walls and the ceiling and always stays inside the work area", () => {
    for (const scale of [1, 1.5]) {
      const w = world(scale, [{ id: 1, x: 300 * scale, y: 600 * scale, w: 500 * scale }]);
      const r = mulberry32(42);
      for (let i = 0; i < 200; i++) {
        const b = body((200 + r() * 1500) * scale, (200 + r() * 600) * scale, (r() - 0.5) * 9000 * scale, (r() - 0.7) * 9000 * scale);
        b.spin = (r() - 0.5) * 2000;
        let bounces = 0;
        for (let t = 0; t < 6; t += 1 / 60) {
          const c = stepAir(b, w, 1 / 60, { drag: true, canSplat: r() < 0.5, airTime: t });
          bounces += c.filter((x) => x.kind === "bounce").length;
          const half = HALF * scale;
          expect(b.x).toBeGreaterThanOrEqual(w.area.x + half - 1e-6);
          expect(b.x).toBeLessThanOrEqual(w.area.x + w.area.w - half + 1e-6);
          expect(b.y).toBeGreaterThanOrEqual(w.area.y + half - 1e-6);
          expect(b.y).toBeLessThanOrEqual(w.area.y + w.area.h - half + 1e-6);
          if (c.some((x) => x.kind === "land")) break;
        }
        expect(bounces).toBeLessThan(40); // damping: it settles
      }
    }
  });

  it("walls reflect and damp", () => {
    const w = world();
    const b = body(100, 500, -2000, 0);
    const c = stepAir(b, w, 0.1);
    expect(c[0]).toMatchObject({ kind: "bounce", side: "left" });
    expect(b.vx).toBeGreaterThan(0);
    expect(b.vx).toBeLessThan(2000);
  });

  it("lands on a window top only when coming down onto it from above, within its x-range", () => {
    const top = { id: 7, x: 400, y: 600, w: 300 };
    const w = world(1, [top]);
    // From above, inside: lands on it.
    const a = body(550, 300);
    const ca = fly(a, w, 3);
    expect(ca.at(-1)).toMatchObject({ kind: "land", surface: { kind: "ledge", ledge: { id: 7 } } });
    expect(a.y + HALF).toBe(600);
    // Outside its x-range: falls past to the floor.
    const b = body(800, 300);
    expect(fly(b, w, 3).at(-1)).toMatchObject({ kind: "land", surface: { kind: "floor" } });
    // Jumping up through it from below: passes, then lands on it on the way down.
    const c = body(550, 900, 0, -1700);
    const cc = fly(c, w, 3);
    expect(cc.at(-1)).toMatchObject({ kind: "land", surface: { kind: "ledge" } });
    // Rising from below without reaching it: lands back on the floor.
    const d = body(550, 1000, 0, -600);
    expect(fly(d, w, 3).at(-1)).toMatchObject({ kind: "land", surface: { kind: "floor" } });
  });

  it("never tunnels through a thin window top, whatever the speed or frame time", () => {
    const top = { id: 3, x: 500, y: 700, w: 60 };
    const w = world(1, [top]);
    for (const dt of [1 / 120, 1 / 60, 1 / 20, 0.1]) {
      for (const vy of [500, 3000, PHYS.maxSpeed, 99999]) {
        const b = body(530, 200, 0, vy);
        const c = fly(b, w, 2, dt);
        expect(c.at(-1), `dt ${dt} vy ${vy}`).toMatchObject({ kind: "land", surface: { kind: "ledge" } });
        expect(b.y + HALF).toBe(700);
      }
      // Diagonal: crosses the top's x-range only for a moment.
      const b = body(300, 400, 1200, 1400);
      const hit = fly(b, w, 2, dt).at(-1);
      // Wherever it crosses y=700 decides; the swept test must agree with the straight-line crossing.
      expect(hit?.kind).toBe("land");
    }
  });

  it("spins down and rights itself in the air (cat reflex)", () => {
    const w = world();
    const b = body(900, 200, 0, -800);
    b.spin = 700;
    for (let t = 0; t < 4; t += 1 / 60) stepAir(b, w, 1 / 60, { airTime: t, extra: [] });
    expect(Math.abs(b.angle - Math.round(b.angle / 360) * 360)).toBeLessThan(15);
  });
});

describe("jump planning", () => {
  it("plans an arc that lands on the target window top", () => {
    const top = { id: 9, x: 900, y: 700, w: 400 };
    const w = world(1, [top]);
    const from = restCenter(FLOOR, 700, w);
    const to = restCenter({ kind: "ledge", ledge: top }, 1000, w);
    const plan = planJump(from, to, w)!;
    expect(plan).not.toBeNull();
    const b = body(from.x, from.y, plan.vx, plan.vy);
    const c = fly(b, w, 3, 1 / 60);
    expect(c.at(-1)).toMatchObject({ kind: "land", surface: { kind: "ledge", ledge: { id: 9 } } });
    expect(Math.abs(b.x - to.x)).toBeLessThan(4);
  });

  it("refuses jumps that are too high, too far, or into the ceiling", () => {
    const w = world();
    const from = restCenter(FLOOR, 500, w);
    expect(planJump(from, { x: 600, y: from.y - 900 }, w)).toBeNull(); // too high
    expect(planJump(from, { x: 1900, y: from.y - 100 }, w)).toBeNull(); // too far
    expect(planJump(from, { x: 520, y: 60 }, { ...w, area: { ...w.area, h: 500 } })).toBeNull();
  });
});

describe("body <-> window mapping", () => {
  const surfaces: Surface[] = [{ kind: "floor" }, { kind: "left" }, { kind: "ceiling" }, { kind: "right" }, { kind: "ledge", ledge: { id: 1, x: 300, y: 500, w: 600 } }];
  // Where the feet must be inside the 160x160 window (CSS px).
  const feetAt: Record<string, [number, number]> = {
    floor: [WIN / 2, WIN - FEET_MARGIN],
    ledge: [WIN / 2, WIN - FEET_MARGIN],
    left: [FEET_MARGIN, WIN / 2],
    ceiling: [WIN / 2, FEET_MARGIN],
    right: [WIN - FEET_MARGIN, WIN / 2],
  };

  for (const scale of [1, 1.25, 2]) {
    it(`puts the feet against the window edge they point at, every orientation (scale ${scale})`, () => {
      const w = world(scale);
      for (const s of surfaces) {
        const surface = s.kind === "ledge" ? { kind: "ledge" as const, ledge: { id: 1, x: 300 * scale, y: 500 * scale, w: 600 * scale } } : s;
        const [lo, hi] = surfaceRange(surface, w);
        for (const at of [lo, (lo + hi) / 2, hi]) {
          const c = restCenter(surface, at, w);
          const angle = surfaceAngle(surface.kind);
          const win = windowFor(c, angle, 1, scale);
          const feet = feetInWindow(c, win, angle, scale);
          expect(feet.x, `${surface.kind} x`).toBeCloseTo(feetAt[surface.kind][0], 0);
          expect(feet.y, `${surface.kind} y`).toBeCloseTo(feetAt[surface.kind][1], 0);
          // The inverse mapping recovers the (rounded) centre.
          const back = centerFor(win, angle, 1, scale);
          expect(Math.abs(back.x - Math.round(c.x))).toBeLessThanOrEqual(0);
          expect(Math.abs(back.y - Math.round(c.y))).toBeLessThanOrEqual(0);
          // Physical feet position = surface line.
          const fx = win.x + feet.x * scale;
          const fy = win.y + feet.y * scale;
          if (surface.kind === "floor") expect(fy).toBeCloseTo(w.area.y + w.area.h, 0);
          if (surface.kind === "ceiling") expect(fy).toBeCloseTo(w.area.y, 0);
          if (surface.kind === "left") expect(fx).toBeCloseTo(w.area.x, 0);
          if (surface.kind === "right") expect(fx).toBeCloseTo(w.area.x + w.area.w, 0);
          if (surface.kind === "ledge") expect(fy).toBeCloseTo(surface.ledge.y, 0);
        }
      }
    });
  }

  it("flying: the body is centred so any spin stays inside the window", () => {
    for (const angle of [0, 37, 90, 180, -135, 400]) {
      const a = anchor(angle, 0);
      expect(a).toEqual({ x: WIN / 2, y: WIN / 2 });
    }
    // Standing anchors keep the whole body inside the window (feet 40 below centre, head 50 above).
    for (const angle of [0, 90, 180, -90]) {
      const a = anchor(angle, 1);
      for (const [dx, dy] of [[0, HALF], [0, -50]]) {
        const r = (angle * Math.PI) / 180;
        const x = a.x + dx * Math.cos(r) - dy * Math.sin(r);
        const y = a.y + dx * Math.sin(r) + dy * Math.cos(r);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(WIN);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(WIN);
      }
    }
  });

  it("the screen edges form one loop of corners, and the facing carries round it", () => {
    const w = world();
    // Walking left along the floor, up the left wall, right along the ceiling, down the right wall.
    let s: Surface = FLOOR;
    let dir = -1;
    const facing = facesLeftFor("floor", -1);
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      const next = cornerAt(s, dir < 0 ? -1 : 1, w)!;
      seen.push(next.surface.kind);
      const [lo, hi] = surfaceRange(next.surface, w);
      // Arrive at an end, continue away from it.
      dir = next.s === lo ? 1 : -1;
      expect(next.s === lo || next.s === hi).toBe(true);
      expect(facesLeftFor(next.surface.kind, dir), next.surface.kind).toBe(facing);
      s = next.surface;
    }
    expect(seen).toEqual(["left", "ceiling", "right", "floor"]);
    expect(cornerAt({ kind: "ledge", ledge: { id: 1, x: 0, y: 500, w: 300 } }, 1, w)).toBeNull();
  });

  it("clamps positions onto a surface, and a tiny window top still has one spot", () => {
    const w = world();
    expect(clampTo(FLOOR, -50, w)).toBe(surfaceRange(FLOOR, w)[0]);
    const tiny: Surface = { kind: "ledge", ledge: { id: 1, x: 500, y: 500, w: 10 } };
    const [lo, hi] = surfaceRange(tiny, w);
    expect(lo).toBe(hi);
    expect(lo).toBe(505);
  });
});
