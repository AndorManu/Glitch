// Games, play and growth: the pure parts (unit-tested in rules.test.ts).
// Which animation to play for a game moment (new art by name, with
// fallbacks until it is in the sheet), the fetch ball's physics (the same
// flight physics as Glitch, for a small round body), how he gets somewhere
// (walk, jump or glitch there), and where he hides.

import { type AnimationName, isAnimationName } from "../animations";
import type { Step } from "../brain";
import {
  clampTo,
  HALF,
  isStanding,
  isTop,
  planJump,
  restCenter,
  type Surface,
  surfaceRange,
  type Vec,
  type World,
} from "../physics";

// ------------------------------------------------------------ animations

/**
 * Animations the games ask for, and what to play until they exist in
 * animations.ts (first that exists wins; "idle" at worst).
 */
export const PLAY_ANIMS: Record<string, readonly string[]> = {
  /**
   * Trotting back with the ball in his mouth. The real clip (chase the ball, pick it up, stand with it) is
   * drawn for the pick-up beat; as a loop while he WALKS its first frames would show a second ball on the floor,
   * so the trot itself stays on the walk cycle until a carry cycle is drawn.
   */
  fetch_ball: ["walk"],
  /** Sitting, tail wagging, waiting for the next throw (the drawn sitting tail loop). */
  idle_tail: ["idle_tail_sit", "sit", "happy", "idle"],
  /** Watching the ball fly, ready to run: the eyes follow (look_dirs). */
  ready: ["look_dirs", "listen", "idle"],
  /** Batting the ball along. */
  bat: ["happy"],
  /** The end of a game: a little bow. */
  bow: ["high_five", "wave", "happy"],
  /** Peeking out from behind an edge (only his head shows). */
  hide_peek: ["hide_peek", "listen", "idle"],
  /** After a meal, for the rest of the day. */
  chubby_idle: ["chubby_idle", "idle"],
  eat: ["eat", "happy"],
  /** After eating. */
  burp: ["sneeze", "happy"],
  celebrate: ["celebrate", "happy"],
  dance: ["dance", "happy"],
  laugh: ["laugh", "happy"],
  /** He noticed a file coming his way. */
  sniff: ["listen", "lookAround"],
};

export function playAnim(name: string, has: (n: string) => boolean = isAnimationName): AnimationName {
  // The table first (it names the real clip, or the one that fits the moment better), then the name itself.
  for (const f of PLAY_ANIMS[name] ?? []) if (has(f)) return f as AnimationName;
  if (has(name)) return name as AnimationName;
  return "idle";
}

// ------------------------------------------------------------------- ball

/** Ball radius, CSS px (the play overlay draws it this size). */
export const BALL_R = 12;
/**
 * Glitch's flight physics works on a body HALF css px "tall": a world grown
 * by (HALF - r) on every side, with window tops lowered by the same amount,
 * makes that body's centre exactly the centre of a ball of radius r.
 */
export function ballWorld(w: World, r = BALL_R): World {
  const d = (HALF - r) * w.scale;
  return {
    ...w,
    area: { x: w.area.x - d, y: w.area.y - d, w: w.area.w + 2 * d, h: w.area.h + 2 * d },
    ledges: w.ledges.map((l) => ({ ...l, y: l.y + d })),
  };
}

// ------------------------------------------------------------- getting there

function sameSurface(a: Surface, b: Surface): boolean {
  if (a.kind !== b.kind) return false;
  return !isTop(a) || (isTop(b) && a.ledge.id === b.ledge.id);
}

/**
 * Steps from where he is to coordinate `s` on surface `to`: walk (same
 * surface), a planned jump (in reach), or glitch-teleport there.
 */
export function route(
  from: { surface: Surface; body: Vec; s: number },
  to: Surface,
  s: number,
  world: World,
  walk: { gait: "walk" | "run"; anim?: AnimationName } = { gait: "run" },
): Step[] {
  const at = clampTo(to, s, world);
  if (sameSurface(from.surface, to) && isStanding(to)) return [{ do: "walk", to: at, gait: walk.gait, anim: walk.anim }];
  if (isStanding(from.surface)) {
    const target = restCenter(to, at, world);
    if (planJump(from.body, target, world)) {
      return [
        { do: "face", dir: target.x >= from.body.x ? 1 : -1 },
        { do: "jump", to: target, ledgeId: isTop(to) ? to.ledge.id : undefined },
      ];
    }
  }
  return [{ do: "teleport", surface: to, s: at }];
}

/** Where to bring the ball: the window top right under the cursor, else the floor below it. */
export function surfaceNear(world: World, p: Vec): { surface: Surface; s: number } {
  const u = world.scale;
  let best: { surface: Surface; d: number } | null = null;
  for (const l of world.ledges) {
    if (p.x < l.x + 20 * u || p.x > l.x + l.w - 20 * u) continue;
    const d = l.y - p.y;
    if (d < -30 * u) continue; // above the cursor: not "under" it
    if (!best || d < best.d) best = { surface: { kind: "ledge", ledge: l }, d };
  }
  const surface: Surface = best ? best.surface : { kind: "floor" };
  return { surface, s: clampTo(surface, p.x, world) };
}

// --------------------------------------------------------------- hiding

/** How far he sinks behind the edge (CSS px): only his ears and eyes show. */
export const HIDE_SINK = 44;

/** A hiding spot away from the cursor: a screen edge, the taskbar, or behind a window top. */
export function hideSpot(world: World, cursor: Vec, rand: () => number): { surface: Surface; s: number } {
  const u = world.scale;
  const a = world.area;
  const options: { surface: Surface; s: number }[] = [];
  for (const kind of ["left", "right"] as const) {
    const surface: Surface = { kind };
    const [lo, hi] = surfaceRange(surface, world);
    options.push({ surface, s: lo + (hi - lo) * (0.25 + 0.6 * rand()) });
  }
  const floor: Surface = { kind: "floor" };
  const [flo, fhi] = surfaceRange(floor, world);
  options.push({ surface: floor, s: flo + (fhi - flo) * rand() });
  for (const l of world.ledges) {
    if (l.w < 160 * u) continue;
    const surface: Surface = { kind: "ledge", ledge: l };
    const [lo, hi] = surfaceRange(surface, world);
    options.push({ surface, s: lo + (hi - lo) * rand() });
  }
  // Far from the cursor, with some luck in it.
  let best = options[0];
  let bestScore = -Infinity;
  for (const o of options) {
    const c = restCenter(o.surface, o.s, world);
    const score = Math.hypot(c.x - cursor.x, c.y - cursor.y) / Math.max(a.w, a.h) + rand() * 0.6;
    if (score > bestScore) {
      bestScore = score;
      best = o;
    }
  }
  return best;
}
