// What Glitch feels like doing next. Pure: given where he is and what the
// screen looks like, pick a behaviour (weighted, with cooldowns, depending
// on where he stands) and plan it as a list of steps. creature.ts runs the
// steps (walking, climbing, jumping...) and asks again when they are done.
//
// Most of his time is spent resting in between (idle fidgets on the floor,
// clinging on walls): `restMs` keeps him calm, and creature.ts rests at
// least 3x as long as the last activity took.

import type { AnimationName } from "./animations";
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
  | { do: "jump"; to: Vec; ledgeId?: number; spin?: number }
  /** Hop off the end of a window top. */
  | { do: "hop"; dir: 1 | -1 }
  /** Let go of the wall / ceiling. */
  | { do: "drop" }
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
  /** Chaos mode (planned by chaos.ts, never picked by the dice here). */
  | "mischief";

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
      const plan = this.plan(name, ctx);
      if (!plan) continue;
      if (!ctx.movement && planMoves(plan)) continue;
      let weight = entry.weight;
      if (name === "chaos" && ctx.excited) weight *= 6;
      // On his own platform he shouldn't stay long.
      if (ctx.surface.kind === "platform" && (name === "drop" || name === "jump")) weight *= 3;
      options.push({ name, plan, weight });
    }
    if (options.length === 0) return this.commit(this.idlePlan(ctx), ctx.now);
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
        return steps({ do: "walk", to, gait: "walk" }, { do: "anim", name: "sitEdge", ms: 6000 + r() * 9000 });
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
        return steps({ do: "anim", name: "malfunction" });
      case "lookAround":
        return standing ? steps({ do: "anim", name: "lookAround" }) : null;
      case "sleep":
        return standing ? steps({ do: "anim", name: "yawn" }) : null;
      case "mischief":
        return null; // chaos.ts plans these (it needs to ask Rust first)
      case "celebrate": {
        if (!standing) return steps({ do: "anim", name: "happy" });
        if (!ctx.movement || r() < 0.4) return steps({ do: "anim", name: r() < 0.3 ? "laugh" : "happy" });
        // A backflip on the spot.
        const c = restCenter(surface, ctx.s, world);
        return steps({ do: "jump", to: c, spin: r() < 0.5 ? 360 : -360 }, { do: "anim", name: "happy" });
      }
    }
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
