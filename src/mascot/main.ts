// The mascot window: draws Glitch, plays animations, wanders, opens the chat.
//
// CPU budget: no requestAnimationFrame. Idle = about one repaint per second
// (a breath, a fidget, a glitch burst every 8-25 s); sleep = one per 2.4 s.
// Walking = 15 window moves + 15 repaints/s, only for a few seconds every
// 25-75 s. Walking stops while the chat panel is open.

import { listen } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import { api, type Mood, type Settings } from "../shared/ipc";
import { GLITCH } from "../sprites/glitch";
import { loadSprites } from "../sprites/load";
import { RACCOON } from "../sprites/raccoon";
import { ANIMATIONS, type AnimationName, Animator, isAnimationName } from "./animations";
import { Renderer, VIEW_H, VIEW_W } from "./render";
import { DEFAULT_WALKER, facesLeft, positionAt, type Walk, Walker } from "./walker";

// Must match the mascot window in tauri.conf.json and MASCOT_W/H in windows.rs.
const WINDOW_W = VIEW_W; // 160
const WINDOW_H = VIEW_H; // 110
const MOVE_FPS = 15;
const SLEEP_AFTER_MS = 10 * 60_000;
const DRAG_THRESHOLD_PX = 4;
/** The dangle ends this long after the window last moved (mouseup is often swallowed by a native drag). */
const DANGLE_SETTLE_MS = 250;
/** Looping actions triggered from outside stop on their own after this long. */
const ACTION_LOOP_MAX_MS = 8000;

const win = getCurrentWindow();
const canvas = document.getElementById("glitch") as HTMLCanvasElement;
canvas.style.width = `${WINDOW_W}px`;
canvas.style.height = `${WINDOW_H}px`;

let renderer: Renderer | null = null;
const animator = new Animator((pose, tick) => renderer?.render(pose, tick));

let movementEnabled = true;
let panelOpen = false;
let busy = false; // AI is thinking / waiting for the user
let asleep = false;

let restTimer: number | undefined;
let sleepTimer: number | undefined;
let actionTimer: number | undefined;
let walk: { plan: Walk; started: number; timer?: number } | null = null;

// ------------------------------------------------------------------ walking

let walker: Walker | null = null;

async function getWalker(): Promise<Walker> {
  if (walker) return walker;
  const scale = await win.scaleFactor();
  walker = new Walker({ ...DEFAULT_WALKER, speed: 70 * scale, maxDistance: 420 * scale });
  return walker;
}

function canWander(): boolean {
  // Only wander from plain idle: never cut a reaction or an action short.
  return movementEnabled && !panelOpen && !busy && !asleep && !dangling && (animator.animation === "idle" || animator.animation === "walk");
}

function scheduleWalk(): void {
  window.clearTimeout(restTimer);
  if (!movementEnabled || panelOpen || busy || asleep || walk) return;
  void getWalker().then((w) => {
    window.clearTimeout(restTimer);
    restTimer = window.setTimeout(() => void startWalk(), w.restMs());
  });
}

async function startWalk(): Promise<void> {
  if (!canWander() || walk) return scheduleWalk();
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
  if (renderer) renderer.facingLeft = facesLeft(plan);
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
    if (panelOpen || busy || animator.animation !== "idle") return resetSleepTimer();
    asleep = true;
    stopWalk();
    animator.play("sleep");
  }, SLEEP_AFTER_MS);
}

function wake(): void {
  if (asleep) {
    asleep = false;
    animator.play("idle");
    animator.glitchBurst(350); // rebooting...
  }
  resetSleepTimer();
  scheduleWalk();
}

function setMood(mood: Mood): void {
  busy = mood === "thinking" || mood === "asking";
  if (busy) stopWalk();
  asleep = false;
  resetSleepTimer();
  if (mood === "thinking") {
    if (animator.animation !== "think") {
      animator.play("think");
      animator.glitchBurst(); // the gears start grinding
    }
  } else {
    animator.play(mood === "happy" ? "happy" : mood === "asking" ? "ask" : "idle");
  }
  scheduleWalk();
}

// ------------------------------------------------------------------ actions

/**
 * Play any animation by name (e.g. "grabCursor", "glitchOut", "peek").
 * One-shots return to what was playing; loops stop after ACTION_LOOP_MAX_MS.
 * Unknown names are ignored. Returns whether something was played.
 */
export function playAction(name: unknown): boolean {
  if (!isAnimationName(name)) return false;
  const resume = animator.base === "walk" ? "idle" : animator.base;
  stopWalk();
  window.clearTimeout(actionTimer);
  asleep = name === "sleep";
  animator.play(name, ANIMATIONS[name].next ?? resume);
  if (!ANIMATIONS[name].once && !["idle", "sleep", "napRock", "think", "ask"].includes(name)) {
    actionTimer = window.setTimeout(() => {
      if (animator.animation === name) animator.play(busy ? "think" : "idle");
    }, ACTION_LOOP_MAX_MS);
  }
  return true;
}

// ----------------------------------------------- click vs. drag (dangle)

let pointerDown: { x: number; y: number } | null = null;
let dragging = false;
let dangling = false;
let lastMoveAt = 0;
let dangleTimer: number | undefined;

function startDangle(): void {
  dangling = true;
  lastMoveAt = performance.now();
  animator.play("dangle");
  animator.glitchBurst(400);
  armDangleEnd(700); // in case the window never actually moves
}

function armDangleEnd(ms: number): void {
  window.clearTimeout(dangleTimer);
  dangleTimer = window.setTimeout(endDangle, ms);
}

function endDangle(): void {
  window.clearTimeout(dangleTimer);
  if (!dangling) return;
  dangling = false;
  dragging = false;
  pointerDown = null;
  animator.play("fall"); // -> land -> idle
  scheduleWalk();
}

/** Any mouse event once the window has settled means the drag is over. */
function settledMouseEvent(): void {
  if (dangling && performance.now() - lastMoveAt > 150) endDangle();
}

canvas.addEventListener("mousedown", (e) => {
  settledMouseEvent();
  if (e.button !== 0) return;
  pointerDown = { x: e.screenX, y: e.screenY };
  dragging = false;
  stopWalk();
  wake();
});

window.addEventListener("mousemove", (e) => {
  settledMouseEvent();
  if (!pointerDown || dragging) return;
  if (Math.hypot(e.screenX - pointerDown.x, e.screenY - pointerDown.y) > DRAG_THRESHOLD_PX) {
    dragging = true;
    startDangle();
    // Native drag: the OS moves the window (and may swallow the mouseup).
    void win.startDragging();
  }
});

window.addEventListener("mouseup", () => {
  if (dangling) return endDangle();
  if (pointerDown && !dragging) {
    void api.mascotClicked();
    animator.play("startled", animator.base === "walk" ? "idle" : animator.base);
  }
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
  const sprites = await loadSprites(RACCOON).catch((e) => {
    console.error("sprite sheet failed to load, using fallback art", e);
    return loadSprites(GLITCH);
  });
  renderer = new Renderer(canvas, sprites);
  animator.play("idle");
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
  // For behaviours driven from Rust or other windows; unknown names are ignored.
  await listen<string>("mascot-action", (e) => void playAction(e.payload));
  await win.onMoved(() => {
    if (!dangling) return;
    lastMoveAt = performance.now();
    armDangleEnd(DANGLE_SETTLE_MS);
  });
  window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener("change", () => renderer?.redraw());
  // Show only now that the first frame is drawn (no blank/white flash).
  await win.show();
  // First run: open the setup wizard next to Glitch.
  if (settings && !settings.onboarding_done) void api.showPanel();
  resetSleepTimer();
  scheduleWalk();
}

// Dev/testing hook: trigger animations and moods from the console or Playwright.
if (import.meta.env.DEV) {
  (window as unknown as { __glitch: object }).__glitch = {
    play: playAction,
    mood: setMood,
    burst: (ms?: number) => animator.glitchBurst(ms),
    face: (left: boolean) => {
      if (renderer) renderer.facingLeft = left;
      renderer?.redraw();
    },
    get animation(): AnimationName {
      return animator.animation;
    },
  };
}

void main();
