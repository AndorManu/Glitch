// The mascot window: draws Glitch, plays animations, wanders, opens the chat.
//
// CPU budget: no requestAnimationFrame. Idle = under one repaint per second
// (sleep = one per 2 s); walking = 15 window moves/s, only for a few seconds
// every 25-75 s. Walking stops while the chat panel is open.

import { listen } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import { api, type Mood, type Settings } from "../shared/ipc";
import { GLITCH } from "../sprites/glitch";
import { loadSprites } from "../sprites/load";
import { RACCOON } from "../sprites/raccoon";
import type { SpriteSet } from "../sprites/types";
import { Animator } from "./animations";
import { DEFAULT_WALKER, facesLeft, positionAt, type Walk, Walker } from "./walker";

// Must match the mascot window in tauri.conf.json and MASCOT_W/H in windows.rs.
const WINDOW_W = 138;
const WINDOW_H = 90;
const MOVE_FPS = 15;
const SLEEP_AFTER_MS = 10 * 60_000;
const DRAG_THRESHOLD_PX = 4;

const win = getCurrentWindow();
const canvas = document.getElementById("glitch") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

let sprites: SpriteSet;
let facingLeft = false;
let lastFrame = "idle0";

let movementEnabled = true;
let panelOpen = false;
let busy = false; // AI is thinking / waiting for the user
let asleep = false;

let restTimer: number | undefined;
let sleepTimer: number | undefined;
let walk: { plan: Walk; started: number; timer?: number } | null = null;

function draw(frame: string): void {
  lastFrame = frame;
  const dpr = window.devicePixelRatio || 1;
  const pw = Math.round(WINDOW_W * dpr);
  const ph = Math.round(WINDOW_H * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const img = sprites.frame(frame);
  // Fit inside the window, feet on the bottom edge. Pixel grids scale by
  // whole numbers so they stay crisp; drawn art is scaled smoothly.
  let scale = Math.min(pw / img.width, ph / img.height);
  if (sprites.pixelated) scale = Math.max(1, Math.floor(scale));
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  ctx.clearRect(0, 0, pw, ph);
  ctx.imageSmoothingEnabled = !sprites.pixelated;
  ctx.imageSmoothingQuality = "high";
  ctx.save();
  if (facingLeft) {
    ctx.translate(pw, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(img, Math.round((pw - w) / 2), ph - h, w, h);
  ctx.restore();
}

const animator = new Animator(draw);

// ------------------------------------------------------------------ walking

let walker: Walker | null = null;

async function getWalker(): Promise<Walker> {
  if (walker) return walker;
  const scale = await win.scaleFactor();
  walker = new Walker({ ...DEFAULT_WALKER, speed: 70 * scale, maxDistance: 420 * scale });
  return walker;
}

function canWander(): boolean {
  return movementEnabled && !panelOpen && !busy && !asleep;
}

function scheduleWalk(): void {
  window.clearTimeout(restTimer);
  if (!canWander() || walk) return;
  void getWalker().then((w) => {
    window.clearTimeout(restTimer);
    restTimer = window.setTimeout(() => void startWalk(), w.restMs());
  });
}

async function startWalk(): Promise<void> {
  if (!canWander() || walk) return;
  const [pos, monitor, size] = await Promise.all([win.outerPosition(), currentMonitor(), win.outerSize()]);
  if (!monitor || !canWander()) return scheduleWalk();
  const area = {
    x: monitor.workArea.position.x,
    y: monitor.workArea.position.y,
    width: monitor.workArea.size.width,
    height: monitor.workArea.size.height,
  };
  const plan = (await getWalker()).plan({ x: pos.x, y: pos.y }, area, { width: size.width, height: size.height });
  if (plan.durationMs < 300) return scheduleWalk();
  facingLeft = facesLeft(plan);
  walk = { plan, started: performance.now() };
  animator.play("walk");
  void step();
}

async function step(): Promise<void> {
  if (!walk) return;
  const t0 = performance.now();
  const p = positionAt(walk.plan, t0 - walk.started);
  try {
    await win.setPosition(new PhysicalPosition(p.x, p.y));
  } catch {
    return stopWalk();
  }
  if (!walk) return;
  if (p.x === walk.plan.to.x && p.y === walk.plan.to.y) return stopWalk();
  const spent = performance.now() - t0;
  walk.timer = window.setTimeout(() => void step(), Math.max(0, 1000 / MOVE_FPS - spent));
}

function stopWalk(): void {
  if (walk) {
    window.clearTimeout(walk.timer);
    walk = null;
    if (animator.animation === "walk") animator.play("idle");
  }
  scheduleWalk();
}

// ------------------------------------------------------------- sleep / mood

function resetSleepTimer(): void {
  window.clearTimeout(sleepTimer);
  sleepTimer = window.setTimeout(() => {
    if (panelOpen || busy) return resetSleepTimer();
    asleep = true;
    stopWalk();
    animator.play("sleep");
  }, SLEEP_AFTER_MS);
}

function wake(): void {
  if (asleep) {
    asleep = false;
    animator.play("idle");
  }
  resetSleepTimer();
  scheduleWalk();
}

function setMood(mood: Mood): void {
  busy = mood === "thinking" || mood === "asking";
  if (busy) stopWalk();
  asleep = false;
  resetSleepTimer();
  animator.play(mood === "happy" ? "happy" : busy ? "think" : "idle");
  scheduleWalk();
}

// ----------------------------------------------------- click vs. drag input

let pointerDown: { x: number; y: number } | null = null;
let dragging = false;

canvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  pointerDown = { x: e.screenX, y: e.screenY };
  dragging = false;
  stopWalk();
  wake();
});

window.addEventListener("mousemove", (e) => {
  if (!pointerDown || dragging) return;
  if (Math.hypot(e.screenX - pointerDown.x, e.screenY - pointerDown.y) > DRAG_THRESHOLD_PX) {
    dragging = true;
    // Native drag: the OS moves the window (and may swallow the mouseup).
    void win.startDragging();
  }
});

window.addEventListener("mouseup", () => {
  if (pointerDown && !dragging) void api.mascotClicked();
  pointerDown = null;
  dragging = false;
});

canvas.addEventListener("mouseenter", () => wake());
window.addEventListener("contextmenu", (e) => e.preventDefault());

// ------------------------------------------------------------------- start

function applySettings(s: Settings): void {
  movementEnabled = s.movement_enabled;
  if (!movementEnabled) stopWalk();
  scheduleWalk();
}

async function main(): Promise<void> {
  // The raccoon sheet; the tiny code-drawn creature only if the PNG fails.
  sprites = await loadSprites(RACCOON).catch((e) => {
    console.error("sprite sheet failed to load, using fallback art", e);
    return loadSprites(GLITCH);
  });
  draw(lastFrame);
  let settings: Settings | null = null;
  try {
    settings = await api.getSettings();
    applySettings(settings);
  } catch (e) {
    console.error("could not load settings", e);
  }
  await listen<Settings>("settings-changed", (e) => applySettings(e.payload));
  await listen<boolean>("panel-visibility", (e) => {
    panelOpen = e.payload;
    if (panelOpen) stopWalk();
    wake();
  });
  await listen<Mood>("mood", (e) => setMood(e.payload));
  window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener("change", () => draw(lastFrame));
  // Show only now that the first frame is drawn (no blank/white flash).
  await win.show();
  // First run: open the setup wizard next to Glitch.
  if (settings && !settings.onboarding_done) void api.showPanel();
  animator.play("idle");
  resetSleepTimer();
  scheduleWalk();
}

void main();
