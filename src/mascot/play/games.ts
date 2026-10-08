// Games, play and growth on the mascot: fetch, hide and seek, eating files,
// and his mood (hearts/stars, dances when happy, mischief when bored, hats
// and eye colour from the wardrobe). Rules in rules.ts; the wiring to Tauri
// in index.ts. No timers run unless a game is on (the ball flying or being
// carried, sinking out of sight, hearts floating up).

import type { PetEventKind, PetView, PlaySettings } from "../../shared/ipc";
import { PLAY_DEFAULTS } from "../../shared/ipc";
import type { Accessories } from "../accessories";
import { isAnimationName, type AnimationName } from "../animations";
import type { BrainContext, Plan, Step } from "../brain";
import type { Creature } from "../creature";
import { capSpeed, VelocityTracker } from "../drag";
import { isStanding, type Surface, type Vec } from "../physics";
import { type Ball, BALL_MAX_THROW, ballWorld, HIDE_SINK, hideSpot, playAnim, route, stepBall, surfaceNear } from "./rules";

export interface PlayClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

/** What the games need from the outside (Tauri in the app, fakes in tests). */
export interface PlayEnv {
  creature: Creature;
  acc: Accessories;
  clock: PlayClock;
  rand(): number;
  cursor(): Promise<Vec>;
  /** Show the ball window with its top-left at (x, y) physical px: its size in physical px. */
  ballOpen(x: number, y: number): Promise<number | null>;
  ballMove(x: number, y: number): void;
  ballClose(): void;
  petEvent(kind: PetEventKind): void;
  settings(): PlaySettings;
}

const plan = (...steps: Step[]): Plan => ({ name: "play", steps });
const call = (run: () => boolean | Step[] | Promise<boolean | Step[]>): Step => ({ do: "call", run });

/** Start a game plan now (waking him first). */
function run(env: PlayEnv, p: Plan): boolean {
  const c = env.creature;
  if (c.asleep) c.wake();
  return c.react(p);
}

// ------------------------------------------------------------------ fetch

/** No throw for this long: the game ends. */
export const FETCH_IDLE_MS = 45_000;
const BALL_FRAME_MS = 16;

type BallMode = "rest" | "held" | "air" | "carried";

export class Fetch {
  active = false;
  mode: BallMode = "rest";
  ball: Ball = { x: 0, y: 0, vx: 0, vy: 0 };
  /** The ball he just dropped (landing doesn't send him after it). */
  private dropped = false;
  private size = 0;
  private timer: unknown = null;
  private idleTimer: unknown = null;
  private tracker = new VelocityTracker(90);
  private cursorBusy = false;

  constructor(private readonly env: PlayEnv) {}

  /** The ball appears at the cursor; he gets excited. */
  async start(): Promise<void> {
    if (this.active || !this.env.settings().fetch) return;
    const c = this.env.creature;
    const w = c.world;
    if (!w) return;
    const p = await this.env.cursor();
    const size = await this.env.ballOpen(Math.round(p.x - 22 * w.scale), Math.round(p.y - 22 * w.scale));
    if (!size) return;
    this.active = true;
    this.size = size;
    this.ball = { x: p.x, y: p.y, vx: 0, vy: 0 };
    this.dropped = true; // it falls to the ground first; he waits for a real throw
    this.mode = "air";
    this.loop();
    this.poke();
    run(this.env, plan({ do: "anim", name: playAnim("celebrate") }, { do: "anim", name: playAnim("wag"), ms: 1500 }));
  }

  end(happy = true): void {
    if (!this.active) return;
    this.active = false;
    for (const t of [this.timer, this.idleTimer]) if (t !== null) this.env.clock.clearTimeout(t);
    this.timer = this.idleTimer = null;
    this.env.acc.carrying = false;
    this.env.ballClose();
    this.env.creature.repaint();
    const c = this.env.creature;
    if (c.mode === "stand" && (!c.plan || c.plan.name === "play")) c.react(plan({ do: "anim", name: happy ? playAnim("laugh") : "lookAround" }));
  }

  /** Something happened: the game goes on a while longer. */
  private poke(): void {
    if (this.idleTimer !== null) this.env.clock.clearTimeout(this.idleTimer);
    this.idleTimer = this.env.clock.setTimeout(() => {
      this.idleTimer = null;
      // Not while he is busy with the ball.
      if (this.mode === "carried" || this.mode === "held") return this.poke();
      this.end();
    }, FETCH_IDLE_MS);
  }

  /** The user grabbed the ball (ball window). */
  grab(): void {
    if (!this.active || this.mode === "carried") return;
    this.mode = "held";
    this.tracker.clear();
    this.dropped = false;
    this.poke();
    this.loop();
  }

  /** Let go: thrown with the cursor's speed. */
  release(): void {
    if (!this.active || this.mode !== "held") return;
    const w = this.env.creature.world;
    const u = w?.scale ?? 1;
    const v = capSpeed(this.tracker.velocity(this.env.clock.now()), BALL_MAX_THROW * u);
    this.ball.vx = v.x;
    this.ball.vy = v.y;
    this.mode = "air";
    this.poke();
    this.loop();
  }

  /** Glitch was grabbed (or fell) while carrying the ball: it drops where he is. */
  creatureEvent(what: string): void {
    if (!this.active) return;
    if (this.mode === "carried" && (what === "grab" || what.startsWith("ledge-gone"))) this.dropFromMouth(false);
  }

  private loop(): void {
    if (this.timer !== null) return;
    this.timer = this.env.clock.setTimeout(() => {
      this.timer = null;
      this.tick();
    }, BALL_FRAME_MS);
  }

  private last = 0;

  private tick(): void {
    if (!this.active) return;
    const w = this.env.creature.world;
    if (!w) return;
    const now = this.env.clock.now();
    const dt = Math.min(0.05, this.last ? (now - this.last) / 1000 : BALL_FRAME_MS / 1000);
    this.last = now;
    if (this.mode === "held") {
      if (!this.cursorBusy) {
        this.cursorBusy = true;
        void this.env.cursor().then(
          (p) => {
            this.cursorBusy = false;
            if (this.mode !== "held") return;
            this.ball.x = p.x;
            this.ball.y = p.y;
            this.tracker.add(this.env.clock.now(), p);
            this.place();
          },
          () => (this.cursorBusy = false),
        );
      }
      return this.loop();
    }
    if (this.mode !== "air") {
      this.last = 0;
      return;
    }
    const rest = stepBall(this.ball, w, dt, ballWorld(w));
    this.place();
    if (!rest) return this.loop();
    this.last = 0;
    this.mode = "rest";
    if (this.dropped) return;
    this.fetchFrom(rest);
  }

  private place(): void {
    this.env.ballMove(Math.round(this.ball.x - this.size / 2), Math.round(this.ball.y - this.size / 2));
  }

  /** Run to the ball, pick it up, bring it back near the cursor, drop it, wait wagging. */
  private fetchFrom(surface: Surface): void {
    const c = this.env.creature;
    const w = c.world;
    if (!w || c.mode !== "stand") return;
    const steps: Step[] = [
      ...route(c, surface, this.ball.x, w, { gait: "run" }),
      call(() => {
        if (!this.active) return false;
        // Picked up: the ball window goes, the ball is in his mouth.
        this.mode = "carried";
        this.env.ballClose();
        this.env.acc.carrying = true;
        c.repaint();
        return true;
      }),
      { do: "anim", name: "lookAround" },
      call(async () => {
        if (!this.active || !c.world) return false;
        const back = surfaceNear(c.world, await this.env.cursor());
        return route(c, back.surface, back.s, c.world, { gait: "walk", anim: playAnim("fetch_ball") });
      }),
      call(() => {
        this.dropFromMouth(true);
        return true;
      }),
      { do: "anim", name: playAnim("wag"), ms: 2500 },
    ];
    run(this.env, plan(...steps));
  }

  /** The ball falls out of his mouth (brought back: XP and energy). */
  private dropFromMouth(brought: boolean): void {
    const c = this.env.creature;
    const w = c.world;
    if (!this.active || this.mode !== "carried" || !w) return;
    const u = w.scale;
    this.env.acc.carrying = false;
    c.repaint();
    const dir = c.facingLeft ? -1 : 1;
    this.ball = { x: c.body.x + dir * 30 * u, y: c.body.y - 6 * u, vx: dir * 60 * u, vy: -150 * u };
    this.dropped = true;
    this.mode = "air";
    void this.env.ballOpen(Math.round(this.ball.x - this.size / 2), Math.round(this.ball.y - this.size / 2)).then((s) => {
      if (s) this.size = s;
    });
    this.loop();
    this.poke();
    if (brought) this.env.petEvent("fetch");
  }
}

// ----------------------------------------------------------- hide and seek

/** Nobody found him in this long: he comes out laughing. */
export const GIVE_UP_MS = 50_000;

export class HideSeek {
  active = false;
  /** Fully hidden (only now does hovering him count). */
  hidden = false;
  private sinkTimer: unknown = null;

  constructor(private readonly env: PlayEnv) {}

  async start(): Promise<void> {
    if (this.active || !this.env.settings().hide_seek) return;
    const c = this.env.creature;
    const w = c.world;
    if (!w || c.mode !== "stand") return;
    const spot = hideSpot(w, await this.env.cursor(), this.env.rand);
    this.active = true;
    run(
      this.env,
      plan(
        { do: "teleport", surface: spot.surface, s: spot.s },
        call(
          () =>
            new Promise<Step[]>((done) =>
              this.sinkTo(HIDE_SINK, 700, () => {
                this.hidden = this.active;
                done([{ do: "anim", name: playAnim("hide_peek"), ms: GIVE_UP_MS }, call(() => (this.giveUp(), true))]);
              }),
            ),
        ),
      ),
    );
  }

  /** The cursor is on him. */
  hover(on: boolean): void {
    if (!on || !this.hidden) return;
    this.hidden = false;
    this.active = false;
    this.env.petEvent("found");
    this.sinkTo(0, 250, () => {
      this.env.acc.sparkle("star", 4);
      run(this.env, plan({ do: "anim", name: playAnim("celebrate") }, { do: "anim", name: playAnim("laugh") }));
    });
  }

  private giveUp(): void {
    if (!this.active) return;
    this.hidden = false;
    this.active = false;
    this.env.petEvent("gave_up");
    this.sinkTo(0, 500, () => run(this.env, plan({ do: "anim", name: playAnim("laugh") })));
  }

  /** Stop now (he was grabbed, the chat opened, the game got switched off). */
  abort(): void {
    if (this.sinkTimer !== null) this.env.clock.clearTimeout(this.sinkTimer);
    this.sinkTimer = null;
    this.active = this.hidden = false;
    if (this.env.acc.sink !== 0) {
      this.env.acc.sink = 0;
      this.env.creature.repaint();
    }
  }

  creatureEvent(what: string): void {
    if ((this.active || this.env.acc.sink) && (what === "grab" || what.startsWith("ledge-gone"))) this.abort();
  }

  /** Ease the sink to `to` CSS px over `ms` (a few repaints), then `done`. */
  private sinkTo(to: number, ms: number, done: () => void): void {
    if (this.sinkTimer !== null) this.env.clock.clearTimeout(this.sinkTimer);
    const from = this.env.acc.sink;
    const t0 = this.env.clock.now();
    const step = () => {
      const t = Math.min(1, (this.env.clock.now() - t0) / ms);
      this.env.acc.sink = from + (to - from) * (t * t * (3 - 2 * t));
      this.env.creature.repaint();
      if (t >= 1) {
        this.sinkTimer = null;
        return done();
      }
      this.sinkTimer = this.env.clock.setTimeout(step, 60);
    };
    step();
  }
}

// ----------------------------------------------------------------- mood

/** Between two mood moments (a dance, a bit of mischief), ms. */
export const MOOD_GAP_MS = 150_000;
/** Hover hearts at most this often. */
const SPARKLE_GAP_MS = 4000;
/** Harmless chaos acts he picks when bored. */
const BORED_ACTS = ["paws", "peek", "knock", "note", "chase"];

export class MoodKeeper {
  view: PetView | null = null;
  private nextMoodAt: number;
  private lastSparkle = -Infinity;
  private greeted = false;

  constructor(private readonly env: PlayEnv) {
    this.nextMoodAt = env.clock.now() + 60_000;
  }

  /** New pet state from Rust: wardrobe, chubbiness, and yesterday's grudge on start. */
  apply(v: PetView): void {
    this.view = v;
    const acc = this.env.acc;
    acc.hat = v.levels_on ? v.hat : null;
    acc.eye = v.levels_on ? v.eye : "magenta";
    acc.girth = v.chubby ? 1.1 : 1;
    this.env.creature.repaint();
    if (!this.greeted) {
      this.greeted = true;
      // Thrown around a lot yesterday: a suspicious look first thing.
      if (v.mood_on && v.suspicion >= 0.3) this.env.clock.setTimeout(() => void this.env.creature.playAction("annoyed"), 4000);
    }
  }

  hover(on: boolean): void {
    if (!on || !this.view?.mood_on) return;
    const now = this.env.clock.now();
    if (now - this.lastSparkle < SPARKLE_GAP_MS) return;
    this.lastSparkle = now;
    const m = this.view.mood;
    this.env.acc.sparkle(m === "happy" ? "heart" : "star", m === "bored" ? 1 : m === "happy" ? 3 : 2);
    this.env.petEvent("pet");
  }

  creatureEvent(what: string): void {
    const t = /^throw:(\d+)/.exec(what);
    if (t && Number(t[1]) > 300) this.env.petEvent("thrown");
  }

  levelUp(): void {
    this.env.acc.sparkle("star", 5);
    run(this.env, plan({ do: "anim", name: playAnim("celebrate") }));
  }

  /** Happy: a dance now and then. Bored: a bit of (harmless) mischief. */
  nextPlan(ctx: BrainContext): Plan | "wait" | null {
    const v = this.view;
    if (!v?.mood_on || !isStanding(ctx.surface) || ctx.sleepy) return null;
    const now = this.env.clock.now();
    if (now < this.nextMoodAt) return null;
    const c = this.env.creature;
    if (v.mood === "happy" && this.env.rand() < 0.35) {
      this.nextMoodAt = now + MOOD_GAP_MS;
      return plan({ do: "anim", name: playAnim("dance"), ms: 4000 + this.env.rand() * 3000 }, { do: "anim", name: "happy" });
    }
    if (v.mood === "bored" && c.chaosOn && c.movement && this.env.rand() < 0.35) {
      this.nextMoodAt = now + MOOD_GAP_MS;
      void c.forceChaos(BORED_ACTS[Math.floor(this.env.rand() * BORED_ACTS.length)]);
      return "wait";
    }
    return null;
  }

  /** Chubby after a meal: the chubby pose if it is drawn (else the wider idle). */
  restAnim(base: AnimationName): AnimationName {
    if (base === "idle" && this.view?.chubby && isAnimationName("chubby_idle")) return "chubby_idle" as AnimationName;
    return base;
  }
}

// ----------------------------------------------------------------- eating

/** A file is dragged over him / dropped / eaten (src-tauri/src/play.rs). */
export class Feeding {
  private sniffed = false;

  constructor(private readonly env: PlayEnv) {}

  drag(over: boolean): void {
    if (!over) {
      this.sniffed = false;
      return;
    }
    if (this.sniffed || !this.env.settings().feeding) return;
    this.sniffed = true;
    void this.env.creature.playAction(playAnim("sniff"));
  }

  result(r: { eaten: string[]; refused: string[]; declined: boolean }): void {
    if (r.eaten.length) {
      run(this.env, plan({ do: "anim", name: playAnim("eat") }, { do: "anim", name: playAnim("burp") }));
    } else if (!r.declined && r.refused.length) {
      run(this.env, plan({ do: "anim", name: "lookAround" }));
    }
  }
}

/** All of it, plus the creature hooks. */
export class Play {
  readonly fetch: Fetch;
  readonly hide: HideSeek;
  readonly mood: MoodKeeper;
  readonly feeding: Feeding;

  constructor(readonly env: PlayEnv) {
    this.fetch = new Fetch(env);
    this.hide = new HideSeek(env);
    this.mood = new MoodKeeper(env);
    this.feeding = new Feeding(env);
    env.creature.hooks = {
      nextPlan: (ctx) => {
        // A game is on: stay around (unless he's stuck on a wall, then the brain gets him down).
        if ((this.fetch.active || this.hide.active) && isStanding(ctx.surface)) return "wait";
        return this.mood.nextPlan(ctx);
      },
      restAnim: (base) => this.mood.restAnim(base),
      event: (what) => {
        this.fetch.creatureEvent(what);
        this.hide.creatureEvent(what);
        this.mood.creatureEvent(what);
      },
    };
  }

  /** "play:fetch", "play:hide", "play:stop". */
  action(name: string): boolean {
    switch (name) {
      case "play:fetch":
        this.hide.abort();
        void this.fetch.start();
        return true;
      case "play:hide":
        this.fetch.end(false);
        void this.hide.start();
        return true;
      case "play:stop":
        this.fetch.end(false);
        this.hide.abort();
        return true;
    }
    return false;
  }

  hover(on: boolean): void {
    this.hide.hover(on);
    this.mood.hover(on);
  }

  /** The chat opened / settings changed: games that may not go on stop. */
  check(chatOpen: boolean, s: PlaySettings = this.env.settings()): void {
    if (chatOpen || !s.fetch) this.fetch.end(false);
    if (chatOpen || !s.hide_seek) this.hide.abort();
  }
}

export function playSettings(s: { play?: PlaySettings } | null): PlaySettings {
  return { ...PLAY_DEFAULTS, ...(s?.play ?? {}) };
}
