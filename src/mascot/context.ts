// "He reacts to what you're doing", the mascot side. Rust watches (music,
// coding, games, videos, the clock, battery, CPU; src-tauri/src/context.rs)
// and sends Reactions; this file turns them into ordinary brain plans and
// runs them when Glitch is free: never while he is held, hovered, asleep,
// annoyed, chatting or up to mischief. A reaction that arrives at a bad
// moment waits a little (PENDING_MS) and is then dropped: no queue, no spam.
//
// Two states hush him (he sits still, no wandering, no chaos): a fullscreen
// app / game ("quiet", he hides in a corner first) and a focus session
// (he guards quietly; hovering shows the countdown; the end is celebrated).

import { ANIMATIONS, type AnimationName, isAnimationName } from "./animations";
import type { Plan, Step } from "./brain";
import { FLOOR, isStanding, isTop, planJump, restCenter, type Surface, surfaceRange, type World } from "./physics";
import type { ContextStatus, FocusPhase, Reaction } from "../shared/context";

// ------------------------------------------------------------ animations

/**
 * Reaction animation names (new art, added to animations.ts by the
 * animation work) and what to play until they exist.
 */
export const REACT_FALLBACKS: Record<string, readonly string[]> = {
  dance_beat: ["dance", "happy"],
  glasses_type: ["typing", "think"],
  watch_tv: ["sitEdge", "sit"],
  sweat_fan: ["sad", "malfunction"],
  worried_battery: ["scared", "sad"],
  celebrate_focus: ["celebrate", "happy"],
  stretch: ["wake", "happy"],
  yawn: ["lookAround"],
  yawn_stay: ["yawn", "lookAround"],
  // Hushed poses (loops).
  hide: ["sit", "idle"],
  guard: ["sit", "idle"],
  suggest: ["point", "happy"],
};

/** The animation for a reaction name: itself if it exists, else the first fallback that does, else "idle". */
export function reactAnim(name: string, has: (n: string) => boolean = isAnimationName): AnimationName {
  if (has(name)) return name as AnimationName;
  for (const f of REACT_FALLBACKS[name] ?? []) if (has(f)) return f as AnimationName;
  return "idle";
}

/** An animation step: loops for `ms`, one-shots until they end. */
function anim(name: AnimationName, ms: number): Step {
  return ANIMATIONS[name]?.once ? { do: "anim", name } : { do: "anim", name, ms };
}

// ------------------------------------------------------------ planning

export interface ReactContext {
  world: World;
  surface: Surface;
  s: number;
  movement: boolean;
}

/**
 * Plan a reaction from where he is (pure). null: doesn't fit here (not
 * standing...), or it isn't something he acts out (quiet, focus).
 */
export function planReaction(r: Reaction, ctx: ReactContext, rand: () => number, has?: (n: string) => boolean): Plan | null {
  if (!isStanding(ctx.surface)) return null;
  const a = (name: string) => reactAnim(name, has);
  const plan = (...steps: Step[]): Plan => ({ name: "react", steps });
  switch (r.kind) {
    case "dance":
      return plan(anim(a("dance_beat"), 9000 + rand() * 6000));
    case "glasses_type":
      return plan(anim(a("glasses_type"), 10_000 + rand() * 10_000));
    case "watch_tv":
      return planWatch(r.window, ctx, rand, a);
    case "late_night":
      // Yawns but stays up (plain "yawn" goes on to sleep).
      return plan(anim(a("yawn_stay"), 2500));
    case "morning":
      return plan(anim(a("stretch"), 3000));
    case "battery_low":
      return plan(anim(a("worried_battery"), 4500));
    case "cpu_hot":
      return plan(anim(a("sweat_fan"), 6000 + rand() * 2000));
    case "suggest_focus":
      return plan(anim(a("suggest"), 2500));
    case "quiet":
      return null;
  }
}

/** Sit on top of the window playing the video (jump up, or glitch over) and watch. */
function planWatch(id: number, ctx: ReactContext, rand: () => number, a: (n: string) => AnimationName): Plan {
  const { world, surface } = ctx;
  const watch = anim(a("watch_tv"), 20_000 + rand() * 25_000);
  const ledge = world.ledges.find((l) => l.id === id);
  // No top to sit on (maximised, covered) or not allowed to move: watch from here.
  if (!ledge || !ctx.movement || (isTop(surface) && surface.ledge.id === id)) return { name: "react", steps: [watch] };
  const target: Surface = { kind: "ledge", ledge };
  const [lo, hi] = surfaceRange(target, world);
  const s = lo + (hi - lo) * (0.2 + 0.6 * rand());
  const from = restCenter(surface, ctx.s, world);
  const to = restCenter(target, s, world);
  if (planJump(from, to, world)) {
    return { name: "react", steps: [{ do: "face", dir: to.x >= from.x ? 1 : -1 }, { do: "jump", to, ledgeId: ledge.id }, watch] };
  }
  return { name: "react", steps: [{ do: "teleport", surface: target, s }, watch] };
}

/** Into the nearest bottom corner of the screen (a game started). null: already there / can't. */
export function planHide(ctx: ReactContext): Plan | null {
  if (!ctx.movement || !isStanding(ctx.surface)) return null;
  const [lo, hi] = surfaceRange(FLOOR, ctx.world);
  const x = restCenter(ctx.surface, ctx.s, ctx.world).x;
  const corner = x - lo < hi - x ? lo : hi;
  if (ctx.surface.kind === "floor" && Math.abs(ctx.s - corner) < 40 * ctx.world.scale) return null;
  return { name: "react", steps: [{ do: "teleport", surface: FLOOR, s: corner }] };
}

// ------------------------------------------------------------ the reactor

/** What the reactor needs from the creature. */
export interface ReactSubject {
  readonly world: World | null;
  readonly surface: Surface;
  readonly s: number;
  readonly movement: boolean;
  canReact(): boolean;
  react(plan: Plan): boolean;
  setHush(pose: AnimationName | null): void;
}

export interface ReactorClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

/** The tiny focus countdown shown while hovering him. */
export interface CountdownLabel {
  show(text: string): void;
  hide(): void;
}

/** A reaction waits this long for him to be free, then it's dropped. */
export const PENDING_MS = 20_000;
const RETRY_MS = 2000;

/** "24:05" / "0:42". */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export class ContextReactor {
  private pending: { r: Reaction; until: number } | null = null;
  private retryTimer: unknown = null;
  private quiet = false;
  private focus: FocusPhase = { phase: "off" };
  /** When the focus phase ends (reactor clock). */
  private focusEnds: number | null = null;
  private hovered = false;
  private labelTimer: unknown = null;
  /** What happened, for tests and the dev log. */
  onEvent: ((what: string) => void) | null = null;

  constructor(
    private readonly subject: ReactSubject,
    private readonly clock: ReactorClock,
    private readonly rand: () => number = Math.random,
    private readonly label: CountdownLabel | null = null,
    private readonly has?: (n: string) => boolean,
  ) {}

  /** A "context" event from Rust. `force` (debug triggers): skip the "is he free" check. */
  handle(r: Reaction, force = false): boolean {
    if (r.kind === "quiet") {
      this.setQuiet(r.on);
      return true;
    }
    if (this.quiet && !force) return false;
    if (this.tryRun(r, force)) return true;
    this.pending = { r, until: this.clock.now() + PENDING_MS };
    this.armRetry();
    return false;
  }

  /** A "focus" event (or the status at start-up). */
  status(s: ContextStatus): void {
    const was = this.focus.phase;
    this.focus = s.focus;
    this.focusEnds = s.remaining_ms === null ? null : this.clock.now() + s.remaining_ms;
    if (s.quiet !== this.quiet) this.setQuiet(s.quiet);
    else this.applyHush();
    // The session is over: celebrate.
    if (was === "focus" && s.focus.phase === "break") {
      const plan: Plan = { name: "react", steps: [anim(reactAnim("celebrate_focus", this.has), 3000)] };
      if (this.subject.canReact()) this.subject.react(plan);
      this.event("focus-done");
    }
    this.updateLabel();
  }

  /** The cursor is over him (countdown while focusing). */
  setHovered(on: boolean): void {
    this.hovered = on;
    this.updateLabel();
  }

  get hushed(): boolean {
    return this.quiet || this.focus.phase === "focus";
  }

  dispose(): void {
    for (const t of [this.retryTimer, this.labelTimer]) if (t !== null) this.clock.clearTimeout(t);
    this.retryTimer = this.labelTimer = null;
  }

  private setQuiet(on: boolean): void {
    this.quiet = on;
    this.event(on ? "quiet" : "unquiet");
    if (on) {
      this.pending = null;
      const w = this.subject.world;
      if (w && this.subject.canReact()) {
        const plan = planHide({ world: w, surface: this.subject.surface, s: this.subject.s, movement: this.subject.movement });
        if (plan) this.subject.react(plan);
      }
    }
    this.applyHush();
  }

  private applyHush(): void {
    const pose = this.quiet ? reactAnim("hide", this.has) : this.focus.phase === "focus" ? reactAnim("guard", this.has) : null;
    this.subject.setHush(pose);
  }

  private tryRun(r: Reaction, force: boolean): boolean {
    const w = this.subject.world;
    if (!w || (!force && (!this.subject.canReact() || this.focus.phase === "focus"))) return false;
    const plan = planReaction(r, { world: w, surface: this.subject.surface, s: this.subject.s, movement: this.subject.movement }, this.rand, this.has);
    if (!plan) return false;
    const ok = this.subject.react(plan);
    if (ok) this.event(`react:${r.kind}`);
    return ok;
  }

  private armRetry(): void {
    if (this.retryTimer !== null) return;
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = null;
      const p = this.pending;
      if (!p) return;
      if (this.clock.now() > p.until || this.quiet) {
        this.pending = null;
        this.event(`dropped:${p.r.kind}`);
        return;
      }
      if (this.tryRun(p.r, false)) this.pending = null;
      else this.armRetry();
    }, RETRY_MS);
  }

  private updateLabel(): void {
    if (!this.label) return;
    const active = this.focus.phase !== "off" && this.focusEnds !== null;
    if (!this.hovered || !active) {
      if (this.labelTimer !== null) this.clock.clearTimeout(this.labelTimer);
      this.labelTimer = null;
      this.label.hide();
      return;
    }
    const left = this.focusEnds! - this.clock.now();
    this.label.show(`${this.focus.phase === "break" ? "break " : ""}${formatCountdown(left)}`);
    if (this.labelTimer === null) {
      // Once a second, only while hovered.
      this.labelTimer = this.clock.setTimeout(() => {
        this.labelTimer = null;
        this.updateLabel();
      }, 1000);
    }
  }

  private event(what: string): void {
    this.onEvent?.(what);
  }
}

/** Debug trigger names (as in Rust) -> a reaction, for the dev stage without Rust. */
export function debugReaction(name: string): Reaction | null {
  switch (name) {
    case "dance":
      return { kind: "dance", bpm: 112 };
    case "glasses":
      return { kind: "glasses_type" };
    case "watch":
      return { kind: "watch_tv", window: 0 };
    case "night":
      return { kind: "late_night", say: true };
    case "morning":
      return { kind: "morning" };
    case "battery":
      return { kind: "battery_low", percent: 12 };
    case "cpu":
      return { kind: "cpu_hot" };
    case "quiet":
      return { kind: "quiet", on: true };
    case "unquiet":
      return { kind: "quiet", on: false };
    case "suggest":
      return { kind: "suggest_focus" };
  }
  return null;
}
