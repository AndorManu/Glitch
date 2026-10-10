// The packed sheet itself: no frame bleeds into its neighbour (visual QA S2-1:
// a dark dash on the top row of 11 frames, outline closed across the cell edge).

import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ANIM_FRAME_H, ANIM_FRAME_W, ANIM_INDEX } from "./anim";

/** Minimal PNG decoder for the 8-bit RGBA, non-interlaced sheet. */
function decodePng(buf: Buffer): { w: number; h: number; px: Uint8Array } {
  let pos = 8;
  let w = 0;
  let h = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      expect(data[8]).toBe(8);
      expect(data[9]).toBe(6);
    } else if (type === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(w * h * 4);
  const stride = w * 4;
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? px[y * stride + x - 4] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? px[(y - 1) * stride + x - 4] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 255;
    }
  }
  return { w, h, px };
}

describe("packed sprite sheet", () => {
  it("no frame has a stray bit on its top row (bleed from the cell above)", () => {
    const { w, px } = decodePng(readFileSync(new URL("../../public/sprites/glitch-anim.png", import.meta.url)));
    const cols = Math.floor(w / ANIM_FRAME_W);
    const bad: string[] = [];
    for (const [name, i] of Object.entries(ANIM_INDEX)) {
      const x0 = (i % cols) * ANIM_FRAME_W;
      const y0 = Math.floor(i / cols) * ANIM_FRAME_H;
      let top = 0;
      for (let x = 0; x < ANIM_FRAME_W; x++) if (px[(y0 * w + x0 + x) * 4 + 3] > 0) top++;
      // A whole frame reaching the top (a tail, arms up) is fine; a 1-row dash of a few pixels is not.
      let below = 0;
      for (let x = 0; x < ANIM_FRAME_W; x++) if (px[((y0 + 1) * w + x0 + x) * 4 + 3] > 0) below++;
      if (top > 0 && below === 0) bad.push(`${name} (${top} px)`);
    }
    expect(bad).toEqual([]);
  });
});
