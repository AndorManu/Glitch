// Glitch as a creature: body + physics + brain + animator, driving the
// mascot window. No DOM and no Tauri here (both come in through `Host` and
// `View`), so the whole life cycle runs on a fake clock in the tests and on
// a fake desktop in dev/stage.html.
//
// Timers (never requestAnimationFrame):
// - the Animator's one keyframe timer (about 1/s while idle);
// - the brain timer: one pending at most (rest, or the current step's wait);
// - the motion timer, ONLY while the window actually moves: 30 Hz walking,
//   climbing and settling, 60 Hz in the air or while held;
// - the ledge watch (2.5 s) only while awake on another app's window top.
// While moving, a repaint happens only when the picture changes (a new key,
// a new angle); the window move alone carries a walking sprite.

import { ANIMATIONS, type AnimationName, Animator, type Clock, isAnimationName, landKeys, type Pose } from "./animations";
import { type BehaviourName, Brain, type BrainContext, isBehaviourName, type Plan, type Gait } from "./brain";
import { capSpeed, Pendulum, VelocityTracker } from "./drag";
import {
  type Body,
  centerFor,
  clampTo,
  coordOf,
  cornerAt,
  facesLeftFor,
  feetInWindow,
  findLedge,
  FLOOR,
  HALF,
  isStanding,
  isTop,
  PHYS,
  planJump,
  restCenter,
  stepAir,
  type Contact,
  type Surface,
  surfaceAngle,
  type Vec,
  windowFor,
  type World,
} from "./physics";
import type { Ledge } from "../shared/ipc";
import { type BodyRect, CALM, type Ghost, type Motion, type Placement, type PlatformFx } from "./render";

export interface CreatureClock extends Clock {
  now(): number;
}

/** The outside world: the OS window, the screen, the mouse. Physical px. */
export interface Host {
  moveWindow(x: number, y: number): void | Promise<unknown>;
  world(): Promise<World>;
  cursor(): Vec | Promise<Vec>;
  /** Window-local CSS px rect that catches the mouse, or null for the whole window. */
  setHitbox(rect: BodyRect | null): void;
  /** A plain click (no drag) on Glitch. */
  clicked(): void;
}

/** What creature.ts needs from the renderer (render.ts `Renderer` fits). */
export interface View {
  facingLeft: boolean;
  placement: Placement;
  motion: Motion;
  platform: PlatformFx | null;
  bodyRect: BodyRect | null;
  render(pose: Pose, tick: number): void;
}

export type Mood = "thinking" | "happy" | "asking" | "idle" | "listening";
const MOODS: readonly string[] = ["thinking", "happy", "asking", "idle", "listening"];

type Mode = "stand" | "corner" | "air" | "held";

export const SLEEP_AFTER_MS = 10 * 60_000;
/** Never ask the OS about windows more often than this. */
export const WORLD_MIN_MS = 1500;
/** While awake on a window top: check it is still there (ride along / fall). */
export const LEDGE_WATCH_MS = 2500;
const WALK_FRAME_MS = 34; // ~30 Hz
const AIR_FRAME_MS = 18; // ~55 Hz (under the 60/s cap even with the odd extra move)
const DRAG_THRESHOLD = 4; // CSS px
/** Looping actions triggered from outside stop on their own after this long. */
const ACTION_LOOP_MAX_MS = 8000;
/** CSS px / s. */
const SPEED: Record<Gait, number> = { walk: 70, run: 180, climb: 82 };
const ACCEL = 700; // CSS px / s^2
const MAX_THROW = 3800;
const CORNER_MS = 380;

const now0 = (): CreatureClock => ({
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  now: () => performance.now(),
});

interface Loco {
  to: number;
  gait: Gait;
  v: number;
  dir: number;
  freezeUntil: number;
  skip: number;
  nextGlitchAt: number;
}

interface Flight {
  drag: boolean;
  canSplat: boolean;
  planned: boolean;
  panic: boolean;
  airTime: number;
  keepSpin: boolean;
  ledgeId?: number;
  build?: { done: boolean };
}

interface Hold {
  cursor: Vec;
  busy: boolean;
  L: number;
  phi0: number;
  angle0: number;
  pivotY: number;
  pend: Pendulum;
  tracker: VelocityTracker;
  vs: Vec;
  kickUntil: number;
}

interface Platform {
  ledge: Ledge;
  build: number;
  fade: number;
  breaking: boolean;
}

export interface CreatureStats {
  moves: number;
  renders: number;
  worldPolls: number;
  motionTicks: number;
  /** Total ms with the motion timer running (the window moving). */
  movingMs: number;
  hitboxes: number;
}

export class Creature {
  readonly animator: Animator;
  readonly brain: Brain;
  readonly stats: CreatureStats = { moves: 0, renders: 0, worldPolls: 0, motionTicks: 0, movingMs: 0, hitboxes: 0 };
  world: World | null = null;
  mode: Mode = "stand";
  surface: Surface = FLOOR;
  /** Centre coordinate along the surface (physical px). */
  s = 0;
  body: Body = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, spin: 0 };
  plan: Plan | null = null;
  asleep = false;
  movement = true;
  panelOpen = false;
  mood: Mood = "idle";
  hovered = false;
  facingLeft = false;
  /** Called when something worth logging happens (dev stage). */
  onEvent: ((what: string) => void) | null = null;

  private readonly clock: CreatureClock;
  private readonly rand: () => number;
  /** 1 = feet at the window edge (standing), 0 = centred (flying). */
  private k = 1;
  private win: Vec = { x: 0, y: 0 };
  private moveInFlight = false;
  private pendingMove: Vec | null = null;
  private pose: Pose | null = null;
  private poseTick = 0;
  private dirty = false;
  private placementKey = "";
  private motion: Motion = CALM;
  private motionTimer: unknown = null;
  private lastTick = 0;
  private motionStart = 0;
  private brainTimer: unknown = null;
  private pollTimer: unknown = null;
  private actionTimer: unknown = null;
  private worldAt = -Infinity;
  private worldPending: Promise<World | null> | null = null;
  private stepIndex = 0;
  private planStarted = 0;
  private loco: Loco | null = null;
  private corner: { from: Vec; to: Vec; a0: number; a1: number; t0: number; next: { surface: Surface; s: number } } | null = null;
  private flight: Flight | null = null;
  private hold: Hold | null = null;
  private press: { local: Vec } | null = null;
  private platform: Platform | null = null;
  private teleportTo: { surface: Surface; s: number } | null = null;
  private waiting: { name: AnimationName; fn: () => void } | null = null;
  private lastInteraction = 0;
  private excitedUntil = -Infinity;
  private sentHitbox: BodyRect | null | undefined = undefined;
  /** start() has placed the body. */
  private started = false;

  constructor(
    private readonly host: Host,
    private readonly view: View,
    opts: { clock?: CreatureClock; random?: () => number } = {},
  ) {
    this.clock = opts.clock ?? now0();
    this.rand = opts.random ?? Math.random;
    this.brain = new Brain(this.rand);
    this.animator = new Animator(
      (pose, tick) => {
        this.pose = pose;
        this.poseTick = tick;
        this.dirty = true;
        // While the window moves, the motion tick paints (once per tick).
        if (this.motionTimer === null) this.place();
      },
      ANIMATIONS,
      this.clock,
      this.rand,
    );
    this.animator.onChange = (name) => this.animationChanged(name);
  }

  private get now(): number {
    return this.clock.now();
  }

  private get u(): number {
    return this.world?.scale ?? 1;
  }

  /** Where the window is (last position asked for). */
  get windowPos(): Vec {
    return { ...this.win };
  }

  get animation(): AnimationName {
    return this.animator.animation;
  }

  /** Is the motion timer running (= the window is moving)? */
  get moving(): boolean {
    return this.motionTimer !== null;
  }

  // =============================================================== start

  /** Begin life where the window is now: stand on what's under him, or fall onto it. */
  async start(window: Vec): Promise<void> {
    this.win = { ...window };
    this.lastInteraction = this.now;
    const w = await this.pollWorld();
    if (!w) return;
    const u = w.scale;
    const c = centerFor(window, 0, 1, u);
    this.body = { x: c.x, y: c.y, vx: 0, vy: 0, angle: 0, spin: 0 };
    const near = (y: number) => y - c.y >= -48 * u && y - c.y <= 48 * u;
    const top = w.ledges.find((l) => c.x >= l.x && c.x <= l.x + l.w && near(l.y - HALF * u));
    this.started = true;
    this.animator.play(this.restAnim());
    if (top) this.settle({ kind: "ledge", ledge: top });
    else if (near(restCenter(FLOOR, c.x, w).y)) this.settle(FLOOR);
    else this.launch({ x: 0, y: 0 }, { planned: false, panic: false, canSplat: false });
    this.scheduleBrain(2500 + this.rand() * 3500);
  }

  /** Stop every timer (tests, page unload). */
  dispose(): void {
    this.animator.stop();
    for (const t of [this.motionTimer, this.brainTimer, this.pollTimer, this.actionTimer]) if (t !== null) this.clock.clearTimeout(t);
    this.motionTimer = this.brainTimer = this.pollTimer = this.actionTimer = null;
  }

  private settle(surface: Surface): void {
    const w = this.world!;
    this.surface = surface;
    this.s = clampTo(surface, coordOf(surface, this.body), w);
    const c = restCenter(surface, this.s, w);
    this.body = { x: c.x, y: c.y, vx: 0, vy: 0, angle: surfaceAngle(surface.kind), spin: 0 };
    this.mode = "stand";
    if (surface.kind !== "platform") this.k = 1;
    this.place();
    this.armLedgeWatch();
    this.ensureMotion();
  }

  // =========================================================== the world

  /** A fresh world snapshot, at most every WORLD_MIN_MS (else the cached one). */
  private pollWorld(): Promise<World | null> {
    if (this.worldPending) return this.worldPending;
    if (this.world && this.now - this.worldAt < WORLD_MIN_MS) return Promise.resolve(this.world);
    this.worldAt = this.now;
    this.stats.worldPolls++;
    this.worldPending = this.host.world().then(
      (w) => {
        this.worldPending = null;
        this.applyWorld(w);
        return this.world;
      },
      () => {
        this.worldPending = null;
        return this.world;
      },
    );
    return this.worldPending;
  }

  /** New snapshot: follow the window he stands on, or fall if it went away. */
  private applyWorld(w: World): void {
    this.world = w;
    if (!this.started || this.mode !== "stand" || this.asleep) return;
    const u = w.scale;
    const s = this.surface;
    if (s.kind === "platform") return;
    if (s.kind !== "ledge") {
      // The screen may have changed (resolution, taskbar): re-snap.
      const c = restCenter(s, clampTo(s, this.s, w), w);
      if (Math.abs(c.x - this.body.x) > 1 || Math.abs(c.y - this.body.y) > 1) this.settle(s);
      return;
    }
    const old = s.ledge;
    const fresh = findLedge(w, old.id, this.body.x);
    let dx = 0;
    let ok = false;
    if (fresh && Math.abs(fresh.y - old.y) <= 120 * u) {
      if (this.body.x >= fresh.x && this.body.x <= fresh.x + fresh.w) ok = true;
      // The same visible width somewhere else: the window was dragged sideways. Ride along.
      if (fresh.w === old.w && Math.abs(fresh.x - old.x) < 600 * u) {
        dx = fresh.x - old.x;
        ok = true;
      }
    }
    if (!fresh || !ok) {
      this.event("ledge-gone");
      this.interrupt();
      this.launch({ x: 0, y: 0 }, { planned: false, panic: true, canSplat: true });
      return;
    }
    const dy = fresh.y - old.y;
    this.surface = { kind: "ledge", ledge: fresh };
    if (dx !== 0 || dy !== 0) {
      this.s = clampTo(this.surface, this.s + dx, w);
      const c = restCenter(this.surface, this.s, w);
      this.body.x = c.x;
      this.body.y = c.y;
      if (this.loco) this.loco.to += dx;
      this.event("ride");
      if (Math.abs(dx) + Math.abs(dy) > 6 * u) this.animator.glitchBurst(160);
      this.place();
    } else if (this.loco) {
      this.s = clampTo(this.surface, this.s, w);
    }
  }

  private armLedgeWatch(): void {
    if (this.pollTimer !== null) this.clock.clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (this.surface.kind !== "ledge" || this.asleep || this.mode !== "stand") return;
    this.pollTimer = this.clock.setTimeout(() => {
      this.pollTimer = null;
      if (this.surface.kind !== "ledge" || this.asleep || this.mode !== "stand") return;
      void this.pollWorld().then(() => this.armLedgeWatch());
    }, LEDGE_WATCH_MS);
  }

  // ========================================================= the window

  /** Window position from the body, then repaint if the picture changed. */
  private place(): void {
    const w = this.world;
    if (!w) {
      if (this.dirty) this.flush();
      return;
    }
    const u = w.scale;
    const win = windowFor(this.body, this.body.angle, this.k, u);
    if (win.x !== this.win.x || win.y !== this.win.y) {
      this.win = win;
      this.sendMove(win);
    }
    const feet = feetInWindow(this.body, win, this.body.angle, u);
    const platform = this.platformFx();
    const view = this.view;
    view.placement = { x: feet.x, y: feet.y, angle: this.body.angle };
    view.facingLeft = this.facingLeft;
    view.motion = this.motion;
    view.platform = platform;
    const m = this.motion;
    const key = [
      feet.x.toFixed(1),
      feet.y.toFixed(1),
      this.body.angle.toFixed(1),
      this.facingLeft,
      m.sx.toFixed(3),
      m.sy.toFixed(3),
      m.shear.toFixed(3),
      m.ghosts.length,
      platform ? `${platform.build.toFixed(2)}/${platform.fade.toFixed(2)}/${platform.y.toFixed(0)}` : "",
    ].join(",");
    if (key !== this.placementKey) {
      this.placementKey = key;
      this.dirty = true;
    }
    if (this.dirty) this.flush();
  }

  private flush(): void {
    this.dirty = false;
    if (!this.pose) return;
    this.view.render(this.pose, this.poseTick);
    this.stats.renders++;
    this.updateHitbox();
  }

  private sendMove(win: Vec): void {
    if (this.moveInFlight) {
      this.pendingMove = win;
      return;
    }
    this.stats.moves++;
    const r = this.host.moveWindow(win.x, win.y);
    if (r && typeof (r as Promise<unknown>).then === "function") {
      this.moveInFlight = true;
      const done = () => {
        this.moveInFlight = false;
        const next = this.pendingMove;
        this.pendingMove = null;
        if (next && (next.x !== win.x || next.y !== win.y)) this.sendMove(next);
      };
      (r as Promise<unknown>).then(done, done);
    }
  }

  /** The body catches the mouse; the rest of the window clicks through. Whole window while it could be dragged / flies. */
  private updateHitbox(): void {
    const loose = this.mode !== "stand" || this.press !== null || this.hold !== null;
    const r = this.view.bodyRect;
    if (loose || !r) {
      if (this.sentHitbox !== null) {
        this.sentHitbox = null;
        this.stats.hitboxes++;
        this.host.setHitbox(null);
      }
      return;
    }
    const want = { x: Math.floor(r.x), y: Math.floor(r.y), w: Math.ceil(r.w), h: Math.ceil(r.h) };
    const was = this.sentHitbox;
    if (was && Math.abs(was.x - want.x) <= 6 && Math.abs(was.y - want.y) <= 6 && Math.abs(was.w - want.w) <= 6 && Math.abs(was.h - want.h) <= 6) return;
    this.sentHitbox = want;
    this.stats.hitboxes++;
    this.host.setHitbox(want);
  }

  // ========================================================= motion loop

  private kTarget(): number {
    if (this.mode !== "stand" && this.mode !== "corner") return 0;
    // On his own platform the feet sit higher so the slab under them fits in the window.
    return this.surface.kind === "platform" ? 0.55 : 1;
  }

  private needsMotion(): boolean {
    if (!this.world) return false;
    return (
      this.mode !== "stand" ||
      this.loco !== null ||
      Math.abs(this.k - this.kTarget()) > 1e-3 ||
      (this.platform !== null && (this.platform.build < 1 || this.platform.breaking))
    );
  }

  private frameMs(): number {
    return this.mode === "air" || this.mode === "held" ? AIR_FRAME_MS : WALK_FRAME_MS;
  }

  private ensureMotion(): void {
    if (this.motionTimer !== null || !this.needsMotion()) return;
    this.lastTick = this.now;
    this.motionStart = this.now;
    this.motionTimer = this.clock.setTimeout(this.motionTick, this.frameMs());
  }

  private motionTick = (): void => {
    this.motionTimer = null;
    const now = this.now;
    const dt = Math.min(0.05, Math.max(0, (now - this.lastTick) / 1000));
    this.lastTick = now;
    this.stats.motionTicks++;
    switch (this.mode) {
      case "air":
        this.stepFlight(dt);
        break;
      case "held":
        this.stepHold(dt, now);
        break;
      case "corner":
        this.stepCorner(now);
        break;
      default:
        if (this.loco) this.stepLoco(dt, now);
    }
    this.stepK(dt);
    this.stepPlatform(dt);
    this.place();
    if (this.motionTimer !== null) return; // something re-armed it already
    if (this.needsMotion()) {
      this.motionTimer = this.clock.setTimeout(this.motionTick, this.frameMs());
    } else {
      this.stats.movingMs += now - this.motionStart;
      this.updateHitbox();
    }
  };

  private stepK(dt: number): void {
    const target = this.kTarget();
    this.k += (target - this.k) * (1 - Math.exp(-dt / 0.05));
    if (Math.abs(target - this.k) < 0.02) this.k = target;
  }

  // ---------------------------------------------------------- walking

  private stepLoco(dt: number, now: number): void {
    const L = this.loco!;
    const w = this.world!;
    const u = w.scale;
    if (now < L.freezeUntil) return;
    if (L.skip) {
      // The lag spike is over: he skips ahead.
      this.s = clampTo(this.surface, this.s + L.skip, w);
      L.skip = 0;
    }
    const target = clampTo(this.surface, L.to, w);
    const dist = target - this.s;
    const prevV = L.v;
    const accel = ACCEL * u;
    L.v = Math.min(SPEED[L.gait] * u, L.v + accel * dt, Math.sqrt(2 * accel * Math.abs(dist)) + 12 * u);
    const step = Math.sign(dist) * L.v * dt;
    let arrived = false;
    if (Math.abs(step) >= Math.abs(dist)) {
      this.s = target;
      arrived = true;
    } else {
      this.s += step;
    }
    const c = restCenter(this.surface, this.s, w);
    this.body.x = c.x;
    this.body.y = c.y;
    // Lean into the acceleration, lean back when braking.
    const a = dt > 0 ? (L.v - prevV) / dt / accel : 0;
    const lean = Math.max(-3, Math.min(4, a * 4));
    const faceSign = this.facingLeft ? -1 : 1;
    this.motion = Math.abs(lean) < 0.5 ? CALM : { ...CALM, shear: (-lean * faceSign) / 80, pivotY: 0 };
    // Now and then the walk lags: a freeze, a glitch, a skip forward.
    if (now >= L.nextGlitchAt && Math.abs(dist) > 80 * u) {
      L.freezeUntil = now + 170;
      L.skip = Math.sign(dist) * 26 * u;
      L.nextGlitchAt = now + 7000 + this.rand() * 14000;
      this.animator.glitchBurst(170);
      this.event("lag");
    }
    if (arrived) {
      this.loco = null;
      this.motion = CALM;
      this.nextStep();
    }
  }

  private startCorner(end: -1 | 1): void {
    const w = this.world!;
    const next = cornerAt(this.surface, end, w);
    if (!next) return this.nextStep();
    const to = restCenter(next.surface, next.s, w);
    const a0 = this.body.angle;
    let a1 = surfaceAngle(next.surface.kind);
    while (a1 - a0 > 180) a1 -= 360;
    while (a1 - a0 < -180) a1 += 360;
    this.corner = { from: { x: this.body.x, y: this.body.y }, to, a0, a1, t0: this.now, next };
    this.mode = "corner";
    if (this.animator.animation !== "climb") this.animator.play("climb");
    this.ensureMotion();
  }

  private stepCorner(now: number): void {
    const c = this.corner!;
    const t = Math.min(1, (now - c.t0) / CORNER_MS);
    const e = t * t * (3 - 2 * t);
    this.body.x = c.from.x + (c.to.x - c.from.x) * e;
    this.body.y = c.from.y + (c.to.y - c.from.y) * e;
    this.body.angle = c.a0 + (c.a1 - c.a0) * e;
    if (t >= 1) this.finishCorner();
  }

  private finishCorner(): void {
    const c = this.corner!;
    this.corner = null;
    this.surface = c.next.surface;
    this.s = c.next.s;
    this.body.x = c.to.x;
    this.body.y = c.to.y;
    this.body.angle = surfaceAngle(c.next.surface.kind);
    this.mode = "stand";
    this.event(`corner:${c.next.surface.kind}`);
    this.nextStep();
  }

  // ----------------------------------------------------------- flying

  private launch(v: Vec, o: { planned: boolean; panic: boolean; canSplat?: boolean; drag?: boolean; keepSpin?: boolean; ledgeId?: number; build?: boolean }): void {
    this.mode = "air";
    this.loco = null;
    this.body.vx = v.x;
    this.body.vy = v.y;
    this.flight = {
      drag: o.drag ?? !o.planned,
      canSplat: o.canSplat ?? !o.planned,
      planned: o.planned,
      panic: o.panic,
      airTime: 0,
      keepSpin: o.keepSpin ?? false,
      ledgeId: o.ledgeId,
      build: o.build ? { done: false } : undefined,
    };
    if (this.pollTimer !== null) this.clock.clearTimeout(this.pollTimer);
    this.pollTimer = null;
    // Leaving his platform: it shatters behind him.
    if (this.platform && !this.platform.breaking && this.surface.kind === "platform") this.platform.breaking = true;
    this.updateAirAnim();
    this.updateHitbox();
    this.ensureMotion();
  }

  private stepFlight(dt: number): void {
    const f = this.flight!;
    const w = this.world!;
    const u = w.scale;
    const extra = this.platform && !this.platform.breaking ? [this.platform.ledge] : undefined;
    const contacts = stepAir(this.body, w, dt, { drag: f.drag, canSplat: f.canSplat, extra, airTime: f.airTime, keepSpin: f.keepSpin });
    f.airTime += dt;
    if (f.build && !f.build.done && this.body.vy >= 0) {
      // The top of the build jump: conjure the platform right under his feet.
      f.build.done = true;
      this.body.vy = 0;
      const ledge: Ledge = { id: -1, x: Math.round(this.body.x - 58 * u), y: Math.round(this.body.y + HALF * u + 1), w: Math.round(116 * u) };
      this.platform = { ledge, build: 0, fade: 0, breaking: false };
      this.animator.glitchBurst(200);
      this.event("platform");
    }
    for (const c of contacts) {
      if (c.kind === "land") return this.landed(c, f);
      this.bounced(c, f);
      if (this.mode !== "air") return;
    }
    this.updateAirAnim();
    // Secondary motion: stretch with speed, afterimages when fast.
    const vx = this.body.vx / u;
    const vy = this.body.vy / u;
    const speed = Math.hypot(vx, vy);
    const tumbling = this.animator.animation === "tumble";
    const st = tumbling ? 1 : 1 + Math.min(0.13, speed / 9000);
    const ghosts: Ghost[] = [];
    if (speed > 1300) {
      for (const [i, alpha] of [0.4, 0.25, 0.13].entries()) {
        let gx = -vx * 0.016 * (i + 1);
        let gy = -vy * 0.016 * (i + 1);
        const len = Math.hypot(gx, gy);
        if (len > 46) {
          gx *= 46 / len;
          gy *= 46 / len;
        }
        ghosts.push({ dx: gx, dy: gy, alpha });
      }
    }
    this.motion = { sx: 1 / Math.sqrt(st), sy: st, shear: 0, pivotY: -HALF, ghosts };
  }

  private updateAirAnim(): void {
    const f = this.flight;
    if (!f || this.animator.animation === "crouch") return;
    let want: AnimationName;
    if (f.panic) want = "flail";
    else if (!f.planned && Math.abs(this.body.spin) > 260) want = "tumble";
    else want = this.body.vy < -60 * this.u ? "airUp" : "airDown";
    if (this.animator.animation !== want) this.animator.play(want);
  }

  private bounced(c: Contact & { kind: "bounce" }, f: Flight): void {
    if (c.speed > 450) this.animator.glitchBurst(Math.min(260, 80 + c.speed / 10));
    this.event(`bounce:${c.side}`);
    if (f.planned || !this.movement || !this.world) return;
    // Thrown at a wall not too hard: sometimes he grabs on (and climbs from there).
    const wall = c.side === "left" || c.side === "right";
    if ((wall && c.speed > 250 && c.speed < 1500 && this.rand() < 0.45) || (c.side === "ceiling" && c.speed < 1100 && this.rand() < 0.35)) {
      this.flight = null;
      this.motion = CALM;
      this.settle({ kind: c.side as "left" | "right" | "ceiling" });
      this.facingLeft = this.rand() < 0.5;
      this.animator.play("cling");
      this.animator.glitchBurst(220);
      this.event("cling");
      this.scheduleBrain(1500 + this.rand() * 1500);
    }
  }

  private landed(c: Contact & { kind: "land" }, f: Flight): void {
    this.flight = null;
    this.motion = CALM;
    this.settle(c.surface);
    this.event(`land:${c.surface.kind}:${Math.round(c.speed)}`);
    const plan = this.plan;
    if (f.planned && plan) {
      const missed = f.ledgeId !== undefined && !(isTop(c.surface) && c.surface.ledge.id === f.ledgeId);
      this.animator.play(this.restAnim());
      this.animator.interject((_, base) => landKeys(c.speed, base));
      if (missed) return this.finishPlan();
      this.wait(260, () => this.nextStep());
      return;
    }
    // Thrown, dropped, or the window under him vanished.
    this.plan = null;
    if (f.canSplat && c.speed > PHYS.splat) {
      this.animator.play("splat"); // -> dizzy -> idle
      this.excitedUntil = this.now + 60_000;
      this.scheduleBrain(5000 + this.rand() * 3000);
    } else {
      this.animator.play(this.restAnim());
      this.animator.interject((_, base) => landKeys(c.speed, base));
      if (c.speed > 1000) this.animator.glitchBurst(250);
      this.scheduleBrain(2500 + this.rand() * 3000);
    }
  }

  // ---------------------------------------------------------- platform

  private stepPlatform(dt: number): void {
    const p = this.platform;
    if (!p) return;
    if (p.build < 1) p.build = Math.min(1, p.build + dt / 0.4);
    if (p.breaking) {
      p.fade = Math.min(1, p.fade + dt / 0.65);
      if (p.fade >= 0.4 && this.mode === "stand" && this.surface.kind === "platform") {
        this.launch({ x: 0, y: 0 }, { planned: true, panic: true, drag: true });
      }
      if (p.fade >= 1) this.platform = null;
    }
  }

  private platformFx(): PlatformFx | null {
    const p = this.platform;
    const w = this.world;
    if (!p || !w) return null;
    const u = w.scale;
    const feetY = this.body.y + HALF * u;
    const y = (p.ledge.y - feetY) / u;
    if (y < -170 || y > 170 || Math.abs(this.body.angle) > 1) return null;
    return { x0: (p.ledge.x - this.body.x) / u, x1: (p.ledge.x + p.ledge.w - this.body.x) / u, y, build: p.build, fade: p.fade };
  }

  // ============================================================ the plan

  private context(w: World): BrainContext {
    return {
      now: this.now,
      world: w,
      surface: this.surface,
      s: this.s,
      movement: this.movement,
      sleepy: this.now - this.lastInteraction >= SLEEP_AFTER_MS,
      excited: this.now < this.excitedUntil,
    };
  }

  private busy(): boolean {
    return this.mood === "thinking" || this.mood === "asking" || this.mood === "listening";
  }

  private canAct(): boolean {
    return this.mode === "stand" && !this.asleep && !this.panelOpen && !this.busy() && !this.hovered && !this.press && !this.hold && !this.plan;
  }

  /** What he does when he's doing nothing. */
  restAnim(): AnimationName {
    if (this.asleep) return "sleep";
    if (this.mood === "thinking") return "think";
    if (this.mood === "asking") return "ask";
    if (this.mood === "listening") return "listen";
    return isStanding(this.surface) || this.mode !== "stand" ? "idle" : "cling";
  }

  private scheduleBrain(ms: number): void {
    if (this.brainTimer !== null) this.clock.clearTimeout(this.brainTimer);
    this.brainTimer = this.clock.setTimeout(this.think, Math.max(50, Math.round(ms)));
  }

  /** Wait `ms` then continue (uses the brain timer: one pending at most). */
  private wait(ms: number, fn: () => void): void {
    if (this.brainTimer !== null) this.clock.clearTimeout(this.brainTimer);
    this.brainTimer = this.clock.setTimeout(() => {
      this.brainTimer = null;
      fn();
    }, Math.max(50, Math.round(ms)));
  }

  private think = (): void => {
    this.brainTimer = null;
    if (!this.canAct()) return; // whatever blocks him reschedules when it ends
    void this.pollWorld().then((w) => {
      if (!w || !this.canAct()) return;
      this.startPlan(this.brain.next(this.context(w)));
    });
  };

  private startPlan(plan: Plan): void {
    this.plan = plan;
    this.stepIndex = 0;
    this.planStarted = this.now;
    this.event(`plan:${plan.name}`);
    this.nextStep();
  }

  private finishPlan(): void {
    const active = this.now - this.planStarted;
    this.plan = null;
    this.stepIndex = 0;
    this.motion = CALM;
    if (this.mode === "stand" && this.animator.animation !== this.restAnim() && !ANIMATIONS[this.animator.animation].once) this.animator.play(this.restAnim());
    if (!this.world || this.asleep) return;
    let rest = this.brain.restMs(this.context(this.world));
    // Mostly idle: rest at least three times as long as he was busy.
    if (isStanding(this.surface)) rest = Math.max(rest, active * 3);
    this.scheduleBrain(rest);
  }

  private waitFor(name: AnimationName, fn: () => void): void {
    this.waiting = { name, fn };
  }

  private animationChanged(name: AnimationName): void {
    if (name === "sleep") return this.enterSleep();
    const w = this.waiting;
    if (w && name !== w.name) {
      this.waiting = null;
      w.fn();
    }
  }

  private nextStep(): void {
    const plan = this.plan;
    const w = this.world;
    if (!plan || !w) return;
    if (this.stepIndex >= plan.steps.length) return this.finishPlan();
    const step = plan.steps[this.stepIndex++];
    const u = w.scale;
    switch (step.do) {
      case "walk": {
        if (this.mode !== "stand") return this.finishPlan();
        const to = clampTo(this.surface, step.to, w);
        if (Math.abs(to - this.s) < 2 * u) return this.nextStep();
        const dir = Math.sign(to - this.s);
        this.facingLeft = facesLeftFor(this.surface.kind, dir);
        this.loco = { to, gait: step.gait, v: 0, dir, freezeUntil: 0, skip: 0, nextGlitchAt: this.now + 2500 + this.rand() * 9000 };
        this.animator.play(step.gait === "run" ? "run" : step.gait === "climb" ? "climb" : "walk");
        this.ensureMotion();
        return;
      }
      case "corner":
        return this.startCorner(step.end);
      case "anim": {
        const anim = ANIMATIONS[step.name];
        if (anim.once) {
          this.waitFor(step.name, () => this.nextStep());
          this.animator.play(step.name, anim.next ?? this.restAnim());
        } else {
          this.animator.play(step.name);
          this.wait(step.ms ?? 3000, () => this.nextStep());
        }
        return;
      }
      case "face":
        this.facingLeft = facesLeftFor(this.surface.kind, step.dir);
        this.place();
        return this.nextStep();
      case "jump": {
        const spin = step.spin ?? 0;
        const jp = planJump(this.body, step.to, w, spin ? 150 : undefined);
        if (!jp || this.mode !== "stand") return this.finishPlan();
        this.waitFor("crouch", () => {
          this.body.spin = spin ? spin / jp.t : 0;
          this.launch({ x: jp.vx, y: jp.vy }, { planned: true, panic: false, keepSpin: spin !== 0, ledgeId: step.ledgeId });
        });
        this.animator.play("crouch", "airUp");
        return;
      }
      case "hop":
        this.facingLeft = facesLeftFor(this.surface.kind, step.dir);
        this.launch({ x: step.dir * 190 * u, y: -430 * u }, { planned: true, panic: false });
        return;
      case "drop": {
        const kind = this.surface.kind;
        if (isStanding(this.surface)) return this.nextStep();
        const push = kind === "left" ? { x: 170 * u, y: -80 * u } : kind === "right" ? { x: -170 * u, y: -80 * u } : { x: 0, y: 30 * u };
        this.body.spin = kind === "left" ? -320 : kind === "right" ? 320 : this.rand() < 0.5 ? 300 : -300;
        this.launch(push, { planned: true, panic: true, drag: true });
        return;
      }
      case "teleport":
        this.teleportTo = { surface: step.surface, s: step.s };
        this.waitFor("glitchOut", () => {
          this.doTeleport();
          this.waitFor("gone", () => this.waitFor("glitchIn", () => this.nextStep()));
        });
        this.animator.play("glitchOut");
        return;
      case "build": {
        const vy = -Math.sqrt(2 * PHYS.gravity * u * step.height * u);
        this.waitFor("crouch", () => this.launch({ x: 0, y: vy }, { planned: true, panic: false, build: true }));
        this.animator.play("crouch", "airUp");
        return;
      }
      case "unbuild":
        if (!this.platform || this.surface.kind !== "platform") return this.nextStep();
        this.platform.breaking = true;
        this.animator.glitchBurst(400);
        this.ensureMotion();
        return;
    }
  }

  private doTeleport(): void {
    const t = this.teleportTo;
    const w = this.world;
    this.teleportTo = null;
    if (!t || !w) return;
    this.surface = t.surface;
    this.s = clampTo(t.surface, t.s, w);
    const c = restCenter(t.surface, this.s, w);
    this.body = { x: c.x, y: c.y, vx: 0, vy: 0, angle: surfaceAngle(t.surface.kind), spin: 0 };
    this.k = 1;
    this.facingLeft = this.rand() < 0.5;
    this.event(`teleport:${t.surface.kind}`);
    this.place();
    this.armLedgeWatch();
  }

  /** Drop whatever plan is running; leave the body somewhere sane. */
  private interrupt(): void {
    this.plan = null;
    this.waiting = null;
    if (this.brainTimer !== null) this.clock.clearTimeout(this.brainTimer);
    this.brainTimer = null;
    if (this.loco) {
      this.loco = null;
      this.motion = CALM;
    }
    if (this.corner) {
      const c = this.corner;
      this.corner = null;
      this.surface = c.next.surface;
      this.s = c.next.s;
      this.body.x = c.to.x;
      this.body.y = c.to.y;
      this.body.angle = surfaceAngle(c.next.surface.kind);
      this.mode = "stand";
    }
    if (this.teleportTo) {
      this.doTeleport();
      this.animator.play("glitchIn", this.restAnim());
    }
    // In the air he can't stop; the landing just won't continue the plan.
    if (this.flight) this.flight.planned = false;
    this.place();
  }

  private enterSleep(): void {
    this.asleep = true;
    this.plan = null;
    this.waiting = null;
    for (const t of [this.brainTimer, this.pollTimer]) if (t !== null) this.clock.clearTimeout(t);
    this.brainTimer = this.pollTimer = null;
    this.event("sleep");
  }

  // ======================================================== reactions

  private interaction(): void {
    this.lastInteraction = this.now;
  }

  /** Back to life (hover, click, a mood...): a reboot glitch. */
  wake(): void {
    this.interaction();
    if (!this.asleep) return;
    this.asleep = false;
    this.animator.play(this.restAnim());
    this.animator.glitchBurst(350);
    this.armLedgeWatch();
    this.scheduleBrain(3000 + this.rand() * 3000);
  }

  setMood(m: string): void {
    const mood = (MOODS.includes(m) ? m : "idle") as Mood;
    this.mood = mood;
    this.interaction();
    if (this.asleep) {
      this.asleep = false;
      this.armLedgeWatch();
    }
    if (this.busy()) {
      this.interrupt();
      if (this.mode !== "stand") return; // after landing, restAnim() picks it up
      const want = this.restAnim();
      if (this.animator.animation !== want) {
        this.animator.play(want);
        if (mood === "thinking") this.animator.glitchBurst(); // the gears start grinding
      }
      return;
    }
    if (mood === "happy") {
      this.excitedUntil = this.now + 60_000;
      if (this.mode !== "stand" || this.hold) return;
      this.interrupt();
      if (this.world && !this.panelOpen && this.movement) {
        const p = this.brain.plan("celebrate", this.context(this.world));
        if (p) return this.startPlan(p);
      }
      this.animator.play("happy", this.restAnim());
      this.scheduleBrain(6000 + this.rand() * 4000);
      return;
    }
    if (this.mode === "stand" && !this.plan) {
      if (["think", "ask", "listen"].includes(this.animator.animation)) this.animator.play(this.restAnim());
      this.scheduleBrain(3000 + this.rand() * 4000);
    }
  }

  setPanelOpen(open: boolean): void {
    this.panelOpen = open;
    this.wake();
    if (open) {
      this.interrupt();
      if (this.mode === "stand" && this.world && isStanding(this.surface)) {
        // Turn towards the bubble (it opens towards the middle of the screen).
        const a = this.world.area;
        this.facingLeft = this.body.x > a.x + a.w / 2;
        if (["walk", "run", "climb"].includes(this.animator.animation)) this.animator.play(this.restAnim());
        this.place();
      }
    } else if (!this.plan) {
      this.scheduleBrain(4000 + this.rand() * 4000);
    }
  }

  setMovement(on: boolean): void {
    this.movement = on;
    if (!on) {
      this.interrupt();
      if (this.mode === "stand" && ["walk", "run", "climb"].includes(this.animator.animation)) this.animator.play(this.restAnim());
      // Off a wall / the ceiling soon; otherwise just stay.
      this.scheduleBrain(isStanding(this.surface) ? 8000 : 400);
    } else if (!this.plan) {
      this.scheduleBrain(3000 + this.rand() * 4000);
    }
  }

  setHovered(on: boolean): void {
    this.hovered = on;
    if (!on) {
      if (!this.plan && this.mode === "stand") this.scheduleBrain(2500 + this.rand() * 3000);
      return;
    }
    if (this.asleep) return this.wake();
    this.interaction();
    if (this.mode !== "stand" || this.press || this.hold) return;
    // Noticed the cursor: stop and look at it.
    if (this.loco || this.plan) {
      this.interrupt();
      this.animator.play(this.restAnim());
    }
    this.animator.interject((_, base) => [
      { ...base, ms: 60, glitch: 0.3, fx: "eye" },
      { ...base, ms: 120, fx: "eye", sx: (base.sx ?? 1) * 0.97, sy: (base.sy ?? 1) * 1.04 },
    ]);
    void Promise.resolve(this.host.cursor()).then(
      (p) => {
        if (this.mode !== "stand" || !isStanding(this.surface) || !this.world) return;
        if (Math.abs(p.x - this.body.x) > 8 * this.u) this.facingLeft = p.x < this.body.x;
        this.place();
      },
      () => {},
    );
  }

  /**
   * Play an animation by name (one-shots return to the rest pose, loops stop
   * after 8 s), or a behaviour by name ("climb", "jump", "teleport", "build",
   * "chaos", "run", "sitEdge"...). Unknown names are ignored. Returns whether
   * something started.
   */
  playAction(name: unknown): boolean {
    // Behaviours first ("climb" is also the climbing animation); the animation if it can't be planned here.
    if (isBehaviourName(name) && this.force(name)) return true;
    if (isAnimationName(name)) {
      if (this.mode === "held") return false;
      this.interaction();
      this.interrupt();
      if (this.actionTimer !== null) this.clock.clearTimeout(this.actionTimer);
      this.actionTimer = null;
      if (name !== "sleep") this.asleep = false;
      this.animator.play(name, ANIMATIONS[name].next ?? this.restAnim());
      if (!ANIMATIONS[name].once && !["idle", "sleep", "napRock", "think", "ask", "listen", "cling"].includes(name)) {
        this.actionTimer = this.clock.setTimeout(() => {
          this.actionTimer = null;
          if (this.animator.animation === name) this.animator.play(this.restAnim());
        }, ACTION_LOOP_MAX_MS);
      }
      if (name !== "sleep") this.scheduleBrain(ACTION_LOOP_MAX_MS + 2000);
      return true;
    }
    return false;
  }

  /** Start a behaviour now (if it fits where he is). */
  force(name: BehaviourName): boolean {
    if (!this.world || this.mode !== "stand" || this.hold) return false;
    this.interaction();
    if (this.asleep) this.wake();
    this.interrupt();
    const plan = this.brain.plan(name, this.context(this.world));
    if (!plan) {
      if (!this.plan) this.scheduleBrain(3000);
      return false;
    }
    this.startPlan(plan);
    return true;
  }

  // ===================================================== drag & throw

  /** Mouse down on the window at a window-local CSS point. */
  pointerDown(local: Vec): void {
    if (!this.world) return;
    this.interaction();
    if (this.hold) return;
    if (this.mode === "air") return this.startHold(local); // caught mid-air!
    this.press = { local };
    this.updateHitbox(); // whole window while a drag could start
    if (this.asleep) this.wake();
    if (this.loco || this.corner) {
      this.interrupt();
      this.animator.play(this.restAnim());
    }
    if (this.brainTimer !== null) this.clock.clearTimeout(this.brainTimer);
    this.brainTimer = null;
  }

  pointerMove(local: Vec): void {
    const p = this.press;
    if (!p || this.hold) return;
    if (Math.hypot(local.x - p.local.x, local.y - p.local.y) > DRAG_THRESHOLD) this.startHold(p.local);
  }

  pointerUp(): void {
    if (this.hold) return this.release();
    if (!this.press) return;
    this.press = null;
    this.host.clicked();
    if (this.mode === "stand") {
      this.interrupt();
      this.animator.play("startled", this.restAnim());
    }
    this.updateHitbox();
    if (!this.plan) this.scheduleBrain(6000 + this.rand() * 6000);
  }

  /** Lost the mouse (pointer cancelled, window blurred): let go. */
  pointerCancel(): void {
    if (this.hold) return this.release();
    this.press = null;
    this.updateHitbox();
  }

  get held(): boolean {
    return this.hold !== null;
  }

  private startHold(local: Vec): void {
    const w = this.world!;
    const u = w.scale;
    this.interrupt();
    this.press = null;
    this.flight = null;
    this.asleep = false;
    if (this.platform) this.platform.breaking = true;
    const grab = { x: this.win.x + local.x * u, y: this.win.y + local.y * u };
    const off = { x: this.body.x - grab.x, y: this.body.y - grab.y };
    const L = Math.hypot(off.x, off.y);
    const phi0 = Math.atan2(off.x, off.y);
    // The grab point in the body's own frame: the legs lag around it.
    const a = (-this.body.angle * Math.PI) / 180;
    const gy = -off.x * Math.sin(a) + -off.y * Math.cos(a);
    this.hold = {
      cursor: grab,
      busy: false,
      L,
      phi0,
      angle0: this.body.angle,
      pivotY: -HALF + gy / u,
      pend: new Pendulum(phi0, Math.max(L, 36 * u), PHYS.gravity * u),
      tracker: new VelocityTracker(),
      vs: { x: 0, y: 0 },
      kickUntil: 0,
    };
    this.hold.tracker.add(this.now, grab);
    this.mode = "held";
    if (this.pollTimer !== null) this.clock.clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.animator.play("held");
    this.animator.glitchBurst(280);
    this.event("grab");
    this.updateHitbox();
    this.ensureMotion();
  }

  private stepHold(dt: number, now: number): void {
    const h = this.hold!;
    const u = this.u;
    if (!h.busy) {
      const r = this.host.cursor();
      if (r && typeof (r as Promise<Vec>).then === "function") {
        h.busy = true;
        (r as Promise<Vec>).then(
          (p) => {
            h.cursor = p;
            h.busy = false;
          },
          () => (h.busy = false),
        );
      } else {
        h.cursor = r as Vec;
      }
    }
    h.tracker.add(now, h.cursor);
    const v = h.tracker.velocity(now);
    const prev = h.vs;
    h.vs = { x: prev.x + (v.x - prev.x) * 0.5, y: prev.y + (v.y - prev.y) * 0.5 };
    const lim = 40000 * u;
    const acc = dt > 0 ? { x: Math.max(-lim, Math.min(lim, (h.vs.x - prev.x) / dt)), y: Math.max(-lim, Math.min(lim, (h.vs.y - prev.y) / dt)) } : { x: 0, y: 0 };
    h.pend.step(dt, acc);
    const phi = h.pend.phi;
    this.body.x = h.cursor.x + h.L * Math.sin(phi);
    this.body.y = h.cursor.y + h.L * Math.cos(phi);
    this.body.angle = h.angle0 - ((phi - h.phi0) * 180) / Math.PI;
    // Legs and tail lag behind the swing.
    const shear = Math.max(-0.35, Math.min(0.35, h.pend.omega * 0.05));
    this.motion = { sx: 0.97, sy: 1.04, shear, pivotY: h.pivotY, ghosts: [] };
    const speed = Math.hypot(h.vs.x, h.vs.y) / u;
    if (speed > 900) h.kickUntil = now + 350;
    const want: AnimationName = now < h.kickUntil ? "heldKick" : "held";
    if (this.animator.animation !== want && (this.animator.animation === "held" || this.animator.animation === "heldKick")) this.animator.play(want);
  }

  private release(): void {
    const h = this.hold!;
    const w = this.world!;
    const u = w.scale;
    this.hold = null;
    const vc = h.tracker.velocity(this.now);
    const tip = h.pend.tipVelocity(h.L);
    const v = capSpeed({ x: vc.x + tip.x, y: vc.y + tip.y }, MAX_THROW * u);
    const speed = Math.hypot(v.x, v.y) / u;
    this.body.spin = Math.max(-1100, Math.min(1100, (-h.pend.omega * 180) / Math.PI + (v.x / u) * 0.3));
    this.motion = CALM;
    this.event(`throw:${Math.round(speed)}`);
    this.launch(v, { planned: false, panic: speed < 250, canSplat: true, drag: true });
    // Ledges may have changed while he was carried around (or he's on another monitor now).
    void this.pollWorld();
  }

  private event(what: string): void {
    this.onEvent?.(what);
  }
}
