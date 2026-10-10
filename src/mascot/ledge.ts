// Standing on another app's window that moves: ride along or lose footing?
// Pure, so the rule is unit-tested; creature.ts applies it to every
// "ledge-event" from Rust (src-tauri/src/ledge_watch.rs).

import type { ScreenRect } from "../shared/ipc";
import type { Vec, World } from "./physics";

/** CSS px / s (times the scale). Faster sideways than this and the window slides out from under him. */
export const SLIP_SPEED = 750;
/** Dropping away faster than this (CSS px / s): he can't keep his feet on it. */
export const DROP_SPEED = 650;
/** One jump bigger than this (CSS px): snapped, maximised, restored... */
export const JUMP_PX = 90;
/** Between snapshots seconds apart: further than this and it was moved away, not dragged along. */
export const FAR_PX = 500;
/** While the user drags the window by hand, he holds on for this far (CSS px), then falls off. */
export const HOLD_ON_PX = 170;

export type LedgeReaction = { kind: "none" } | { kind: "ride"; dx: number; dy: number } | { kind: "fall"; v: Vec; why: string };

/**
 * The window he stands on went from `prev` to `next` in `dtMs`.
 * `handTravel`: how far the user has dragged it by hand since grabbing it
 * (null: not being dragged by hand). `bodyX`: his centre.
 */
export function reactToMove(prev: ScreenRect, next: ScreenRect, dtMs: number, world: World, bodyX: number, handTravel: number | null): LedgeReaction {
  const u = world.scale;
  const dx = next.x - prev.x;
  const dy = next.y - prev.y;
  if (dx === 0 && dy === 0 && next.w === prev.w) return { kind: "none" };
  const dt = Math.max(16, dtMs) / 1000;
  const vx = dx / dt;
  const vy = dy / dt;
  const fall = (why: string): LedgeReaction => ({
    kind: "fall",
    why,
    // A little of the window's sideways motion; flung up a bit if it shot upwards.
    v: { x: Math.max(-600 * u, Math.min(600 * u, vx * 0.3)), y: Math.min(0, Math.max(-500 * u, vy * 0.4)) },
  });
  // A big step within one tick (30 Hz watch): it jumped (snapped, restored...).
  // Between rare snapshots (no watch) only a really far jump counts; the rest is ridden, eased.
  const jump = dtMs <= 100 ? JUMP_PX : FAR_PX;
  if (Math.abs(dx) > jump * u || Math.abs(dy) > jump * u) return fall("jump");
  if (Math.abs(vx) > SLIP_SPEED * u) return fall("slip");
  if (vy > DROP_SPEED * u) return fall("drop");
  if (handTravel !== null && handTravel + Math.hypot(dx, dy) > HOLD_ON_PX * u) return fall("dragged");
  // No room above it any more (pushed up against the top of the screen).
  if (next.y - 60 * u < world.area.y) return fall("no-room");
  // Narrower now (resized) and he isn't over it any more.
  const x = bodyX + dx;
  if (x < next.x || x > next.x + next.w) return fall("off");
  return { kind: "ride", dx, dy };
}
