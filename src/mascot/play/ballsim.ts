// The fetch ball as a little physics toy. Pure (no DOM, no Tauri): the
// mascot page steps it and sends the picture to the play overlay
// (playfield.html), which only draws.
//
// Flight is Glitch's own flight physics (physics.ts stepAir) on a world
// grown so that his body centre is the ball's centre (rules.ts ballWorld);
// on top of that: a bouncier ball (restitution ~0.55, spin from the
// sideways speed), rolling with friction along the floor and window tops
// (it rolls off their ends and falls), rebounds off the screen edges, and
// the looks: the roll frame from the distance actually travelled, squash on
// impact, stretch at speed, a short pixel trail, sparks on hard hits, a
// ground shadow, a rare glitch jitter and a glow pulse while it rests.

import {
  type Body,
  HALF,
  isTop,
  restCenter,
  stepAir,
  type Surface,
  type World,
} from "../physics";
import { ballWorld, BALL_R } from "./rules";

/** Restitution of a bounce (vertical speed kept). */
export const BOUNCE = 0.55;
/** Slower than this on impact (CSS px/s): it stops bouncing and rolls. */
export const SETTLE_SPEED = 150;
/** Rolling friction, CSS px/s². */
export const ROLL_FRICTION = 520;
/** Slower than this (CSS px/s) while rolling: it comes to rest. */
export const REST_SPEED = 12;
/** Fastest throw, CSS px/s. */
export const MAX_THROW = 3000;
/** Above this speed (CSS px/s): stretched along the motion, with a trail. */
export const FAST = 900;
/** Hard impacts (CSS px/s) throw sparks. */
export const SPARK_SPEED = 950;
/** Roll loop frames per full turn. */
export const ROLL_FRAMES = 8;

export type BallMode = "air" | "roll" | "rest";

export interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
}

export interface BallSim {
  /** Centre, physical px; velocity physical px/s. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  mode: BallMode;
  /** Where it rolls / rests (roll and rest modes). */
  surface: Surface | null;
  /** Rotation, radians (+ = clockwise on screen); from the distance rolled or the spin in the air. */
  angle: number;
  /** Radians per second in the air. */
  spin: number;
  /** 0-1, eases out after an impact. */
  squash: number;
  /** Recent centres (physical px), newest first, while fast. */
  trail: { x: number; y: number }[];
  sparks: Spark[];
  /** ms left of a glitch flicker. */
  glitch: number;
  /** Sideways glitch jitter (CSS px). */
  jitter: number;
  /** Time resting (s), for the glow pulse. */
  restT: number;
}

export function newBall(x: number, y: number, vx = 0, vy = 0): BallSim {
  return { x, y, vx, vy, mode: "air", surface: null, angle: 0, spin: 0, squash: 0, trail: [], sparks: [], glitch: 0, jitter: 0, restT: 0 };
}

export interface StepResult {
  /** It just stopped bouncing (rolling or resting now) on this surface. */
  settled?: Surface;
  /** It just came to rest. */
  rested?: Surface;
  /** Impact speed (CSS px/s), if it hit something this step. */
  impact?: number;
}

/**
 * Advance the ball `dt` seconds in `world` (the real one). `bw` is
 * ballWorld(world), passed in so it isn't rebuilt every frame.
 */
export function stepSim(b: BallSim, world: World, dt: number, rand: () => number = Math.random, bw: World = ballWorld(world)): StepResult {
  const u = world.scale;
  const out: StepResult = {};
  const x0 = b.x;
  b.squash = Math.max(0, b.squash - dt * 6);
  b.glitch = Math.max(0, b.glitch - dt * 1000);
  if (b.glitch <= 0) b.jitter = 0;
  for (const s of b.sparks) {
    s.age += dt;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.vy += 900 * u * dt;
  }
  b.sparks = b.sparks.filter((s) => s.age < 0.35);

  if (b.mode === "air") {
    const body: Body = { x: b.x, y: b.y, vx: b.vx, vy: b.vy, angle: 0, spin: 0 };
    let vx = b.vx;
    const contacts = stepAir(body, bw, dt, { drag: true, canSplat: false, keepSpin: true });
    for (const c of contacts) {
      if (c.kind === "bounce") {
        const speed = c.speed;
        if (c.side === "floor" || c.side === "top") {
          // stepAir bounces bodies softly; a ball is livelier.
          body.vy = -speed * BOUNCE * u;
          body.vx = vx * 0.92;
        }
        vx = body.vx;
        hit(b, body.x, body.y, speed, c.side, rand, u, out);
        continue;
      }
      // Landed (slow enough for Glitch's physics): bounce on, or settle and roll.
      const landed = c.surface;
      // Back from the ball world (tops lowered) to the real window top.
      const surface: Surface = isTop(landed) ? { kind: "ledge", ledge: world.ledges.find((l) => l.id === landed.ledge.id) ?? landed.ledge } : landed;
      hit(b, body.x, body.y, c.speed, "floor", rand, u, out);
      if (c.speed > SETTLE_SPEED) {
        body.vy = -c.speed * BOUNCE * u;
        body.vx = vx * 0.92;
      } else {
        b.mode = "roll";
        b.surface = surface;
        body.vx = vx * 0.9;
        body.vy = 0;
        out.settled = surface;
      }
    }
    b.x = body.x;
    b.y = body.y;
    b.vx = body.vx;
    b.vy = body.vy;
    // Spin follows the sideways speed (a thrown ball turns as it flies).
    b.spin += ((b.vx / u / (BALL_R * 1)) - b.spin) * Math.min(1, dt * 2);
    b.angle += b.spin * dt * 0.6;
  } else if (b.mode === "roll" && b.surface) {
    const s = b.surface;
    const f = ROLL_FRICTION * u * dt;
    b.vx = Math.abs(b.vx) <= f ? 0 : b.vx - Math.sign(b.vx) * f;
    b.x += b.vx * dt;
    const a = world.area;
    const lo = a.x + BALL_R * u;
    const hi = a.x + a.w - BALL_R * u;
    if (b.x < lo || b.x > hi) {
      // Rebounds off the screen edge.
      b.x = b.x < lo ? lo : hi;
      hit(b, b.x, b.y, Math.abs(b.vx) / u, b.vx < 0 ? "left" : "right", rand, u, out);
      b.vx = -b.vx * BOUNCE;
    }
    if (isTop(s) && (b.x < s.ledge.x || b.x > s.ledge.x + s.ledge.w)) {
      // Rolled off the end of a window top: falls.
      b.mode = "air";
      b.surface = null;
      b.vy = 0;
    } else {
      b.y = restCenter(s, b.x, world).y + (HALF - BALL_R) * u;
      if (Math.abs(b.vx) < REST_SPEED * u) {
        b.vx = 0;
        b.mode = "rest";
        b.restT = 0;
        out.rested = s;
      }
    }
    b.angle += (b.x - x0) / (BALL_R * u);
  } else if (b.mode === "rest") {
    b.restT += dt;
  }

  // Trail while fast.
  const speed = Math.hypot(b.vx, b.vy) / u;
  if (speed > FAST && b.mode === "air") b.trail.unshift({ x: b.x, y: b.y });
  else if (b.trail.length) b.trail.pop();
  if (b.trail.length > 7) b.trail.length = 7;
  // A rare glitch while it moves.
  if (b.mode !== "rest" && b.glitch <= 0 && rand() < dt * 0.6) {
    b.glitch = 90;
    b.jitter = (rand() < 0.5 ? -1 : 1) * (2 + Math.floor(rand() * 3));
  }
  return out;
}

function hit(b: BallSim, x: number, y: number, speed: number, side: string, rand: () => number, u: number, out: StepResult): void {
  out.impact = Math.max(out.impact ?? 0, speed);
  b.squash = Math.max(b.squash, Math.min(1, speed / 1400));
  if (speed < SPARK_SPEED) return;
  const n = 3 + Math.floor(rand() * 3);
  const away = side === "left" ? 1 : side === "right" ? -1 : 0;
  for (let i = 0; i < n; i++) {
    const a = Math.PI * (1 + rand()); // upwards half
    b.sparks.push({ x, y: y + BALL_R * u * (side === "floor" || side === "top" ? 1 : 0), vx: (Math.cos(a) * 220 + away * 160) * u, vy: Math.sin(a) * 260 * u, age: 0 });
  }
}

/** Throw it (from being held / a toss): airborne with this velocity, clamped. */
export function throwBall(b: BallSim, vx: number, vy: number, u: number): void {
  const s = Math.hypot(vx, vy);
  const max = MAX_THROW * u;
  const k = s > max ? max / s : 1;
  b.vx = vx * k;
  b.vy = vy * k;
  b.mode = "air";
  b.surface = null;
  b.spin = b.vx / u / BALL_R;
}

/** Roll loop frame (0..ROLL_FRAMES-1) for the angle (rolls the right way both ways). */
export function rollFrame(angle: number): number {
  const turn = angle / (2 * Math.PI);
  const f = Math.floor((turn - Math.floor(turn)) * ROLL_FRAMES);
  return Math.min(ROLL_FRAMES - 1, Math.max(0, f));
}

/** What the overlay draws (CSS px relative to the work area's top-left). */
export interface BallPicture {
  x: number;
  y: number;
  r: number;
  /** Roll loop frame. */
  frame: number;
  angle: number;
  squash: number;
  /** 0-1 stretch along `dir` (radians) at speed. */
  stretch: number;
  dir: number;
  /** CSS px above the ground below it (shadow size), null = no ground in sight. */
  height: number | null;
  /** Ground y (CSS px) for the shadow. */
  groundY: number;
  trail: { x: number; y: number }[];
  sparks: { x: number; y: number; a: number }[];
  glitch: boolean;
  jitter: number;
  /** Glow pulse 0-1 while resting (and when hovered). */
  glow: number;
  hidden: boolean;
}

/** The ground right under the ball: the floor or the highest window top below it. */
export function groundBelow(world: World, x: number, y: number): number {
  let g = world.area.y + world.area.h;
  for (const l of world.ledges) if (x >= l.x && x <= l.x + l.w && l.y >= y && l.y < g) g = l.y;
  return g;
}

export function picture(b: BallSim, world: World, hover = false, hidden = false): BallPicture {
  const u = world.scale;
  const a = world.area;
  const speed = Math.hypot(b.vx, b.vy) / u;
  const ground = groundBelow(world, b.x, b.y);
  const height = (ground - (b.y + BALL_R * u)) / u;
  const glow = b.mode === "rest" ? 0.5 + 0.5 * Math.sin(b.restT * 3.2) : 0;
  return {
    x: (b.x - a.x) / u + b.jitter,
    y: (b.y - a.y) / u,
    r: BALL_R,
    frame: rollFrame(b.angle),
    angle: b.angle,
    squash: b.squash,
    stretch: b.mode === "air" ? Math.min(1, Math.max(0, (speed - FAST) / 1600)) : 0,
    dir: Math.atan2(b.vy, b.vx),
    height: height < 400 ? Math.max(0, height) : null,
    groundY: (ground - a.y) / u,
    trail: b.trail.map((p) => ({ x: (p.x - a.x) / u, y: (p.y - a.y) / u })),
    sparks: b.sparks.map((s) => ({ x: (s.x - a.x) / u, y: (s.y - a.y) / u, a: 1 - s.age / 0.35 })),
    glitch: b.glitch > 0,
    jitter: b.jitter,
    glow: hover ? 1 : glow,
    hidden,
  };
}
