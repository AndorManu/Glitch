// Chaos mode: Glitch the desktop gremlin. Decides when he gets up to
// mischief and plans it as ordinary brain steps (walk, teleport, anim...)
// plus "call" steps that talk to Rust, and "haul" walks that drag something
// along. creature.ts runs the plans like any other.
//
// The acts:
//   window  stands on another app's window top, grabs it (grab_tab) and
//           walks backwards: the window slides along under him
//   push    on the taskbar, pushes a window that reaches down to it (push)
//   chase   runs after (or sneaks up behind) the cursor; now and then
//           catches it and drags it a little (Rust lets go the moment the
//           user moves the mouse)
//   note    drags a sticky note with a silly line in from the screen edge
//   peek    peeks in from a screen edge
//   knock   knocks on the inside of the screen glass
//   paws    steps in glitch: magenta paw prints behind him for a while
//
// Gentle by default: one act every 45-120 s at most (resting in between
// as usual), each act with its own cooldown on top, and Rust's hard limits
// for anything touching other apps (src-tauri/src/chaos.rs).

import { ANIMATIONS, type AnimationName, isAnimationName, type Keyframe } from "./animations";
import type { Haul, Plan, Step } from "./brain";
import { clampTo, FLOOR, HALF, isTop, restCenter, type Surface, surfaceRange, type Vec, type World } from "./physics";
import type { ChaosStatus, ChaosWindow, PawStamp, ScreenRect } from "../shared/ipc";
import { pickLine } from "../chaos/lines";

// ------------------------------------------------------------ animations

/**
 * Chaos animation names (new on-model frame cycles, being added to
 * animations.ts separately) and what to play until they exist.
 */
export const ANIM_FALLBACKS: Record<string, readonly string[]> = {
  push: ["pushWindow", "walk"],
  grab_tab: ["dragWindow", "walk"],
  peek: ["peekEdge", "lookBack"],
  chase: ["run"],
  spin: ["chaosSpin"],
  teleport: ["glitchOut"],
  scared: ["startled"],
  celebrate: ["happy"],
  dance: ["happy"],
  sneeze: ["malfunction"],
  dizzy: ["malfunction"],
};

/** The animation to play for a chaos name: itself if it exists, else the first fallback that does, else "walk". */
export function chaosAnim(name: string, has: (n: string) => boolean = isAnimationName): AnimationName {
  if (has(name)) return name as AnimationName;
  for (const f of ANIM_FALLBACKS[name] ?? []) if (has(f)) return f as AnimationName;
  return "walk";
}

/** Is it a one-shot (ends by itself)? */
function once(name: AnimationName): boolean {
  return !!ANIMATIONS[name]?.once;
}

/** "Knock knock knock" on the screen glass: leans in close, three taps. For `animator.interject`. */
export function knockKeys(base: Omit<Keyframe, "ms">): Keyframe[] {
  const sx = base.sx ?? 1;
  const sy = base.sy ?? 1;
  const near = { ...base, sx: sx * 1.12, sy: sy * 1.12, dy: (base.dy ?? 0) - 2 };
  const keys: Keyframe[] = [{ ...near, ms: 220, fx: "eye" }];
  for (let i = 0; i < 3; i++) {
    keys.push({ ...near, ms: 90, sx: sx * 1.16, sy: sy * 1.08, glitch: 0.25 });
    keys.push({ ...near, ms: 160 });
  }
  keys.push({ ...near, ms: 420, fx: "eye" }, { ...base, ms: 120 });
  return keys;
}

// ------------------------------------------------------------- the host

/** What chaos mode needs from the outside (Rust in the app, a fake on the stage / in tests). */
export interface ChaosHost {
  status(): Promise<ChaosStatus>;
  windows(): Promise<ChaosWindow[]>;
  /** Resolves to the frame, or null if refused. */
  grabWindow(id: number): Promise<ScreenRect | null>;
  /** Applied offset, or null = let go. */
  dragWindow(dx: number, dy: number): Promise<Vec | null>;
  releaseWindow(): void;
  grabCursor(): Promise<Vec | null>;
  dragCursor(x: number, y: number): Promise<boolean>;
  releaseCursor(): void;
  paws(paws: PawStamp[]): void;
  noteOpen(line: number, x: number, y: number): Promise<{ w: number; h: number } | null>;
  noteMove(x: number, y: number): void;
  noteIsOpen(): Promise<boolean>;
}

/** What chaos mode needs to know about Glitch (creature.ts). */
export interface ChaosSubject {
  readonly world: World | null;
  readonly surface: Surface;
  /** Centre coordinate along the surface. */
  readonly s: number;
  /** Body centre, physical px. */
  readonly body: Vec;
  now(): number;
  cursor(): Promise<Vec>;
  /** Leave paw prints for `ms`. */
  stepInGlitch(ms: number): void;
  /** Knock on the glass; resolves when done. */
  knock(): Promise<void>;
}

export type Act = "window" | "push" | "chase" | "note" | "peek" | "knock" | "paws";
export const ACTS: readonly Act[] = ["window", "push", "chase", "note", "peek", "knock", "paws"];

export function isAct(name: unknown): name is Act {
  return typeof name === "string" && (ACTS as readonly string[]).includes(name);
}

/** Weight and own cooldown (s) per act. Rust adds its hard limits for window/cursor. */
export const ACT_TABLE: Record<Act, { weight: number; cooldown: number }> = {
  window: { weight: 2.2, cooldown: 240 },
  push: { weight: 1.6, cooldown: 240 },
  chase: { weight: 2, cooldown: 90 },
  note: { weight: 1, cooldown: 600 },
  peek: { weight: 1.4, cooldown: 90 },
  knock: { weight: 1, cooldown: 150 },
  paws: { weight: 1.4, cooldown: 90 },
};

/** Between two acts (ms): gentle. */
export const CHAOS_GAP_MS: [number, number] = [45_000, 120_000];
/** The user typed / moved the mouse more recently than this: no mischief now. */
export const USER_QUIET_MS = 1500;
/** CSS px of the note window (note.html / chaos.rs). */
export const NOTE_SIZE = { w: 210, h: 150 };
/** How far left of / right of his centre his paws hold things (CSS px). */
export const HAND = 26;

// ------------------------------------------------------- pure geometry

/** The window top to drag and which way: towards the side with more room. */
export function planWindowDrag(
  world: World,
  wins: ChaosWindow[],
  near: Vec,
  rand: () => number,
): { ledge: World["ledges"][number]; win: ChaosWindow; dir: 1 | -1; dist: number } | null {
  const u = world.scale;
  const a = world.area;
  let best: { score: number; ledge: World["ledges"][number]; win: ChaosWindow } | null = null;
  for (const ledge of world.ledges) {
    if (ledge.w < 140 * u) continue;
    const win = wins.find((w) => w.id === ledge.id);
    if (!win) continue;
    const score = Math.hypot(ledge.x + ledge.w / 2 - near.x, ledge.y - near.y);
    if (!best || score < best.score) best = { score, ledge, win };
  }
  if (!best) return null;
  const f = best.win.frame;
  const roomLeft = f.x - a.x;
  const roomRight = a.x + a.w - (f.x + f.w);
  const dir: 1 | -1 = roomRight > roomLeft ? 1 : -1;
  const room = Math.max(roomLeft, roomRight);
  if (room < 80 * u) return null;
  const dist = Math.min(room, (170 + rand() * 190) * u);
  return { ledge: best.ledge, win: best.win, dir, dist };
}

/** A window whose side reaches down to the taskbar, to push from the side (on the floor). */
export function planPush(world: World, wins: ChaosWindow[], bodyX: number, rand: () => number): { win: ChaosWindow; stand: number; dir: 1 | -1; dist: number } | null {
  const u = world.scale;
  const a = world.area;
  const feetY = a.y + a.h;
  const [lo, hi] = surfaceRange(FLOOR, world);
  let best: { d: number; win: ChaosWindow; stand: number; dir: 1 | -1; dist: number } | null = null;
  for (const win of wins) {
    const f = win.frame;
    // Its side must cover his upper body when he stands on the taskbar.
    if (!(f.y + f.h > feetY - 45 * u && f.y < feetY - 70 * u)) continue;
    for (const dir of [1, -1] as const) {
      const stand = dir > 0 ? f.x - (HALF - 8) * u : f.x + f.w + (HALF - 8) * u;
      if (stand < lo || stand > hi) continue;
      const room = dir > 0 ? a.x + a.w - (f.x + f.w) : f.x - a.x;
      if (room < 60 * u) continue;
      const dist = Math.min(room, (120 + rand() * 160) * u);
      const d = Math.abs(stand - bodyX);
      if (!best || d < best.d) best = { d, win, stand, dir, dist };
    }
  }
  return best && { win: best.win, stand: best.stand, dir: best.dir, dist: best.dist };
}

/** The note starts mostly off screen at the nearer edge, his paw on its inner edge. */
export function planNote(world: World, bodyX: number): { s0: number; dir: 1 | -1; noteX: (s: number) => number; noteY: number; dist: number } {
  const u = world.scale;
  const a = world.area;
  const [lo, hi] = surfaceRange(FLOOR, world);
  const right = bodyX > a.x + a.w / 2;
  const w = NOTE_SIZE.w * u;
  const noteY = Math.round(a.y + a.h - NOTE_SIZE.h * u + 6 * u);
  // He faces the note (outwards) and walks backwards (inwards).
  const s0 = right ? hi : lo;
  const dir: 1 | -1 = right ? -1 : 1;
  const noteX = right ? (s: number) => Math.round(s + HAND * u) : (s: number) => Math.round(s - HAND * u - w);
  // Far enough that the whole note ends up on screen.
  const need = right ? noteX(s0) + w - (a.x + a.w) : a.x - noteX(s0);
  const dist = Math.max(need + 24 * u, 200 * u);
  return { s0, dir, noteX, noteY, dist };
}

/** Is the cursor somewhere he can chase it (near his surface, within reach along it)? Where to run to. */
export function planChase(world: World, surface: Surface, s: number, cursor: Vec): { to: number; side: 1 | -1 } | null {
  if (!(surface.kind === "floor" || isTop(surface))) return null;
  const u = world.scale;
  const c = restCenter(surface, s, world);
  const feetY = c.y + HALF * u;
  if (cursor.y > feetY + 10 * u || cursor.y < feetY - 260 * u) return null;
  const [lo, hi] = surfaceRange(surface, world);
  if (cursor.x < lo - 60 * u || cursor.x > hi + 60 * u) return null;
  const side: 1 | -1 = cursor.x >= c.x ? 1 : -1;
  // Stop just behind it.
  const to = clampTo(surface, cursor.x - side * 34 * u, world);
  if (Math.abs(to - s) < 30 * u) return null;
  return { to, side };
}

// ---------------------------------------------------------- the director

export class ChaosDirector {
  private nextAt: number;
  private readonly last = new Map<Act, number>();
  private lastLine = -1;

  constructor(
    private readonly host: ChaosHost,
    private readonly me: ChaosSubject,
    private readonly rand: () => number = Math.random,
  ) {
    // Not straight after start-up.
    this.nextAt = me.now() + 30_000 + rand() * 30_000;
  }

  private ready(act: Act, now: number): boolean {
    return now - (this.last.get(act) ?? -Infinity) >= ACT_TABLE[act].cooldown * 1000;
  }

  /**
   * Time for mischief? Then a plan (or null: the brain picks as usual).
   * Never throws.
   */
  async maybe(): Promise<Plan | null> {
    const now = this.me.now();
    if (now < this.nextAt) return null;
    const st = await this.host.status().catch(() => null);
    if (!st || !st.enabled || st.blocked || (st.available && st.idle_ms < USER_QUIET_MS)) return null;
    this.nextAt = now + CHAOS_GAP_MS[0] + this.rand() * (CHAOS_GAP_MS[1] - CHAOS_GAP_MS[0]);
    const options = ACTS.filter((a) => this.ready(a, now))
      .filter((a) => st.available || (a !== "window" && a !== "push"))
      .filter((a) => a !== "window" || st.window_ready)
      .map((a) => ({ a, w: ACT_TABLE[a].weight }));
    // Try in weighted random order until one fits where he is.
    while (options.length) {
      let roll = this.rand() * options.reduce((t, o) => t + o.w, 0);
      let i = 0;
      for (; i < options.length - 1; i++) {
        roll -= options[i].w;
        if (roll <= 0) break;
      }
      const [{ a }] = options.splice(i, 1);
      const plan = await this.plan(a).catch(() => null);
      if (plan) {
        this.last.set(a, now);
        return plan;
      }
    }
    return null;
  }

  /** Plan this act now if it fits (cooldowns ignored: Rust's limits still apply). */
  async plan(act: Act): Promise<Plan | null> {
    const w = this.me.world;
    if (!w) return null;
    switch (act) {
      case "window":
        return this.planWindow(w);
      case "push":
        return this.planPushAct(w);
      case "chase":
        return this.planChaseAct(w);
      case "note":
        return this.planNoteAct(w);
      case "peek":
        return this.planPeek(w);
      case "knock":
        return mischief({ do: "call", run: () => this.me.knock().then(() => true) }, { do: "anim", name: this.rand() < 0.5 ? "laugh" : "lookAround" });
      case "paws":
        return this.planPaws(w);
    }
  }

  private async planWindow(w: World): Promise<Plan | null> {
    const wins = await this.host.windows();
    const pick = planWindowDrag(w, wins, this.me.body, this.rand);
    if (!pick) return null;
    const { ledge, win, dir, dist } = pick;
    const surface: Surface = { kind: "ledge", ledge };
    const [lo, hi] = surfaceRange(surface, w);
    const s0 = dir < 0 ? lo : hi;
    const steps: Step[] = [];
    const here = isTop(this.me.surface) && this.me.surface.ledge.id === ledge.id;
    if (here) steps.push({ do: "walk", to: s0, gait: "walk" });
    else steps.push({ do: "teleport", surface, s: s0 });
    // Face the window (into it), grab the edge under his feet...
    steps.push({ do: "face", dir: dir > 0 ? -1 : 1 });
    const grab = chaosAnim("grab_tab");
    if (once(grab)) steps.push({ do: "anim", name: grab });
    else steps.push({ do: "anim", name: "crouch" });
    steps.push({
      do: "call",
      run: async () => {
        const f = await this.host.grabWindow(win.id).catch(() => null);
        if (!f) return [{ do: "anim", name: "lookAround" }];
        // ...and walk backwards, dragging it along.
        return [
          {
            do: "walk",
            to: s0 + dir * dist,
            gait: "walk",
            anim: grab,
            backwards: true,
            haul: this.windowHaul(ledge.id),
          },
          { do: "anim", name: this.rand() < 0.5 ? "laugh" : chaosAnim("celebrate") },
        ];
      },
    });
    return mischief(...steps);
  }

  private windowHaul(ledgeId?: number): Haul {
    return {
      ledgeId,
      move: (dx, dy) => this.host.dragWindow(dx, dy),
      release: () => this.host.releaseWindow(),
    };
  }

  private async planPushAct(w: World): Promise<Plan | null> {
    if (this.me.surface.kind !== "floor") return null;
    const wins = await this.host.windows();
    const pick = planPush(w, wins, this.me.body.x, this.rand);
    if (!pick) return null;
    const push = chaosAnim("push");
    return mischief(
      { do: "walk", to: pick.stand, gait: Math.abs(pick.stand - this.me.s) > 450 * w.scale ? "run" : "walk" },
      { do: "face", dir: pick.dir },
      {
        do: "call",
        run: async () => {
          const f = await this.host.grabWindow(pick.win.id).catch(() => null);
          if (!f) return [{ do: "anim", name: "lookAround" }];
          return [
            { do: "walk", to: pick.stand + pick.dir * pick.dist, gait: "walk", anim: push, haul: this.windowHaul() },
            { do: "anim", name: "laugh" },
          ];
        },
      },
    );
  }

  private async planChaseAct(w: World): Promise<Plan | null> {
    const cursor = await this.me.cursor();
    const surface = this.me.surface;
    const chase = planChase(w, surface, this.me.s, cursor);
    if (!chase) return null;
    const u = w.scale;
    const sneak = this.rand() < 0.45;
    const steps: Step[] = [
      { do: "anim", name: "lookAround" },
      sneak ? { do: "walk", to: chase.to, gait: "walk" } : { do: "walk", to: chase.to, gait: "run", anim: chaosAnim("chase") },
      { do: "face", dir: chase.side },
    ];
    if (sneak) steps.push({ do: "anim", name: "startled" }); // boo!
    steps.push({
      do: "call",
      run: async () => {
        // Close enough to catch it? (Rarely: Rust says no most of the time.)
        const now = await this.me.cursor();
        const b = this.me.body;
        const reach = Math.abs(now.x - b.x) < 110 * u && Math.abs(now.y - (b.y - 10 * u)) < 90 * u;
        if (!reach || this.rand() < 0.35) return [{ do: "anim", name: "laugh" }];
        const p = await this.host.grabCursor().catch(() => null);
        if (!p) return [{ do: "anim", name: "laugh" }];
        const s = this.me.s;
        return [
          {
            do: "walk",
            to: clampTo(this.me.surface, s - chase.side * (90 + this.rand() * 70) * u, w),
            gait: "run",
            anim: chaosAnim("grab_tab"),
            backwards: true,
            haul: {
              move: async (dx, dy) => ((await this.host.dragCursor(p.x + dx, p.y + dy).catch(() => false)) ? { x: dx, y: dy } : null),
              release: () => this.host.releaseCursor(),
            },
          },
          { do: "anim", name: "laugh" },
        ];
      },
    });
    return mischief(...steps);
  }

  private async planNoteAct(w: World): Promise<Plan | null> {
    if (await this.host.noteIsOpen().catch(() => true)) return null;
    const n = planNote(w, this.me.body.x);
    const steps: Step[] = [];
    if (this.me.surface.kind === "floor" && Math.abs(this.me.s - n.s0) < 700 * w.scale) steps.push({ do: "walk", to: n.s0, gait: "run" });
    else steps.push({ do: "teleport", surface: FLOOR, s: n.s0 });
    steps.push({ do: "face", dir: n.dir > 0 ? -1 : 1 });
    const line = pickLine(this.rand, this.lastLine);
    steps.push({
      do: "call",
      run: async () => {
        const s = this.me.s;
        const ok = await this.host.noteOpen(line, n.noteX(s), n.noteY).catch(() => null);
        if (!ok) return false;
        this.lastLine = line;
        return [
          {
            do: "walk",
            to: s + n.dir * n.dist,
            gait: "walk",
            anim: chaosAnim("grab_tab"),
            backwards: true,
            haul: {
              move: (dx) => {
                this.host.noteMove(n.noteX(s + dx), n.noteY);
                return { x: dx, y: 0 };
              },
              release: () => {},
            },
          },
          { do: "anim", name: chaosAnim("celebrate") },
        ];
      },
    });
    return mischief(...steps);
  }

  private planPeek(w: World): Plan | null {
    const side: Surface = { kind: this.me.body.x > w.area.x + w.area.w / 2 ? "right" : "left" };
    const [lo, hi] = surfaceRange(side, w);
    const s = lo + (hi - lo) * (0.2 + 0.5 * this.rand());
    const peek = chaosAnim("peek");
    return mischief({ do: "teleport", surface: side, s }, once(peek) ? { do: "anim", name: peek } : { do: "anim", name: peek, ms: 2200 }, { do: "anim", name: "lookBack" }, { do: "drop" });
  }

  private planPaws(w: World): Plan | null {
    const surface = this.me.surface;
    if (!(surface.kind === "floor" || isTop(surface))) return null;
    const [lo, hi] = surfaceRange(surface, w);
    if (hi - lo < 200 * w.scale) return null;
    const far = this.me.s - lo > hi - this.me.s ? lo + (hi - lo) * 0.15 * this.rand() : hi - (hi - lo) * 0.15 * this.rand();
    return mischief(
      { do: "anim", name: chaosAnim("sneeze") },
      { do: "call", run: () => (this.me.stepInGlitch(20_000), true) },
      { do: "walk", to: far, gait: "walk" },
      { do: "anim", name: "lookBack" },
    );
  }
}

function mischief(...steps: Step[]): Plan {
  return { name: "mischief", steps };
}
