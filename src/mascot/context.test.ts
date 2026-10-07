import { describe, expect, it } from "vitest";
import { isAnimationName, type AnimationName } from "./animations";
import type { Plan } from "./brain";
import { ContextReactor, debugReaction, formatCountdown, PENDING_MS, planHide, planReaction, type ReactContext, reactAnim, REACT_FALLBACKS, type ReactSubject } from "./context";
import { mulberry32 } from "./glitchfx";
import { FLOOR, type Surface, surfaceRange, type World } from "./physics";
import type { ContextStatus, Reaction } from "../shared/context";

const LEDGES = [
  { id: 1, x: 200, y: 640, w: 520 },
  { id: 2, x: 900, y: 120, w: 600 },
];
const world: World = { area: { x: 0, y: 0, w: 1920, h: 1040 }, scale: 1, ledges: LEDGES };

function ctx(o: Partial<ReactContext> = {}): ReactContext {
  const surface = o.surface ?? FLOOR;
  const [lo, hi] = surfaceRange(surface, world);
  return { world, surface, s: (lo + hi) / 2, movement: true, ...o };
}

const ALL: Reaction[] = [
  { kind: "dance", bpm: 112 },
  { kind: "glasses_type" },
  { kind: "watch_tv", window: 1 },
  { kind: "late_night", say: true },
  { kind: "morning" },
  { kind: "battery_low", percent: 12 },
  { kind: "cpu_hot" },
  { kind: "suggest_focus" },
];

class FakeClock {
  t = 0;
  timers: { at: number; fn: () => void; id: number }[] = [];
  private next = 1;
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    const id = this.next++;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  };
  clearTimeout = (id: unknown) => {
    this.timers = this.timers.filter((t) => t.id !== id);
  };
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const t = this.timers[0];
      if (!t || t.at > end) break;
      this.timers.shift();
      this.t = t.at;
      t.fn();
    }
    this.t = end;
  }
}

class FakeSubject implements ReactSubject {
  world: World | null = world;
  surface: Surface = FLOOR;
  s = 900;
  movement = true;
  free = true;
  plans: Plan[] = [];
  hush: AnimationName | null = null;
  canReact = () => this.free;
  react = (p: Plan) => {
    this.plans.push(p);
    return true;
  };
  setHush = (p: AnimationName | null) => {
    this.hush = p;
  };
}

const status = (o: Partial<ContextStatus>): ContextStatus => ({ enabled: true, quiet: false, focus: { phase: "off" }, remaining_ms: null, ...o });

describe("context reactions", () => {
  it("fall back to existing animations until the new art lands", () => {
    for (const name of Object.keys(REACT_FALLBACKS)) expect(isAnimationName(reactAnim(name))).toBe(true);
    const none = () => false;
    expect(reactAnim("dance_beat", none)).toBe("idle");
    expect(reactAnim("dance_beat", (n) => n === "dance")).toBe("dance");
    expect(reactAnim("dance_beat", (n) => n === "dance_beat" || n === "dance")).toBe("dance_beat");
    expect(reactAnim("glasses_type", (n) => n === "typing")).toBe("typing");
    expect(reactAnim("watch_tv", (n) => n === "sit")).toBe("sit");
  });

  it("plans every reaction as valid steps when standing, none on a wall", () => {
    const r = mulberry32(3);
    for (const re of ALL) {
      const p = planReaction(re, ctx(), r);
      expect(p, re.kind).not.toBeNull();
      expect(p!.name).toBe("react");
      expect(p!.steps.length).toBeGreaterThan(0);
      for (const s of p!.steps) if (s.do === "anim") expect(isAnimationName(s.name)).toBe(true);
      expect(planReaction(re, ctx({ surface: { kind: "left" } }), r)).toBeNull();
    }
    expect(planReaction({ kind: "quiet", on: true }, ctx(), r)).toBeNull();
  });

  it("watches a video from that window's top: jumps up if he can, glitches over if not", () => {
    const r = mulberry32(5);
    const low = planReaction({ kind: "watch_tv", window: 1 }, ctx({ s: 500 }), r)!;
    expect(low.steps.some((s) => s.do === "jump" && s.ledgeId === 1)).toBe(true);
    const high = planReaction({ kind: "watch_tv", window: 2 }, ctx({ s: 300 }), r)!;
    expect(high.steps[0]).toMatchObject({ do: "teleport", surface: { kind: "ledge", ledge: LEDGES[1] } });
    // Already on it, unknown window, or movement off: watch right here.
    for (const c of [ctx({ surface: { kind: "ledge", ledge: LEDGES[0] }, s: 400 }), ctx({ movement: false })]) {
      expect(planReaction({ kind: "watch_tv", window: 1 }, c, r)!.steps.map((s) => s.do)).toEqual(["anim"]);
    }
    expect(planReaction({ kind: "watch_tv", window: 99 }, ctx(), r)!.steps.map((s) => s.do)).toEqual(["anim"]);
  });

  it("hides in the nearest bottom corner", () => {
    const [lo, hi] = surfaceRange(FLOOR, world);
    expect(planHide(ctx({ s: lo + 300 }))!.steps[0]).toMatchObject({ do: "teleport", s: lo });
    expect(planHide(ctx({ s: hi - 300 }))!.steps[0]).toMatchObject({ do: "teleport", s: hi });
    expect(planHide(ctx({ s: lo + 10 }))).toBeNull();
    expect(planHide(ctx({ movement: false }))).toBeNull();
  });

  it("waits for him to be free, briefly, then drops the reaction", () => {
    const clock = new FakeClock();
    const sub = new FakeSubject();
    const re = new ContextReactor(sub, clock, mulberry32(1));
    sub.free = false; // chat open / held / annoyed
    expect(re.handle({ kind: "dance", bpm: 112 })).toBe(false);
    clock.advance(5000);
    expect(sub.plans).toHaveLength(0);
    sub.free = true;
    clock.advance(2000);
    expect(sub.plans).toHaveLength(1);
    // Busy for too long: dropped, never played late.
    sub.free = false;
    re.handle({ kind: "cpu_hot" });
    clock.advance(PENDING_MS + 3000);
    sub.free = true;
    clock.advance(10_000);
    expect(sub.plans).toHaveLength(1);
    expect(clock.timers).toHaveLength(0);
    // A forced (debug) reaction skips the check.
    sub.free = false;
    expect(re.handle({ kind: "cpu_hot" }, true)).toBe(true);
  });

  it("goes quiet for games: corner, hushed, no reactions until it ends", () => {
    const clock = new FakeClock();
    const sub = new FakeSubject();
    const re = new ContextReactor(sub, clock, mulberry32(1));
    re.handle({ kind: "quiet", on: true });
    expect(sub.plans[0].steps[0]).toMatchObject({ do: "teleport" });
    expect(sub.hush).toBe(reactAnim("hide"));
    expect(re.handle({ kind: "dance", bpm: 112 })).toBe(false);
    clock.advance(PENDING_MS * 2);
    expect(sub.plans).toHaveLength(1);
    re.handle({ kind: "quiet", on: false });
    expect(sub.hush).toBeNull();
    expect(re.handle({ kind: "dance", bpm: 112 })).toBe(true);
  });

  it("guards during focus, shows the countdown on hover, celebrates the break", () => {
    const clock = new FakeClock();
    const sub = new FakeSubject();
    const shown: (string | null)[] = [];
    const label = { show: (t: string) => shown.push(t), hide: () => shown.push(null) };
    const re = new ContextReactor(sub, clock, mulberry32(1), label);
    re.status(status({ focus: { phase: "focus", minutes: 25 }, remaining_ms: 25 * 60_000 }));
    expect(sub.hush).toBe(reactAnim("guard"));
    expect(re.hushed).toBe(true);
    expect(re.handle({ kind: "glasses_type" })).toBe(false);
    re.setHovered(true);
    expect(shown.at(-1)).toBe("25:00");
    clock.advance(61_000);
    expect(shown.at(-1)).toBe("23:59");
    re.setHovered(false);
    expect(shown.at(-1)).toBeNull();
    expect(clock.timers).toHaveLength(0); // no label ticking when not hovered; the blocked reaction was dropped
    re.status(status({ focus: { phase: "break", minutes: 5 }, remaining_ms: 5 * 60_000 }));
    expect(sub.hush).toBeNull();
    const last = sub.plans.at(-1)!;
    expect(last.steps[0]).toMatchObject({ do: "anim", name: reactAnim("celebrate_focus") });
    re.setHovered(true);
    expect(shown.at(-1)).toBe("break 5:00");
    re.status(status({}));
    expect(shown.at(-1)).toBeNull();
    re.dispose();
  });

  it("formats the countdown and maps debug names", () => {
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(42_000)).toBe("0:42");
    expect(formatCountdown(25 * 60_000)).toBe("25:00");
    for (const n of ["dance", "glasses", "watch", "night", "morning", "battery", "cpu", "quiet", "unquiet", "suggest"]) expect(debugReaction(n)).not.toBeNull();
    expect(debugReaction("nope")).toBeNull();
  });
});
