// Dev gallery: renders every mascot animation through the real Animator and
// Renderer (no Tauri, no window code). Live loops on top; below, a strip of
// the first frames of each animation (fixed seed) for screenshots.

import { ANIMATIONS, type AnimationName, Animator, type Clock, type Pose } from "../src/mascot/animations";
import { mulberry32 } from "../src/mascot/glitchfx";
import { Renderer } from "../src/mascot/render";
import { loadSprites } from "../src/sprites/load";
import { RACCOON } from "../src/sprites/raccoon";
import { GLITCH } from "../src/sprites/glitch";
import { loadGlitchSprites } from "../src/sprites/glitch-sprites";

const q = new URLSearchParams(location.search);
if (q.get("bg")) document.body.style.background = q.get("bg")!;
const left = q.get("left") === "1";
const only = q.get("strip")?.split(",");
const STRIP_FRAMES = Number(q.get("frames") ?? 16);
const STRIP_SKIP = Number(q.get("skip") ?? 0);
const app = document.getElementById("app")!;
const names = Object.keys(ANIMATIONS) as AnimationName[];

function section(title: string, cls: string): HTMLElement {
  const h = document.createElement("h2");
  h.textContent = title;
  const grid = document.createElement("div");
  grid.className = `grid ${cls}`;
  app.append(h, grid);
  return grid;
}

async function main(): Promise<void> {
  const sprites = q.get("old") === "1" ? await loadSprites(RACCOON) : q.get("fallback") === "1" ? await loadSprites(GLITCH) : await loadGlitchSprites();

  if (q.get("live") !== "0") {
    const grid = section("Live (once-animations replay)", "live");
    for (const name of names) {
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `<b>${name}</b>`;
      const canvas = document.createElement("canvas");
      card.append(canvas);
      grid.append(card);
      const r = new Renderer(canvas, sprites, { pixelRatio: () => 2 });
      r.facingLeft = left;
      let replay: number | undefined;
      const a: Animator = new Animator((pose, tick) => {
        r.render(pose, tick);
        // A one-shot finished: show it again after a beat.
        if (a.animation === "idle" && name !== "idle" && replay === undefined) {
          replay = window.setTimeout(() => {
            replay = undefined;
            a.play(name);
          }, 1200);
        }
      });
      a.play(name);
    }
  }

  // Strips: step a fake clock and keep every repaint.
  const grid = section(`Strips (first ${STRIP_FRAMES} repaints, ms since start)`, "strips");
  for (const name of only ?? names) {
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.anim = name;
    card.innerHTML = `<b>${name}</b>`;
    const strip = document.createElement("div");
    strip.className = "strip";
    card.append(strip);
    grid.append(card);
    let pending: { fn: () => void; ms: number } | null = null;
    const clock: Clock = { setTimeout: (fn, ms) => (pending = { fn, ms }), clearTimeout: () => (pending = null) };
    const frames: { pose: Pose; tick: number; at: number }[] = [];
    let t = 0;
    const a = new Animator((pose, tick) => frames.push({ pose, tick, at: t }), ANIMATIONS, clock, mulberry32(4));
    a.play(name as AnimationName);
    while (frames.length < STRIP_SKIP + STRIP_FRAMES && pending) {
      const p: { fn: () => void; ms: number } = pending;
      pending = null;
      t += p.ms;
      p.fn();
    }
    for (const f of frames.slice(STRIP_SKIP, STRIP_SKIP + STRIP_FRAMES)) {
      const cell = document.createElement("div");
      const canvas = document.createElement("canvas");
      const r = new Renderer(canvas, sprites, { pixelRatio: () => 2 });
      r.facingLeft = left;
      r.render(f.pose, f.tick);
      const label = document.createElement("small");
      label.textContent = `${f.at}ms ${f.pose.frame}${f.pose.glitch ? ` g${f.pose.glitch.toFixed(1)}` : ""}`;
      cell.append(canvas, label);
      strip.append(cell);
    }
  }
  document.body.dataset.ready = "1";
}

void main();
