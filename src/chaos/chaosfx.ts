// The effects overlay: a transparent, click-through window over the work area
// (src-tauri/src/chaos2.rs). Draws the hook's line from Glitch's rod tip to the
// real cursor, the ghost cursor trail, matrix rain, the CRT scanline sweep, the
// melting screen, screen bugs and the swarm of mini clones. One animation loop
// that runs only while something is on screen; when the last effect ends the
// window asks Rust to hide it. Nothing here touches the system: it only paints.
// The melt's screenshot comes once from Rust (RAM only), is drawn as sliding
// columns and dropped when the effect ends.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { chaos2Api } from "../shared/ipc";
import { loadGlitchSprites } from "../sprites/glitch-sprites";
import { ANIM_FRAME_H, ANIM_FRAME_W } from "../sprites/anim";
import { ART_SCALE } from "../sprites/glitch-anim";
import type { SpriteSet } from "../sprites/types";
import {
  ARROW,
  type Bug,
  type Clone,
  cloneFrame,
  ghostCopies,
  type HookPhase,
  lineAt,
  type P,
  MELT_COLUMN,
  meltColumns,
  meltOffset,
  rainAlpha,
  rainColumns,
  RAIN_CELL,
  scanAlpha,
  scanSweepY,
  smooth,
  snapHalves,
  spawnBugs,
  spawnClones,
  stepBug,
  stepClone,
  SWARM_MS,
  SWARM_SCALE,
} from "./fx-lib";

const canvas = document.getElementById("fx") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
let dpr = 1;
let W = 0;
let H = 0;

/** Screen effects respect the OS animation setting; Rust checks "Reduce effects" too. */
const reduced = (): boolean => matchMedia("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------------ state

interface Hook {
  phase: HookPhase;
  t0: number;
  castMs: number;
  rod: P;
  cursor: P;
  /** Physical -> local conversion for rod events. */
  origin: [number, number];
  scale: number;
  sparks: { p: P; vx: number; vy: number; born: number }[];
}

let hook: Hook | null = null;
let cursorNow: P | null = null;
const history: { p: P; t: number }[] = [];
let trailUntil = 0;
let rain: { until: number; t0: number; cols: ReturnType<typeof rainColumns> } | null = null;
let scan: { until: number; t0: number } | null = null;
let melt: { until: number; t0: number; img: HTMLCanvasElement | null; cols: { delay: number; dist: number }[]; w: number; h: number } | null = null;
let bugs: { until: number; t0: number; list: Bug[]; tops: { x0: number; x1: number; y: number }[]; splats: { p: P; born: number; seed: number }[]; squashedAt: number | null } | null = null;
let swarm: { until: number; t0: number; list: Clone[]; floor: number } | null = null;
let pops: { rect: [number, number, number, number]; t0: number }[] = [];
let sprites: SpriteSet | null = null;
let timer: number | null = null;
let last = 0;

const now = (): number => performance.now();

function fit(): void {
  dpr = devicePixelRatio || 1;
  W = innerWidth;
  H = innerHeight;
  const w = Math.round(W * dpr);
  const h = Math.round(H * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

// ------------------------------------------------------------------ events

interface FxEvent {
  kind: string;
  phase?: HookPhase;
  rod?: [number, number];
  cursor?: [number, number];
  cast_ms?: number;
  origin?: [number, number];
  scale?: number;
  ms?: number;
  w?: number;
  h?: number;
  tops?: { id: number; x0: number; x1: number; y: number }[];
  seed?: number;
  at?: [number, number];
  rect?: [number, number, number, number];
  why?: string;
}

const pt = (a: [number, number] | undefined): P | null => (a ? { x: a[0], y: a[1] } : null);

function onEvent(e: FxEvent): void {
  fit();
  const t = now();
  switch (e.kind) {
    case "hook": {
      const rod = pt(e.rod) ?? hook?.rod;
      const cursor = pt(e.cursor) ?? hook?.cursor;
      if (!rod || !cursor || !e.phase) return;
      if (e.phase === "cast") {
        hook = { phase: "cast", t0: t, castMs: e.cast_ms ?? 900, rod, cursor, origin: e.origin ?? [0, 0], scale: e.scale ?? 1, sparks: [] };
      } else if (hook) {
        hook.phase = e.phase;
        hook.t0 = t;
        hook.cursor = cursor;
        if (e.phase === "snap") {
          // A small spark where the line breaks (one burst, a few pixels).
          const at = { x: rod.x + (cursor.x - rod.x) * 0.55, y: rod.y + (cursor.y - rod.y) * 0.55 };
          hook.sparks = Array.from({ length: 10 }, (_, i) => ({ p: at, vx: Math.cos(i * 0.63) * (60 + (i % 3) * 30), vy: Math.sin(i * 0.63) * (60 + (i % 3) * 30) - 40, born: t }));
        }
      }
      break;
    }
    case "cursor": {
      const c = pt(e.cursor);
      if (!c) return;
      cursorNow = c;
      history.push({ p: c, t });
      while (history.length > 120 || (history.length && t - history[0].t > 1200)) history.shift();
      if (hook && e.rod) hook.rod = pt(e.rod)!;
      if (hook) hook.cursor = c;
      break;
    }
    case "trail":
      if (!reduced()) trailUntil = t + (e.ms ?? 6000);
      break;
    case "matrix":
      if (!reduced()) rain = { until: t + (e.ms ?? 5000), t0: t, cols: rainColumns(W, e.seed ?? 1) };
      break;
    case "scanlines":
      if (!reduced()) scan = { until: t + (e.ms ?? 3500), t0: t };
      break;
    case "melt":
      if (!reduced()) void startMelt(e, t);
      break;
    case "bugs":
      if (!reduced() && e.tops?.length) {
        const tops = e.tops.slice(0, 4);
        bugs = { until: t + (e.ms ?? 9000), t0: t, list: tops.flatMap((top, i) => spawnBugs(top, (e.seed ?? 1) + i)), tops, splats: [], squashedAt: null };
      }
      break;
    case "squash":
      if (bugs && e.at) {
        const at = { x: e.at[0], y: e.at[1] };
        bugs.squashedAt = t;
        for (const b of bugs.list) {
          if (b.alive && Math.hypot(b.x - at.x, b.y - at.y) < 170) {
            b.alive = false;
            bugs.splats.push({ p: { x: b.x, y: b.y }, born: t, seed: b.seed });
          }
        }
      }
      break;
    case "swarm":
      if (!reduced()) swarm = { until: t + SWARM_MS + 700, t0: t, list: spawnClones(W, e.seed ?? 1), floor: H };
      break;
    case "pop":
      if (e.rect && !reduced()) pops.push({ rect: e.rect, t0: t });
      break;
    case "stop":
      stopAll();
      return;
  }
  ensureLoop();
}

function stopAll(): void {
  hook = null;
  trailUntil = 0;
  rain = scan = melt = bugs = swarm = null;
  pops = [];
  history.length = 0;
  cursorNow = null;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (timer !== null) clearTimeout(timer);
  timer = null;
  void chaos2Api.fxIdle().catch(() => {});
}

async function startMelt(e: FxEvent, t: number): Promise<void> {
  try {
    const buf = await invoke<ArrayBuffer>("chaos2_melt_frame");
    if (!buf || buf.byteLength < 16) return;
    const head = new DataView(buf, 0, 8);
    const w = head.getUint32(0, true);
    const h = head.getUint32(4, true);
    if (buf.byteLength < 8 + w * h * 4) return;
    const img = document.createElement("canvas");
    img.width = w;
    img.height = h;
    img.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(buf, 8, w * h * 4), w, h), 0, 0);
    const cols = Math.ceil((e.w ?? W) / MELT_COLUMN);
    melt = { until: t + (e.ms ?? 5500), t0: now(), img, cols: meltColumns(cols, e.seed ?? 3), w, h };
    ensureLoop();
  } catch {
    // The capture was refused or missing: no melt, nothing else happens.
  }
}

// ------------------------------------------------------------------ drawing

function ensureLoop(): void {
  if (timer !== null) return;
  last = now();
  timer = window.setTimeout(frame, 16);
  if (!sprites) {
    void loadGlitchSprites().then((s) => {
      sprites = s;
    });
  }
}

function active(t: number): boolean {
  return !!hook || t < trailUntil || !!rain || !!scan || !!melt || !!bugs || !!swarm || pops.length > 0;
}

function frame(): void {
  timer = null;
  const t = now();
  const dt = Math.min(0.05, (t - last) / 1000);
  last = t;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = false;
  if (melt) drawMelt(t);
  if (rain) drawRain(t);
  if (scan) drawScan(t);
  if (t < trailUntil) drawTrail(t);
  if (bugs) drawBugs(t, dt);
  if (swarm) drawSwarm(t, dt);
  if (hook) drawHook(t);
  drawPops(t);
  expire(t);
  if (active(t)) timer = window.setTimeout(frame, 16);
  else {
    ctx.clearRect(0, 0, W, H);
    void chaos2Api.fxIdle().catch(() => {});
  }
}

function expire(t: number): void {
  if (rain && t > rain.until) rain = null;
  if (scan && t > scan.until) scan = null;
  if (melt && t > melt.until) melt = null; // the picture is dropped with it
  if (bugs && t > bugs.until) bugs = null;
  if (swarm && t > swarm.until) swarm = null;
  pops = pops.filter((p) => t - p.t0 < 900);
  if (hook) {
    const age = t - hook.t0;
    if ((hook.phase === "release" && age > 500) || (hook.phase === "snap" && age > 1100)) hook = null;
    // A hook that never got its end (the page died): gone after 14 s.
    else if (hook.phase === "reel" && age > 14_000) hook = null;
  }
}

const INK = "#1d0b2e";
const MAGENTA = "#ff2bd6";
const CYAN = "#29f1ff";

function strokePts(pts: P[], width: number, color: string): void {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.stroke();
}

/** The line: thin dark core with a magenta glow, and a small hook. */
function glowLine(pts: P[]): void {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = MAGENTA;
  ctx.shadowBlur = 9;
  strokePts(pts, 3, "rgba(255,43,214,0.35)");
  ctx.shadowBlur = 0;
  strokePts(pts, 1.5, INK);
  ctx.restore();
}

function drawHookShape(p: P, angle: number): void {
  // A tiny pixel hook: shank and a curl, drawn in 2 px blocks.
  ctx.save();
  ctx.translate(Math.round(p.x), Math.round(p.y));
  ctx.rotate(angle);
  ctx.shadowColor = MAGENTA;
  ctx.shadowBlur = 8;
  ctx.fillStyle = "#e9e1ff";
  const px = 2;
  for (const [x, y] of [
    [0, 0],
    [0, 1],
    [0, 2],
    [0, 3],
    [0, 4],
    [-1, 5],
    [-2, 5],
    [-3, 4],
    [-3, 3],
  ]) ctx.fillRect(x * px, y * px, px, px);
  ctx.shadowBlur = 0;
  ctx.fillStyle = INK;
  ctx.fillRect(-1, 8, 2, 2);
  ctx.restore();
}

function drawHook(t: number): void {
  const h = hook!;
  const age = t - h.t0;
  if (h.phase === "snap") {
    const halves = snapHalves(h.rod, h.cursor, age);
    ctx.globalAlpha = Math.max(0, 1 - age / 1000);
    glowLine(halves.a);
    glowLine(halves.b);
    ctx.globalAlpha = 1;
    // One small burst of spark pixels, falling.
    for (const s of h.sparks) {
      const a = (t - s.born) / 1000;
      if (a > 0.55) continue;
      ctx.fillStyle = a < 0.2 ? "#ffffff" : MAGENTA;
      ctx.globalAlpha = 1 - a / 0.55;
      ctx.fillRect(Math.round(s.p.x + s.vx * a), Math.round(s.p.y + s.vy * a + 260 * a * a), 3, 3);
    }
    ctx.globalAlpha = 1;
    return;
  }
  const line = lineAt(h.phase, h.phase === "cast" ? age : h.phase === "reel" ? age : age, h.rod, h.cursor, h.castMs);
  glowLine(line.pts);
  if (line.hook) {
    const end = line.pts[line.pts.length - 1];
    const prev = line.pts[line.pts.length - 3] ?? end;
    drawHookShape(line.hook, Math.atan2(end.y - prev.y, end.x - prev.x) - Math.PI / 2 + Math.PI);
  }
  // When the hook bites: the cursor gets a tiny magenta ring (once, soft, no flash).
  if (h.phase === "reel" && age < 420) {
    ctx.strokeStyle = MAGENTA;
    ctx.globalAlpha = 0.6 * (1 - age / 420);
    ctx.lineWidth = 2;
    ctx.strokeRect(Math.round(h.cursor.x - 10 - age / 40), Math.round(h.cursor.y - 10 - age / 40), 20 + age / 20, 20 + age / 20);
    ctx.globalAlpha = 1;
  }
}

function drawArrow(p: P, alpha: number, fill: string, ink: string): void {
  const px = 1.6;
  ctx.globalAlpha = alpha;
  ARROW.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = row[x];
      if (c !== "1" && c !== "2") continue;
      ctx.fillStyle = c === "1" ? ink : fill;
      ctx.fillRect(p.x + x * px, p.y + y * px, px + 0.2, px + 0.2);
    }
  });
  ctx.globalAlpha = 1;
}

function drawTrail(t: number): void {
  const remain = trailUntil - t;
  const fade = smooth(remain / 600);
  for (const g of ghostCopies(history, t)) {
    // An RGB-split pair: subtle, a 2 px offset, never bright.
    drawArrow({ x: g.p.x - 1.5, y: g.p.y }, g.alpha * 0.8 * fade, "rgba(41,241,255,0.8)", "rgba(29,11,46,0.5)");
    drawArrow({ x: g.p.x + 1.5, y: g.p.y }, g.alpha * fade, "rgba(255,43,214,0.8)", "rgba(29,11,46,0.5)");
  }
  void cursorNow;
}

function drawRain(t: number): void {
  const r = rain!;
  const age = t - r.t0;
  const total = r.until - r.t0;
  const a = rainAlpha(age, total);
  ctx.font = `${RAIN_CELL - 2}px "Cascadia Mono", Consolas, monospace`;
  ctx.textBaseline = "top";
  const glyphs = "01<>/\\|=+*#%&$@アイウエオカキクケコ";
  for (const col of r.cols) {
    const run = Math.max(0, age - col.delay);
    if (run <= 0) continue;
    const headY = (run / 1000) * col.speed;
    for (let i = 0; i < col.len; i++) {
      const y = headY - i * RAIN_CELL;
      if (y < -RAIN_CELL || y > H) continue;
      const g = glyphs[Math.floor((y / RAIN_CELL + col.seed * 7 + Math.floor(run / 140)) % glyphs.length + glyphs.length) % glyphs.length];
      ctx.globalAlpha = a * (i === 0 ? 1 : 1 - i / col.len);
      ctx.fillStyle = i === 0 ? "#ffd6f7" : MAGENTA;
      ctx.fillText(g, col.x, Math.round(y));
    }
  }
  ctx.globalAlpha = 1;
}

function drawScan(t: number): void {
  const s = scan!;
  const age = t - s.t0;
  const total = s.until - s.t0;
  const a = scanAlpha(age, total);
  const y = scanSweepY(age, total, H);
  // A soft band with fine scanlines inside it, sweeping once.
  const g = ctx.createLinearGradient(0, y - 70, 0, y + 70);
  g.addColorStop(0, "rgba(41,241,255,0)");
  g.addColorStop(0.5, `rgba(41,241,255,${a})`);
  g.addColorStop(1, "rgba(41,241,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, y - 70, W, 140);
  ctx.fillStyle = `rgba(29,11,46,${a * 1.3})`;
  for (let ly = Math.max(0, Math.floor((y - 70) / 3) * 3); ly < Math.min(H, y + 70); ly += 3) ctx.fillRect(0, ly, W, 1);
}

function drawMelt(t: number): void {
  const m = melt!;
  if (!m.img) return;
  const age = t - m.t0;
  const total = m.until - m.t0;
  // The picture fades out at the very end so there is no snap back.
  const fade = 1 - smooth((age - (total - 500)) / 500);
  ctx.globalAlpha = fade;
  const sx = m.w / W;
  const sy = m.h / H;
  m.cols.forEach((c, i) => {
    const x = i * MELT_COLUMN;
    const off = meltOffset(c, age, H, total);
    ctx.drawImage(m.img!, x * sx, 0, MELT_COLUMN * sx, m.h, x, off, MELT_COLUMN, H);
    // The drip's rounded lower edge: a small bulb in the column's own colours is not drawn, the slide is the effect.
    void sy;
  });
  ctx.globalAlpha = 1;
}

function drawBug(b: Bug, t: number): void {
  const step = Math.floor(t / 160 + b.seed) % 2;
  const px = 2;
  const body: [number, number][] = [
    [1, 0],
    [2, 0],
    [0, 1],
    [1, 1],
    [2, 1],
    [3, 1],
    [1, 2],
    [2, 2],
  ];
  ctx.fillStyle = INK;
  for (const [x, y] of body) ctx.fillRect(Math.round(b.x) + (x - 2) * px, Math.round(b.y) - 7 + y * px, px, px);
  ctx.fillStyle = b.seed % 2 ? MAGENTA : CYAN;
  ctx.fillRect(Math.round(b.x) - px, Math.round(b.y) - 7, px, px);
  // legs
  ctx.fillStyle = INK;
  ctx.fillRect(Math.round(b.x) - 3 * px, Math.round(b.y) - 3 + step * px, px, px);
  ctx.fillRect(Math.round(b.x) + 2 * px, Math.round(b.y) - 3 + (1 - step) * px, px, px);
}

function drawBugs(t: number, dt: number): void {
  const bg = bugs!;
  const age = t - bg.t0;
  for (const b of bg.list) {
    if (!b.alive) continue;
    const top = bg.tops.find((x) => x.y === b.y)!;
    stepBug(b, (top.x0 + top.x1) / 2, dt, age);
    drawBug(b, t);
  }
  for (const s of bg.splats) {
    const a = (t - s.born) / 700;
    if (a > 1) continue;
    ctx.globalAlpha = 1 - a;
    for (let i = 0; i < 7; i++) {
      const ang = i * 0.9 + s.seed;
      ctx.fillStyle = i % 2 ? MAGENTA : CYAN;
      ctx.fillRect(Math.round(s.p.x + Math.cos(ang) * 14 * a * 2), Math.round(s.p.y - 4 + Math.sin(ang) * 8 * a * 2 - 10 * a), 3, 3);
    }
    ctx.globalAlpha = 1;
  }
  // Bugs nobody stamped on scurry off at the end.
  if (!bg.squashedAt && age > bg.until - bg.t0 - 800) for (const b of bg.list) b.x += b.dir * 90 * dt;
}

function drawSwarm(t: number, dt: number): void {
  const s = swarm!;
  const age = t - s.t0;
  if (!sprites) return;
  const dw = ANIM_FRAME_W * ART_SCALE * SWARM_SCALE;
  const dh = ANIM_FRAME_H * ART_SCALE * SWARM_SCALE;
  for (const c of s.list) {
    const a = age - c.born;
    const f = cloneFrame(a, c.popAt);
    if (!f.name) continue;
    if (!f.name.startsWith("clone_pop")) stepClone(c, W, dt);
    const img = sprites.frame(f.name);
    ctx.save();
    ctx.globalAlpha = f.alpha;
    ctx.translate(c.x, s.floor - 2);
    if (c.dir < 0) ctx.scale(-1, 1);
    // A small drop shadow so they sit on the floor.
    ctx.fillStyle = "rgba(29,11,46,0.25)";
    ctx.fillRect(-dw * 0.25, -2, dw * 0.5, 3);
    ctx.drawImage(img, -dw / 2, -dh, dw, dh);
    ctx.restore();
  }
}

function drawPops(t: number): void {
  for (const p of pops) {
    const a = (t - p.t0) / 800;
    if (a > 1) continue;
    const [x, y, w, h] = p.rect;
    ctx.globalAlpha = 1 - a;
    // A ring of pixel stars along the window's frame, drifting outwards.
    for (let i = 0; i < 18; i++) {
      const k = i / 18;
      const px = x + (k < 0.5 ? w * (k * 2) : w * (1 - (k - 0.5) * 2));
      const py = y + (k < 0.5 ? 0 : h);
      ctx.fillStyle = i % 3 === 0 ? CYAN : MAGENTA;
      ctx.fillRect(Math.round(px), Math.round(py + (k < 0.5 ? -1 : 1) * a * 26), 3, 3);
    }
    ctx.globalAlpha = 1;
  }
}

// ------------------------------------------------------------------ start

void listen<FxEvent>("chaos2-fx", (e) => onEvent(e.payload));
// The rod tip moves with every drawn frame of Glitch (physical px): the line starts exactly there.
void listen<{ x: number; y: number }>("chaos2-rod", (e) => {
  if (!hook) return;
  hook.rod = { x: (e.payload.x - hook.origin[0]) / hook.scale, y: (e.payload.y - hook.origin[1]) / hook.scale };
});
addEventListener("resize", fit);
fit();
window.addEventListener("contextmenu", (e) => e.preventDefault());
