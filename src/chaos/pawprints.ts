// The paw-print overlay: a transparent, click-through window over the work
// area (src-tauri/src/chaos.rs). Draws Glitch's glitchy pixel paw prints:
// a bright stamp with an RGB split, a calm hold, then the print corrupts
// (rows slip, colours drift purple) and dissolves pixel by pixel, the last
// bits drifting up. 10 redraws/s only while something changes, 4/s while
// prints just sit there, none when the last one is gone. No frame loop.

import { listen } from "@tauri-apps/api/event";
import { chaosApi } from "../shared/ipc";
import { busy, hash, PAW_ART, PAW_COLORS, PAW_FPS, PAW_FPS_ACTIVE, PAW_PX, type PawPrint, pawState, prune, variation } from "./paws";

const canvas = document.getElementById("paws") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
let paws: PawPrint[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let dpr = 1;

function fit(): void {
  dpr = devicePixelRatio || 1;
  const w = Math.round(innerWidth * dpr);
  const h = Math.round(innerHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
}

function rgb([r, g, b]: [number, number, number], drift: number, tone: number, a: number): string {
  // Drift toward a cold glitch violet as the print ages.
  const tr = Math.round((r + (120 - r) * drift * 0.6) * tone);
  const tg = Math.round((g + (40 - g) * drift * 0.6) * tone);
  const tb = Math.round(b + (255 - b) * drift * 0.5);
  return `rgba(${tr},${tg},${tb},${a.toFixed(3)})`;
}

function drawPaw(p: PawPrint, now: number): void {
  const s = pawState(p, now);
  if (s.phase === "gone") return;
  const v = variation(p);
  // One art pixel in device px, whole pixels only so it stays crisp.
  const px = Math.max(1, Math.round(PAW_PX * dpr * v.scale * (1 + s.pop * 0.25)));
  const angle = ((p.angle + v.tilt) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // Left and right feet step a little apart and one slightly ahead, like a real trail.
  const side = p.left ? -1 : 1;
  const ox = Math.round((p.x + side * 4) * dpr);
  const oy = Math.round((p.y - (p.left ? 2 : 0)) * dpr);
  const age = now - p.born;
  // Occasional row slips while corrupting (stable per 300 ms window, not a flicker every frame).
  const slipSeed = Math.floor(age / 300);
  for (const cell of PAW_ART) {
    const r = hash(p.x + cell.x * 31, p.y + cell.y * 17, 7);
    if (r > s.keep) continue; // dissolved
    let dx = 0;
    let dy = 0;
    if (s.phase === "dissolve") {
      if (hash(cell.y, slipSeed, Math.round(p.x)) < s.drift * 0.25) dx = (hash(cell.y, slipSeed, 9) < 0.5 ? -1 : 1) * Math.ceil(s.drift * 2);
      // The last pixels to go float upward a little.
      if (r > s.keep - 0.15) dy = -Math.round((1 - s.keep) * 4);
    }
    const lx = (cell.x + dx) * px;
    const ly = (cell.y + dy) * px;
    const x = Math.round(ox + lx * cos - ly * sin);
    const y = Math.round(oy + lx * sin + ly * cos);
    const base = PAW_COLORS[cell.c];
    if (s.pop > 0 && cell.c !== "o") {
      // Stamp: chromatic split, cyan left / hot magenta right.
      ctx.fillStyle = `rgba(41,241,255,${(0.55 * s.pop).toFixed(3)})`;
      ctx.fillRect(x - px, y, px, px);
    }
    ctx.fillStyle = rgb(base, s.drift, v.tone, s.alpha * (cell.c === "o" ? 0.85 : 1));
    ctx.fillRect(x, y, px, px);
  }
}

function draw(): void {
  timer = null;
  const now = performance.now();
  paws = prune(paws, now);
  fit();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const p of paws) drawPaw(p, now);
  if (paws.length) timer = setTimeout(draw, 1000 / (busy(paws, now) ? PAW_FPS_ACTIVE : PAW_FPS));
  else void chaosApi.pawsIdle().catch(() => {});
}

void listen<Omit<PawPrint, "born">[]>("paws", (e) => {
  const now = performance.now();
  for (const p of e.payload) paws.push({ ...p, born: now });
  if (timer !== null) clearTimeout(timer);
  draw();
});
