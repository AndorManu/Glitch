import { describe, expect, it } from "vitest";
import type { Chaos2Status, CursorAct, CursorOutcome, Fx, FxKind, FxStarted, PopupKind, ScreenRect } from "../shared/ipc";
import { ANIM_RODS } from "../sprites/anim";
import { ANIMATIONS } from "./animations";
import type { ChaosHost } from "./chaos";
import {
  artPx,
  DANCE_KINDS,
  giggleSteps,
  gapFor,
  HOOK_STYLES,
  isNewAct,
  NEW_ACT_WEIGHTS,
  NEW_ACTS,
  orderNewActs,
  pickHookStyle,
  planHookSpot,
  rodTipOf,
  snapSteps,
  usesNewActs,
} from "./chaos2";
import { Creature, type CreatureClock, type Host, type View } from "./creature";
import { mulberry32 } from "./glitchfx";
import { FLOOR, HALF, type Vec, type World } from "./physics";
import { CALM } from "./render";

const AREA = { x: 0, y: 0, w: 1920, h: 1040 };
const world = (ledges: World["ledges"] = []): World => ({ area: AREA, scale: 1, ledges });

describe("chaos 2: pure planning helpers", () => {
  it("knows the new acts and gives every one a weight (the hook is the star)", () => {
    for (const a of NEW_ACTS) {
      expect(isNewAct(a)).toBe(true);
      expect(NEW_ACT_WEIGHTS[a]).toBeGreaterThan(0);
    }
    expect(isNewAct("format_disk")).toBe(false);
    expect(NEW_ACT_WEIGHTS.hook).toBe(Math.max(...Object.values(NEW_ACT_WEIGHTS)));
  });

  it("only Mischief and Full Virus use the new acts; Gentle keeps today's behaviour", () => {
    expect(usesNewActs("gentle")).toBe(false);
    expect(usesNewActs("off")).toBe(false);
    expect(usesNewActs(undefined)).toBe(false);
    expect(usesNewActs("mischief")).toBe(true);
    expect(usesNewActs("full_virus")).toBe(true);
  });

  it("orders only the acts Rust says are ready, each once, weighted", () => {
    const ready: Fx[] = ["hook", "popup", "yoink", "melt"];
    const seen = new Map<string, number>();
    for (let i = 0; i < 400; i++) {
      const o = orderNewActs(ready, mulberry32(i + 1));
      expect([...o].sort()).toEqual([...ready].sort());
      seen.set(o[0], (seen.get(o[0]) ?? 0) + 1);
    }
    expect(seen.get("hook")!).toBeGreaterThan(seen.get("melt")!);
    expect(orderNewActs([], Math.random)).toEqual([]);
  });

  it("takes the pause between acts from Rust's level range (Full Virus 30-60 s, Mischief 90-180 s)", () => {
    expect(gapFor({ gap_ms: [30_000, 60_000] }, [1, 2], () => 0)).toBe(30_000);
    expect(gapFor({ gap_ms: [30_000, 60_000] }, [1, 2], () => 1)).toBe(60_000);
    expect(gapFor({ gap_ms: [90_000, 180_000] }, [1, 2], () => 0.5)).toBe(135_000);
    expect(gapFor(null, [45_000, 120_000], () => 0)).toBe(45_000);
  });

  it("picks a valid hook style and dance kind", () => {
    for (let i = 0; i < 50; i++) expect(HOOK_STYLES).toContain(pickHookStyle(mulberry32(i)));
    expect(DANCE_KINDS).toEqual(["wobble", "edge_slide", "quake", "run_away"]);
  });

  it("the rod tip anchors exist for every cast and reel frame, and the tip follows the facing", () => {
    for (const sheet of ["hook_cast", "hook_reel"]) for (let i = 0; i < 8; i++) expect(ANIM_RODS[`${sheet}${i}`], `${sheet}${i}`).toBeDefined();
    const feet = { x: 500, y: 900 };
    const ux = artPx(1);
    const right = rodTipOf("hook_reel0", feet, false, ux)!;
    const left = rodTipOf("hook_reel0", feet, true, ux)!;
    // Mirrored about the feet; the same height; up in the air above the feet.
    expect(right.x - feet.x).toBeCloseTo(feet.x - left.x, 5);
    expect(right.y).toBe(left.y);
    expect(right.y).toBeLessThan(feet.y - 40);
    expect(rodTipOf("idle0", feet, false, ux)).toBeNull();
  });

  it("stands where a fair cast reaches the cursor, else drops to the taskbar a cast away", () => {
    const w = world();
    // Already on the floor, cursor a fair distance to the right: stays, faces it.
    const fair = planHookSpot(w, FLOOR, 600, { x: 1000, y: 800 });
    expect(fair.pre).toEqual([]);
    expect(fair.dir).toBe(1);
    // Cursor right above him: not a cast; goes elsewhere on the floor.
    const close = planHookSpot(w, FLOOR, 600, { x: 640, y: 500 });
    expect(close.pre.length).toBe(1);
    expect(close.surface).toBe(FLOOR);
    expect(Math.abs(close.s - 640)).toBeGreaterThan(200);
    // On a wall: down to the floor.
    const wall = planHookSpot(w, { kind: "left" }, 500, { x: 1200, y: 300 });
    expect(wall.pre[0]).toMatchObject({ do: "teleport" });
  });

  it("snap and giggle reactions are real animations", () => {
    for (const s of [...snapSteps(), ...giggleSteps()]) {
      expect(s.do).toBe("anim");
      if (s.do === "anim") expect(ANIMATIONS[s.name]).toBeDefined();
    }
    expect(snapSteps().map((s) => (s.do === "anim" ? s.name : ""))).toEqual(["startled", "splat", "annoyed"]);
  });
});

// ------------------------------------------------- the creature + a fake Rust

function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { fn: () => void; due: number }>();
  const clock: CreatureClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      timers.set(next, { fn, due: now + Math.max(0, ms) });
      return next++;
    },
    clearTimeout: (id) => void timers.delete(id as number),
  };
  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  const run = async (ms: number) => {
    const end = now + ms;
    await flush();
    for (;;) {
      let id = -1;
      let due = Infinity;
      for (const [k, t] of timers) if (t.due < due) [id, due] = [k, t.due];
      if (id < 0 || due > end) break;
      const t = timers.get(id)!;
      timers.delete(id);
      now = due;
      t.fn();
      await flush();
    }
    now = end;
  };
  return { clock, run };
}

/** A fake Rust: the hook runs `hookMs` then ends (or `abortAt`: the user took the mouse back). */
function fake2(opts: { hookMs?: number; abortAt?: number; refuse?: boolean } = {}) {
  const log: string[] = [];
  const state = { rods: [] as Vec[], aborts: 0, outcome: null as CursorOutcome | null, yoinked: 0, squashes: 0, popups: [] as PopupKind[], fx: [] as FxKind[] };
  const status: Chaos2Status = {
    level: "full_virus",
    label: "Chaos: Full Virus",
    reduce_effects: false,
    ready: [...NEW_ACTS],
    blocked: null,
    idle_ms: 60_000,
    gap_ms: [30_000, 60_000],
  };
  let clock: CreatureClock | null = null;
  const sleepFor = (ms: number) => new Promise<void>((resolve) => clock!.setTimeout(resolve, ms));
  const host: ChaosHost = {
    status: async () => ({ blocked: null, enabled: true, available: true, idle_ms: 60_000, window_ready: true, cursor_ready: true }),
    windows: async () => [{ id: 42, frame: { x: 600, y: 500, w: 500, h: 300 } }],
    grabWindow: async () => null,
    dragWindow: async () => null,
    releaseWindow: () => {},
    grabCursor: async () => null,
    dragCursor: async () => false,
    releaseCursor: () => {},
    paws: () => {},
    noteOpen: async () => null,
    noteMove: () => {},
    noteIsOpen: async () => false,
    chaos2: {
      status: async () => status,
      cursorAct: async (act: CursorAct, rod: Vec) => {
        log.push(`act:${act.kind}`);
        state.rods.push(rod);
        if (opts.refuse) return null;
        const ms = opts.abortAt ?? opts.hookMs ?? 4000;
        await sleepFor(ms);
        const aborted = opts.abortAt !== undefined && state.aborts === 0 ? ("user_moved" as const) : null;
        state.outcome = { aborted, travel: 120, ms };
        return state.outcome;
      },
      fxStart: async (kind: FxKind): Promise<FxStarted | null> => {
        log.push(`fx:${kind}`);
        state.fx.push(kind);
        return opts.refuse ? null : { ms: 3000, tops: [] };
      },
      fxSquash: () => void state.squashes++,
      popup: async (kind) => {
        state.popups.push(kind);
        return !opts.refuse;
      },
      dance: async (id) => {
        log.push(`dance:${id}`);
        await sleepFor(2000);
        return { aborted: null };
      },
      yoink: async () => {
        if (opts.refuse) return null;
        state.yoinked = 1;
        // Rust restores it 9 s later.
        void sleepFor(9000).then(() => (state.yoinked = 0));
        return { id: 77, frame: { x: 800, y: 300, w: 600, h: 400 } as ScreenRect, deadline_ms: 9000 };
      },
      yoinkedCount: async () => state.yoinked,
      rod: () => {},
      abort: () => void state.aborts++,
    },
  };
  return { host, log, state, status, bind: (c: CreatureClock) => (clock = c) };
}

function setup(opts?: Parameters<typeof fake2>[0]) {
  const fc = fakeClock();
  const rust = fake2(opts);
  rust.bind(fc.clock);
  const host: Host = {
    moveWindow: () => {},
    world: async () => ({ area: AREA, scale: 1, ledges: [{ id: 42, x: 600, y: 500, w: 500 }] }),
    cursor: () => ({ x: 1200, y: 700 }),
    setHitbox: () => {},
    clicked: () => {},
    chaos: rust.host,
  };
  const view: View = { facingLeft: false, placement: { x: 80, y: 156, angle: 0 }, motion: CALM, platform: null, bodyRect: null, render: () => {} };
  const c = new Creature(host, view, { clock: fc.clock, random: mulberry32(5) });
  return { c, fc, rust };
}

/** Run the fake clock in 100 ms steps until `cond` holds (max `maxMs`). */
async function until(t: { fc: { run(ms: number): Promise<void> } }, cond: () => boolean, maxMs = 15_000): Promise<void> {
  for (let ms = 0; ms < maxMs && !cond(); ms += 100) await t.fc.run(100);
}

const start = (c: Creature): Promise<void> => c.start({ x: 300, y: 1040 - 160 } as Vec);

describe("chaos 2: the hook act, end to end with a fake Rust", () => {
  it("casts, the cursor act runs with his rod tip, he reels meanwhile, then giggles", async () => {
    const t = setup({ hookMs: 4000 });
    await start(t.c);
    expect(await t.c.forceChaos("hook")).toBe(true);
    await until(t, () => t.rust.log.includes("act:hook"));
    await t.fc.run(1500);
    expect(t.rust.log).toContain("act:hook");
    // The rod he sent is a real point above and in front of his feet, not (0, 0).
    const rod = t.rust.state.rods[0];
    expect(rod.y).toBeLessThan(1040 - 20);
    expect(rod.y).toBeGreaterThan(300);
    expect(t.c.animation).toBe("hook_reel");
    await t.fc.run(3500);
    expect(t.c.animation).toBe("virus_giggle");
    expect(t.rust.state.aborts).toBe(0);
    await t.fc.run(8000);
    expect(t.c.plan).toBeNull();
  });

  it("when the user takes the mouse back: startled, a flop, a pout", async () => {
    const t = setup({ abortAt: 2200 });
    await start(t.c);
    await t.c.forceChaos("hook");
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      await t.fc.run(100);
      seen.add(t.c.animation);
    }
    for (const a of ["hook_reel", "startled", "splat", "annoyed"]) expect(seen, a).toContain(a);
    expect(seen).not.toContain("virus_giggle");
  });

  it("switching chaos off or Stop chaos in the middle lets go in Rust at once", async () => {
    const t = setup({ hookMs: 6000 });
    await start(t.c);
    await t.c.forceChaos("hook");
    await until(t, () => t.c.animation === "hook_reel");
    t.c.setChaos(false);
    expect(t.rust.state.aborts).toBe(1);
    expect(t.c.plan).toBeNull();
    // Rust's own stop (tray, Esc, panic) ends the plan too.
    const u = setup({ hookMs: 6000 });
    await start(u.c);
    await u.c.forceChaos("hook");
    await until(u, () => u.c.animation === "hook_reel");
    u.c.stopMischief();
    expect(u.rust.state.aborts).toBe(1);
    expect(u.c.plan).toBeNull();
  });

  it("a refusal from Rust (cooldown, quiet mode...) ends quietly: no giggle, no snap", async () => {
    const t = setup({ refuse: true });
    await start(t.c);
    await t.c.forceChaos("hook");
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      await t.fc.run(100);
      seen.add(t.c.animation);
    }
    expect(seen).not.toContain("virus_giggle");
    expect(seen).not.toContain("splat");
  });
});

describe("chaos 2: the other acts", () => {
  it("the minimise prank: he waits on the taskbar until Rust has put the window back, then celebrates", async () => {
    const t = setup();
    await start(t.c);
    expect(await t.c.forceChaos("yoink")).toBe(true);
    await t.fc.run(3000);
    expect(t.rust.state.yoinked).toBe(1);
    expect(t.c.surface.kind).toBe("floor");
    expect(t.c.animation).toBe("sit");
    const seen = new Set<string>();
    for (let i = 0; i < 160; i++) {
      await t.fc.run(100);
      seen.add(t.c.animation);
    }
    expect(t.rust.state.yoinked).toBe(0);
    expect(seen).toContain("virus_giggle");
  });

  it("a refused minimise does nothing to anything", async () => {
    const t = setup({ refuse: true });
    await start(t.c);
    await t.c.forceChaos("yoink");
    await t.fc.run(8000);
    expect(t.rust.state.yoinked).toBe(0);
  });

  it("popups, effects and dances call Rust once and then stop", async () => {
    const t = setup();
    await start(t.c);
    await t.c.forceChaos("popup:ram");
    await t.fc.run(9000);
    expect(t.rust.state.popups).toEqual(["ram"]);
    await t.c.forceChaos("matrix");
    await t.fc.run(9000);
    expect(t.rust.state.fx).toContain("matrix");
    await t.c.forceChaos("dance:quake");
    await t.fc.run(9000);
    expect(t.rust.log).toContain("dance:42");
  });

  it("the director in Full Virus picks new acts and rests 30-60 s after", async () => {
    const t = setup();
    await start(t.c);
    await t.fc.run(70_000);
    let plan = null;
    for (let i = 0; i < 20 && !plan; i++) plan = await t.c.director!.maybe();
    expect(plan?.name).toBe("mischief");
  });
});

describe("chaos 2: facts about the halves", () => {
  it("HALF is the feet line the rod tip is measured from", () => {
    expect(HALF).toBe(40);
  });
});
