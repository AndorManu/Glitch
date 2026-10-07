// The stream overlay page (OBS browser source), served by Glitch itself at
// http://127.0.0.1:<port>/overlay?token=<view token> (src-tauri/src/stream/).
// No Tauri here: a plain web page on a transparent background. It listens
// to /overlay/events (server-sent events) for:
//   config  {mode, size, position, show_chat}
//   mirror  {animation, facing_left}   the desktop Glitch's animation
//   react   {kind, action, line, speaker}   a follow/sub/raid/chat
//   say     {line}   what he said in the desktop chat (only if the user allows it)
// "mirror" mode plays the desktop Glitch's animations in place; "walk" mode
// runs a separate Glitch (the real Creature with a fake host, like
// dev/stage.ts) walking along the bottom of the canvas.
//
// Everything from the server is drawn with textContent, never as HTML.

import { ANIMATIONS, Animator, isAnimationName } from "../mascot/animations";
import { BEHAVIOURS, type BehaviourName } from "../mascot/brain";
import { Creature, type Host } from "../mascot/creature";
import type { Vec } from "../mascot/physics";
import { Renderer, VIEW_H, VIEW_W } from "../mascot/render";
import type { WorldSnapshot } from "../shared/ipc";
import { loadGlitchSprites } from "../sprites/glitch-sprites";
import {
  clipFor,
  LineQueue,
  type OverlayConfig,
  parseConfig,
  placeX,
  type Reaction,
  readMs,
  STREAM_BEHAVIOURS,
  STREAMER_H,
  STREAMER_SCALE,
  STREAMER_W,
} from "./queue";

const token = new URLSearchParams(location.search).get("token") ?? "";
const stage = document.getElementById("stage") as HTMLDivElement;
const canvas = document.getElementById("glitch") as HTMLCanvasElement;
const clip = document.getElementById("clip") as HTMLCanvasElement;
const bubble = document.getElementById("bubble") as HTMLDivElement;
const dpr = () => window.devicePixelRatio || 1;

let config: OverlayConfig | null = null;
let creature: Creature | null = null;
let animator: Animator | null = null;
let renderer: Renderer | null = null;
/** Stage top-left, CSS px of the page. */
let pos: Vec = { x: 0, y: 0 };

function px(n: number): string {
  return `${Math.round(n)}px`;
}

/** His 160x160 "window", scaled. */
function sizeStage(cfg: OverlayConfig): void {
  for (const c of [canvas, clip]) {
    c.style.width = px(VIEW_W * cfg.size);
    c.style.height = px(VIEW_H * cfg.size);
  }
}

function placeStage(): void {
  stage.style.transform = `translate(${px(pos.x)}, ${px(pos.y)})`;
  placeBubble();
}

// ------------------------------------------------------------------ bubble

const lines = new LineQueue();
let bubbleTimer: number | null = null;

function placeBubble(): void {
  if (bubble.hidden || !config) return;
  const s = config.size;
  const w = bubble.offsetWidth;
  const h = bubble.offsetHeight;
  // Above his head (the body is in the lower ~70% of his 160 px window), kept on the page.
  const cx = pos.x + (VIEW_W * s) / 2;
  const x = Math.max(8, Math.min(window.innerWidth - w - 8, cx - w / 2));
  const y = Math.max(8, pos.y + VIEW_H * s * 0.22 - h);
  bubble.style.transform = `translate(${px(x)}, ${px(y)})`;
  bubble.style.setProperty("--tail-x", px(Math.max(14, Math.min(w - 14, cx - x))));
}

function showNextLine(): void {
  if (bubbleTimer !== null) return;
  const l = lines.next();
  if (!l) {
    bubble.hidden = true;
    return;
  }
  bubble.replaceChildren();
  if (l.speaker) {
    const who = document.createElement("b");
    who.textContent = `${l.speaker}: `;
    bubble.append(who);
  }
  bubble.append(document.createTextNode(l.text));
  bubble.hidden = false;
  bubble.classList.remove("pop");
  void bubble.offsetWidth;
  bubble.classList.add("pop");
  placeBubble();
  creature?.talk(l.text.length);
  bubbleTimer = window.setTimeout(() => {
    bubbleTimer = null;
    showNextLine();
  }, readMs(l.text));
}

function say(text: string, speaker: string | null, alert: boolean): void {
  if (!text) return;
  lines.push({ text, speaker, alert });
  showNextLine();
}

// ------------------------------------------------------------- streamer clip

const streamerArt = new Image();
streamerArt.src = "/sprites/streamer.png";
let clipTimer: number | null = null;

function playClip(frames: number[], ms: number): void {
  if (!config || !streamerArt.complete || streamerArt.naturalWidth === 0) return;
  if (clipTimer !== null) window.clearTimeout(clipTimer);
  const s = config.size;
  const ratio = s * dpr();
  // The 160x160 window, feet 4 px above its bottom, body centred (like render.ts).
  clip.width = Math.round(VIEW_W * ratio);
  clip.height = Math.round(VIEW_H * ratio);
  const ctx = clip.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  const w = STREAMER_W * STREAMER_SCALE;
  const h = STREAMER_H * STREAMER_SCALE;
  const x = (VIEW_W - w) / 2;
  const y = VIEW_H - 4 - h;
  let i = 0;
  const step = () => {
    if (i >= frames.length) {
      clipTimer = null;
      clip.hidden = true;
      canvas.hidden = false;
      return;
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, VIEW_W, VIEW_H);
    ctx.drawImage(streamerArt, frames[i] * STREAMER_W, 0, STREAMER_W, STREAMER_H, x, y, w, h);
    clip.hidden = false;
    canvas.hidden = true;
    i++;
    clipTimer = window.setTimeout(step, ms);
  };
  step();
}

function react(r: Reaction): void {
  if (!config) return;
  if (r.kind === "chat" && !config.show_chat) return;
  const c = clipFor(r.kind);
  if (c) playClip(c.frames, c.ms);
  else creature?.playAction(r.action);
  say(r.line, r.speaker, r.kind !== "chat");
}

// ----------------------------------------------------------------- mirror

async function startMirror(cfg: OverlayConfig): Promise<void> {
  sizeStage(cfg);
  const sprites = await loadGlitchSprites(cfg.size * dpr());
  const r = new Renderer(canvas, sprites, { pixelRatio: () => cfg.size * dpr() });
  r.contact = true;
  renderer = r;
  animator = new Animator((pose, tick) => r.render(pose, tick), ANIMATIONS);
  animator.play("idle");
  const place = () => {
    const w = VIEW_W * cfg.size;
    pos = { x: placeX(cfg.position, window.innerWidth, w), y: window.innerHeight - VIEW_H * cfg.size };
    placeStage();
  };
  place();
  window.addEventListener("resize", place);
}

function mirror(m: { animation?: unknown; facing_left?: unknown }): void {
  if (!animator || !renderer || !isAnimationName(m.animation)) return;
  const left = m.facing_left === true;
  renderer.facingLeft = left;
  animator.mem.facingLeft = left;
  // Walking/running/flying in place looks odd on a fixed spot: show them standing.
  const still = ["walk", "run", "climb", "airUp", "airDown", "tumble", "flail", "fall", "held", "heldKick", "dangle"];
  animator.play(still.includes(m.animation) ? "idle" : m.animation);
}

// ------------------------------------------------------------------- walk

async function startWalk(cfg: OverlayConfig): Promise<void> {
  // This page's own copy of the brain: the stream Glitch stays on the floor
  // (no climbing the canvas edges, no teleports onto the ceiling).
  for (const name of Object.keys(BEHAVIOURS) as BehaviourName[]) {
    if (!STREAM_BEHAVIOURS.has(name)) BEHAVIOURS[name].weight = 0;
  }
  sizeStage(cfg);
  const sprites = await loadGlitchSprites(cfg.size * dpr());
  const r = new Renderer(canvas, sprites, { pixelRatio: () => cfg.size * dpr() });
  renderer = r;
  const world = (): WorldSnapshot => ({ area: { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }, scale: cfg.size, ledges: [] });
  const host: Host = {
    moveWindow: (x, y) => {
      pos = { x, y };
      placeStage();
    },
    world: async () => world(),
    // No mouse on a stream: far away, so he never reacts to it.
    cursor: () => ({ x: -1e6, y: -1e6 }),
    setHitbox: () => {},
    clicked: () => {},
  };
  const c = new Creature(host, r);
  creature = c;
  const w = VIEW_W * cfg.size;
  await c.start({ x: placeX(cfg.position, window.innerWidth, w), y: window.innerHeight - VIEW_H * cfg.size });
}

// ----------------------------------------------------------------- events

function connect(): void {
  const es = new EventSource(`/overlay/events?token=${encodeURIComponent(token)}`);
  const json = (e: Event): unknown => {
    try {
      return JSON.parse((e as MessageEvent<string>).data);
    } catch {
      return null;
    }
  };
  es.addEventListener("config", (e) => {
    const next = parseConfig(json(e));
    if (!config) {
      config = next;
      void (next.mode === "walk" ? startWalk(next) : startMirror(next));
      return;
    }
    // A new mode or size: start over (the stream picks it up without touching OBS).
    if (next.mode !== config.mode || next.size !== config.size) {
      location.reload();
      return;
    }
    config = next;
    if (next.mode === "mirror") window.dispatchEvent(new Event("resize"));
  });
  es.addEventListener("mirror", (e) => {
    if (config?.mode === "mirror") mirror((json(e) ?? {}) as { animation?: unknown; facing_left?: unknown });
  });
  es.addEventListener("react", (e) => {
    const r = json(e) as Reaction | null;
    if (r && typeof r.line === "string" && typeof r.kind === "string") react(r);
  });
  es.addEventListener("say", (e) => {
    const s = json(e) as { line?: unknown } | null;
    if (s && typeof s.line === "string") say(s.line, null, false);
  });
}

// Debug hook for the page check (dev/overlay-check.mjs): state only.
(window as unknown as { __overlay: object }).__overlay = {
  get config() {
    return config;
  },
  get animation() {
    return creature?.animation ?? animator?.animation ?? null;
  },
  get pos() {
    return { ...pos };
  },
  get bubble() {
    return bubble.hidden ? null : bubble.textContent;
  },
  get clip() {
    return !clip.hidden;
  },
};

connect();
