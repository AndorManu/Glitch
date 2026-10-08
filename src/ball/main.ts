// The fetch ball window: draws the glowing glitch ball and reports grabs and
// releases to the mascot (which moves this window and throws the ball, see
// src/mascot/play/games.ts). Esc or right-click ends the game.

import { emitTo } from "@tauri-apps/api/event";
import { drawBallAt } from "../mascot/accessories";

const canvas = document.getElementById("ball") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
let tick = 0;

function draw(): void {
  const dpr = window.devicePixelRatio || 1;
  const size = Math.round(44 * dpr);
  if (canvas.width !== size) canvas.width = canvas.height = size;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, size, size);
  drawBallAt(ctx, size / 2, size / 2, 9 * dpr, tick++);
}

// A slow shimmer (4 repaints a second), only while the ball is on screen.
let timer: ReturnType<typeof setInterval> | null = null;
function shimmer(on: boolean): void {
  if (timer) clearInterval(timer);
  timer = on ? setInterval(draw, 250) : null;
}
document.addEventListener("visibilitychange", () => shimmer(!document.hidden));
draw();
shimmer(!document.hidden);

const send = (what: string) => void emitTo("mascot", what).catch(() => {});
let held = false;
canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  held = true;
  canvas.setPointerCapture(e.pointerId);
  send("ball-grab");
});
const letGo = () => {
  if (!held) return;
  held = false;
  send("ball-release");
};
canvas.addEventListener("pointerup", letGo);
canvas.addEventListener("pointercancel", letGo);
canvas.addEventListener("lostpointercapture", letGo);
window.addEventListener("blur", letGo);
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") send("ball-quit");
});
window.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  send("ball-quit");
});
