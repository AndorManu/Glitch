// The paw-print overlay: a transparent, click-through window over the work
// area (src-tauri/src/chaos.rs). Draws the prints Glitch leaves behind after
// stepping in glitch, fades them over ~20 s at 4 redraws per second, and
// asks Rust to hide the window when the last one is gone. No frame loop.

import { listen } from "@tauri-apps/api/event";
import { chaosApi } from "../shared/ipc";
import { PAW_CELLS, PAW_FPS, PAW_PX, pawAlpha, type PawPrint, prune } from "./paws";

const canvas = document.getElementById("paws") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
let paws: PawPrint[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function fit(): void {
  const dpr = devicePixelRatio || 1;
  const w = Math.round(innerWidth * dpr);
  const h = Math.round(innerHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function draw(): void {
  timer = null;
  const now = performance.now();
  paws = prune(paws, now);
  fit();
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  for (const p of paws) {
    const a = pawAlpha(p, now);
    ctx.save();
    ctx.translate(Math.round(p.x), Math.round(p.y));
    ctx.rotate((p.angle * Math.PI) / 180);
    // Left/right feet a little apart, toes pointing up from the surface.
    ctx.translate(p.left ? -5 : 5, -PAW_PX - 1);
    for (const [cx, cy] of PAW_CELLS) {
      ctx.fillStyle = `rgba(41, 241, 255, ${(a * 0.5).toFixed(3)})`;
      ctx.fillRect(cx * PAW_PX - 1, cy * PAW_PX, PAW_PX, PAW_PX);
      ctx.fillStyle = `rgba(255, 43, 214, ${a.toFixed(3)})`;
      ctx.fillRect(cx * PAW_PX, cy * PAW_PX, PAW_PX, PAW_PX);
    }
    ctx.restore();
  }
  if (paws.length) timer = setTimeout(draw, 1000 / PAW_FPS);
  else void chaosApi.pawsIdle().catch(() => {});
}

void listen<Omit<PawPrint, "born">[]>("paws", (e) => {
  const now = performance.now();
  for (const p of e.payload) paws.push({ ...p, born: now });
  if (timer !== null) clearTimeout(timer);
  draw();
});
