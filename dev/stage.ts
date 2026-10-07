// Dev stage: a fake desktop for watching Glitch live. The real Creature
// (src/mascot/creature.ts) and Renderer run unchanged; only the Host is
// fake: "moving the window" moves a 160x160 canvas over a desktop canvas,
// world() reports the fake app windows' visible tops, the cursor is the
// page mouse. Click-through is emulated from the hitbox like Rust does.
//
// Playwright hooks on window.__stage: do(name), mood(m), panel(open),
// movement(on), moveWin(id, dx, dy), closeWin(id), state(), film(opts).

import { Creature, type Host } from "../src/mascot/creature";
import { mulberry32 } from "../src/mascot/glitchfx";
import type { Vec } from "../src/mascot/physics";
import { type BodyRect, Renderer } from "../src/mascot/render";
import type { Ledge, WorldSnapshot } from "../src/shared/ipc";
import { loadGlitchSprites } from "../src/sprites/glitch-sprites";

const q = new URLSearchParams(location.search);
const DEBUG = q.get("debug") === "1";
const desk = document.getElementById("desk") as HTMLCanvasElement;
const hud = document.getElementById("hud")!;
const DPR = 2;
const W = window.innerWidth;
const H = window.innerHeight;
const TASKBAR = 40;
desk.width = W * DPR;
desk.height = H * DPR;
const ctx = desk.getContext("2d")!;

interface AppWin {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  color: string;
  closed?: boolean;
}

// Back to front.
const apps: AppWin[] =
  q.get("nowin") === "1"
    ? []
    : [
        { id: 11, x: 90, y: 330, w: 520, h: 330, title: "Terminal", color: "#1e1b2e" },
        { id: 12, x: 700, y: 250, w: 450, h: 360, title: "Browser", color: "#f4f1fb" },
        { id: 13, x: 470, y: 520, w: 330, h: 200, title: "Notes", color: "#fff6c8" },
      ];

const area = { x: 0, y: 0, w: W, h: H - TASKBAR };

/** Visible top edges (minus parts covered by windows in front), like Rust's world_snapshot. */
function ledges(): Ledge[] {
  const out: Ledge[] = [];
  const open = apps.filter((a) => !a.closed);
  open.forEach((a, i) => {
    if (a.y < area.y + 150) return;
    let spans: [number, number][] = [[Math.max(a.x, area.x), Math.min(a.x + a.w, area.x + area.w)]];
    for (const f of open.slice(i + 1)) {
      if (a.y < f.y || a.y > f.y + f.h) continue;
      spans = spans.flatMap(([s, e]) => {
        const parts: [number, number][] = [];
        if (f.x > s) parts.push([s, Math.min(e, f.x)]);
        if (f.x + f.w < e) parts.push([Math.max(s, f.x + f.w), e]);
        return parts;
      });
    }
    for (const [s, e] of spans) if (e - s >= 40) out.push({ id: a.id, x: s, y: a.y, w: e - s });
  });
  return out;
}

const mascotCanvas = document.createElement("canvas");
let winPos: Vec = { x: W - 200, y: H - TASKBAR - 184 };
let hitbox: BodyRect | null = null;
let mouse: Vec = { x: 0, y: 0 };
const log: string[] = [];
const counts = { moves: [] as number[], renders: [] as number[] };

const host: Host = {
  moveWindow: (x, y) => {
    winPos = { x, y };
    counts.moves.push(performance.now());
  },
  world: async (): Promise<WorldSnapshot> => ({ area, scale: 1, ledges: ledges() }),
  cursor: () => ({ ...mouse }),
  setHitbox: (r) => (hitbox = r),
  clicked: () => note("click -> mascot_clicked"),
};

function note(s: string): void {
  log.push(`${(performance.now() / 1000).toFixed(1)} ${s}`);
  if (log.length > 9) log.shift();
}

let creature: Creature;
let renderer: Renderer;

// ------------------------------------------------------------------ input

function overMascot(p: Vec): boolean {
  const lx = p.x - winPos.x;
  const ly = p.y - winPos.y;
  if (lx < 0 || ly < 0 || lx >= 160 || ly >= 160) return false;
  if (!hitbox) return true;
  const m = 4;
  return lx >= hitbox.x - m && lx < hitbox.x + hitbox.w + m && ly >= hitbox.y - m && ly < hitbox.y + hitbox.h + m;
}

let pressingMascot = false;
let dragApp: { app: AppWin; dx: number; dy: number } | null = null;
let hovered = false;

desk.addEventListener("pointerdown", (e) => {
  mouse = { x: e.clientX, y: e.clientY };
  desk.setPointerCapture(e.pointerId);
  if (overMascot(mouse)) {
    pressingMascot = true;
    creature.pointerDown({ x: mouse.x - winPos.x, y: mouse.y - winPos.y });
    return;
  }
  for (const a of [...apps].reverse()) {
    if (a.closed) continue;
    if (mouse.x >= a.x && mouse.x < a.x + a.w && mouse.y >= a.y && mouse.y < a.y + 28) {
      dragApp = { app: a, dx: mouse.x - a.x, dy: mouse.y - a.y };
      apps.splice(apps.indexOf(a), 1);
      apps.push(a); // bring to front
      return;
    }
  }
});
desk.addEventListener("pointermove", (e) => {
  mouse = { x: e.clientX, y: e.clientY };
  if (pressingMascot) creature.pointerMove({ x: mouse.x - winPos.x, y: mouse.y - winPos.y });
  if (dragApp) {
    dragApp.app.x = mouse.x - dragApp.dx;
    dragApp.app.y = Math.max(0, mouse.y - dragApp.dy);
  }
});
desk.addEventListener("pointerup", () => {
  if (pressingMascot) creature.pointerUp();
  pressingMascot = false;
  dragApp = null;
});

// Rust's hover thread polls at 10 Hz.
setInterval(() => {
  const over = overMascot(mouse);
  if (over !== hovered) {
    hovered = over;
    creature.setHovered(over);
  }
}, 100);

// ---------------------------------------------------------------- drawing

function drawDesktop(): void {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, "#23406b");
  g.addColorStop(1, "#4b2a63");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  for (const a of apps) {
    if (a.closed) continue;
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(a.x + 6, a.y + 8, a.w, a.h);
    ctx.fillStyle = a.color;
    ctx.fillRect(a.x, a.y, a.w, a.h);
    ctx.fillStyle = a.color === "#1e1b2e" ? "#33304a" : "#dcd6ea";
    ctx.fillRect(a.x, a.y, a.w, 28);
    for (const [i, c] of ["#ff5f57", "#febc2e", "#28c840"].entries()) {
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(a.x + 16 + i * 18, a.y + 14, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = a.color === "#1e1b2e" ? "#cfc8ff" : "#4a3f5c";
    ctx.font = "12px system-ui";
    ctx.fillText(a.title, a.x + 76, a.y + 18);
    const r = mulberry32(a.id);
    ctx.fillStyle = a.color === "#1e1b2e" ? "#7cf08a" : "#b9b2c8";
    for (let y = a.y + 46; y < a.y + a.h - 16; y += 18) ctx.fillRect(a.x + 18, y, 40 + r() * (a.w - 90), 7);
  }
  ctx.fillStyle = "rgba(12, 10, 24, 0.92)";
  ctx.fillRect(0, H - TASKBAR, W, TASKBAR);
  ctx.fillStyle = "#9a00f5";
  ctx.fillRect(14, H - TASKBAR + 10, 20, 20);
  if (DEBUG) {
    ctx.strokeStyle = "#5dff8a";
    ctx.lineWidth = 2;
    for (const l of ledges()) {
      ctx.beginPath();
      ctx.moveTo(l.x, l.y);
      ctx.lineTo(l.x + l.w, l.y);
      ctx.stroke();
    }
  }
  // Glitch's window.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(mascotCanvas, Math.round(winPos.x * DPR), Math.round(winPos.y * DPR), 160 * DPR, 160 * DPR);
  if (DEBUG) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1;
    ctx.strokeRect(winPos.x + 0.5, winPos.y + 0.5, 159, 159);
    if (hitbox) {
      ctx.strokeStyle = "#ff1fc8";
      ctx.strokeRect(winPos.x + hitbox.x, winPos.y + hitbox.y, hitbox.w, hitbox.h);
    }
  }
}

// ------------------------------------------------------------------ film

interface Film {
  every: number;
  next: number;
  until: number;
  mode: "follow" | "full";
  size: number;
  tile: number;
  cols: number;
  frames: { img: HTMLCanvasElement; at: number }[];
  t0: number;
  done: (url: string) => void;
}
let film: Film | null = null;

function capture(f: Film): void {
  const c = document.createElement("canvas");
  if (f.mode === "full") {
    c.width = f.tile;
    c.height = Math.round((f.tile * H) / W);
    c.getContext("2d")!.drawImage(desk, 0, 0, c.width, c.height);
  } else {
    c.width = c.height = f.tile;
    const cx = (winPos.x + 80) * DPR;
    const cy = (winPos.y + 80) * DPR;
    const s = f.size * DPR;
    const x = Math.max(0, Math.min(desk.width - s, cx - s / 2));
    const y = Math.max(0, Math.min(desk.height - s, cy - s / 2));
    c.getContext("2d")!.drawImage(desk, x, y, s, s, 0, 0, f.tile, f.tile);
  }
  f.frames.push({ img: c, at: performance.now() - f.t0 });
}

function finishFilm(f: Film): void {
  const tw = f.frames[0]?.img.width ?? 1;
  const th = f.frames[0]?.img.height ?? 1;
  const rows = Math.ceil(f.frames.length / f.cols);
  const sheet = document.createElement("canvas");
  sheet.width = f.cols * (tw + 4);
  sheet.height = rows * (th + 18);
  const s = sheet.getContext("2d")!;
  s.fillStyle = "#111";
  s.fillRect(0, 0, sheet.width, sheet.height);
  f.frames.forEach((fr, i) => {
    const x = (i % f.cols) * (tw + 4);
    const y = Math.floor(i / f.cols) * (th + 18);
    s.drawImage(fr.img, x, y);
    s.fillStyle = "#ddd";
    s.font = "12px monospace";
    s.fillText(`${Math.round(fr.at)}ms`, x + 4, y + th + 13);
  });
  f.done(sheet.toDataURL("image/png"));
}

// ------------------------------------------------------------------ loop

function frame(): void {
  drawDesktop();
  if (film) {
    const now = performance.now();
    if (now >= film.next) {
      capture(film);
      film.next += film.every;
    }
    if (now >= film.until) {
      const f = film;
      film = null;
      finishFilm(f);
    }
  }
  const now = performance.now();
  for (const k of ["moves", "renders"] as const) while (counts[k].length && counts[k][0] < now - 2000) counts[k].shift();
  hud.textContent = [
    `mode ${creature.mode}  surface ${creature.surface.kind}  anim ${creature.animation}`,
    `plan ${creature.plan?.name ?? "-"}  asleep ${creature.asleep}  moving ${creature.moving}`,
    `moves/s ${(counts.moves.length / 2).toFixed(1)}  renders/s ${(counts.renders.length / 2).toFixed(1)}  polls ${creature.stats.worldPolls}`,
    ...log,
  ].join("\n");
  requestAnimationFrame(frame); // dev page only; the real mascot never uses rAF
}

async function main(): Promise<void> {
  const sprites = await loadGlitchSprites(DPR);
  renderer = new Renderer(mascotCanvas, sprites, { pixelRatio: () => DPR });
  const render = renderer.render.bind(renderer);
  renderer.render = (pose, tick) => {
    counts.renders.push(performance.now());
    render(pose, tick);
  };
  const seed = q.get("seed");
  creature = new Creature(host, renderer, seed ? { random: mulberry32(Number(seed)) } : {});
  creature.onEvent = note;
  if (q.get("movement") === "0") creature.movement = false;
  await creature.start(winPos);
  requestAnimationFrame(frame);

  (window as unknown as { __stage: object }).__stage = {
    creature,
    do: (name: string) => creature.playAction(name),
    mood: (m: string) => creature.setMood(m),
    panel: (open: boolean) => creature.setPanelOpen(open),
    movement: (on: boolean) => creature.setMovement(on),
    moveWin: (id: number, dx: number, dy: number) => {
      const a = apps.find((w) => w.id === id);
      if (a) {
        a.x += dx;
        a.y += dy;
      }
    },
    closeWin: (id: number) => {
      const a = apps.find((w) => w.id === id);
      if (a) a.closed = true;
    },
    apps,
    ledges,
    get win() {
      return winPos;
    },
    get hitbox() {
      return hitbox;
    },
    state: () => ({ mode: creature.mode, surface: creature.surface.kind, anim: creature.animation, plan: creature.plan?.name ?? null, win: winPos, log: [...log] }),
    /** Record a contact sheet: every `every` ms for `ms`; "follow" crops around Glitch. Resolves to a PNG data URL. */
    film: (o: { ms: number; every: number; mode?: "follow" | "full"; size?: number; tile?: number; cols?: number }) =>
      new Promise<string>((done) => {
        const t0 = performance.now();
        film = {
          every: o.every,
          next: t0,
          until: t0 + o.ms,
          mode: o.mode ?? "follow",
          size: o.size ?? 240,
          tile: o.tile ?? 200,
          cols: o.cols ?? 8,
          frames: [],
          t0,
          done,
        };
      }),
  };
  document.body.dataset.ready = "1";
}

void main();
