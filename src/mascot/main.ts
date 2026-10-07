// The mascot window: wires Glitch the creature (creature.ts: physics, brain,
// animations) to Tauri: the window he lives in, the screen and other apps'
// windows (api.world), the click-through hitbox, the mouse, and the events
// from Rust (moods, chat open, settings, actions).
//
// CPU budget: no requestAnimationFrame. Resting = about one repaint and one
// timer wakeup per second; asleep = one per 2.4 s and no polling at all.
// The window only moves while he walks/climbs (30 Hz) or flies / is carried
// (60 Hz); otherwise no movement timer runs. See creature.ts.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  currentMonitor,
  cursorPosition,
  getCurrentWindow,
  PhysicalPosition,
  primaryMonitor,
} from "@tauri-apps/api/window";
import { api, chaosApi, type LedgeEvent, MASCOT_TALK_EVENT, type Settings, type WorldSnapshot } from "../shared/ipc";
import { loadGlitchSprites } from "../sprites/glitch-sprites";
import type { AnimationName } from "./animations";
import { Creature, type Host } from "./creature";
import { WIN, type Vec } from "./physics";
import { Renderer } from "./render";

const win = getCurrentWindow();
const canvas = document.getElementById("glitch") as HTMLCanvasElement;
canvas.style.width = `${WIN}px`;
canvas.style.height = `${WIN}px`;

/** If `world_snapshot` isn't available, the monitor's work area without window tops. */
async function fallbackWorld(): Promise<WorldSnapshot> {
  const [monitor, scale] = await Promise.all([currentMonitor(), win.scaleFactor()]);
  const area = monitor
    ? { x: monitor.workArea.position.x, y: monitor.workArea.position.y, w: monitor.workArea.size.width, h: monitor.workArea.size.height }
    : { x: 0, y: 0, w: Math.round(screen.availWidth * scale), h: Math.round(screen.availHeight * scale) };
  return { area, scale, ledges: [] };
}

let lastPointer: { x: number; y: number } = { x: 0, y: 0 };

// macOS reports the global cursor scaled by the PRIMARY screen's factor, but
// window positions with the factor of the window's own screen. Convert the
// cursor into the window's space so dragging works on mixed-DPI setups
// (e.g. a Retina MacBook + a 1x external monitor). Windows: both are global
// physical pixels already.
const isMac = /Mac/.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent);
let cursorToWindow = 1;
async function updateCursorScale(): Promise<void> {
  if (!isMac) return;
  const [primary, own] = await Promise.all([primaryMonitor(), win.scaleFactor()]);
  cursorToWindow = own / (primary?.scaleFactor ?? own);
}
void updateCursorScale();
void win.onScaleChanged(() => void updateCursorScale());

const host: Host = {
  moveWindow: (x, y) => win.setPosition(new PhysicalPosition(Math.round(x), Math.round(y))),
  world: () => api.world().catch(() => fallbackWorld()),
  // Global physical cursor; if that fails, the last pointer event (screen CSS px x DPR).
  cursor: () => cursorPosition().then(
    (p) => ({ x: p.x * cursorToWindow, y: p.y * cursorToWindow }),
    () => ({ x: lastPointer.x * devicePixelRatio, y: lastPointer.y * devicePixelRatio }),
  ),
  setHitbox: (rect) => void api.setHitbox(rect).catch(() => {}),
  clicked: () => void api.mascotClicked(),
  watchLedge: (id) => api.ledgeWatch(id).catch(() => null),
  ledgeFrame: (id) => api.ledgeFrame(id),
  chaos: {
    status: () => chaosApi.status(),
    windows: () => chaosApi.windows().catch(() => []),
    grabWindow: (id) => chaosApi.grabWindow(id).catch(() => null),
    dragWindow: (dx, dy) => chaosApi.dragWindow(dx, dy).then((r) => (r ? { x: r[0], y: r[1] } : null), () => null),
    releaseWindow: () => void chaosApi.releaseWindow().catch(() => {}),
    grabCursor: () => chaosApi.grabCursor().then((p) => (p ? { x: p[0], y: p[1] } : null), () => null),
    dragCursor: (x, y) => chaosApi.dragCursor(x, y).catch(() => false),
    releaseCursor: () => void chaosApi.releaseCursor().catch(() => {}),
    paws: (paws) => void chaosApi.paws(paws).catch(() => {}),
    noteOpen: (line, x, y) => chaosApi.noteOpen(line, x, y).catch(() => null),
    noteMove: (x, y) => void chaosApi.noteMove(x, y).catch(() => {}),
    noteIsOpen: () => chaosApi.noteIsOpen(),
  },
};

let creature: Creature | null = null;

// ----------------------------------------------------------- the mouse
// Our own drag (not the OS one): pointer capture keeps the events coming
// even when the cursor outruns the window; the creature polls the global
// cursor while carrying him.

const local = (e: PointerEvent): Vec => {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
};

canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || !creature) return;
  lastPointer = { x: e.screenX, y: e.screenY };
  canvas.setPointerCapture(e.pointerId);
  creature.pointerDown(local(e));
});
canvas.addEventListener("pointermove", (e) => {
  lastPointer = { x: e.screenX, y: e.screenY };
  creature?.pointerMove(local(e));
});
canvas.addEventListener("pointerup", (e) => {
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  creature?.pointerUp();
});
canvas.addEventListener("pointercancel", () => creature?.pointerCancel());
canvas.addEventListener("lostpointercapture", () => creature?.held && creature.pointerCancel());
window.addEventListener("blur", () => creature?.held && creature.pointerCancel());
window.addEventListener("contextmenu", (e) => e.preventDefault());

// ------------------------------------------------------------------ actions

/**
 * Play any animation by name (e.g. "grabCursor", "glitchOut", "peek") or a
 * behaviour ("climb", "jump", "teleport", "build", "chaos", "run",
 * "sitEdge", "peekEdge", "hopDown"...). One-shots return to what was
 * playing; loops stop after 8 s. Unknown names are ignored. Returns whether
 * something was played.
 */
export function playAction(name: unknown): boolean {
  return creature?.playAction(name) ?? false;
}

function applySettings(s: Settings): void {
  creature?.setMovement(s.movement_enabled);
  creature?.setChaos(s.chaos_enabled ?? true);
}

async function main(): Promise<void> {
  // The raccoon sheet; the tiny code-drawn creature only if the PNG fails.
  const sprites = await loadGlitchSprites();
  const renderer = new Renderer(canvas, sprites);
  const c = new Creature(host, renderer);
  creature = c;
  // Debug builds (`tauri dev` / `tauri build --debug`): creature events on the Rust console.
  if (import.meta.env.DEV || import.meta.env.TAURI_ENV_DEBUG === "true") {
    c.onEvent = (what) => void invoke("chaos_debug_log", { what }).catch(() => {});
  }
  let settings: Settings | null = null;
  try {
    settings = await api.getSettings();
    c.movement = settings.movement_enabled;
    c.chaosOn = settings.chaos_enabled ?? true;
  } catch (e) {
    console.error("could not load settings", e);
  }
  const pos = await win.outerPosition().catch(() => ({ x: 0, y: 0 }));
  await c.start({ x: pos.x, y: pos.y });

  await listen<Settings>("settings-changed", (e) => applySettings(e.payload));
  await listen<boolean>("panel-visibility", (e) => c.setPanelOpen(e.payload));
  // Unknown moods fall back to idle inside setMood.
  await listen<string>("mood", (e) => c.setMood(e.payload));
  await listen<boolean>("mascot-hover", (e) => c.setHovered(e.payload));
  // The window he stands on moved / closed / got covered (src-tauri/src/ledge_watch.rs).
  await listen<LedgeEvent>("ledge-event", (e) => c.ledgeEvent(e.payload));
  // For behaviours driven from Rust or other windows; unknown names are ignored.
  await listen<string>("mascot-action", (e) => void playAction(e.payload));
  // The bubble shows a reply: he says it (mouth moving while it appears).
  await listen<number>(MASCOT_TALK_EVENT, (e) => c.talk(Number(e.payload) || 0));
  window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener("change", () => renderer.redraw());
  // Show only now that the first frame is drawn (no blank/white flash).
  await win.show();
  // First run: open the setup wizard next to Glitch.
  if (settings && !settings.onboarding_done) void api.showPanel();
}

// Dev/testing hook: trigger animations, behaviours and moods from the console or Playwright.
if (import.meta.env.DEV) {
  (window as unknown as { __glitch: object }).__glitch = {
    play: playAction,
    /** A chaos act now: "window", "push", "chase", "note", "peek", "knock", "paws". */
    chaos: (act: string) => creature?.forceChaos(act),
    mood: (m: string) => creature?.setMood(m),
    burst: (ms?: number) => creature?.animator.glitchBurst(ms),
    face: (left: boolean) => {
      if (!creature) return;
      creature.facingLeft = left;
      creature.animator.glitchBurst(60);
    },
    get creature() {
      return creature;
    },
    get animation(): AnimationName | undefined {
      return creature?.animation;
    },
  };
}

void main();
