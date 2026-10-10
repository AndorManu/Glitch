// What Glitch feels like doing next. Pure: given where he is and what the
// screen looks like, pick a behaviour (weighted, with cooldowns, depending
// on where he stands) and plan it as a list of steps. creature.ts runs the
// steps (walking, climbing, jumping...) and asks again when they are done.
//
// Most of his time is spent resting in between (idle fidgets on the floor,
// clinging on walls): `restMs` keeps him calm, and creature.ts rests at
// least 3x as long as the last activity took.

import { ANIMATIONS, type AnimationName } from "./animations";
import { chaosAnim } from "./chaos";
import {
  clampTo,
  cornerAt,
  HALF,
  isStanding,
  isTop,
  JUMP,
  planJump,
  restCenter,
  type Surface,
  surfaceRange,
  type Vec,
  type World,
} from "./physics";

export type Gait = "walk" | "run" | "climb";

/**
 * Something Glitch drags along while he walks (chaos mode: another app's
 * window, his sticky note, the cursor). See chaos.ts.
 */
export interface Haul {
  /**
   * He has moved (dx, dy) physical px since the walk began: move the thing.
   * Resolves to the offset actually applied (it may be clamped), or null to
   * let go (refused, the user took over...).
   */
  move(dx: number, dy: number): Vec | null | Promise<Vec | null>;
  /** The walk ended (arrived, interrupted or refused). */
  release(): void;
  /**
   * Set when he stands on the window he drags (its top is this ledge): he
   * then rides along with it instead of walking off its end.
   */
  ledgeId?: number;
}

export type Step =
  /**
   * Walk along the current surface to coordinate `to` (centre x on
   * floors/tops/ceiling, y on walls). Chaos extras: `anim` instead of the
   * gait's animation, `backwards` (face against the way he walks), `haul`
   * (drag something along).
   */
  | { do: "walk"; to: number; gait: Gait; anim?: AnimationName; backwards?: boolean; haul?: Haul }
  /**
   * Run some code (chaos mode: ask Rust, open a note...). false = abandon the
   * plan; a list of steps = do these next; true = carry on.
   */
  | { do: "call"; run: () => boolean | Step[] | Promise<boolean | Step[]> }
  /** Turn the corner at this end of the current surface onto the next screen edge. */
  | { do: "corner"; end: -1 | 1 }
  /** Play an animation: one-shots until they end, loops for `ms`. */
  | { do: "anim"; name: AnimationName; ms?: number }
  /** Face this way along the surface (+1 = increasing coordinate). */
  | { do: "face"; dir: 1 | -1 }
  /** Crouch, then a ballistic jump to this centre point (physical px). `spin` in degrees over the flight (a flip). */
  | {
      do: "jump";
      to: Vec;
      ledgeId?: number;
      spin?: number;
      /** Apex height above the higher end (CSS px; default JUMP.clearance). */
      height?: number;
      /** Animation in the air instead of airUp/airDown. */
      anim?: AnimationName;
      /** Stop dead at `to` in mid-air (a wall-jump kick off a window's side); the next jump starts there. */
      touch?: boolean;
      /** Barely pause after landing (bouncing). */
      quick?: boolean;
    }
  /** Hop off the end of a window top. */
  | { do: "hop"; dir: 1 | -1 }
  /** Let go of the wall / ceiling. `float`: come down slowly, tail spinning like a helicopter or gliding, drifting `drift` CSS px/s sideways. */
  | { do: "drop"; float?: "copter" | "glide"; drift?: number }
  /** At the end of a window top: hang off its edge by the paws for `ms`, then pull himself back up. */
  | { do: "hang"; ms: number }
  /** Slide down a window's side to centre (x, y) physical px: onto the taskbar (`land`) or let go there. */
  | { do: "slide"; x: number; y: number; land: boolean }
  /** Glitch out, reappear on `surface` at `s`. */
  | { do: "teleport"; surface: Surface; s: number }
  /** Jump straight up `height` CSS px and conjure a glitch platform at the top. */
  | { do: "build"; height: number }
  /** The platform under him breaks up; he falls. */
  | { do: "unbuild" };

export type BehaviourName =
  | "stroll"
  | "run"
  | "climb"
  | "jump"
  | "sitEdge"
  | "peekEdge"
  | "hopDown"
  | "teleport"
  | "build"
  | "chaos"
  | "malfunction"
  | "lookAround"
  | "climbOn"
  | "climbDown"
  | "crawl"
  | "drop"
  | "lookBack"
  | "sleep"
  | "celebrate"
  // Playful moves (see the end of plan()).
  | "copter"
  | "hangOn"
  | "slideDown"
  | "trampoline"
  | "fish"
  | "wallJump"
  /** Chaos mode (planned by chaos.ts, never picked by the dice here). */
  | "mischief"
  /** Reacting to what the user does (planned by context.ts, never picked by the dice). */
  | "react"
  /** Games: fetch, hide and seek, eating (planned by play/, never picked by the dice). */
  | "play";

export interface Plan {
  name: BehaviourName;
  steps: Step[];
}

export interface BrainContext {
  /** ms, same clock as the creature. */
  now: number;
  world: World;
  surface: Surface;
  /** Centre coordinate along the surface. */
  s: number;
  /** Settings: may he wander? (false: stays put, idle animations only) */
  movement: boolean;
  /** 10 idle minutes are up: get down somewhere and sleep. */
  sleepy: boolean;
  /** Recently happy / thrown around: chaos is more likely. */
  excited: boolean;
}

interface Entry {
  weight: number;
  /** Seconds before it can be picked again. */
  cooldown: number;
  /** Does it walk / climb / jump (not allowed with movement off)? */
  moves: boolean;
}

/** With movement off: a look around at most this often (sitting a while fills the gaps). */
export const STILL_LOOK_COOLDOWN_MS = 75_000;

export const BEHAVIOURS: Record<BehaviourName, Entry> = {
  stroll: { weight: 5, cooldown: 4, moves: true },
  run: { weight: 1.2, cooldown: 45, moves: true },
  climb: { weight: 2.4, cooldown: 50, moves: true },
  jump: { weight: 3.5, cooldown: 14, moves: true },
  sitEdge: { weight: 2, cooldown: 60, moves: true },
  peekEdge: { weight: 1.5, cooldown: 25, moves: true },
  hopDown: { weight: 1.4, cooldown: 20, moves: true },
  teleport: { weight: 0.8, cooldown: 120, moves: true },
  build: { weight: 0.9, cooldown: 150, moves: true },
  chaos: { weight: 0.5, cooldown: 90, moves: false },
  malfunction: { weight: 0.9, cooldown: 45, moves: false },
  lookAround: { weight: 2, cooldown: 20, moves: false },
  climbOn: { weight: 3, cooldown: 0, moves: true },
  climbDown: { weight: 2, cooldown: 0, moves: true },
  crawl: { weight: 3, cooldown: 0, moves: true },
  drop: { weight: 1.5, cooldown: 0, moves: false },
  lookBack: { weight: 1, cooldown: 6, moves: false },
  sleep: { weight: 0, cooldown: 0, moves: false },
  celebrate: { weight: 0, cooldown: 0, moves: false },
  mischief: { weight: 0, cooldown: 0, moves: true },
  react: { weight: 0, cooldown: 0, moves: false },
  play: { weight: 0, cooldown: 0, moves: true },
  copter: { weight: 1.1, cooldown: 120, moves: true },
  hangOn: { weight: 1.3, cooldown: 90, moves: true },
  slideDown: { weight: 1.2, cooldown: 90, moves: true },
  trampoline: { weight: 1, cooldown: 100, moves: true },
  fish: { weight: 0.9, cooldown: 150, moves: true },
  wallJump: { weight: 1, cooldown: 120, moves: true },
};

export function isBehaviourName(name: unknown): name is BehaviourName {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(BEHAVIOURS, name);
}

/** Does this plan move him around (walk, climb, jump, teleport...)? */
export function planMoves(plan: Plan): boolean {
  return plan.steps.some((s) => s.do !== "anim" && s.do !== "face");
}

export class Brain {
  private readonly last = new Map<BehaviourName, number>();

  constructor(private readonly rand: () => number = Math.random) {}

  /** Rest before the next behaviour (ms): 5-14 s standing (creature.ts makes it at least 3x the last activity), short while clinging to a wall. */
  restMs(ctx: BrainContext): number {
    if (!isStanding(ctx.surface)) return 1200 + this.rand() * 2300;
    return 5000 + this.rand() * 9000;
  }

  /** When was this last chosen (ms), or -Infinity. */
  lastUsed(name: BehaviourName): number {
    return this.last.get(name) ?? -Infinity;
  }

  ready(name: BehaviourName, now: number): boolean {
    return now - this.lastUsed(name) >= BEHAVIOURS[name].cooldown * 1000;
  }

  /** Pick and plan the next behaviour. Always returns something (at worst a look around). */
  next(ctx: BrainContext): Plan {
    // Things that override the dice. (His own platform doesn't count as somewhere to stay.)
    const mustGetDown = !isStanding(ctx.surface) || ctx.surface.kind === "platform";
    if (mustGetDown && (ctx.sleepy || !ctx.movement)) return this.commit(this.getDown(ctx), ctx.now);
    if (ctx.sleepy) return this.commit({ name: "sleep", steps: [{ do: "anim", name: "yawn" }] }, ctx.now);

    const options: { name: BehaviourName; plan: Plan; weight: number }[] = [];
    for (const name of Object.keys(BEHAVIOURS) as BehaviourName[]) {
      const entry = BEHAVIOURS[name];
      if (entry.weight <= 0 || !this.ready(name, ctx.now)) continue;
      if (entry.moves && !ctx.movement) continue;
      // Movement off leaves few behaviours: the look around would come every 20 s.
      if (name === "lookAround" && !ctx.movement && ctx.now - this.lastUsed(name) < STILL_LOOK_COOLDOWN_MS) continue;
      const plan = this.plan(name, ctx);
      if (!plan) continue;
      if (!ctx.movement && planMoves(plan)) continue;
      let weight = entry.weight;
      if (name === "chaos" && ctx.excited) weight *= 6;
      // On his own platform he shouldn't stay long.
      if (ctx.surface.kind === "platform" && (name === "drop" || name === "jump")) weight *= 3;
      options.push({ name, plan, weight });
    }
    if (options.length === 0) {
      // Movement off and he looked around not long ago: sit down a while instead (stands up
      // again after). Not committed: it doesn't push the next look around further away.
      if (!ctx.movement && isStanding(ctx.surface) && ctx.now - this.lastUsed("lookAround") < STILL_LOOK_COOLDOWN_MS) {
        return { name: "lookAround", steps: [{ do: "anim", name: "sit", ms: 6000 + this.rand() * 6000 }] };
      }
      return this.commit(this.idlePlan(ctx), ctx.now);
    }
    let roll = this.rand() * options.reduce((t, o) => t + o.weight, 0);
    for (const o of options) {
      roll -= o.weight;
      if (roll <= 0) return this.commit(o.plan, ctx.now);
    }
    return this.commit(options[options.length - 1].plan, ctx.now);
  }

  private commit(plan: Plan, now: number): Plan {
    this.last.set(plan.name, now);
    return plan;
  }

  /** Something harmless to do in place. */
  private idlePlan(ctx: BrainContext): Plan {
    if (!isStanding(ctx.surface)) return { name: "lookBack", steps: [{ do: "anim", name: "lookBack" }] };
    return { name: "lookAround", steps: [{ do: "anim", name: "lookAround" }] };
  }

  /** Off the wall / ceiling / platform: let go (or step off the platform). */
  private getDown(ctx: BrainContext): Plan {
    if (ctx.surface.kind === "platform") return { name: "drop", steps: [{ do: "unbuild" }] };
    // On a wall he climbs down (letting go and falling looks like an accident); off the ceiling he still drops.
    const down = this.plan("climbDown", ctx);
    if (down) return down;
    return { name: "drop", steps: [{ do: "drop" }] };
  }

  /** Plan one behaviour from here, or null if it doesn't fit (wrong surface, nothing in reach...). */
  plan(name: BehaviourName, ctx: BrainContext): Plan | null {
    const { surface, world } = ctx;
    const u = world.scale;
    const kind = surface.kind;
    const r = this.rand;
    const [lo, hi] = surfaceRange(surface, world);
    const standing = isStanding(surface);
    const steps = (...list: Step[]): Plan => ({ name, steps: list });
    switch (name) {
      case "stroll": {
        if (!(kind === "floor" || kind === "ledge")) return null;
        const dist = (100 + r() * 380) * u;
        let to = clampTo(surface, ctx.s + (r() < 0.5 ? -dist : dist), world);
        if (Math.abs(to - ctx.s) < 40 * u) to = clampTo(surface, ctx.s + (to > ctx.s ? -dist : dist), world);
        if (Math.abs(to - ctx.s) < 40 * u) return null;
        const list: Step[] = [{ do: "walk", to, gait: "walk" }];
        if (r() < 0.25) list.push({ do: "anim", name: "lookAround" });
        return steps(...list);
      }
      case "run": {
        if (kind !== "floor" || hi - lo < 500 * u) return null;
        const to = ctx.s - lo > hi - ctx.s ? lo + r() * 120 * u : hi - r() * 120 * u;
        if (Math.abs(to - ctx.s) < 350 * u) return null;
        return steps({ do: "walk", to, gait: "run" }, { do: "anim", name: "malfunction" });
      }
      case "climb": {
        if (kind !== "floor") return null;
        const end: -1 | 1 = Math.abs(ctx.s - lo) < Math.abs(ctx.s - hi) ? (r() < 0.75 ? -1 : 1) : r() < 0.75 ? 1 : -1;
        const corner = cornerAt(surface, end, world)!;
        const wall = corner.surface;
        const [wlo, whi] = surfaceRange(wall, world);
        const list: Step[] = [{ do: "walk", to: end < 0 ? lo : hi, gait: "walk" }, { do: "corner", end }];
        const roll = r();
        const part = wlo + (whi - wlo) * (0.25 + 0.45 * r());
        if (roll < 0.45) {
          // All the way up, along the ceiling for a bit, then let go.
          const ceil = cornerAt(wall, -1, world)!;
          const [clo, chi] = surfaceRange(ceil.surface, world);
          const across = end < 0 ? clo + (chi - clo) * (0.2 + 0.5 * r()) : chi - (chi - clo) * (0.2 + 0.5 * r());
          list.push({ do: "walk", to: part, gait: "climb" }, { do: "anim", name: "lookBack" }, { do: "walk", to: wlo, gait: "climb" }, { do: "corner", end: -1 });
          list.push({ do: "walk", to: across, gait: "climb" });
          if (r() < 0.5) list.push({ do: "anim", name: "cling", ms: 1500 + r() * 2000 });
          list.push({ do: "drop" });
        } else if (roll < 0.7) {
          // Part way up, a look back, and back down.
          list.push({ do: "walk", to: part, gait: "climb" }, { do: "anim", name: "lookBack" }, { do: "walk", to: whi, gait: "climb" }, { do: "corner", end: 1 });
        } else if (roll < 0.85) {
          // Part way up, then let go.
          list.push({ do: "walk", to: part, gait: "climb" }, { do: "anim", name: "lookBack" }, { do: "drop" });
        } else {
          // The grand tour: up, across the whole ceiling, down the other side.
          list.push({ do: "walk", to: wlo, gait: "climb" }, { do: "corner", end: -1 });
          const ceilEnd: -1 | 1 = end < 0 ? 1 : -1;
          const ceil = cornerAt(wall, -1, world)!.surface;
          const [clo, chi] = surfaceRange(ceil, world);
          list.push({ do: "walk", to: ceilEnd > 0 ? chi : clo, gait: "climb" }, { do: "corner", end: ceilEnd });
          const other = cornerAt(ceil, ceilEnd, world)!.surface;
          list.push({ do: "walk", to: surfaceRange(other, world)[1], gait: "climb" }, { do: "corner", end: 1 });
        }
        return steps(...list);
      }
      case "climbOn": {
        // On a wall: up to the ceiling and along it, then let go.
        if (kind !== "left" && kind !== "right") return null;
        const list: Step[] = [{ do: "walk", to: lo, gait: "climb" }, { do: "corner", end: -1 }];
        const ceil = cornerAt(surface, -1, world)!.surface;
        const [clo, chi] = surfaceRange(ceil, world);
        list.push({ do: "walk", to: clo + (chi - clo) * (0.25 + 0.5 * r()), gait: "climb" }, { do: "drop" });
        return steps(...list);
      }
      case "climbDown": {
        if (kind !== "left" && kind !== "right") return null;
        return steps({ do: "walk", to: hi, gait: "climb" }, { do: "corner", end: 1 });
      }
      case "crawl": {
        if (kind !== "ceiling") return null;
        if (r() < 0.5) {
          const to = lo + (hi - lo) * r();
          return steps({ do: "walk", to, gait: "climb" }, { do: "drop" });
        }
        const end: -1 | 1 = ctx.s - lo < hi - ctx.s ? -1 : 1;
        const wall = cornerAt(surface, end, world)!.surface;
        const [, whi] = surfaceRange(wall, world);
        return steps({ do: "walk", to: end < 0 ? lo : hi, gait: "climb" }, { do: "corner", end }, { do: "walk", to: whi, gait: "climb" }, { do: "corner", end: 1 });
      }
      case "drop":
        if (kind === "platform") return steps({ do: "unbuild" });
        if (standing) return null;
        return steps({ do: "drop" });
      case "lookBack":
        return standing ? null : steps({ do: "anim", name: "lookBack" });
      case "jump":
        return this.planLedgeJump(ctx);
      case "sitEdge": {
        if (kind !== "ledge") return null;
        const to = lo + (hi - lo) * (0.15 + 0.7 * r());
        return steps({ do: "walk", to, gait: "walk" }, { do: "anim", name: chaosAnim("sit_edge_swing"), ms: 6000 + r() * 9000 });
      }
      case "peekEdge": {
        if (kind !== "ledge" || hi - lo < 30 * u) return null;
        const dir: -1 | 1 = ctx.s - lo < hi - ctx.s ? -1 : 1;
        return steps({ do: "walk", to: dir < 0 ? lo : hi, gait: "walk" }, { do: "face", dir }, { do: "anim", name: "peekEdge" });
      }
      case "hopDown": {
        if (!isTop(surface)) return null;
        const dir: -1 | 1 = ctx.s - lo < hi - ctx.s ? -1 : 1;
        // Don't hop off into the screen edge.
        const edge = dir < 0 ? surface.ledge.x : surface.ledge.x + surface.ledge.w;
        if (edge - HALF * u < world.area.x || edge + HALF * u > world.area.x + world.area.w) return null;
        const list: Step[] = [{ do: "walk", to: dir < 0 ? lo : hi, gait: "walk" }, { do: "face", dir }];
        if (r() < 0.4) list.push({ do: "anim", name: "peekEdge" });
        list.push({ do: "hop", dir });
        return steps(...list);
      }
      case "teleport": {
        if (!standing || kind === "platform") return null;
        const dest = this.teleportTarget(ctx);
        return dest ? steps({ do: "teleport", surface: dest.surface, s: dest.s }) : null;
      }
      case "build":
        return this.planBuild(ctx);
      case "chaos":
        return standing && kind !== "platform" ? steps({ do: "anim", name: "chaosSpin" }) : null;
      case "malfunction":
        // A front-facing glitch fit: on a wall or the ceiling it would lie sideways and cut to the cling pose.
        return standing ? steps({ do: "anim", name: "malfunction" }) : null;
      case "lookAround":
        return standing ? steps({ do: "anim", name: "lookAround" }) : null;
      case "sleep":
        return standing ? steps({ do: "anim", name: "yawn" }) : null;
      case "mischief":
        return null; // chaos.ts plans these (it needs to ask Rust first)
      case "react":
        return null; // context.ts plans these (from what the user is doing)
      case "play":
        return null; // play/ plans these (games)
      case "copter":
        return this.planCopter(ctx);
      case "hangOn": {
        if (kind !== "ledge" || hi - lo < 60 * u) return null;
        const dir: -1 | 1 = ctx.s - lo < hi - ctx.s ? -1 : 1;
        return steps(
          { do: "walk", to: dir < 0 ? lo : hi, gait: "walk" },
          { do: "face", dir },
          { do: "hang", ms: 2500 + r() * 3500 },
          { do: "anim", name: "lookAround" },
        );
      }
      case "slideDown":
        return this.planSlide(ctx);
      case "trampoline": {
        if (kind !== "floor") return null;
        const c = restCenter(surface, ctx.s, world);
        const anim = chaosAnim("bounce");
        const list: Step[] = [];
        for (const h of [50, 110, 180]) list.push({ do: "jump", to: { x: c.x, y: c.y }, height: h, anim, quick: true });
        list.push({ do: "jump", to: { x: c.x, y: c.y }, height: 240, anim, spin: r() < 0.5 ? 360 : -360 });
        list.push({ do: "anim", name: r() < 0.5 ? "happy" : "laugh" });
        return steps(...list);
      }
      case "fish": {
        if (kind !== "ledge" || hi - lo < 60 * u) return null;
        const dir: -1 | 1 = ctx.s - lo < hi - ctx.s ? -1 : 1;
        const fish = chaosAnim("fish");
        return steps(
          { do: "walk", to: dir < 0 ? lo : hi, gait: "walk" },
          { do: "face", dir },
          ANIMATIONS_ONCE(fish) ? { do: "anim", name: fish } : { do: "anim", name: fish, ms: 6000 + r() * 6000 },
          { do: "anim", name: r() < 0.5 ? "happy" : "lookAround" },
        );
      }
      case "wallJump":
        return this.planWallJump(ctx);
      case "celebrate": {
        if (!standing) return steps({ do: "anim", name: "happy" });
        if (!ctx.movement || r() < 0.4) return steps({ do: "anim", name: r() < 0.3 ? "laugh" : "happy" });
        // A backflip on the spot.
        const c = restCenter(surface, ctx.s, world);
        return steps({ do: "jump", to: c, spin: r() < 0.5 ? 360 : -360 }, { do: "anim", name: "happy" });
      }
    }
  }

  /** Up a screen edge to the very top, let go, and float down (tail copter or flying-squirrel glide). */
  private planCopter(ctx: BrainContext): Plan | null {
    const { surface, world } = ctx;
    const u = world.scale;
    const r = this.rand;
    const float: "copter" | "glide" = r() < 0.5 ? "copter" : "glide";
    const list: Step[] = [];
    let wall: Surface;
    if (surface.kind === "floor") {
      const [lo, hi] = surfaceRange(surface, world);
      const end: -1 | 1 = Math.abs(ctx.s - lo) < Math.abs(ctx.s - hi) ? -1 : 1;
      list.push({ do: "walk", to: end < 0 ? lo : hi, gait: "walk" }, { do: "corner", end });
      wall = cornerAt(surface, end, world)!.surface;
    } else if (surface.kind === "left" || surface.kind === "right") {
      wall = surface;
    } else return null;
    const [wlo, whi] = surfaceRange(wall, world);
    if (whi - wlo < 300 * u) return null;
    list.push({ do: "walk", to: wlo + 20 * u, gait: "climb" }, { do: "anim", name: "lookBack" });
    // Away from the wall he was on.
    const drift = (wall.kind === "left" ? 1 : -1) * (float === "glide" ? 70 + r() * 50 : 20 + r() * 25);
    list.push({ do: "drop", float, drift }, { do: "anim", name: r() < 0.5 ? "happy" : "lookAround" });
    return { name: "copter", steps: list };
  }

  /** From the end of a window top, slide down its side (to the taskbar, or let go at the bottom). */
  private planSlide(ctx: BrainContext): Plan | null {
    const { surface, world } = ctx;
    if (surface.kind !== "ledge") return null;
    const u = world.scale;
    const a = world.area;
    const frame = world.frames?.find((f) => f.id === surface.ledge.id);
    if (!frame) return null;
    const [lo, hi] = surfaceRange(surface, world);
    const floorY = a.y + a.h;
    const options: { dir: -1 | 1; x: number }[] = [];
    // Only where the top really ends at the window's side (not where something covers it).
    if (Math.abs(surface.ledge.x - frame.x) < 4 * u) options.push({ dir: -1, x: frame.x - (HALF - 12) * u });
    if (Math.abs(surface.ledge.x + surface.ledge.w - (frame.x + frame.w)) < 4 * u) options.push({ dir: 1, x: frame.x + frame.w + (HALF - 12) * u });
    const ok = options.filter((o) => o.x - HALF * u >= a.x && o.x + HALF * u <= a.x + a.w);
    if (!ok.length) return null;
    const pick = ok[Math.floor(this.rand() * ok.length)];
    const bottom = frame.y + frame.h;
    const land = bottom >= floorY - 30 * u;
    const y = land ? floorY - HALF * u : bottom - HALF * u;
    if (y - (surface.ledge.y - HALF * u) < 120 * u) return null;
    return {
      name: "slideDown",
      steps: [
        { do: "walk", to: pick.dir < 0 ? lo : hi, gait: "walk" },
        { do: "face", dir: pick.dir },
        { do: "anim", name: "peekEdge" },
        { do: "slide", x: pick.x, y, land },
        { do: "anim", name: "lookAround" },
      ],
    };
  }

  /**
   * Two windows with a gap between them that reach down near the taskbar:
   * zig-zag up between their sides (kick, kick, kick) and land on the lower top.
   */
  private planWallJump(ctx: BrainContext): Plan | null {
    const { surface, world } = ctx;
    if (surface.kind !== "floor") return null;
    const u = world.scale;
    const frames = world.frames ?? [];
    const floorY = world.area.y + world.area.h;
    const [flo, fhi] = surfaceRange(surface, world);
    for (const A of frames) {
      for (const B of frames) {
        const ax = A.x + A.w;
        const gap = B.x - ax;
        if (A.id === B.id || gap < 170 * u || gap > 520 * u) continue;
        const low = Math.max(A.y, B.y); // the lower top: where he ends up
        const target = A.y >= B.y ? A : B;
        const ledge = world.ledges.find((l) => l.id === target.id && (target === A ? l.x + l.w >= ax - 4 * u : l.x <= B.x + 4 * u));
        if (!ledge) continue;
        // Both sides must reach down to where his first kick is.
        const firstY = floorY - (HALF + 130) * u;
        if (A.y + A.h < firstY || B.y + B.h < firstY || floorY - low < 280 * u) continue;
        const mid = ax + gap / 2;
        if (mid < flo || mid > fhi) continue;
        const steps: Step[] = [{ do: "walk", to: mid, gait: Math.abs(mid - ctx.s) > 450 * u ? "run" : "walk" }];
        const kick = chaosAnim("wall_jump");
        let y = firstY;
        let left = true;
        let n = 0;
        while (y > low + 110 * u && n < 6) {
          const x = left ? ax + (HALF - 4) * u : B.x - (HALF - 4) * u;
          steps.push({ do: "face", dir: left ? -1 : 1 }, { do: "jump", to: { x, y }, height: 30, touch: true, anim: kick });
          y -= 140 * u;
          left = !left;
          n++;
        }
        if (n < 2) continue;
        const land = target === A ? ax - 50 * u : B.x + 50 * u;
        const top: Surface = { kind: "ledge", ledge };
        steps.push({ do: "face", dir: target === A ? -1 : 1 }, { do: "jump", to: restCenter(top, clampTo(top, land, world), world), ledgeId: ledge.id });
        steps.push({ do: "anim", name: chaosAnim("celebrate") });
        return { name: "wallJump", steps };
      }
    }
    return null;
  }

  /** Find a window top in reach: walk to a takeoff point and jump onto it. */
  private planLedgeJump(ctx: BrainContext): Plan | null {
    const { surface, world } = ctx;
    if (!isStanding(surface)) return null;
    const u = world.scale;
    const r = this.rand;
    const here = isTop(surface) ? surface.ledge.id : null;
    const candidates = world.ledges.filter((l) => l.id !== here && l.w >= 60 * u);
    if (candidates.length === 0) return null;
    // Sample takeoff / landing pairs biased towards where he is; keep the shortest walk.
    let best: { score: number; takeoff: number; to: Vec; id: number } | null = null;
    for (let i = 0; i < 16; i++) {
      const ledge = candidates[Math.floor(r() * candidates.length)];
      const target: Surface = { kind: "ledge", ledge };
      const [tlo, thi] = surfaceRange(target, world);
      const landX = Math.min(thi, Math.max(tlo, ctx.s + (r() - 0.5) * 700 * u));
      // Take off a little to the side so it's a proper arc, not a straight hop up.
      const side = r() < 0.5 ? -1 : 1;
      const takeoff = clampTo(surface, landX + side * (70 + r() * 250) * u, world);
      const from = restCenter(surface, takeoff, world);
      const to = restCenter(target, landX, world);
      if (Math.abs(to.y - from.y) < 30 * u && Math.abs(to.x - from.x) < 60 * u) continue;
      if (!planJump(from, to, world)) continue;
      const score = Math.abs(takeoff - ctx.s) + r() * 150 * u;
      if (!best || score < best.score) best = { score, takeoff, to, id: ledge.id };
    }
    if (!best) return null;
    const { takeoff, to } = best;
    const dir: 1 | -1 = to.x >= takeoff ? 1 : -1;
    const list: Step[] = [];
    if (Math.abs(takeoff - ctx.s) > 8 * u) list.push({ do: "walk", to: takeoff, gait: Math.abs(takeoff - ctx.s) > 450 * u ? "run" : "walk" });
    list.push({ do: "face", dir }, { do: "jump", to, ledgeId: best.id });
    if (r() < 0.35) list.push({ do: "anim", name: "lookAround" });
    return { name: "jump", steps: list };
  }

  /**
   * Make a glitch platform. If some window top is too high to jump onto, it
   * becomes a stepping stone: build under it, then jump the rest of the way.
   * Otherwise he just builds one, admires it, and it breaks under him.
   */
  private planBuild(ctx: BrainContext): Plan | null {
    const { surface, world } = ctx;
    if (surface.kind !== "floor") return null;
    const u = world.scale;
    const r = this.rand;
    const feetY = restCenter(surface, ctx.s, world).y + HALF * u;
    for (const ledge of world.ledges) {
      const target: Surface = { kind: "ledge", ledge };
      const [tlo, thi] = surfaceRange(target, world);
      const landX = (tlo + thi) / 2;
      const to = restCenter(target, landX, world);
      const takeoff = clampTo(surface, landX + (r() < 0.5 ? -1 : 1) * 160 * u, world);
      if (planJump(restCenter(surface, takeoff, world), to, world)) continue; // reachable anyway
      const height = Math.min(300, (feetY - ledge.y) / u / 2 + 40);
      if (height < 120) continue;
      const platformCenter = { x: takeoff, y: restCenter(surface, takeoff, world).y - height * u };
      if (platformCenter.y - HALF * u < world.area.y + 140 * u) continue;
      if (!planJump(platformCenter, to, world)) continue;
      return {
        name: "build",
        steps: [
          { do: "walk", to: takeoff, gait: "walk" },
          { do: "build", height },
          { do: "anim", name: "lookAround" },
          { do: "face", dir: to.x >= takeoff ? 1 : -1 },
          { do: "jump", to, ledgeId: ledge.id },
        ],
      };
    }
    const height = 150 + r() * 130;
    if (feetY - height * u - 120 * u < world.area.y + 100 * u) return null;
    return {
      name: "build",
      steps: [{ do: "build", height }, { do: "anim", name: "build" }, { do: "anim", name: "lookAround" }, { do: "anim", name: "idle", ms: 1500 + r() * 2500 }, { do: "unbuild" }],
    };
  }

  /** Somewhere surprising: another window top, the ceiling, or the far side of the screen. */
  private teleportTarget(ctx: BrainContext): { surface: Surface; s: number } | null {
    const { world, surface } = ctx;
    const r = this.rand;
    const roll = r();
    const here = isTop(surface) ? surface.ledge.id : null;
    const tops = world.ledges.filter((l) => l.id !== here && l.w >= 60 * world.scale);
    if (roll < 0.45 && tops.length) {
      const ledge = tops[Math.floor(r() * tops.length)];
      const s: Surface = { kind: "ledge", ledge };
      const [lo, hi] = surfaceRange(s, world);
      return { surface: s, s: lo + (hi - lo) * r() };
    }
    if (roll < 0.7) {
      const ceil: Surface = { kind: "ceiling" };
      const [lo, hi] = surfaceRange(ceil, world);
      return { surface: ceil, s: lo + (hi - lo) * r() };
    }
    const floor: Surface = { kind: "floor" };
    const [lo, hi] = surfaceRange(floor, world);
    const x = restCenter(surface, ctx.s, world).x;
    // The other half of the screen.
    const mid = (lo + hi) / 2;
    const s = x < mid ? mid + (hi - mid) * (0.3 + 0.7 * r()) : lo + (mid - lo) * 0.7 * r();
    return { surface: floor, s };
  }
}

export const JUMP_LIMITS = JUMP;

function ANIMATIONS_ONCE(name: AnimationName): boolean {
  return !!ANIMATIONS[name]?.once;
}
