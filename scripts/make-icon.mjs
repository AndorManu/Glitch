// Renders the placeholder sprite into a 1024x1024 PNG used as the source for
// `npx tauri icon` (which generates every icon size in src-tauri/icons).
//   node scripts/make-icon.mjs && npx tauri icon src-tauri/icons/source.png
// Replace source.png with real art later and re-run the second command.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { GLITCH } from "../src/sprites/glitch.ts";

const SIZE = 1024;
const SCALE = 56; // 16 * 56 = 896
const rows = GLITCH.frames.idle0;
const pad = (SIZE - 16 * SCALE) / 2;
const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const gx = Math.floor((x - pad) / SCALE);
    const gy = Math.floor((y - pad) / SCALE);
    const ch = rows[gy]?.[gx];
    if (!ch || ch === "." || x < pad || y < pad) continue;
    const [r, g, b] = hex(GLITCH.palette[ch]);
    raw.set([r, g, b, 255], y * (SIZE * 4 + 1) + 1 + x * 4);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(new URL("../src-tauri/icons/source.png", import.meta.url), png);
console.log("wrote src-tauri/icons/source.png");
