// Glitch as a creature: body + physics + brain + animator, driving the
// mascot window. No DOM and no Tauri here (both come in through `Host` and
// `View`), so the whole life cycle runs on a fake clock in the tests and on
// a fake desktop in dev/stage.html.
//
// Timers (never requestAnimationFrame):
// - the Animator's one keyframe timer (under 2.5/s while idle, see IDLE_BUDGET);
// - the brain timer: one pending at most (rest, or the current step's wait);
// - the motion timer, ONLY while the window actually moves: 30 Hz walking,
//   climbing and settling, 60 Hz in the air or while held;
// - the ledge watch (2.5 s) only while awake on another app's window top.
// While moving, a repaint happens only when the picture changes (a new key,
// a new angle); the window move alone carries a walking sprite.

import { ANIMATIONS, type AnimationName, Animator, type Clock, isAnimationName, type Keyframe, landKeys, MIN_KEY_MS, type Pose } from "./animations";
import { bridge, clip, familyOf, glitchCut, has, turnKeys } from "./transitions";
import { ANIM_FRAME_H, ANIM_FRAME_W, ANIM_GRIPS } from "../sprites/anim";
import { ART_SCALE } from "../sprites/glitch-anim";
import { type BehaviourName, Brain, type BrainContext, type Haul, isBehaviourName, type Plan, type Gait } from "./brain";
import { ChaosDirector, chaosAnim, type ChaosHost, isAct, knockKeys } from "./chaos";
import { reactToMove } from "./ledge";
import { capSpeed, Pendulum, VelocityTracker } from "./drag";
import {
  alongX,
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
import type { Ledge, LedgeEvent, LedgeWatchInfo, ScreenRect } from "../shared/ipc";
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
  /** Chaos mode (other apps' windows, the cursor, paw prints, notes). Absent: no mischief. */
  chaos?: ChaosHost;
  /**
   * Watch the window he stands on (null: stop). With `events`, moves arrive
   * through `Creature.ledgeEvent`; otherwise he polls `ledgeFrame` at 30 Hz
   * while standing on it.
   */
  watchLedge?(id: number | null): Promise<LedgeWatchInfo | null>;
  ledgeFrame?(id: number): Promise<ScreenRect | null>;
}

/** What creature.ts needs from the renderer (render.ts `Renderer` fits). */
export interface View {
  facingLeft: boolean;
  placement: Placement;
  motion: Motion;
  platform: PlatformFx | null;
  bodyRect: BodyRect | null;
  /** Standing on a surface (feet snapped onto it) / with a contact shadow. Optional for fakes. */
  contact?: boolean;
  shadow?: boolean;
  render(pose: Pose, tick: number): void;
}

export type Mood = "thinking" | "happy" | "asking" | "idle" | "listening" | "talking" | "looking";
const MOODS: readonly string[] = ["thinking", "happy", "asking", "idle", "listening", "talking", "looking"];

type Mode = "stand" | "corner" | "air" | "held";

export const SLEEP_AFTER_MS = 10 * 60_000;
/** Annoyance levels (see Creature.annoyance): a pickup adds 1, a throw 1.5, a poke 0.4. */
export const ANNOY_MEDIUM = 2.5;
/** Held: body centre this far (CSS px) below the cursor tip = the scruff of his neck at the cursor. */
const SCRUFF = 46;
/** Held: the sway never goes past this many degrees. */
const SWAY_MAX = 9;
/** Held: easing from where he was to hanging from the scruff. */
const ATTACH_MS = 80;
/** Thrown faster than this (CSS px/s): he spins; slower, he falls upright. */
const HARD_THROW = 900;
export const ANNOY_HIGH = 4.5;
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
/**
 * The ground speed (CSS px/s) each drawn cycle shows at its keyed timing:
 * stride measured on the frames (dev/feet.py: a planted foot travels ~21 art
 * px per walk step, ~33 per run step; x1.5 CSS px, two steps per cycle) over
 * the cycle time (walk 8 x 83 ms, run 6 x 70 ms). The animation runs at
 * actual speed / this, so planted feet stay planted.
 */
const DRAWN_SPEED: Record<Gait, number> = { walk: 95, run: 236, climb: 82 };
const ACCEL = 700; // CSS px / s^2
const MAX_THROW = 3800;
const CORNER_MS = 380;
/** Floating down (tail copter / glide): fall speed, CSS px / s. */
export const FLOAT_FALL = 130;
/** Landing back on the window he just fell off within this long: no rest pose yet (it may slide away again). */
export const RELAND_MS = 250;
/** Clicks closer together than this count as rapid clicking (annoy more). */
const RAPID_CLICK_MS = 700;
/** A click reaction is never restarted within this long (a flinch instead). */
export const CLICK_DEBOUNCE_MS = 500;
/** What a click gets, from mild to fed up (see clickReaction). */
type ClickReaction = "startled" | "annoyed" | "grumpy";
const CLICK_REACTIONS: ClickReaction[] = ["startled", "annoyed", "grumpy"];

/** Clicked on a wall or the ceiling: a twitch in the wall pose (glance back, eye spark), never a front pose. */
function wallFlinch(base: Omit<Keyframe, "ms">): Keyframe[] {
  const keep = { flip: base.flip, rot: base.rot, pivot: base.pivot };
  return [
    { frame: "climb0", ms: 60, ...keep, glitch: 0.5, fx: "eye" },
    { frame: "climb7", ms: 220, ...keep, fx: "eye" },
    { frame: "climb0", ms: 120, ...keep },
  ];
}

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
  /** Dragging something along (chaos mode). */
  haul?: HaulState;
}

interface HaulState {
  h: Haul;
  /** Surface coordinate where the walk began. */
  s0: number;
  /** Where he'd be if nothing held him back (riding his own window: the window lags behind). */
  virt: number;
  /** Offset last asked for / last applied (physical px along the surface). */
  sent: number;
  applied: number;
  busy: boolean;
  /** Riding the window he drags: its ledge when the walk began. */
  ledge0?: Ledge;
  done: boolean;
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
  /** Animation in the air instead of airUp/airDown. */
  anim?: AnimationName;
  /** Floating down: terminal speed + a sideways drift (tail copter / glide). */
  float?: { drift: number };
  /** Wall-jump kick: stop dead at `to` after `t` s and carry on with the plan from there. */
  stopAt?: { t: number; to: Vec };
  /** Stopped mid-air (on a kick) until the next jump. */
  frozen?: boolean;
  /** Barely pause after landing. */
  quick?: boolean;
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
  /** Where he was relative to the cursor when grabbed (eased out over ATTACH_MS). */
  attach: { x: number; y: number; angle: number; t0: number };
  /** Clinging on to the cursor: body centre offset from the cursor (physical px). */
  grip?: Vec;
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
  /** Chaos mode switch (only acts with `movement` on too). */
  chaosOn = true;
  /** Chaos mode's planner, if the host supports it. */
  readonly director: ChaosDirector | null;
  panelOpen = false;
  mood: Mood = "idle";
  /**
   * Hushed (a game is fullscreen, a focus session runs): he holds this rest
   * pose, doesn't wander and gets up to no mischief until it's lifted.
   */
  hush: AnimationName | null = null;
  hovered = false;
  private facingLeftValue = false;
  /** Which way he faces; the animator's transition clips need it too (see transitions.ts toSide). */
  get facingLeft(): boolean {
    return this.facingLeftValue;
  }
  set facingLeft(left: boolean) {
    this.facingLeftValue = left;
    if (this.animator) this.animator.mem.facingLeft = left;
  }
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
  /** When the ledge under him was last compared (snapshot or event). */
  private ledgeSampleAt = 0;
  private worldPending: Promise<World | null> | null = null;
  private stepIndex = 0;
  private planStarted = 0;
  private loco: Loco | null = null;
  /** Turning a corner (or sliding down a window's side: `ms` set, `next` null = let go at the end). */
  private corner: { from: Vec; to: Vec; a0: number; a1: number; t0: number; ms?: number; next: { surface: Surface; s: number } | null } | null = null;
  /** Hanging off the edge of a window top: how far below his standing spot (physical px). */
  private hangDrop = 0;
  private flight: Flight | null = null;
  private hold: Hold | null = null;
  private press: { local: Vec } | null = null;
  private platform: Platform | null = null;
  private teleportTo: { surface: Surface; s: number } | null = null;
  private waiting: { name: AnimationName; fn: () => void } | null = null;
  private lastInteraction = 0;
  private excitedUntil = -Infinity;
  private sentHitbox: BodyRect | null | undefined = undefined;
  /** The window he stands on, as last reported (ledge watch). */
  private watchedId: number | null = null;
  private watchFrame: ScreenRect | null = null;
  private watchAt = 0;
  private watchTimer: unknown = null;
  /** How far the user has dragged his window by hand since grabbing it (null: not grabbed). */
  private handTravel: number | null = null;
  /** Riding a moving window: the window trails the body by this much, easing to 0 (no jumps). */
  private rideLag: Vec = { x: 0, y: 0 };
  /** Stepped in glitch: leave paw prints until then. */
  private pawsUntil = -Infinity;
  private pawLast: Vec | null = null;
  private pawLeft = false;
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
        // The feet line follows the pose (off a window edge): ease there.
        if (this.mode === "stand" && this.world && Math.abs(this.k - this.kTarget()) > 1e-3) this.ensureMotion();
        // While the window moves, the motion tick paints (once per tick).
        // (Also while a motion tick runs: it paints at its end.)
        if (this.motionTimer === null && !this.inTick) this.place();
      },
      ANIMATIONS,
      this.clock,
      this.rand,
    );
    this.animator.onChange = (name) => this.animationChanged(name);
    const me = this;
    this.director = host.chaos
      ? new ChaosDirector(
          host.chaos,
          {
            get world() {
              return me.world;
            },
            get surface() {
              return me.surface;
            },
            get s() {
              return me.s;
            },
            get body() {
              return { x: me.body.x, y: me.body.y };
            },
            now: () => this.now,
            cursor: () => Promise.resolve(this.host.cursor()),
            stepInGlitch: (ms) => this.stepInGlitch(ms),
            knock: () => this.knock(),
          },
          this.rand,
        )
      : null;
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
    for (const t of [this.annoyTimer, this.clingTimer]) if (t !== null) this.clock.clearTimeout(t);
    this.annoyTimer = this.clingTimer = null;
    for (const t of [this.motionTimer, this.brainTimer, this.pollTimer, this.actionTimer, this.talkTimer, this.watchTimer]) if (t !== null) this.clock.clearTimeout(t);
    this.motionTimer = this.brainTimer = this.pollTimer = this.actionTimer = this.talkTimer = this.watchTimer = null;
  }

  private talkTimer: unknown = null;

  // ------------------------------------------------------------ annoyance
  // Picking him up, throwing him and poking him annoys him. The meter rises
  // with each, and decays on its own (60 s time constant, so ~2 min to calm
  // down completely). Low: he just dangles. Medium: he struggles while held,
  // clings on to the cursor for a moment when let go, and is annoyed after.
  // High: he bites the cursor, turns his back on you and sulks for a few
  // seconds (clicks get no reaction), then calms down with a little hop.

  /** The window he last fell off, and until when landing back on it doesn't count yet (see landed). */
  private lostLedge: { id: number; until: number } | null = null;
  private lastClickAt = -Infinity;
  /** When the last click reaction started (debounce). */
  private reactAt = -Infinity;
  /** Which rung of CLICK_REACTIONS that was. */
  private reactLevel = 0;
  /** When he last woke up. */
  private wokeAt = -Infinity;
  private annoyRaw = 0;
  private annoyAt = 0;
  private sulkUntil = 0;
  private reactAfterLanding: "annoyed" | "grumpy" | null = null;
  private annoyTimer: unknown = null;
  private clingTimer: unknown = null;
  private clingDone = false;

  /** How annoyed he is right now (0 = calm; MEDIUM / HIGH thresholds below). */
  get annoyance(): number {
    return this.annoyRaw * Math.exp(-(this.now - this.annoyAt) / 60_000);
  }

  private annoy(amount: number): void {
    this.annoyRaw = this.annoyance + amount;
    this.annoyAt = this.now;
  }

  /** Sulking: back turned, clicks don't get a reaction. */
  get sulking(): boolean {
    return this.now < this.sulkUntil;
  }

  /**
   * Face left/right. Standing (side-on or facing you), he turns round with
   * the drawn turn; elsewhere (walls, air) the picture just mirrors. Returns
   * the turn keys for the caller to lead its next animation with; the
   * renderer's facing switches now (keys with flip show the old facing until
   * the turn passes the front view).
   */
  private turn(left: boolean): Keyframe[] {
    if (left === this.facingLeft) return [];
    const frame = this.animator.pose?.frame ?? "idle0";
    this.facingLeft = left;
    if (this.asleep) return [];
    const fam = familyOf(frame);
    // Crawling on a wall (also mid-corner or letting go): swing round, never a mirror flip.
    if (fam === "wall") return turnKeys("wall", left, frame);
    if (this.mode !== "stand") return [];
    if (!isStanding(this.surface)) return [];
    return fam === "side" || fam === "front" ? turnKeys(fam, left, frame) : [];
  }

  /** Turn round on the spot, then carry on with what was playing. */
  /** Turn round on the spot, then carry on with what was playing. Returns how long the turn takes (ms). */
  private turnNow(left: boolean): number {
    const keys = this.turn(left);
    if (keys.length) this.animator.interject(() => keys);
    return keys.reduce((t, k) => t + k.ms, 0);
  }

  /**
   * The chat bubble started showing a reply of `chars` characters: move his
   * mouth for about as long as it takes to read (1.2-6 s), then go back to
   * the mood he was in. Ignored while he is busy (thinking, listening), not
   * standing, held or asleep.
   */
  talk(chars: number): void {
    const ms = Math.min(6000, Math.max(1200, chars * 45));
    if (this.mode !== "stand" || this.hold || this.asleep) return;
    if (this.mood !== "idle" && this.mood !== "happy" && this.mood !== "talking") return;
    const after = this.mood === "talking" ? "idle" : this.mood;
    if (this.talkTimer !== null) this.clock.clearTimeout(this.talkTimer);
    const stop = () => {
      this.talkTimer = null;
      if (this.mood === "talking") this.setMood(after === "happy" ? "idle" : after);
    };
    if (this.animator.animation === "point") {
      // Let him finish pointing at what he opened, then talk.
      this.talkTimer = this.clock.setTimeout(() => {
        this.setMood("talking");
        this.talkTimer = this.clock.setTimeout(stop, ms);
      }, 1100);
      return;
    }
    this.setMood("talking");
    this.talkTimer = this.clock.setTimeout(stop, ms);
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
  private pollWorld(force = false): Promise<World | null> {
    if (this.worldPending) return this.worldPending;
    if (!force && this.world && this.now - this.worldAt < WORLD_MIN_MS) return Promise.resolve(this.world);
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
    // Dragging a window: he knows where it is better than a snapshot does.
    if (this.loco?.haul) return;
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
    if (this.watchFrame) {
      // Watched (events / 30 Hz polls) moves are handled in ledgeEvent. A
      // snapshot only tells whether something now covers his spot, and only
      // once the window has been still for a moment (else it may be stale).
      if (this.now - this.watchAt < 300) return;
      if (!fresh || !(this.body.x >= fresh.x && this.body.x <= fresh.x + fresh.w) || Math.abs(fresh.y - old.y) > 2 * u) {
        return this.loseFooting({ x: 0, y: 0 }, "covered");
      }
      this.surface = { kind: "ledge", ledge: fresh };
      if (this.loco) this.s = clampTo(this.surface, this.s, w);
      return;
    }
    if (!fresh) return this.loseFooting({ x: 0, y: 0 }, "gone");
    if (fresh.w !== old.w) {
      // Something in front now covers part of it (or it was resized): he must still be over it.
      if (this.body.x < fresh.x || this.body.x > fresh.x + fresh.w || Math.abs(fresh.y - old.y) > 2 * u) {
        return this.loseFooting({ x: 0, y: 0 }, "covered");
      }
      this.surface = { kind: "ledge", ledge: fresh };
      if (this.loco) this.s = clampTo(this.surface, this.s, w);
      return;
    }
    // The same visible width somewhere else: the window moved. Ride along, or fall if it jumped away.
    const r = reactToMove({ x: old.x, y: old.y, w: old.w, h: 0 }, { x: fresh.x, y: fresh.y, w: fresh.w, h: 0 }, this.now - this.ledgeSampleAt, w, this.body.x, this.handTravel);
    this.ledgeSampleAt = this.now;
    if (r.kind === "fall") {
      const dx = fresh.x - old.x;
      const dy = fresh.y - old.y;
      if ((r.why === "slip" || r.why === "jump") && this.slipOn({ x: fresh.x, y: fresh.y, w: fresh.w, h: 0 }, dx, dy)) return;
      return this.loseFooting(r.v, r.why, { dx, dy });
    }
    if (r.kind === "ride") this.rideBy(r.dx, r.dy);
    else if (this.loco) this.s = clampTo(this.surface, this.s, w);
  }

  /** The window under him moved by (dx, dy): move with it, the picture eases after (no jump). */
  private rideBy(dx: number, dy: number): void {
    const w = this.world;
    if (!w || !isTop(this.surface) || this.surface.kind !== "ledge") return;
    const l = this.surface.ledge;
    this.surface = { kind: "ledge", ledge: { ...l, x: l.x + dx, y: l.y + dy } };
    this.s += dx;
    if (this.loco) this.loco.to += dx;
    this.body.x += dx;
    this.body.y += dy;
    // Small steps (30 Hz events) need no easing; bigger ones glide over ~0.1 s.
    if (Math.abs(dx) + Math.abs(dy) > 12 * w.scale) {
      this.rideLag = { x: this.rideLag.x - dx, y: this.rideLag.y - dy };
    }
    if (this.handTravel !== null) this.handTravel += Math.hypot(dx, dy);
    this.event("ride");
    this.place();
    this.ensureMotion();
  }

  /** The window under him left, closed, or moved out from under him: fall for real. */
  private loseFooting(v: Vec, why: string, moved?: { dx: number; dy: number }): void {
    this.event(`ledge-gone:${why}`);
    this.asleep = false;
    const id = isTop(this.surface) ? this.surface.ledge.id : null;
    if (id !== null) this.lostLedge = { id, until: this.now + RELAND_MS };
    // His snapshot of the world still has that window where it was: update it
    // (or drop it) so he doesn't land straight back on a ghost.
    if (this.world && id !== null) {
      const ledges = moved
        ? this.world.ledges.map((l) => (l.id === id ? { ...l, x: l.x + moved.dx, y: l.y + moved.dy } : l))
        : this.world.ledges.filter((l) => l.id !== id);
      this.world = { ...this.world, ledges };
    }
    this.interrupt();
    this.rideLag = { x: 0, y: 0 };
    this.launch(v, { planned: false, panic: true, canSplat: true });
    void this.pollWorld(true);
  }

  /**
   * The window moved too fast for him to ride along, but it is still under
   * his feet: it slides under him (he stays where he is) and he stumbles.
   */
  private slipOn(next: ScreenRect, dx: number, dy: number): boolean {
    const w = this.world;
    if (!w || this.surface.kind !== "ledge" || Math.abs(dy) > 4 * w.scale) return false;
    const m = 12 * w.scale;
    if (this.body.x < next.x + m || this.body.x > next.x + next.w - m) return false;
    const l = this.surface.ledge;
    this.surface = { kind: "ledge", ledge: { ...l, x: l.x + dx, y: l.y + dy } };
    this.s = this.body.x;
    if (this.loco) this.loco.to = clampTo(this.surface, this.loco.to, w);
    this.event("slip");
    if (this.mode === "stand" && !this.loco && !this.plan) this.animator.play("startled", this.restAnim());
    return true;
  }

  /** From Rust: the window he stands on moved / closed / got covered (see ledge_watch.rs). */
  ledgeEvent(e: LedgeEvent): void {
    if (e.id !== this.watchedId || !this.world) return;
    if (this.mode !== "stand" || this.surface.kind !== "ledge" || this.surface.ledge.id !== e.id) return;
    switch (e.kind) {
      case "gone":
        return this.loseFooting({ x: 0, y: 0 }, "gone");
      case "front":
        // Something came to the front: does it cover his spot now?
        void this.pollWorld(true);
        return;
      case "grab":
        this.handTravel = 0;
        return;
      case "move": {
        const prev = this.watchFrame;
        const next = e.frame;
        const dt = this.now - this.watchAt;
        this.watchFrame = next;
        this.watchAt = this.now;
        this.ledgeSampleAt = this.now;
        if (!prev || !next) return;
        // He's dragging it himself (chaos): stepHaul keeps him on it.
        if (this.loco?.haul) return;
        const r = reactToMove(prev, next, dt, this.world, this.body.x, this.handTravel);
        if (r.kind === "fall") {
          const dx = next.x - prev.x;
          const dy = next.y - prev.y;
          if ((r.why === "slip" || r.why === "jump") && this.slipOn(next, dx, dy)) return;
          return this.loseFooting(r.v, r.why, { dx, dy });
        }
        if (r.kind === "ride") this.rideBy(r.dx, r.dy);
        return;
      }
    }
  }

  /** Watch the window he stands on (only then; nothing at all otherwise). */
  private syncLedgeWatch(): void {
    const want = this.started && this.mode === "stand" && this.surface.kind === "ledge" ? this.surface.ledge.id : null;
    if (want === this.watchedId) return;
    this.watchedId = want;
    this.watchFrame = null;
    this.handTravel = null;
    if (this.watchTimer !== null) this.clock.clearTimeout(this.watchTimer);
    this.watchTimer = null;
    const host = this.host;
    if (!host.watchLedge) return;
    void host.watchLedge(want).then(
      (info) => {
        if (want === null || this.watchedId !== want || !info) return;
        if (!info.frame) return this.ledgeEvent({ id: want, kind: "gone", frame: null });
        this.watchFrame = info.frame;
        this.watchAt = this.now;
        if (!info.events && host.ledgeFrame) this.pollLedge(want);
      },
      () => {},
    );
  }

  /** No OS events (macOS, the dev stage): ask where his window is, 30 times a second, while on it and awake. */
  private pollLedge(id: number): void {
    this.watchTimer = this.clock.setTimeout(() => {
      this.watchTimer = null;
      if (this.watchedId !== id || !this.host.ledgeFrame) return;
      if (this.asleep) return this.pollLedge(id);
      void this.host.ledgeFrame(id).then(
        (frame) => {
          if (this.watchedId !== id) return;
          this.ledgeEvent({ id, kind: frame ? "move" : "gone", frame });
          if (this.watchedId === id && this.watchTimer === null) this.pollLedge(id);
        },
        () => this.watchedId === id && this.pollLedge(id),
      );
    }, WALK_FRAME_MS);
  }

  private armLedgeWatch(): void {
    this.syncLedgeWatch();
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
    const lag = this.rideLag;
    const shown = lag.x || lag.y ? { ...this.body, x: this.body.x + lag.x, y: this.body.y + lag.y } : this.body;
    const win = windowFor(shown, this.body.angle, this.k, u);
    if (win.x !== this.win.x || win.y !== this.win.y) {
      this.win = win;
      this.sendMove(win);
    }
    const feet = feetInWindow(shown, win, this.body.angle, u);
    const platform = this.platformFx();
    const view = this.view;
    view.placement = { x: feet.x, y: feet.y, angle: this.body.angle };
    view.facingLeft = this.facingLeft;
    view.motion = this.motion;
    view.platform = platform;
    const contact = (this.mode === "stand" || this.mode === "corner") && !this.hangDrop;
    const shadow = contact && this.mode === "stand" && (this.surface.kind === "floor" || isTop(this.surface));
    view.contact = contact;
    view.shadow = shadow;
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
      contact,
      shadow,
    ].join(",");
    if (key !== this.placementKey) {
      this.placementKey = key;
      this.dirty = true;
    }
    if (this.dirty) this.flush();
  }

  private lastFlushAt = -1;

  private flush(): void {
    // While moving, at most one paint per 60 Hz frame: a second paint in the
    // same frame (a launch places him and the new air animation draws) is
    // left to the motion tick that follows.
    if (this.motionTimer !== null && this.lastFlushAt >= 0 && this.now - this.lastFlushAt < 1000 / 60) return;
    this.dirty = false;
    if (!this.pose) return;
    this.lastFlushAt = this.now;
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
    if (this.surface.kind === "platform") return 0.55;
    // Sitting on an edge with his legs over it: the feet line higher, so the legs fit in the window.
    if (this.animator && (this.animator.animation === "sitEdge" || this.animator.animation === "sit_edge_swing")) return 0.2;
    // Still getting up off the edge (its outro plays under the next animation's name): legs still over it.
    const p = this.animator?.pose;
    if (p && p.dy > 0 && (p.frame.startsWith("sit_edge_swing") || p.frame === "sit_down7")) return 0.2;
    return 1;
  }

  private needsMotion(): boolean {
    if (!this.world) return false;
    return (
      this.mode !== "stand" ||
      this.loco !== null ||
      Math.abs(this.k - this.kTarget()) > 1e-3 ||
      Math.abs(this.rideLag.x) + Math.abs(this.rideLag.y) > 0.5 ||
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

  private inTick = false;

  private motionTick = (): void => {
    this.inTick = true;
    try {
      this.motionTickBody();
    } finally {
      this.inTick = false;
    }
  };

  private motionTickBody(): void {
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
    this.stepRideLag(dt);
    this.stepPlatform(dt);
    this.place();
    if (this.motionTimer !== null) return; // something re-armed it already
    if (this.needsMotion()) {
      this.motionTimer = this.clock.setTimeout(this.motionTick, this.frameMs());
    } else {
      this.stats.movingMs += now - this.motionStart;
      this.updateHitbox();
    }
  }

  private stepRideLag(dt: number): void {
    const l = this.rideLag;
    if (!l.x && !l.y) return;
    const f = Math.exp(-dt / 0.045);
    l.x *= f;
    l.y *= f;
    if (Math.abs(l.x) + Math.abs(l.y) < 0.5) this.rideLag = { x: 0, y: 0 };
  }

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
    if (L.haul) return this.stepHaul(dt);
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
    // Play the drawn cycle at the speed he actually goes (no sliding feet).
    this.animator.rate = Math.min(1.5, Math.max(0.3, L.v / (DRAWN_SPEED[L.gait] * u)));
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
    this.maybePaw();
    if (arrived) {
      this.loco = null;
      this.motion = CALM;
      this.nextStep();
    }
  }

  // ------------------------------------------------- chaos: hauling things

  /**
   * Walking while dragging something (a window, his note, the cursor). One
   * move request in flight at most (so <= 30 per second). Riding the window
   * he drags, he moves with what the window actually did (it may stop at the
   * screen edge); otherwise the thing follows him.
   */
  private stepHaul(dt: number): void {
    const L = this.loco!;
    const H = L.haul!;
    const w = this.world!;
    const u = w.scale;
    const riding = H.ledge0 !== undefined;
    const target = riding ? L.to : clampTo(this.surface, L.to, w);
    const cur = riding ? H.virt : this.s;
    const dist = target - cur;
    const accel = ACCEL * u;
    L.v = Math.min(SPEED[L.gait] * u, L.v + accel * dt, Math.sqrt(2 * accel * Math.abs(dist)) + 12 * u);
    const step = Math.sign(dist) * L.v * dt;
    const arrived = Math.abs(step) >= Math.abs(dist);
    const next = arrived ? target : cur + step;
    if (riding) H.virt = next;
    else this.s = next;
    const want = next - H.s0;
    if (!H.busy && Math.abs(want - H.sent) >= 0.5) {
      H.busy = true;
      H.sent = want;
      const along = alongX(this.surface.kind);
      const r = H.h.move(along ? want : 0, along ? 0 : want);
      const done = (v: Vec | null) => {
        H.busy = false;
        if (this.loco !== L || H.done) return;
        if (!v) return this.haulRefused();
        H.applied = along ? v.x : v.y;
        if (riding) this.rideTo(H);
      };
      if (r && typeof (r as Promise<Vec | null>).then === "function") (r as Promise<Vec | null>).then(done, () => done(null));
      else done(r as Vec | null);
    }
    if (this.loco !== L) return;
    const c = restCenter(this.surface, this.s, w);
    this.body.x = c.x;
    this.body.y = c.y;
    // Leaning into the pull.
    const faceSign = this.facingLeft ? -1 : 1;
    this.motion = { ...CALM, shear: (Math.sign(dist) * faceSign * -0.05) / (riding ? 1 : 1.5), pivotY: 0 };
    this.maybePaw();
    // Riding a window that got stuck at the screen edge: that's far enough.
    const stuck = riding && !H.busy && Math.abs(want - H.applied) > 60 * u;
    if (arrived || stuck) {
      if (riding && H.busy) return; // let the last move land first
      if (this.onEvent) this.event(`haul-end:${Math.round(this.s)}:applied=${Math.round(H.applied)}${stuck ? ":stuck" : ""}`);
      this.endHaul();
      this.nextStep();
    }
  }

  /** Riding the window he drags: stand where it went, its top under his feet. */
  private rideTo(H: HaulState): void {
    const l0 = H.ledge0!;
    this.surface = { kind: "ledge", ledge: { ...l0, x: l0.x + H.applied } };
    this.s = H.s0 + H.applied;
  }

  private endHaul(): void {
    const L = this.loco;
    if (!L?.haul) return;
    const H = L.haul;
    if (!H.done) {
      H.done = true;
      H.h.release();
    }
    this.loco = null;
    this.motion = CALM;
  }

  /** Rust said stop (the user moved, time's up, chaos off...): let go, look caught. */
  private haulRefused(): void {
    this.event("haul-refused");
    this.endHaul();
    this.plan = null;
    this.waiting = null;
    this.animator.play("startled", this.restAnim());
    this.scheduleBrain(5000 + this.rand() * 4000);
  }

  // ---------------------------------------------- chaos: paw prints, knock

  /** Leave magenta paw prints for a while (chaos mode). */
  stepInGlitch(ms: number): void {
    if (!this.host.chaos || !this.chaosOn) return;
    this.pawsUntil = Math.max(this.pawsUntil, this.now + ms);
    this.pawLast = null;
    this.event("glitch-paws");
  }

  private maybePaw(): void {
    if (this.now >= this.pawsUntil || !this.host.chaos || !this.chaosOn || !this.movement) return;
    if (!isStanding(this.surface) || !this.world) return;
    const u = this.u;
    const feet = { x: this.body.x, y: this.body.y + HALF * u };
    if (this.pawLast && Math.hypot(feet.x - this.pawLast.x, feet.y - this.pawLast.y) < 22 * u) return;
    // Toes lean the way he walks, so the trail reads as footsteps going somewhere.
    const lean = this.pawLast ? Math.sign(feet.x - this.pawLast.x) * 18 : 0;
    this.pawLast = feet;
    this.pawLeft = !this.pawLeft;
    this.host.chaos.paws([{ x: feet.x, y: feet.y, angle: lean, left: this.pawLeft }]);
  }

  /** Knock on the inside of the screen glass. */
  private knock(): Promise<void> {
    this.facingLeft = !this.facingLeft;
    this.place();
    this.animator.interject((_, base) => knockKeys(base));
    return new Promise((done) => this.clock.setTimeout(done, 1700));
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
    const t = Math.min(1, (now - c.t0) / (c.ms ?? CORNER_MS));
    const e = t * t * (3 - 2 * t);
    this.body.x = c.from.x + (c.to.x - c.from.x) * e;
    this.body.y = c.from.y + (c.to.y - c.from.y) * e;
    this.body.angle = c.a0 + (c.a1 - c.a0) * e;
    if (t >= 1) this.finishCorner();
  }

  private finishCorner(): void {
    const c = this.corner!;
    this.corner = null;
    this.body.x = c.to.x;
    this.body.y = c.to.y;
    if (!c.next) {
      // The bottom of a window's side: let go and drop onto whatever is below.
      this.event("slide-off");
      this.launch({ x: 0, y: 0 }, { planned: true, panic: false });
      return;
    }
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

  private launch(
    v: Vec,
    o: { planned: boolean; panic: boolean; canSplat?: boolean; drag?: boolean; keepSpin?: boolean; ledgeId?: number; build?: boolean; extra?: Partial<Flight> },
  ): void {
    this.unhang(false);
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
      ...o.extra,
    };
    if (this.pollTimer !== null) this.clock.clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.syncLedgeWatch();
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
    if (f.frozen) return; // kicking off a window's side: the next jump launches from here
    if (f.stopAt && f.airTime + dt >= f.stopAt.t) {
      this.body.x = f.stopAt.to.x;
      this.body.y = f.stopAt.to.y;
      this.body.vx = this.body.vy = 0;
      f.stopAt = undefined;
      f.frozen = true;
      this.motion = CALM;
      this.event("kick");
      this.nextStep();
      return;
    }
    if (f.float) {
      // Floating down: slow fall, a lazy sideways sway.
      const sway = 0.65 + 0.35 * Math.sin(f.airTime * 2.4);
      this.body.vx = f.float.drift * u * sway;
      this.body.vy = Math.min(this.body.vy, FLOAT_FALL * u);
    }
    const extra = this.platform && !this.platform.breaking ? [this.platform.ledge] : undefined;
    const contacts = stepAir(this.body, w, dt, { drag: f.drag, canSplat: f.canSplat, extra, airTime: f.airTime, keepSpin: f.keepSpin });
    f.airTime += dt;
    if (f.float) this.body.vy = Math.min(this.body.vy, FLOAT_FALL * u);
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
    if (f.anim && !f.panic) want = f.anim;
    else if (f.panic) want = chaosAnim("fall_flail");
    else if (!f.planned && Math.abs(this.body.spin) > 260) want = "tumble";
    // Thrown (not hard enough to spin): the drawn flailing fall, upright.
    else if (!f.planned && f.drag) want = chaosAnim("fall_flail");
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
      // Grabbing on: the cling pose turned the way he faces (the frame before was a flight pose, never mirrored).
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
      this.wait(f.quick ? 60 : 260, () => this.nextStep());
      return;
    }
    // Thrown, dropped, or the window under him vanished.
    this.plan = null;
    const lost = this.lostLedge;
    if (lost && this.now < lost.until && isTop(c.surface) && c.surface.ledge.id === lost.id) {
      // Caught again by the window he just slipped off (it's being yanked about): it may well
      // slide away again at once, so no flash of the rest pose between two falls. Stay in
      // the fall pose a moment and land properly only if it holds still.
      this.event("reland");
      this.wait(RELAND_MS, () => {
        if (this.mode !== "stand") return;
        this.animator.play(this.restAnim());
        this.animator.interject((_, base) => landKeys(c.speed, base));
        this.scheduleBrain(2500 + this.rand() * 3000);
      });
      return;
    }
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
    return this.mood === "thinking" || this.mood === "asking" || this.mood === "listening" || this.mood === "talking" || this.mood === "looking";
  }

  private canAct(): boolean {
    return this.mode === "stand" && !this.asleep && !this.panelOpen && !this.busy() && !this.hovered && !this.press && !this.hold && !this.plan && !this.hush && !this.sulking;
  }

  /**
   * May he react to what the user is doing right now (context.ts)? Not
   * while asleep, held, hovered, chatting, annoyed, mid-mischief or flying.
   */
  canReact(): boolean {
    if (this.mode !== "stand" || this.asleep || this.panelOpen || this.busy() || this.hovered || this.press || this.hold) return false;
    if (this.annoyance >= ANNOY_MEDIUM || this.sulking) return false;
    return !this.plan || this.plan.name === "stroll" || this.plan.name === "lookAround";
  }

  /** Run a reaction plan now (context.ts checked canReact). */
  react(plan: Plan): boolean {
    if (!this.world || this.mode !== "stand" || this.hold) return false;
    this.interrupt();
    this.startPlan(plan);
    return true;
  }

  /** Hush him into `pose` (null: lift it). See `hush`. */
  setHush(pose: AnimationName | null): void {
    if (this.hush === pose) return;
    this.hush = pose;
    if (pose) {
      if (this.plan?.name === "mischief" || this.loco?.haul) this.interrupt();
      if (this.mode === "stand" && !this.plan && isStanding(this.surface)) this.animator.play(this.restAnim());
      return;
    }
    if (this.mode === "stand" && !this.plan) {
      this.animator.play(this.restAnim());
      this.scheduleBrain(3000 + this.rand() * 3000);
    }
  }

  /** What he does when he's doing nothing. */
  restAnim(): AnimationName {
    if (this.asleep) return "sleep";
    // Just landed after being picked up once too often: the annoyed reaction (once), then the sulk.
    if (this.reactAfterLanding && this.mode === "stand" && isStanding(this.surface)) {
      const r = this.reactAfterLanding;
      this.reactAfterLanding = null;
      if (r === "grumpy") {
        this.sulkUntil = this.now + 7000;
        if (this.annoyTimer !== null) this.clock.clearTimeout(this.annoyTimer);
        this.annoyTimer = this.clock.setTimeout(() => {
          this.annoyTimer = null;
          if (this.mode === "stand" && ["grumpy", "annoyed", "sulk"].includes(this.animator.animation)) this.animator.play("calmDown", "idle");
        }, 7000);
      }
      return r;
    }
    if (this.sulking && this.mode === "stand" && isStanding(this.surface)) return "sulk";
    // On a wall or the ceiling the front-facing mood poses would lie sideways: hold on instead.
    if (this.mode === "stand" && !isStanding(this.surface)) return "cling";
    if (this.mood === "thinking") return "think";
    if (this.mood === "asking") return "ask";
    if (this.mood === "listening") return "listen";
    // Studying a screenshot: the same curious, ears-forward look.
    if (this.mood === "looking") return "listen";
    if (this.mood === "talking") return "talk";
    if (this.hush && this.mode === "stand" && isStanding(this.surface)) return this.hush;
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
    void this.pollWorld().then(async (w) => {
      if (!w || !this.canAct()) return;
      // Chaos mode gets a say first (it mostly says "not now").
      if (this.director && this.chaosOn && this.movement && isStanding(this.surface)) {
        const plan = await this.director.maybe().catch(() => null);
        if (!this.canAct()) return;
        if (plan) return this.startPlan(plan);
      }
      this.startPlan(this.brain.next(this.context(w)));
    });
  };

  /** Chaos mode on/off (settings, tray). Off stops any mischief at once. */
  setChaos(on: boolean): void {
    this.chaosOn = on;
    if (on) return;
    this.pawsUntil = -Infinity;
    if (this.plan?.name === "mischief" || this.loco?.haul) {
      this.interrupt();
      if (this.mode === "stand") this.animator.play(this.restAnim());
      this.scheduleBrain(4000 + this.rand() * 3000);
    }
  }

  /** Do this chaos act now if it fits (debug trigger / dev tools). Rust's limits still apply. */
  async forceChaos(what: string): Promise<boolean> {
    const [act, arg] = what.split(":");
    if (!this.director || !isAct(act) || !this.world || this.mode !== "stand" || this.hold) return false;
    this.interaction();
    if (this.asleep) this.wake();
    this.interrupt();
    const plan = await this.director.plan(act, true, arg).catch((e) => {
      this.event(`chaos-error:${String(e)}`);
      return null;
    });
    this.event(`chaos:${act}:${plan ? "go" : "no"}`);
    if (!plan && this.onEvent) this.event(`ledges:${(this.world?.ledges ?? []).map((l) => `${l.id}@${l.x},${l.y}+${l.w}`).join(" ")}`);
    if (!plan || this.mode !== "stand" || this.plan) {
      if (!this.plan) this.scheduleBrain(3000);
      return false;
    }
    this.startPlan(plan);
    return true;
  }

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
    // Sitting on an edge raises the feet in the window (kTarget): ease there.
    if (this.mode === "stand" && Math.abs(this.k - this.kTarget()) > 1e-3) this.ensureMotion();
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
        if (this.mode !== "stand") {
          step.haul?.release();
          return this.finishPlan();
        }
        const surf = this.surface;
        // Riding the window he drags: walk "off its end", the window comes along.
        const riding = step.haul?.ledgeId !== undefined && isTop(surf) && surf.ledge.id === step.haul.ledgeId;
        const to = riding ? step.to : clampTo(surf, step.to, w);
        if (Math.abs(to - this.s) < 2 * u) {
          step.haul?.release();
          return this.nextStep();
        }
        const dir = Math.sign(to - this.s);
        const left = facesLeftFor(surf.kind, step.backwards ? -dir : dir);
        // Already side-on and turning round: the drawn turn first, standing still meanwhile.
        let lead: Keyframe[] = [];
        const fam = familyOf(this.animator.pose?.frame ?? "idle0");
        if (fam === "side" || fam === "wall") lead = this.turn(left);
        else this.facingLeft = left;
        const wait = lead.reduce((t, k) => t + k.ms, 0);
        this.loco = { to, gait: step.gait, v: 0, dir, freezeUntil: this.now + wait, skip: 0, nextGlitchAt: this.now + 2500 + this.rand() * 9000 };
        if (step.haul) {
          this.loco.haul = { h: step.haul, s0: this.s, virt: this.s, sent: 0, applied: 0, busy: false, ledge0: riding && isTop(surf) ? { ...surf.ledge } : undefined, done: false };
          this.event("haul");
        }
        if (this.onEvent) this.event(`walk:${surf.kind}:${Math.round(this.s)}->${Math.round(to)}${step.haul ? ":haul" : ""}`);
        this.animator.play(step.anim ?? (step.gait === "run" ? "run" : step.gait === "climb" ? "climb" : "walk"), undefined, lead);
        this.ensureMotion();
        return;
      }
      case "call": {
        void Promise.resolve()
          .then(() => step.run())
          .then(
            (r) => {
              if (this.plan !== plan) {
                // Interrupted while asking: let go of anything just grabbed.
                if (Array.isArray(r)) for (const s of r) if (s.do === "walk") s.haul?.release();
                return;
              }
              if (r === false) return this.finishPlan();
              if (Array.isArray(r)) plan.steps.splice(this.stepIndex, 0, ...r);
              this.nextStep();
            },
            (e) => {
              this.event(`call-error:${String(e)}`);
              if (this.plan === plan) this.finishPlan();
            },
          );
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
      case "face": {
        const ms = this.turnNow(facesLeftFor(this.surface.kind, step.dir));
        this.place();
        // Let the turn play before the next step (a jump's crouch would cut it off).
        if (ms > 0) return this.wait(ms, () => this.nextStep());
        return this.nextStep();
      }
      case "jump": {
        // Asleep or sitting: get up first (the drawn get-up / stand-up), then jump.
        const fam = familyOf(this.animator.pose?.frame ?? "idle0");
        if (this.mode === "stand" && (fam === "curled" || fam === "sit")) {
          this.asleep = false;
          this.animator.play("idle");
          this.stepIndex--;
          return this.wait(1200, () => this.nextStep());
        }
        const spin = step.spin ?? 0;
        const kicking = this.mode === "air" && !!this.flight?.frozen;
        const jp = planJump(this.body, step.to, w, step.height ?? (spin ? 150 : undefined));
        if (!jp || (this.mode !== "stand" && !kicking)) {
          if (kicking) this.flight!.frozen = false; // can't go on: drop from the wall
          return this.finishPlan();
        }
        const go = () => {
          this.body.spin = spin ? spin / jp.t : 0;
          this.launch(
            { x: jp.vx, y: jp.vy },
            {
              planned: true,
              panic: false,
              keepSpin: spin !== 0,
              ledgeId: step.ledgeId,
              extra: { anim: step.anim, quick: step.quick, stopAt: step.touch ? { t: jp.t, to: { ...step.to } } : undefined },
            },
          );
        };
        if (kicking) {
          // Off the wall straight away: a quick kick pose, then the next leap.
          this.animator.play(step.anim ?? "crouch");
          this.wait(140, go);
          return;
        }
        this.waitFor("crouch", go);
        this.animator.play("crouch", "airUp");
        return;
      }
      case "hang": {
        if (this.mode !== "stand" || !isTop(this.surface)) return this.nextStep();
        // Over the edge, hanging on by the paws.
        this.hangDrop = (2 * HALF - 14) * u;
        this.body.y += this.hangDrop;
        this.animator.play(chaosAnim("hang_ledge"));
        this.place();
        this.event("hang");
        this.wait(step.ms, () => {
          const pull = chaosAnim("pull_up");
          this.animator.play(pull, this.restAnim());
          this.wait(ANIMATIONS[pull].once ? 700 : 600, () => {
            this.unhang();
            this.animator.play(this.restAnim());
            this.nextStep();
          });
        });
        return;
      }
      case "slide": {
        if (this.mode !== "stand") return this.finishPlan();
        const to = { x: step.x, y: step.y };
        const dist = Math.hypot(to.x - this.body.x, to.y - this.body.y);
        const next = step.land ? { surface: FLOOR, s: clampTo(FLOOR, step.x, w) } : null;
        this.corner = { from: { x: this.body.x, y: this.body.y }, to, a0: this.body.angle, a1: 0, t0: this.now, ms: Math.max(350, (dist / (380 * u)) * 1000), next };
        this.mode = "corner";
        this.animator.play(chaosAnim("slide_down"));
        this.event("slide");
        this.ensureMotion();
        return;
      }
      case "hop": {
        const go = () => this.launch({ x: step.dir * 190 * u, y: -430 * u }, { planned: true, panic: false });
        const ms = this.turnNow(facesLeftFor(this.surface.kind, step.dir));
        if (ms > 0) return this.wait(ms, () => (this.mode === "stand" ? go() : this.finishPlan()));
        go();
        return;
      }
      case "drop": {
        const kind = this.surface.kind;
        if (isStanding(this.surface)) return this.nextStep();
        const push = kind === "left" ? { x: 170 * u, y: -80 * u } : kind === "right" ? { x: -170 * u, y: -80 * u } : { x: 0, y: 30 * u };
        if (step.float) {
          // Let go and float down: upright, no tumbling.
          this.body.spin = 0;
          this.turnNow((step.drift ?? 0) < 0);
          const anim = chaosAnim(step.float === "copter" ? "tail_copter" : "glide");
          this.launch({ x: push.x * 0.5, y: -40 * u }, { planned: true, panic: false, drag: false, extra: { anim, float: { drift: step.drift ?? 0 } } });
          return;
        }
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

  /** Back up from hanging off an edge (onto the top again, or nowhere if he's launching). */
  private unhang(restore = true): void {
    if (!this.hangDrop) return;
    if (restore) this.body.y -= this.hangDrop;
    this.hangDrop = 0;
    this.place();
  }

  private doTeleport(): void {
    const t = this.teleportTo;
    const w = this.world;
    this.teleportTo = null;
    if (!t || !w) return;
    // Glitching away from his own platform: it breaks up behind him.
    if (this.platform && !this.platform.breaking) {
      this.platform.breaking = true;
      this.ensureMotion();
    }
    this.surface = t.surface;
    this.s = clampTo(t.surface, t.s, w);
    const c = restCenter(t.surface, this.s, w);
    this.body = { x: c.x, y: c.y, vx: 0, vy: 0, angle: surfaceAngle(t.surface.kind), spin: 0 };
    this.k = 1;
    this.facingLeft = this.rand() < 0.5;
    this.event(isTop(t.surface) ? `teleport:${t.surface.kind}:${t.surface.ledge.id}@${t.surface.ledge.x},${t.surface.ledge.y}` : `teleport:${t.surface.kind}`);
    this.place();
    this.armLedgeWatch();
    // Teleporting is messy: sometimes he lands in a puddle of glitch.
    if (this.chaosOn && this.host.chaos && this.rand() < 0.35) this.stepInGlitch(14_000);
  }

  /** Drop whatever plan is running; leave the body somewhere sane. */
  private interrupt(): void {
    this.plan = null;
    this.waiting = null;
    if (this.brainTimer !== null) this.clock.clearTimeout(this.brainTimer);
    this.brainTimer = null;
    // Let go of whatever he was dragging (another app's window, the cursor).
    this.endHaul();
    if (this.loco) {
      this.loco = null;
      this.motion = CALM;
    }
    this.unhang();
    if (this.corner && !this.corner.next) {
      // Mid-slide: just let go there.
      this.corner = null;
      this.launch({ x: 0, y: 0 }, { planned: false, panic: false });
    }
    if (this.corner && this.corner.next) {
      const c = this.corner as { from: Vec; to: Vec; next: { surface: Surface; s: number } };
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
    if (this.flight) {
      this.flight.planned = false;
      // Stopped on a wall-jump kick: nothing holds him up any more.
      this.flight.frozen = false;
      this.flight.stopAt = undefined;
      this.flight.float = undefined;
    }
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
    this.wokeAt = this.now;
    // Stretch and yawn awake (standing only: on a wall he just snaps back to life).
    if (this.mode === "stand" && isStanding(this.surface) && !this.busy()) this.animator.play("wake", this.restAnim());
    else this.animator.play(this.restAnim());
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
      if (this.mode !== "stand" || this.hold || !isStanding(this.surface)) return;
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
      if (["think", "ask", "listen", "talk"].includes(this.animator.animation)) this.animator.play(this.restAnim());
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
        if (["walk", "run", "climb"].includes(this.animator.animation)) this.animator.play(this.restAnim());
        this.turnNow(this.body.x > a.x + a.w / 2);
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
    // Mischief involving the cursor (chasing, carrying it) brings it onto him: carry on.
    if (this.plan?.name === "mischief") return;
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
        if (Math.abs(p.x - this.body.x) > 8 * this.u) this.turnNow(p.x < this.body.x);
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
    // "chaos:window", "chaos:note"...: a chaos act (debug trigger).
    if (typeof name === "string" && name.startsWith("chaos:")) {
      if (this.director && isAct(name.slice(6).split(":")[0])) {
        void this.forceChaos(name.slice(6));
        return true;
      }
      // Not a chaos act: a behaviour or animation by that name (debug trigger).
      return this.playAction(name.slice(6));
    }
    // Behaviours first ("climb" is also the climbing animation); the animation if it can't be planned here.
    if (isBehaviourName(name) && this.force(name)) return true;
    if (isAnimationName(name)) {
      if (this.mode === "held") return false;
      // On a wall or the ceiling he is turned with the surface: a front-facing
      // emote would look like waving lying down. Only wall/air poses there.
      const keys = ANIMATIONS[name].keys;
      const fam = familyOf((typeof keys === "function" ? keys(() => 0.5, {}) : keys)[0]?.frame ?? "");
      if (!isStanding(this.surface) && this.mode === "stand" && fam !== "wall" && fam !== "any") return false;
      // And the wall poses (crawling, holding on) only on a wall, never standing on the floor.
      if (isStanding(this.surface) && fam === "wall") return false;
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
    // Clicked again and again: each quick click annoys him more than a single poke.
    const rapid = this.now - this.lastClickAt < RAPID_CLICK_MS;
    this.lastClickAt = this.now;
    this.annoy(rapid ? 0.6 : 0.4);
    if (this.sulking) {
      // Ignores you (a glance back over the shoulder at most).
      this.updateHitbox();
      return;
    }
    if (this.mode === "stand") this.clickReaction();
    this.updateHitbox();
    if (!this.plan) this.scheduleBrain(6000 + this.rand() * 6000);
  }

  /**
   * A click: startled, or, the more annoyed he is, annoyed and then grumpy
   * (bite, back turned, sulk). Never restarts a reaction that is still
   * playing (rapid clicks would make him vibrate between two frames): a quick
   * glitch flinch over it instead. On a wall or the ceiling a wall pose
   * flinch (the front poses would lie sideways there). Sitting or lying down,
   * he gets up first.
   */
  private clickReaction(): void {
    const cur = this.animator.animation;
    const frame = this.animator.pose?.frame ?? "idle0";
    // Just woken up (by this press or the hover before it): let the wake-up play, a flinch over it.
    if (this.now - this.wokeAt < 1500 && (cur === "wake" || familyOf(frame) === "curled")) return this.flinch();
    this.interrupt();
    if (!isStanding(this.surface)) {
      if (this.now - this.reactAt < CLICK_DEBOUNCE_MS) return this.flinch();
      this.reactAt = this.now;
      if (cur !== "cling") this.animator.play("cling");
      this.animator.interject((_, base) => wallFlinch(base));
      return;
    }
    const a = this.annoyance;
    let want: ClickReaction = a >= ANNOY_HIGH ? "grumpy" : a >= ANNOY_MEDIUM ? "annoyed" : "startled";
    // Step by step up the ladder: right after a startle he gets annoyed before he bites.
    if (this.now - this.reactAt < 4000) want = CLICK_REACTIONS[Math.min(CLICK_REACTIONS.indexOf(want), this.reactLevel + 1)];
    const playing = CLICK_REACTIONS.indexOf(cur as ClickReaction);
    // The same reaction or a milder one is still on: no restart.
    if ((playing >= 0 && CLICK_REACTIONS.indexOf(want) <= playing) || this.now - this.reactAt < CLICK_DEBOUNCE_MS) return this.flinch();
    this.reactAt = this.now;
    this.reactLevel = CLICK_REACTIONS.indexOf(want);
    if (want === "grumpy") {
      this.startSulk();
      this.animator.play("grumpy");
      return;
    }
    if (want === "annoyed") return this.animator.play("annoyed", this.restAnim());
    this.animator.play("startled", this.restAnim(), this.standUpFirst("surprised0"));
  }

  /**
   * Startled is unbridged (a fright can't wait), but it is drawn standing:
   * finish the clip on screen, and from sitting jump up (the hop stand-up,
   * quick), from lying down get up at double speed, else the usual bridge.
   */
  private standUpFirst(next: string): Keyframe[] {
    const lead = this.animator.exitKeys("startled");
    const shown = lead.at(-1)?.frame ?? this.animator.pose?.frame ?? "idle0";
    const fam = familyOf(shown);
    if (fam === "sit") return [...lead, ...(has("stand_up_hop") ? clip("stand_up_hop", 60, { ease: 0 }) : glitchCut(next))];
    if (fam === "curled") return [...lead, ...(has("get_up") ? clip("get_up", 55, { ease: 0 }) : glitchCut(next))];
    // A fright: the turn at double speed.
    const turn = bridge(shown, next, this.rand, this.animator.mem as { lastClip?: Record<string, string> });
    return [...lead, ...turn.map((key) => ({ ...key, ms: Math.max(MIN_KEY_MS, Math.round(key.ms / 2)) }))];
  }

  /** A quick glitch twitch over whatever is showing (no new animation). */
  private flinch(): void {
    this.animator.interject((_, base) => [
      { ...base, ms: 50, dx: (base.dx ?? 0) - 2, glitch: 0.6, fx: "eye" },
      { ...base, ms: 50, glitch: 0.3, fx: "eye" },
    ]);
  }

  /** Back turned and sulking for 7 s (clicks get no reaction), then he calms down. */
  private startSulk(): void {
    this.sulkUntil = this.now + 7000;
    if (this.annoyTimer !== null) this.clock.clearTimeout(this.annoyTimer);
    this.annoyTimer = this.clock.setTimeout(() => {
      this.annoyTimer = null;
      if (this.mode === "stand" && ["grumpy", "annoyed", "sulk"].includes(this.animator.animation)) this.animator.play("calmDown", "idle");
      // The sulk kept the brain quiet (canAct): back to normal life.
      if (!this.plan) this.scheduleBrain(3000 + this.rand() * 3000);
    }, 7000);
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
    // Picked up by the scruff of his neck, wherever you clicked: he hangs
    // straight down from the cursor tip, his neck between his ears at it
    // (the body centre SCRUFF px below), upright. The attach eases in from
    // where he was (ATTACH_MS) so he doesn't snap.
    const L = SCRUFF * u;
    this.hold = {
      cursor: grab,
      busy: false,
      L,
      phi0: 0,
      angle0: 0,
      pivotY: -HALF - SCRUFF,
      pend: new Pendulum(0, L, PHYS.gravity * u),
      tracker: new VelocityTracker(),
      vs: { x: 0, y: 0 },
      kickUntil: 0,
      attach: { x: this.body.x - grab.x, y: this.body.y - grab.y, angle: this.body.angle, t0: this.now },
    };
    this.hold.tracker.add(this.now, grab);
    this.mode = "held";
    this.rideLag = { x: 0, y: 0 };
    if (this.pollTimer !== null) this.clock.clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.syncLedgeWatch();
    this.annoy(1);
    this.sulkUntil = 0;
    this.animator.play(this.annoyance >= ANNOY_MEDIUM ? "struggle" : "held");
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
    // A small damped sway that lags the cursor (never more than SWAY_MAX).
    const sway = (SWAY_MAX * Math.PI) / 180;
    const phi = Math.max(-sway, Math.min(sway, h.pend.phi));
    let x = h.cursor.x + h.L * Math.sin(phi);
    let y = h.cursor.y + h.L * Math.cos(phi);
    let angle = -(phi * 180) / Math.PI;
    // Clinging on to the cursor (drawn holding it): the frame's grip point at the cursor tip, no sway.
    if (h.grip) {
      x = h.cursor.x + h.grip.x;
      y = h.cursor.y + h.grip.y;
      angle = 0;
    }
    // Easing in from where he was when you grabbed him.
    const e = Math.min(1, (now - h.attach.t0) / ATTACH_MS);
    if (e < 1) {
      const k = e * e * (3 - 2 * e);
      x = h.cursor.x + h.attach.x + (x - h.cursor.x - h.attach.x) * k;
      y = h.cursor.y + h.attach.y + (y - h.cursor.y - h.attach.y) * k;
      angle = h.attach.angle + (angle - h.attach.angle) * k;
    }
    this.body.x = x;
    this.body.y = y;
    this.body.angle = angle;
    // Upright drawn frames, no stretching or shearing of the sprite.
    this.motion = CALM;
    const speed = Math.hypot(h.vs.x, h.vs.y) / u;
    if (speed > 900) h.kickUntil = now + 350;
    if (this.clingTimer !== null) return; // hanging on to the cursor after you let go
    const want: AnimationName = now < h.kickUntil ? "heldKick" : this.annoyance >= ANNOY_MEDIUM ? "struggle" : "held";
    if (this.animator.animation !== want && ["held", "heldKick", "struggle"].includes(this.animator.animation)) this.animator.play(want);
  }

  private release(): void {
    const h = this.hold!;
    const w = this.world!;
    const u = w.scale;
    const vc = h.tracker.velocity(this.now);
    const tip = h.pend.tipVelocity(h.L);
    const v = capSpeed({ x: vc.x + tip.x, y: vc.y + tip.y }, MAX_THROW * u);
    const speed = Math.hypot(v.x, v.y) / u;
    // Let go gently while he's annoyed: he holds on to the cursor a moment
    // longer (still following it), then drops. Not when thrown.
    if (this.clingTimer === null && !this.clingDone && this.annoyance >= ANNOY_MEDIUM && speed < 400) {
      this.annoy(0.5);
      this.animator.play("clingCursor");
      // Hold on by the grip drawn in the frame (art/frames/cling_cursor-grips.json), easing there from the scruff.
      const g = ANIM_GRIPS.cling_cursor0;
      if (g) {
        const ux = this.u * ART_SCALE;
        h.grip = { x: -(g[0] - ANIM_FRAME_W / 2) * ux, y: -(g[1] - ANIM_FRAME_H) * ux - HALF * this.u };
        h.attach = { x: this.body.x - h.cursor.x, y: this.body.y - h.cursor.y, angle: this.body.angle, t0: this.now };
      }
      this.event("cling-cursor");
      this.clingTimer = this.clock.setTimeout(() => {
        this.clingTimer = null;
        // Now he lets go (this release must not start another cling).
        this.clingDone = true;
        if (this.hold === h) this.release();
        this.clingDone = false;
      }, 1400);
      return;
    }
    if (this.clingTimer !== null) {
      this.clock.clearTimeout(this.clingTimer);
      this.clingTimer = null;
    }
    this.hold = null;
    this.annoy(speed > 600 ? 1.5 : 0.5);
    const a = this.annoyance;
    this.reactAfterLanding = a >= ANNOY_HIGH ? "grumpy" : a >= ANNOY_MEDIUM ? "annoyed" : null;
    // Only a hard throw sends him spinning (the drawn spin); otherwise he falls upright, flailing.
    this.body.spin = speed > HARD_THROW ? Math.max(-1100, Math.min(1100, (-h.pend.omega * 180) / Math.PI + (v.x / u) * 0.3)) : 0;
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
