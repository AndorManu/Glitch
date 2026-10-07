import { describe, expect, it } from "vitest";
import { capSpeed, Pendulum, VelocityTracker } from "./drag";
import { mulberry32 } from "./glitchfx";

describe("throw velocity", () => {
  it("measures a steady drag at 60 Hz", () => {
    const t = new VelocityTracker();
    for (let i = 0; i <= 30; i++) t.add(i * 16.7, { x: 100 + i * 20, y: 300 - i * 10 });
    const v = t.velocity(30 * 16.7);
    expect(v.x).toBeCloseTo(20 / 0.0167, -1);
    expect(v.y).toBeCloseTo(-10 / 0.0167, -1);
  });

  it("only the last ~80 ms count: a flick at the end throws, a pause before release doesn't", () => {
    const flick = new VelocityTracker();
    for (let i = 0; i < 40; i++) flick.add(i * 16, { x: 500, y: 500 }); // held still
    for (let i = 40; i < 46; i++) flick.add(i * 16, { x: 500 + (i - 39) * 40, y: 500 }); // flick
    expect(flick.velocity(45 * 16).x).toBeGreaterThan(2000);

    const pause = new VelocityTracker();
    for (let i = 0; i < 40; i++) pause.add(i * 16, { x: i * 40, y: 0 }); // fast
    for (let i = 40; i < 50; i++) pause.add(i * 16, { x: 39 * 40, y: 0 }); // stopped 160 ms
    expect(Math.abs(pause.velocity(49 * 16).x)).toBeLessThan(1);
  });

  it("smooths jittery samples (least squares)", () => {
    const r = mulberry32(5);
    const t = new VelocityTracker();
    for (let i = 0; i <= 10; i++) t.add(i * 16 + (r() - 0.5) * 4, { x: i * 16 * 1.5 + (r() - 0.5) * 6, y: 0 });
    expect(t.velocity(160).x).toBeGreaterThan(1200);
    expect(t.velocity(160).x).toBeLessThan(1800);
  });

  it("no samples, or one: no throw", () => {
    const t = new VelocityTracker();
    expect(t.velocity(0)).toEqual({ x: 0, y: 0 });
    t.add(0, { x: 5, y: 5 });
    expect(t.velocity(1)).toEqual({ x: 0, y: 0 });
  });

  it("caps the throw speed, keeping the direction", () => {
    const v = capSpeed({ x: 3000, y: 4000 }, 1000);
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(1000, 6);
    expect(v.x / v.y).toBeCloseTo(0.75, 6);
    expect(capSpeed({ x: 1, y: 1 }, 10)).toEqual({ x: 1, y: 1 });
  });
});

describe("pendulum", () => {
  it("swings and settles hanging straight down", () => {
    const p = new Pendulum(0.9, 60, 2600);
    let crossed = false;
    for (let i = 0; i < 240; i++) {
      p.step(1 / 60, { x: 0, y: 0 });
      if (p.phi < 0) crossed = true;
    }
    expect(crossed).toBe(true); // it swung past the bottom
    expect(Math.abs(p.phi)).toBeLessThan(0.02);
  });

  it("dragging the pivot right makes him swing back to the left (he lags behind)", () => {
    const p = new Pendulum(0, 60, 2600);
    for (let i = 0; i < 6; i++) p.step(1 / 60, { x: 20000, y: 0 });
    expect(p.phi).toBeLessThan(-0.1);
  });

  it("held by the feet he tips over and hangs upside down", () => {
    const p = new Pendulum(Math.PI - 0.05, 40, 2600);
    for (let i = 0; i < 400; i++) p.step(1 / 60, { x: 0, y: 0 });
    expect(Math.abs(p.phi)).toBeLessThan(0.05);
  });

  it("tip velocity is tangential", () => {
    const p = new Pendulum(0, 50, 2600);
    p.omega = 2;
    expect(p.tipVelocity(50)).toEqual({ x: 100, y: -0 });
  });
});
