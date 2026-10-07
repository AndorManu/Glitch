import { describe, expect, it } from "vitest";
import { BEHAVIOURS, type BehaviourName, Brain, type BrainContext, isBehaviourName, planMoves, type Plan } from "./brain";
import { mulberry32 } from "./glitchfx";
import { type Body, FLOOR, restCenter, stepAir, type Surface, surfaceRange, type World } from "./physics";

const LEDGES = [
  { id: 1, x: 200, y: 640, w: 520 },
  { id: 2, x: 900, y: 420, w: 600 },
];
const world = (ledges = LEDGES): World => ({ area: { x: 0, y: 0, w: 1920, h: 1040 }, scale: 1, ledges });

function ctx(o: Partial<BrainContext> = {}): BrainContext {
  const w = o.world ?? world();
  const surface = o.surface ?? FLOOR;
  const [lo, hi] = surfaceRange(surface, w);
  return { now: 1_000_000, world: w, surface, s: (lo + hi) / 2, movement: true, sleepy: false, excited: false, ...o };
}

const LEFT: Surface = { kind: "left" };
const CEILING: Surface = { kind: "ceiling" };
const ON_TOP: Surface = { kind: "ledge", ledge: LEDGES[1] };
const PLATFORM: Surface = { kind: "platform", ledge: { id: -1, x: 500, y: 600, w: 116 } };

describe("brain", () => {
  it("only plans behaviours that fit where he is", () => {
    const b = new Brain(mulberry32(1));
    expect(b.plan("climb", ctx())).not.toBeNull();
    expect(b.plan("climb", ctx({ surface: ON_TOP }))).toBeNull();
    expect(b.plan("crawl", ctx())).toBeNull();
    expect(b.plan("crawl", ctx({ surface: CEILING }))).not.toBeNull();
    expect(b.plan("climbDown", ctx({ surface: LEFT }))).not.toBeNull();
    expect(b.plan("sitEdge", ctx())).toBeNull();
    expect(b.plan("sitEdge", ctx({ surface: ON_TOP }))).not.toBeNull();
    expect(b.plan("drop", ctx())).toBeNull();
    expect(b.plan("drop", ctx({ surface: PLATFORM }))!.steps).toEqual([{ do: "unbuild" }]);
    expect(isBehaviourName("climb")).toBe(true);
    expect(isBehaviourName("constructor")).toBe(false);
  });

  it("every plan from every surface is made of valid steps", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const b = new Brain(mulberry32(seed));
      for (const surface of [FLOOR, LEFT, CEILING, ON_TOP, PLATFORM, { kind: "right" } as Surface]) {
        for (const name of Object.keys(BEHAVIOURS) as BehaviourName[]) {
          const p = b.plan(name, ctx({ surface }));
          if (!p) continue;
          expect(p.steps.length, `${name} on ${surface.kind}`).toBeGreaterThan(0);
          for (const s of p.steps) if (s.do === "walk") expect(Number.isFinite(s.to)).toBe(true);
        }
      }
    }
  });

  it("respects cooldowns: nothing comes back before its cooldown is over", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const b = new Brain(mulberry32(seed));
      const last = new Map<BehaviourName, number>();
      let now = 0;
      for (let i = 0; i < 300; i++) {
        now += 5000; // a decision every 5 s
        const p = b.next(ctx({ now }));
        const prev = last.get(p.name);
        if (prev !== undefined && BEHAVIOURS[p.name].weight > 0 && p.name !== "lookAround") {
          expect(now - prev, `${p.name} seed ${seed}`).toBeGreaterThanOrEqual(BEHAVIOURS[p.name].cooldown * 1000);
        }
        last.set(p.name, now);
      }
    }
  });

  it("varies: over time on the floor he does many different things", () => {
    const b = new Brain(mulberry32(3));
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) seen.add(b.next(ctx({ now: i * 15000 })).name);
    for (const name of ["stroll", "climb", "jump", "teleport", "build", "malfunction", "lookAround", "run"]) expect(seen, name).toContain(name);
  });

  it("movement off: never walks, climbs or jumps; gets off walls and platforms", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const b = new Brain(mulberry32(seed));
      for (let i = 0; i < 30; i++) {
        const p = b.next(ctx({ now: i * 60_000, movement: false }));
        expect(planMoves(p), p.name).toBe(false);
        const onTop = b.next(ctx({ now: i * 60_000 + 30_000, movement: false, surface: ON_TOP }));
        expect(planMoves(onTop), onTop.name).toBe(false);
      }
      expect(b.next(ctx({ movement: false, surface: LEFT })).steps).toEqual([{ do: "drop" }]);
      expect(b.next(ctx({ movement: false, surface: CEILING })).steps).toEqual([{ do: "drop" }]);
      expect(b.next(ctx({ movement: false, surface: PLATFORM })).steps).toEqual([{ do: "unbuild" }]);
    }
  });

  it("sleepy: yawns and sleeps where he can stand, lets go first anywhere else", () => {
    const b = new Brain(mulberry32(2));
    expect(b.next(ctx({ sleepy: true }))).toEqual({ name: "sleep", steps: [{ do: "anim", name: "yawn" }] });
    expect(b.next(ctx({ sleepy: true, surface: ON_TOP })).name).toBe("sleep");
    expect(b.next(ctx({ sleepy: true, surface: CEILING })).steps).toEqual([{ do: "drop" }]);
  });

  it("on walls and the ceiling he keeps going (and rests only briefly)", () => {
    const b = new Brain(mulberry32(8));
    const names = new Set<string>();
    for (let i = 0; i < 50; i++) names.add(b.next(ctx({ now: i * 10_000, surface: LEFT })).name);
    expect([...names].every((n) => ["climbOn", "climbDown", "drop", "lookBack", "malfunction"].includes(n))).toBe(true);
    expect(b.restMs(ctx({ surface: LEFT }))).toBeLessThan(4000);
    expect(b.restMs(ctx())).toBeGreaterThanOrEqual(5000);
  });

  it("jump plans really land on the window top they aim for", () => {
    let planned = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const b = new Brain(mulberry32(seed));
      const c = ctx({ s: 200 + ((seed * 137) % 1500) });
      const p = b.plan("jump", c);
      if (!p) continue;
      planned++;
      const jump = p.steps.find((s) => s.do === "jump")!;
      expect(jump.do === "jump" && jump.ledgeId).toBeDefined();
      const walk = p.steps.find((s) => s.do === "walk");
      const from = restCenter(FLOOR, walk?.do === "walk" ? walk.to : c.s, c.world);
      if (jump.do !== "jump") continue;
      const target = LEDGES.find((l) => l.id === jump.ledgeId)!;
      // Fly the arc the creature would fly.
      const g = 2600;
      const apex = Math.min(from.y, jump.to.y) - 46; // JUMP.clearance
      const vy = -Math.sqrt(2 * g * (from.y - apex));
      const t = -vy / g + Math.sqrt((2 * (jump.to.y - apex)) / g);
      const body: Body = { x: from.x, y: from.y, vx: (jump.to.x - from.x) / t, vy, angle: 0, spin: 0 };
      let landed: Surface | null = null;
      for (let i = 0; i < 300 && !landed; i++) {
        for (const ct of stepAir(body, c.world, 1 / 60, { keepSpin: true })) if (ct.kind === "land") landed = ct.surface;
      }
      // (It may also come down on a window top it passes over first: still a top.)
      expect(landed?.kind, `seed ${seed}`).toBe("ledge");
      if (landed?.kind === "ledge" && landed.ledge.id === target.id) expect(Math.abs(body.x - jump.to.x)).toBeLessThan(4);
    }
    expect(planned).toBeGreaterThan(40);
  });

  it("no window tops: no jumping, but a stepping-stone-free platform build is still possible", () => {
    const b = new Brain(mulberry32(4));
    expect(b.plan("jump", ctx({ world: world([]) }))).toBeNull();
    const p = b.plan("build", ctx({ world: world([]) })) as Plan;
    expect(p.steps.map((s) => s.do)).toEqual(["build", "anim", "anim", "anim", "unbuild"]);
  });

  it("a window top out of reach: builds a stepping stone and jumps from it", () => {
    const high = { id: 5, x: 700, y: 330, w: 500 };
    const b = new Brain(mulberry32(4));
    const p = b.plan("build", ctx({ world: world([high]), s: 600 }))!;
    expect(p.steps.map((s) => s.do)).toEqual(["walk", "build", "anim", "face", "jump"]);
  });
});
