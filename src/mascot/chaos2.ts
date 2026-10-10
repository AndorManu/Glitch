// Chaos mode 2 ("old virus style"): the planners for the new acts. Glitch is
// the actor, Rust is the gatekeeper: every call here is checked again in
// src-tauri/src/chaos2.rs (level, safety gate, cooldowns, global rate limit),
// and the abort rules (any real mouse move, a button, Esc, the panic hotkey)
// live there too, ticking every 8 ms. This file only decides what Glitch does
// around them: where he stands, which animation plays, how he reacts.
//
// The acts (all harmless and fake, drawn in his own pixel style):
//   hook      the fishing line that hooks the real cursor and drags it
//   orbit     the cursor circles around a point        jitter  a tiny shake
//   hops      little cursor hops with a spark
//   trail     ghost copies of the arrow behind the cursor (overlay)
//   matrix    magenta rain   scanlines  a CRT sweep   melt  the screen drips
//   bugs      screen bugs crawl along a window top, he squashes them
//   swarm     mini clones of him run around, then pop
//   popup     a fake pixel dialog in his own style
//   yoink     minimises one window and pops it back
//   dance     wobbles / slides / shakes / runs away with a window

import type { AnimationName } from "./animations";
import type { Plan, Step } from "./brain";
import type { ChaosWindow, Chaos2Status, CursorAct, CursorOutcome, DanceKind, Fx, FxKind, FxStarted, HookStyle, PopupKind, ScreenRect } from "../shared/ipc";
import { ANIM_FRAME_H, ANIM_FRAME_W, ANIM_RODS } from "../sprites/anim";
import { ART_SCALE } from "../sprites/glitch-anim";
import { clampTo, FLOOR, isTop, restCenter, type Surface, surfaceRange, type Vec, type World } from "./physics";

// ------------------------------------------------------------------ acts

export const NEW_ACTS = ["hook", "orbit", "jitter", "hops", "trail", "matrix", "scanlines", "melt", "bugs", "swarm", "popup", "yoink", "dance"] as const;
export type NewAct = (typeof NEW_ACTS)[number];

export function isNewAct(name: unknown): name is NewAct {
  return typeof name === "string" && (NEW_ACTS as readonly string[]).includes(name);
}

/** How often each new act is picked (the hook is the star). Rust has the cooldowns. */
export const NEW_ACT_WEIGHTS: Record<NewAct, number> = {
  hook: 3,
  orbit: 1,
  jitter: 0.8,
  hops: 1.2,
  trail: 1.4,
  matrix: 1,
  scanlines: 1,
  melt: 0.8,
  bugs: 1.2,
  swarm: 1,
  popup: 1.6,
  yoink: 1.6,
  dance: 1.8,
};

/** Between two acts (ms) as Rust says for the level, else the gentle default. */
export function gapFor(st: Pick<Chaos2Status, "gap_ms"> | null, fallback: [number, number], rand: () => number): number {
  const [lo, hi] = st?.gap_ms ?? fallback;
  return lo + rand() * (hi - lo);
}

/** Does this level use the new acts at all? (Gentle is today's behaviour.) */
export function usesNewActs(level: string | undefined): boolean {
  return level === "mischief" || level === "full_virus";
}

/** The new acts that are ready, in weighted random order. */
export function orderNewActs(ready: readonly Fx[], rand: () => number): NewAct[] {
  const pool = (ready as readonly string[]).filter(isNewAct).map((a) => ({ a, w: NEW_ACT_WEIGHTS[a] }));
  const out: NewAct[] = [];
  while (pool.length) {
    let roll = rand() * pool.reduce((t, o) => t + o.w, 0);
    let i = 0;
    for (; i < pool.length - 1; i++) {
      roll -= pool[i].w;
      if (roll <= 0) break;
    }
    out.push(pool.splice(i, 1)[0].a);
  }
  return out;
}

// ------------------------------------------------------------- the host

export interface Chaos2Host {
  status(): Promise<Chaos2Status | null>;
  /** Hook / orbit / jitter / hop the cursor. Resolves when it ends; null = refused. */
  cursorAct(act: CursorAct, rod: Vec): Promise<CursorOutcome | null>;
  /** A screen effect on the overlay; null = refused. */
  fxStart(kind: FxKind): Promise<FxStarted | null>;
  fxSquash(x: number, y: number): void;
  popup(kind: PopupKind): Promise<boolean>;
  dance(id: number, kind: DanceKind): Promise<{ aborted: string | null } | null>;
  yoink(): Promise<{ id: number; frame: ScreenRect; deadline_ms: number } | null>;
  yoinkedCount(): Promise<number>;
  /** Where his rod tip is now (physical px), for the overlay's line. */
  rod(p: Vec): void;
  /** Let go of anything running (he was grabbed, chaos off...). */
  abort(): void;
}

/** What the planners need to know about Glitch. */
export interface Chaos2Subject {
  readonly world: World | null;
  readonly surface: Surface;
  readonly s: number;
  readonly body: Vec;
  cursor(): Promise<Vec>;
  /** Where his rod tip is right now (physical px), null if the frame has none. */
  rodTip(): Vec | null;
  /** Resolves after `ms` on the creature's clock. */
  sleep(ms: number): Promise<void>;
}

// ----------------------------------------------------------- pure helpers

/** Position of the rod tip of art frame `frame`: feet at `feet`, art px = `ux` physical px. */
export function rodTipOf(frame: string, feet: Vec, facingLeft: boolean, ux: number): Vec | null {
  const tip = ANIM_RODS[frame];
  if (!tip) return null;
  const sign = facingLeft ? -1 : 1;
  return { x: feet.x + sign * (tip[0] - ANIM_FRAME_W / 2) * ux, y: feet.y + (tip[1] - ANIM_FRAME_H) * ux };
}

/** Physical px per art px at a world scale. */
export function artPx(scale: number): number {
  return scale * ART_SCALE;
}

export const HOOK_STYLES: readonly HookStyle[] = ["pull", "circle", "figure8", "bounce"];

export function isHookStyle(name: unknown): name is HookStyle {
  return typeof name === "string" && (HOOK_STYLES as readonly string[]).includes(name);
}

export function pickHookStyle(rand: () => number): HookStyle {
  return HOOK_STYLES[Math.min(HOOK_STYLES.length - 1, Math.floor(rand() * HOOK_STYLES.length))];
}

export const DANCE_KINDS: readonly DanceKind[] = ["wobble", "edge_slide", "quake", "run_away"];

export function isDanceKind(name: unknown): name is DanceKind {
  return typeof name === "string" && (DANCE_KINDS as readonly string[]).includes(name);
}

export const POPUP_KINDS: readonly PopupKind[] = ["ram", "raccoons", "adopted"];

export function isPopupKind(name: unknown): name is PopupKind {
  return typeof name === "string" && (POPUP_KINDS as readonly string[]).includes(name);
}

/**
 * Where he stands to fish for the cursor: where he is if the cursor is a fair
 * cast away (to one side, not under his feet), else on the taskbar a little
 * way off it. Returns the steps to get there and the way he faces.
 */
export function planHookSpot(world: World, surface: Surface, s: number, cursor: Vec): { pre: Step[]; surface: Surface; s: number; dir: 1 | -1 } {
  const u = world.scale;
  const standing = surface.kind === "floor" || isTop(surface);
  const c = standing ? restCenter(surface, s, world) : null;
  const dx = c ? cursor.x - c.x : 0;
  const fair = !!c && Math.abs(dx) > 150 * u && Math.abs(dx) < 720 * u && Math.abs(cursor.y - c.y) < 620 * u;
  if (fair && c) return { pre: [], surface, s, dir: dx >= 0 ? 1 : -1 };
  // Off the wall / too close / too far: down to the taskbar, a cast away from the cursor.
  const a = world.area;
  const side: 1 | -1 = cursor.x > a.x + a.w / 2 ? -1 : 1;
  const to = clampTo(FLOOR, cursor.x + side * 340 * u, world);
  const here = restCenter(FLOOR, to, world);
  return { pre: [{ do: "teleport", surface: FLOOR, s: to }], surface: FLOOR, s: to, dir: cursor.x >= here.x ? 1 : -1 };
}

/** How he reacts when the line snaps because the user took the mouse back: startled, a flop, a pout. */
export function snapSteps(): Step[] {
  return [
    { do: "anim", name: "startled" },
    { do: "anim", name: "splat" },
    { do: "anim", name: "annoyed" },
  ];
}

/** And when the act simply ended. */
export function giggleSteps(): Step[] {
  return [{ do: "anim", name: "virus_giggle" }];
}

const NOT_NOW: Step[] = [{ do: "anim", name: "lookAround" }];

// -------------------------------------------------------------- planner

function mischief(...steps: Step[]): Plan {
  return { name: "mischief", steps };
}

export class Chaos2Planner {
  constructor(
    private readonly host: Chaos2Host,
    private readonly me: Chaos2Subject,
    private readonly rand: () => number,
    private readonly windows: () => Promise<ChaosWindow[]>,
  ) {}

  async plan(act: NewAct, arg?: string): Promise<Plan | null> {
    const w = this.me.world;
    if (!w) return null;
    switch (act) {
      case "hook":
        return this.hook(w, arg);
      case "orbit":
        return this.classic({ kind: "orbit" }, "dance", 6800);
      case "jitter":
        return this.classic({ kind: "jitter" }, "typing", 2300);
      case "hops":
        return this.classic({ kind: "hops" }, "happy", 5000);
      case "trail":
        return this.effect("trail", "dance", w);
      case "matrix":
        return this.effect("matrix", "typing", w);
      case "scanlines":
        return this.effect("scanlines", "think", w);
      case "melt":
        return this.effect("melt", "startled", w);
      case "swarm":
        return this.effect("swarm", "laugh", w);
      case "bugs":
        return this.bugs(w);
      case "popup":
        return this.popup(arg);
      case "yoink":
        return this.yoink(w);
      case "dance":
        return this.dance(w, arg);
    }
  }

  /** Cast, hook, drag, release, giggle. */
  private async hook(w: World, arg?: string): Promise<Plan | null> {
    const cursor = await this.me.cursor();
    const style = isHookStyle(arg) ? arg : pickHookStyle(this.rand);
    const spot = planHookSpot(w, this.me.surface, this.me.s, cursor);
    const steps: Step[] = [...spot.pre, { do: "face", dir: spot.dir }];
    let run: Promise<CursorOutcome | null> | null = null;
    const tick = () => {
      const p = this.me.rodTip();
      if (p) this.host.rod(p);
    };
    steps.push({
      do: "call",
      run: () => {
        // The cast starts on the overlay while his arm swings; Rust pulls from the end of the cast.
        const rod = this.me.rodTip() ?? { x: this.me.body.x + spot.dir * 60 * w.scale, y: this.me.body.y - 40 * w.scale };
        run = this.host.cursorAct({ kind: "hook", style }, rod).catch(() => null);
        return true;
      },
    });
    steps.push({ do: "hold", anim: "hook_cast", maxMs: 1200, until: () => this.me.sleep(950).then(() => true), onTick: tick });
    steps.push({
      do: "hold",
      anim: "hook_reel",
      maxMs: 13_000,
      until: () => new Promise<Step[] | boolean>((resolve) => {
        // `run` is set by the call step above, which runs before this step starts.
        const wait = () => (run ? run.then((o) => resolve(o === null ? NOT_NOW : o.aborted ? snapSteps() : giggleSteps())) : void this.me.sleep(50).then(wait));
        void this.me.sleep(50).then(wait);
      }),
      cancel: () => this.host.abort(),
      onTick: tick,
    });
    return mischief(...steps);
  }

  /** Orbit / jitter / hops: Rust moves the cursor, he watches (and "types" or dances along). */
  private async classic(act: CursorAct, anim: AnimationName, ms: number): Promise<Plan | null> {
    let run: Promise<CursorOutcome | null> | null = null;
    return mischief(
      {
        do: "call",
        run: () => {
          const w = this.me.body;
          run = this.host.cursorAct(act, { x: w.x, y: w.y }).catch(() => null);
          return true;
        },
      },
      {
        do: "hold",
        anim,
        maxMs: ms + 1500,
        until: () => new Promise<Step[] | boolean>((resolve) => {
          const wait = () => (run ? run.then((o) => resolve(o === null ? NOT_NOW : o.aborted ? snapSteps() : giggleSteps())) : void this.me.sleep(50).then(wait));
          void this.me.sleep(50).then(wait);
        }),
        cancel: () => this.host.abort(),
      },
    );
  }

  /** A screen effect on the overlay: he reacts for as long as it lasts. */
  private async effect(kind: FxKind, anim: AnimationName, w: World): Promise<Plan | null> {
    void w;
    return mischief({
      do: "call",
      run: async () => {
        const r = await this.host.fxStart(kind).catch(() => null);
        if (!r) return NOT_NOW;
        const ms = Math.min(r.ms, 6500);
        return [
          { do: "hold", anim, maxMs: ms, until: () => this.me.sleep(ms).then(() => true), cancel: () => this.host.abort() } as Step,
          ...giggleSteps(),
        ];
      },
    });
  }

  /** Bugs crawl along a window top; he walks over and squashes them. */
  private async bugs(w: World): Promise<Plan | null> {
    return mischief({
      do: "call",
      run: async () => {
        const r = await this.host.fxStart("bugs").catch(() => null);
        if (!r || !r.tops.length) return NOT_NOW;
        // The top of a window he can stand on (same id as the window), nearest first.
        const cand = r.tops
          .map((t) => ({ t, ledge: w.ledges.find((l) => l.id === t.id) }))
          .filter((c): c is { t: (typeof r.tops)[number]; ledge: NonNullable<typeof c.ledge> } => !!c.ledge)
          .sort((a, b) => Math.hypot(a.ledge.x + a.ledge.w / 2 - this.me.body.x, a.ledge.y - this.me.body.y) - Math.hypot(b.ledge.x + b.ledge.w / 2 - this.me.body.x, b.ledge.y - this.me.body.y));
        const pick = cand[0];
        if (!pick) return [{ do: "hold", anim: "lookAround", maxMs: 5000, until: () => this.me.sleep(5000).then(() => true) } as Step];
        const surface: Surface = { kind: "ledge", ledge: pick.ledge };
        const [lo, hi] = surfaceRange(surface, w);
        const mid = (pick.t.x0 + pick.t.x1) / 2;
        const stand = clampTo(surface, mid, w);
        const side: 1 | -1 = stand - lo > hi - stand ? 1 : -1;
        const from = clampTo(surface, mid - side * 190 * w.scale, w);
        return [
          { do: "teleport", surface, s: from },
          { do: "face", dir: from < stand ? 1 : -1 },
          { do: "anim", name: "lookAround" },
          { do: "walk", to: stand, gait: "walk" },
          {
            do: "call",
            run: () => {
              // The bugs have gathered where he stands: stamp.
              this.host.fxSquash(Math.round(mid), Math.round(pick.t.y));
              return true;
            },
          },
          { do: "anim", name: "startled" },
          ...giggleSteps(),
        ] as Step[];
      },
    });
  }

  private async popup(arg?: string): Promise<Plan | null> {
    const kind: PopupKind = isPopupKind(arg) ? arg : POPUP_KINDS[Math.floor(this.rand() * POPUP_KINDS.length)];
    return mischief(
      { do: "hold", anim: "typing", maxMs: 2600, until: () => this.me.sleep(2400).then(() => true) },
      {
        do: "call",
        run: async () => {
          const ok = await this.host.popup(kind).catch(() => false);
          if (!ok) return NOT_NOW;
          return [{ do: "hold", anim: "laugh", maxMs: 3500, until: () => this.me.sleep(3200).then(() => true) } as Step, ...giggleSteps()];
        },
      },
    );
  }

  /** Minimise a window (Rust picks it), sit by its taskbar button, pop it back. */
  private async yoink(w: World): Promise<Plan | null> {
    return mischief({
      do: "call",
      run: async () => {
        const info = await this.host.yoink().catch(() => null);
        if (!info) return NOT_NOW;
        const cx = info.frame.x + info.frame.w / 2;
        const to = clampTo(FLOOR, cx, w);
        const here = restCenter(FLOOR, to, w);
        const wait = () => new Promise<Step[] | boolean>((resolve) => {
          const t0 = Date.now();
          const poll = () =>
            void this.host.yoinkedCount().then(
              (n) => (n === 0 || Date.now() - t0 > info.deadline_ms + 4000 ? resolve(true) : void this.me.sleep(250).then(poll)),
              () => resolve(true),
            );
          void this.me.sleep(250).then(poll);
        });
        return [
          { do: "teleport", surface: FLOOR, s: to },
          { do: "face", dir: cx >= here.x ? 1 : -1 },
          { do: "hold", anim: "sit", maxMs: info.deadline_ms + 5000, until: wait },
          { do: "anim", name: "virus_giggle" },
        ] as Step[];
      },
    });
  }

  /** Ride a window as it wobbles, slides, shakes or runs away. */
  private async dance(w: World, arg?: string): Promise<Plan | null> {
    const wins = await this.windows();
    const kind: DanceKind = isDanceKind(arg) ? arg : DANCE_KINDS[Math.floor(this.rand() * DANCE_KINDS.length)];
    let best: { score: number; ledge: World["ledges"][number]; win: ChaosWindow } | null = null;
    for (const ledge of w.ledges) {
      if (ledge.w < 160 * w.scale) continue;
      const win = wins.find((x) => x.id === ledge.id);
      if (!win) continue;
      const score = Math.hypot(ledge.x + ledge.w / 2 - this.me.body.x, ledge.y - this.me.body.y);
      if (!best || score < best.score) best = { score, ledge, win };
    }
    if (!best) return null;
    const { ledge, win } = best;
    const surface: Surface = { kind: "ledge", ledge };
    const s = clampTo(surface, ledge.x + ledge.w * (0.35 + 0.3 * this.rand()), w);
    const anim: AnimationName = kind === "run_away" ? "scared" : kind === "quake" ? "dizzy" : "laugh";
    let run: Promise<{ aborted: string | null } | null> | null = null;
    return mischief(
      { do: "teleport", surface, s },
      {
        do: "call",
        run: () => {
          run = this.host.dance(win.id, kind).catch(() => null);
          return true;
        },
      },
      {
        do: "hold",
        anim,
        maxMs: 11_500,
        until: () => new Promise<Step[] | boolean>((resolve) => {
          const wait = () => (run ? run.then((o) => resolve(o === null ? NOT_NOW : o.aborted ? snapSteps().slice(0, 1) : giggleSteps())) : void this.me.sleep(50).then(wait));
          void this.me.sleep(50).then(wait);
        }),
        cancel: () => this.host.abort(),
      },
    );
  }
}
