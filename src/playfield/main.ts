// The play overlay page (playfield.html): draws the fetch ball pictures the
// mascot sends ("ball-frame"), tells the mascot when the ball is pressed /
// let go, pops the ball at the end ("ball-end"). Rust keeps the window
// click-through except right over the ball (src-tauri/src/play.rs).
// Nothing runs while no picture arrives (no frame loop).

import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import type { BallPicture } from "../mascot/play/ballsim";
import { type BallArt, codeBall, drawBall, drawPop, sheetBall } from "./draw";

const canvas = document.getElementById("play") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
let art: BallArt = codeBall();
void sheetBall().then((a) => {
  if (a) art = a;
});
let last: BallPicture | null = null;
let shown = false;

function fit(): number {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(window.innerWidth * dpr);
  const h = Math.round(window.innerHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return dpr;
}

function paint(p: BallPicture | null): void {
  const dpr = fit();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (p) drawBall(ctx, art, p, dpr);
  if (!shown) {
    // Only now (something drawn, transparent everywhere else) may it appear: no flash.
    shown = true;
    void invoke("playfield_ready").catch(() => {});
  }
}

void listen<BallPicture>("ball-frame", (e) => {
  last = e.payload;
  paint(last);
});
void listen("ball-begin", () => {
  shown = false;
  popping = false;
  paint(last);
});
void listen<boolean>("ball-hover", (e) => canvas.classList.toggle("over", !!e.payload));

let popping = false;
void listen("ball-end", () => {
  const at = last;
  if (popping) return;
  popping = true;
  const dpr = fit();
  const t0 = performance.now();
  const step = () => {
    const t = Math.min(1, (performance.now() - t0) / 450);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (at && !at.hidden) drawPop(ctx, at.x, at.y, t, dpr);
    if (t < 1) return void setTimeout(step, 33);
    last = null;
    shown = false;
    popping = false;
    void invoke("playfield_idle").catch(() => {});
  };
  step();
});

// Pressing the ball: the mascot sticks it to the cursor; letting go throws it.
const send = (what: string) => void emitTo("mascot", what).catch(() => {});
let held = false;
canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  held = true;
  canvas.classList.add("held");
  canvas.setPointerCapture(e.pointerId);
  void invoke("ball_hold", { held: true }).catch(() => {});
  send("ball-grab");
});
const letGo = () => {
  if (!held) return;
  held = false;
  canvas.classList.remove("held");
  void invoke("ball_hold", { held: false }).catch(() => {});
  send("ball-release");
};
canvas.addEventListener("pointerup", letGo);
canvas.addEventListener("pointercancel", letGo);
canvas.addEventListener("lostpointercapture", letGo);
window.addEventListener("blur", letGo);
window.addEventListener("contextmenu", (e) => e.preventDefault());
