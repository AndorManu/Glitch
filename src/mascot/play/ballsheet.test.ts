import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BALL_R } from "./rules";

// public/sprites/ball.png is made by scripts/slice-ball.py: 13 square cells
// side by side (0-7 roll loop, 8 squash, 9 stretch, 10 glitch, 11 glow, 12 the
// ball in his mouth), drawn 1:1 on the play overlay.
describe("the sliced ball sheet", () => {
  const png = readFileSync(new URL("../../../public/sprites/ball.png", import.meta.url));
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);

  it("is 13 square cells", () => {
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(w).toBe(h * 13);
  });

  it("draws a ball about as big as its physics radius", () => {
    // The roll frames hold a ~23 art px body; at 1 CSS px per art px that is 2 * BALL_R.
    expect(Math.abs(23 - 2 * BALL_R)).toBeLessThanOrEqual(2);
  });
});
