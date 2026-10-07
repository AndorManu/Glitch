import { describe, expect, it } from "vitest";
import { NOTE_LINES, noteLine, pickLine } from "../chaos/lines";
import { MAX_PAWS, PAW_LIFE_MS, pawAlpha, prune } from "../chaos/paws";
import type { ChaosStatus, ChaosWindow, PawStamp, ScreenRect } from "../shared/ipc";
import { ANIMATIONS } from "./animations";
import { ACTS, chaosAnim, type ChaosHost, isAct, knockKeys, NOTE_SIZE, planChase, planNote, planPush, planWindowDrag } from "./chaos";
import { Creature, type CreatureClock, type Host, type View } from "./creature";
import { mulberry32 } from "./glitchfx";
import { FLOOR, HALF, type Vec, type World } from "./physics";
import { CALM } from "./render";

const AREA = { x: 0, y: 0, w: 1920, h: 1040 };
const world = (ledges: World["ledges"] = []): World => ({ area: AREA, scale: 1, ledges });
const win = (id: number, frame: ScreenRect): ChaosWindow => ({ id, frame });

describe("chaos: animation fallbacks", () => {
  it("uses the new frame cycles when they exist, else an existing animation", () => {
    const only = (names: string[]) => (n: string) => names.includes(n);
    expect(chaosAnim("push", only(["push", "pushWindow"]))).toBe("push");
    expect(chaosAnim("push", only(["pushWindow"]))).toBe("pushWindow");
    expect(chaosAnim("grab_tab", only(["walk"]))).toBe("walk");
    expect(chaosAnim("chase", only(["run"]))).toBe("run");
    expect(chaosAnim("nonsense", only([]))).toBe("walk");
    // With today's animation table every chaos name resolves to something real.
    for (const n of ["push", "grab_tab", "peek", "chase", "spin", "teleport", "scared", "celebrate", "dance", "sneeze", "dizzy"]) {
      expect(ANIMATIONS[chaosAnim(n)], n).toBeDefined();
    }
  });

  it("knock keys stay above the 20 fps floor and end on the base pose", () => {
    const keys = knockKeys({ frame: "idle0" });
    expect(keys.length).toBeGreaterThan(4);
    for (const k of keys) expect(k.ms).toBeGreaterThanOrEqual(50);
    expect(keys.at(-1)!.sx ?? 1).toBe(1);
  });

  it("knows its acts", () => {
    for (const a of ACTS) expect(isAct(a)).toBe(true);
    expect(isAct("delete_files")).toBe(false);
  });
});

describe("chaos: planning", () => {
  it("drags a window towards the side with more room, never further than the room", () => {
    const w = world([{ id: 7, x: 100, y: 400, w: 600, h: 0 } as unknown as World["ledges"][number]]);
    const pick = planWindowDrag(w, [win(7, { x: 100, y: 400, w: 600, h: 300 })], { x: 300, y: 1000 }, () => 0.99);
    expect(pick?.dir).toBe(1);
    expect(pick!.dist).toBeLessThanOrEqual(1920 - 700);
    // A window not on the eligible list is never picked.
    expect(planWindowDrag(w, [win(8, { x: 100, y: 400, w: 600, h: 300 })], { x: 0, y: 0 }, Math.random)).toBeNull();
    // No room at all: nothing.
    const full = world([{ id: 9, x: 0, y: 400, w: 1920 }]);
    expect(planWindowDrag(full, [win(9, { x: 0, y: 400, w: 1920, h: 300 })], { x: 0, y: 0 }, Math.random)).toBeNull();
  });

  it("pushes only windows that reach down to the taskbar, from the side", () => {
    const low = win(1, { x: 800, y: 700, w: 500, h: 330 }); // bottom at 1030
    const high = win(2, { x: 200, y: 100, w: 500, h: 300 });
    const p = planPush(world(), [high, low], 1700, () => 0.5)!;
    expect(p.win.id).toBe(1);
    expect(p.dir).toBe(-1); // he comes from the right, pushes it left
    expect(p.stand).toBeGreaterThan(1300);
    expect(planPush(world(), [high], 1700, () => 0.5)).toBeNull();
  });

  it("drags the note far enough that it ends fully on screen", () => {
    for (const x of [100, 1800]) {
      const n = planNote(world(), x);
      const end = n.s0 + n.dir * n.dist;
      const left = n.noteX(end);
      expect(left).toBeGreaterThanOrEqual(0);
      expect(left + NOTE_SIZE.w).toBeLessThanOrEqual(1920);
      expect(n.noteY + NOTE_SIZE.h).toBeGreaterThan(1040 - 10); // standing on the taskbar
    }
  });

  it("chases a cursor near his floor, stopping just behind it", () => {
    const w = world();
    const c = planChase(w, FLOOR, 1500, { x: 600, y: 1020 })!;
    expect(c.side).toBe(-1);
    expect(c.to).toBeGreaterThan(600);
    expect(c.to).toBeLessThan(700);
    expect(planChase(w, FLOOR, 1500, { x: 600, y: 200 })).toBeNull(); // too high up
    expect(planChase(w, { kind: "left" }, 500, { x: 600, y: 1020 })).toBeNull();
  });
});

describe("chaos: notes and paw prints", () => {
  it("has about 40+ offline lines, wraps any index, avoids repeats", () => {
    expect(NOTE_LINES.length).toBeGreaterThanOrEqual(40);
    for (const l of NOTE_LINES) expect(l.length).toBeLessThanOrEqual(60);
    expect(noteLine(NOTE_LINES.length)).toBe(NOTE_LINES[0]);
    expect(noteLine(-1)).toBe(NOTE_LINES.at(-1));
    expect(noteLine(Number.NaN)).toBe(NOTE_LINES[0]);
    expect(pickLine(() => 0, 0)).not.toBe(0);
  });

  it("paw prints fade out in steps within their life and the list stays bounded", () => {
    const p = { born: 0 };
    expect(pawAlpha(p, 0)).toBeGreaterThan(0.8);
    expect(pawAlpha(p, PAW_LIFE_MS * 0.7)).toBeLessThan(pawAlpha(p, PAW_LIFE_MS * 0.4));
    expect(pawAlpha(p, PAW_LIFE_MS)).toBe(0);
    const many = Array.from({ length: MAX_PAWS + 50 }, (_, i) => ({ x: i, y: 0, angle: 0, left: true, born: i }));
    expect(prune(many, 100).length).toBe(MAX_PAWS);
    expect(prune(many, PAW_LIFE_MS + 10_000).length).toBe(0);
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

/** Fake Rust: one app window at `frame` (its top is ledge 42). */
function fakeRust(frame: ScreenRect) {
  const log: string[] = [];
  const state = { frame: { ...frame }, grabbed: null as ScreenRect | null, refuseAfter: Infinity, drags: 0, paws: [] as PawStamp[] };
  const status: ChaosStatus = { available: true, enabled: true, blocked: null, idle_ms: 60_000, window_ready: true, cursor_ready: true };
  const host: ChaosHost = {
    status: async () => status,
    windows: async () => [win(42, state.frame)],
    grabWindow: async (id) => {
      log.push(`grab:${id}`);
      state.grabbed = { ...state.frame };
      return state.grabbed;
    },
    dragWindow: async (dx, dy) => {
      if (!state.grabbed || ++state.drags > state.refuseAfter) {
        state.grabbed = null;
        return null;
      }
      // Clamp on screen like Rust does.
      const x = Math.max(AREA.x, Math.min(AREA.x + AREA.w - state.frame.w, state.grabbed.x + dx));
      state.frame.x = Math.round(x);
      state.frame.y = state.grabbed.y + Math.round(dy);
      return { x: state.frame.x - state.grabbed.x, y: state.frame.y - state.grabbed.y };
    },
    releaseWindow: () => {
      log.push("release");
      state.grabbed = null;
    },
    grabCursor: async () => null,
    dragCursor: async () => false,
    releaseCursor: () => log.push("release-cursor"),
    paws: (p) => void state.paws.push(...p),
    noteOpen: async () => ({ w: 210, h: 150 }),
    noteMove: () => {},
    noteIsOpen: async () => false,
  };
  return { host, log, state, status };
}

function setup(frame: ScreenRect) {
  const fc = fakeClock();
  const rust = fakeRust(frame);
  const ledges = () => [{ id: 42, x: rust.state.frame.x, y: rust.state.frame.y, w: rust.state.frame.w }];
  const host: Host = {
    moveWindow: () => {},
    world: async () => ({ area: AREA, scale: 1, ledges: ledges() }),
    cursor: () => ({ x: 10, y: 10 }),
    setHitbox: () => {},
    clicked: () => {},
    chaos: rust.host,
  };
  const view: View = { facingLeft: false, placement: { x: 80, y: 156, angle: 0 }, motion: CALM, platform: null, bodyRect: null, render: () => {} };
  const c = new Creature(host, view, { clock: fc.clock, random: mulberry32(3) });
  return { c, fc, rust };
}

const FRAME = { x: 600, y: 500, w: 500, h: 300 };
const start = (c: Creature): Promise<void> => c.start({ x: 1600, y: 1040 - 160 } as Vec);

describe("chaos: the creature drags a window", () => {
  it("teleports onto it, grabs it, walks backwards and the window slides along; then lets go", async () => {
    const t = setup(FRAME);
    await start(t.c);
    expect(await t.c.forceChaos("window")).toBe(true);
    await t.fc.run(12_000);
    expect(t.rust.log).toContain("grab:42");
    expect(t.rust.log.at(-1)).toBe("release");
    const moved = t.rust.state.frame.x - FRAME.x;
    expect(Math.abs(moved)).toBeGreaterThan(100);
    // Size never changes, stays on screen.
    expect(t.rust.state.frame.w).toBe(FRAME.w);
    expect(t.rust.state.frame.x).toBeGreaterThanOrEqual(0);
    expect(t.rust.state.frame.x + FRAME.w).toBeLessThanOrEqual(1920);
    // He rode along: still on top of it.
    expect(t.c.surface.kind).toBe("ledge");
    expect(t.c.body.y + HALF).toBe(FRAME.y);
    expect(t.c.body.x).toBeGreaterThanOrEqual(t.rust.state.frame.x);
    expect(t.c.body.x).toBeLessThanOrEqual(t.rust.state.frame.x + FRAME.w);
  });

  it("lets go at once when Rust refuses (user input), and when chaos is switched off", async () => {
    const t = setup(FRAME);
    t.rust.state.refuseAfter = 5;
    await start(t.c);
    await t.c.forceChaos("window");
    await t.fc.run(12_000);
    expect(t.rust.state.drags).toBeGreaterThan(5);
    expect(t.rust.state.grabbed).toBeNull();
    expect(t.c.plan?.name).not.toBe("mischief");

    const u = setup(FRAME);
    await start(u.c);
    await u.c.forceChaos("window");
    // Run until the drag is under way, then flip the switch.
    for (let i = 0; i < 100 && u.rust.state.drags < 3; i++) await u.fc.run(100);
    expect(u.rust.state.drags).toBeGreaterThanOrEqual(3);
    u.c.setChaos(false);
    expect(u.rust.log.at(-1)).toBe("release");
    const at = u.rust.state.frame.x;
    await u.fc.run(5000);
    expect(u.rust.state.frame.x).toBe(at);
  });

  it("movement off or the chat opening stops the drag too", async () => {
    for (const stop of [(c: Creature) => c.setMovement(false), (c: Creature) => c.setPanelOpen(true)]) {
      const t = setup(FRAME);
      await start(t.c);
      await t.c.forceChaos("window");
      for (let i = 0; i < 100 && t.rust.state.drags < 3; i++) await t.fc.run(100);
      stop(t.c);
      expect(t.rust.log.at(-1)).toBe("release");
    }
  });

  it("stepping in glitch leaves paw prints while he walks, then stops", async () => {
    const t = setup(FRAME);
    await start(t.c);
    expect(await t.c.forceChaos("paws")).toBe(true);
    await t.fc.run(8000);
    const n = t.rust.state.paws.length;
    expect(n).toBeGreaterThan(5);
    // Alternating feet, on the floor line.
    expect(t.rust.state.paws[0].left).not.toBe(t.rust.state.paws[1].left);
    expect(t.rust.state.paws[0].y).toBe(1040);
    t.c.setChaos(false);
    await t.fc.run(30_000);
    expect(t.rust.state.paws.length).toBe(n);
  });

  it("does nothing without a chaos host, or when Rust says no", async () => {
    const t = setup(FRAME);
    t.rust.status.blocked = "fullscreen";
    await start(t.c);
    // A couple of minutes of life: the director asks Rust before every act and always hears "no".
    await t.fc.run(150_000);
    expect(t.rust.log).toEqual([]);
    expect(await t.c.director!.maybe()).toBeNull();
    // Rust says yes: within a few minutes he gets up to something.
    t.rust.status.blocked = null;
    await t.fc.run(400_000);
    expect(t.rust.log.length + t.rust.state.paws.length).toBeGreaterThan(0);
  });
});
