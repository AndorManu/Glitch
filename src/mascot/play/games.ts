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
import { VelocityTracker } from "../drag";
import { clampTo, FLOOR, isStanding, restCenter, type Surface, type Vec, type World } from "../physics";
import { type BallPicture, type BallSim, newBall, picture, stepSim, throwBall } from "./ballsim";
import { BALL_R, ballWorld, HIDE_SINK, hideSpot, playAnim, route, surfaceNear } from "./rules";

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
  /** Bring up the play overlay the ball is drawn on. */
  ballOpen(): Promise<boolean>;
  /** A new picture of the ball (centre and radius in physical px, for the mouse). */
  ballFrame(f: { x: number; y: number; r: number; pic: BallPicture }): void;
  /** The ball pops away, the overlay goes. */
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
export const FETCH_IDLE_MS = 60_000;
/** Physics frame while the ball moves / rests (glow pulse). */
const BALL_FRAME_MS = 16;
const BALL_REST_MS = 100;
/** Held this briefly without moving: a little toss up instead of a throw. */
const TOSS_MS = 300;

/** What happens when he reaches the ball (chances per catch). */
export const FETCH_ODDS = { fumble: 0.15, bat: 0.12, spin: 0.2, runOff: 0.07 };

export class Fetch {
  active = false;
  /** The ball, or null while it is in his mouth. */
  sim: BallSim | null = null;
  held = false;
  carried = false;
  hover = false;
  /** The ball he just dropped / that fell out on its own: landing doesn't send him after it. */
  private dropped = false;
  /** This throw already had its fumble / bat (once each). */
  private tricks = { fumble: false, bat: false };
  private timer: unknown = null;
  private idleTimer: unknown = null;
  private tracker = new VelocityTracker(80);
  private heldAt = 0;
  private cursorBusy = false;
  private last = 0;
  private chasing = false;

  constructor(private readonly env: PlayEnv) {}

  private get u(): number {
    return this.env.creature.world?.scale ?? 1;
  }

  /** The ball appears at the cursor and drops; he gets excited. */
  async start(): Promise<void> {
    if (this.active || !this.env.settings().fetch) return;
    const c = this.env.creature;
    if (!c.world) return;
    const p = await this.env.cursor();
    if (!(await this.env.ballOpen())) return;
    this.active = true;
    this.sim = newBall(p.x, p.y, 0, 0);
    this.dropped = true;
    this.carried = false;
    this.loop();
    this.poke();
    run(this.env, plan({ do: "anim", name: playAnim("celebrate") }, { do: "anim", name: playAnim("idle_tail"), ms: 2500 }));
  }

  /** Over: if he has it he tucks it away; the ball pops into pixels and he bows. */
  end(happy = true): void {
    if (!this.active) return;
    this.active = false;
    this.held = false;
    for (const t of [this.timer, this.idleTimer]) if (t !== null) this.env.clock.clearTimeout(t);
    this.timer = this.idleTimer = null;
    this.env.acc.carrying = false;
    this.carried = false;
    this.env.creature.repaint();
    this.env.ballClose();
    this.sim = null;
    const c = this.env.creature;
    if (c.mode === "stand" && (!c.plan || c.plan.name === "play")) {
      c.react(plan({ do: "anim", name: happy ? playAnim("bow") : "lookAround" }));
    }
  }

  /** Something happened: the game goes on a while longer. */
  private poke(): void {
    if (this.idleTimer !== null) this.env.clock.clearTimeout(this.idleTimer);
    this.idleTimer = this.env.clock.setTimeout(() => {
      this.idleTimer = null;
      if (this.held || this.chasing) return this.poke();
      this.end();
    }, FETCH_IDLE_MS);
  }

  /** Pressed on the ball (play overlay). */
  grab(): void {
    if (!this.active || !this.sim || this.carried) return;
    this.held = true;
    this.heldAt = this.env.clock.now();
    this.tracker.clear();
    this.dropped = false;
    this.poke();
    this.loop();
  }

  /** Let go: thrown with the cursor's speed of the last ~80 ms, or a little toss. */
  release(): void {
    if (!this.active || !this.held || !this.sim) return;
    this.held = false;
    const now = this.env.clock.now();
    const u = this.u;
    let v = this.tracker.velocity(now);
    if (Math.hypot(v.x, v.y) < 120 * u && now - this.heldAt < TOSS_MS) {
      // A click: a small toss straight up.
      v = { x: (this.env.rand() - 0.5) * 120 * u, y: -720 * u };
    }
    throwBall(this.sim, v.x, v.y, u);
    this.tricks = { fumble: false, bat: false };
    this.poke();
    this.loop();
    this.watch();
  }

  /** He sees the throw: turns to the ball, crouches, ready to run. */
  private watch(): void {
    const c = this.env.creature;
    const b = this.sim;
    if (!b || c.mode !== "stand" || this.carried || this.chasing) return;
    const dir: 1 | -1 = b.x + b.vx * 0.3 >= c.body.x ? 1 : -1;
    run(this.env, plan({ do: "face", dir }, { do: "anim", name: "crouch" }, { do: "anim", name: playAnim("ready"), ms: 4000 }));
  }

  hoverBall(on: boolean): void {
    this.hover = on;
    if (this.sim && !this.timer) this.send();
  }

  /** Glitch was grabbed (or fell) while carrying the ball: it drops where he is. */
  creatureEvent(what: string): void {
    if (!this.active) return;
    if (what === "grab" || what.startsWith("ledge-gone")) {
      this.chasing = false;
      if (this.carried) this.dropFromMouth(false);
    }
  }

  private loop(): void {
    if (this.timer !== null || !this.active) return;
    const resting = this.sim?.mode === "rest" && !this.held;
    this.timer = this.env.clock.setTimeout(() => {
      this.timer = null;
      this.tick();
    }, resting ? BALL_REST_MS : BALL_FRAME_MS);
  }

  private tick(): void {
    const w = this.env.creature.world;
    const b = this.sim;
    if (!this.active || !w || !b) return;
    const now = this.env.clock.now();
    const dt = Math.min(0.05, this.last ? (now - this.last) / 1000 : BALL_FRAME_MS / 1000);
    this.last = now;
    if (this.held) {
      if (!this.cursorBusy) {
        this.cursorBusy = true;
        void this.env.cursor().then(
          (p) => {
            this.cursorBusy = false;
            if (!this.held || !this.sim) return;
            this.tracker.add(this.env.clock.now(), p);
            // Sticks to the cursor with a small lag.
            this.sim.x += (p.x - this.sim.x) * 0.55;
            this.sim.y += (p.y - this.sim.y) * 0.55;
            this.sim.vx = this.sim.vy = 0;
            this.sim.mode = "air";
          },
          () => (this.cursorBusy = false),
        );
      }
      this.send();
      return this.loop();
    }
    const r = stepSim(b, w, dt, this.env.rand);
    this.send();
    if ((r.settled || r.rested) && !this.dropped && !this.chasing && !this.carried) this.chase();
    this.loop();
  }

  /** The picture to the play overlay, and where the ball is for the mouse. */
  private send(): void {
    const w = this.env.creature.world;
    const b = this.sim;
    if (!w || !b) return;
    this.env.ballFrame({ x: b.x, y: b.y, r: BALL_R * w.scale, pic: picture(b, w, this.hover || this.held) });
  }

  /** Where the ball will stop, if left alone (for running there straight away). */
  private predictRest(): { surface: Surface; x: number } | null {
    const w = this.env.creature.world;
    const b = this.sim;
    if (!w || !b) return null;
    const ghost: BallSim = { ...b, trail: [], sparks: [] };
    const bw = ballWorld(w);
    for (let i = 0; i < 600; i++) {
      stepSim(ghost, w, 1 / 60, () => 0.99, bw);
      if (ghost.mode === "rest" && ghost.surface) return { surface: ghost.surface, x: ghost.x };
    }
    return ghost.surface ? { surface: ghost.surface, x: ghost.x } : null;
  }

  /** Run to the ball (where it will stop), pounce when close, then catch / fumble / bat it. */
  private chase(tries = 0): void {
    const c = this.env.creature;
    const w = c.world;
    const target = this.predictRest();
    if (!w || !target || c.mode !== "stand" || !this.sim) return;
    this.chasing = true;
    const u = w.scale;
    const dir: 1 | -1 = target.x >= c.body.x ? 1 : -1;
    const approach = target.x - dir * 64 * u;
    const steps: Step[] = [...route(c, target.surface, approach, w, { gait: "run" })];
    steps.push(
      call(() => {
        const b = this.sim;
        if (!this.active || !b || !c.world) return false;
        const near = Math.abs(b.x - c.body.x) < 150 * u && Math.abs(b.y - c.body.y) < 90 * u;
        if (!near || b.mode === "air") {
          // It got away: after it again (a few times, then he just glitches over to it).
          if (tries < 3) {
            this.chasing = false;
            this.env.clock.setTimeout(() => this.chase(tries + 1), 300);
            return false;
          }
          return [{ do: "teleport", surface: b.surface ?? FLOOR, s: b.x }, call(() => this.catchNow())];
        }
        // Pounce onto it.
        const at = c.surface;
        const to = restCenterOf(at, b.x, c.world);
        return to ? [{ do: "face", dir: b.x >= c.body.x ? 1 : -1 }, { do: "jump", to, height: 40, anim: "airDown" }] : true;
      }),
      call(() => this.reach()),
    );
    run(this.env, plan(...steps));
  }

  /** At the ball: a fumble, a bit of batting it around, or the catch. */
  private reach(): boolean | Step[] {
    const b = this.sim;
    const c = this.env.creature;
    const u = this.u;
    if (!this.active || !b) return false;
    const dir = c.facingLeft ? -1 : 1;
    const roll = this.env.rand();
    if (!this.tricks.fumble && roll < FETCH_ODDS.fumble) {
      // Off his nose: up and away, and after it again.
      this.tricks.fumble = true;
      throwBall(b, dir * (220 + this.env.rand() * 200) * u, -620 * u, u);
      this.chasing = false;
      this.loop();
      return [{ do: "anim", name: "startled" }, { do: "anim", name: playAnim("laugh") }];
    }
    if (!this.tricks.bat && roll < FETCH_ODDS.fumble + FETCH_ODDS.bat) {
      // Bats it along the ground a couple of times, then goes after it.
      this.tricks.bat = true;
      throwBall(b, dir * (360 + this.env.rand() * 160) * u, -160 * u, u);
      this.chasing = false;
      this.loop();
      return [{ do: "anim", name: playAnim("bat") }];
    }
    return this.catchNow();
  }

  /** Caught: into his mouth, maybe a happy spin, maybe a cheeky run off, then back to you. */
  private catchNow(): boolean | Step[] {
    const c = this.env.creature;
    if (!this.active || !this.sim) return false;
    this.carried = true;
    this.chasing = true;
    this.sim = { ...this.sim, mode: "rest" };
    this.env.ballFrame({ x: 0, y: 0, r: 0, pic: { ...picture(this.sim, c.world!, false, true) } });
    this.env.acc.carrying = true;
    c.repaint();
    const steps: Step[] = [];
    if (this.env.rand() < FETCH_ODDS.spin) steps.push({ do: "anim", name: "chaosSpin" });
    if (this.env.rand() < FETCH_ODDS.runOff) {
      // Keep-away! A short dash the other way, a look back, a laugh.
      steps.push(
        call(async () => {
          const w = c.world;
          if (!w) return true;
          const p = await this.env.cursor();
          const away = c.body.x + (c.body.x >= p.x ? 1 : -1) * 320 * w.scale;
          return [...route(c, c.surface, away, w, { gait: "run", anim: playAnim("fetch_ball") }), { do: "anim", name: "lookBack" }, { do: "anim", name: playAnim("laugh") }];
        }),
      );
    }
    steps.push(
      call(async () => {
        if (!this.active || !c.world) return false;
        const p = await this.env.cursor();
        const back = surfaceNear(c.world, p);
        // Stop a little before the cursor, facing it.
        const side = c.body.x >= p.x ? 1 : -1;
        return route(c, back.surface, back.s + side * 46 * c.world.scale, c.world, { gait: "walk", anim: playAnim("fetch_ball") });
      }),
      call(async () => {
        const p = await this.env.cursor();
        return [{ do: "face", dir: p.x >= c.body.x ? 1 : -1 }];
      }),
      call(() => {
        this.dropFromMouth(true);
        return true;
      }),
      { do: "anim", name: playAnim("idle_tail"), ms: 5000 },
    );
    return steps;
  }

  /** The ball falls out of his mouth and rolls a little (brought back: XP and energy). */
  private dropFromMouth(brought: boolean): void {
    const c = this.env.creature;
    const w = c.world;
    if (!this.active || !this.carried || !w) return;
    const u = w.scale;
    this.carried = false;
    this.chasing = false;
    this.env.acc.carrying = false;
    c.repaint();
    const dir = c.facingLeft ? -1 : 1;
    this.sim = newBall(c.body.x + dir * 30 * u, c.body.y - 4 * u, dir * 140 * u, -180 * u);
    this.dropped = true;
    this.loop();
    this.poke();
    if (brought) this.env.petEvent("fetch");
  }
}

function restCenterOf(s: Surface, x: number, w: World): Vec | null {
  return isStanding(s) ? restCenter(s, clampTo(s, x, w), w) : null;
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
