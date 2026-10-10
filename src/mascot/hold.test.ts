// Held by the cursor: he hangs straight down from the scruff, upright, with
// only a small damped sway, wherever he was grabbed and near screen edges too.

import { describe, expect, it } from "vitest";
import type { Pose } from "./animations";
import { Creature, type Host, type View } from "./creature";
import { mulberry32 } from "./glitchfx";
import type { Vec, World } from "./physics";
import { CALM } from "./render";
import { ANIM_BITES, ANIM_FRAME_H, ANIM_FRAME_W } from "../sprites/anim";
import { ART_SCALE } from "../sprites/glitch-anim";

function fakeClock() {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let id = 1;
  return {
    clock: {
      now: () => now,
      setTimeout: (fn: () => void, ms: number) => {
        timers.set(id, { at: now + ms, fn });
        return id++;
      },
      clearTimeout: (t: unknown) => void timers.delete(t as number),
    },
    async run(ms: number) {
      const end = now + ms;
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | null = null;
        for (const e of timers) if (!next || e[1].at < next[1].at) next = e;
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await Promise.resolve();
      }
      now = end;
    },
  };
}

function setup(world: World, window: Vec) {
  const fc = fakeClock();
  let cursor: Vec = { x: 0, y: 0 };
  let win: Vec = window;
  const host: Host = {
    moveWindow: (x, y) => void (win = { x, y }),
    world: () => Promise.resolve(world),
    cursor: () => Promise.resolve(cursor), // async, like the real app (Rust)
    setHitbox: () => {},
    clicked: () => {},
  } as Host;
  const poses: Pose[] = [];
  const view: View = {
    facingLeft: false,
    placement: { x: 80, y: 156, angle: 0 },
    motion: CALM,
    platform: null,
    bodyRect: { x: 15, y: 70, w: 125, h: 86 },
    render(pose) {
      poses.push(pose);
    },
  } as View;
  const c = new Creature(host, view, { clock: fc.clock, random: mulberry32(3) } as never);
  return { c, fc, view, poses, setCursor: (p: Vec) => (cursor = p), get win() { return win; } };
}

describe("bites the real cursor", () => {
  for (const [label, cx, cy] of [
    ["cursor just above him", 960, 900],
    ["cursor up in the air", 1000, 600],
    ["cursor far away (runs first)", 1500, 880],
  ] as const) {
    it(`puts the drawn mouth on the cursor tip (${label})`, async () => {
      const world: World = { area: { x: 0, y: 0, w: 1920, h: 1040 }, scale: 1, ledges: [] };
      const t = setup(world, { x: 880, y: 1040 - 160 });
      await t.c.start({ x: 880, y: 1040 - 160 });
      await t.fc.run(500);
      t.setCursor({ x: cx, y: cy });
      expect(t.c.biteCursor()).toBe(true);
      const errs: number[] = [];
      for (let i = 0; i < 200; i++) {
        await t.fc.run(20);
        const f = t.c.animator.pose?.frame ?? "";
        const g = ANIM_BITES[f];
        // Chomp and shake frames, after the lunge has landed him on it.
        if (!g || !["bite_cursor2", "bite_cursor3", "bite_cursor4"].includes(f) || t.c.mode !== "held") continue;
        const p = t.view.placement;
        const mouth = { x: t.win.x + p.x + (g[0] - ANIM_FRAME_W / 2) * ART_SCALE, y: t.win.y + p.y + (g[1] - ANIM_FRAME_H) * ART_SCALE };
        errs.push(Math.hypot(mouth.x - cx, mouth.y - cy));
      }
      console.info(`${label}: ${errs.length} bite samples, mouth to cursor tip max ${Math.max(...errs).toFixed(2)} px`);
      expect(errs.length).toBeGreaterThan(5);
      expect(Math.max(...errs)).toBeLessThanOrEqual(2);
      await t.fc.run(4000);
      expect(t.c.mode).toBe("stand"); // let go, landed
      t.c.dispose();
    });
  }
});

describe("annoyed: clings on to the cursor", () => {
  it("after a few pickups a gentle drop makes him hang on by the drawn grip, then let go", async () => {
    const world: World = { area: { x: 0, y: 0, w: 1920, h: 1040 }, scale: 1, ledges: [] };
    const t = setup(world, { x: 900, y: 1040 - 160 });
    await t.c.start({ x: 900, y: 1040 - 160 });
    await t.fc.run(500);
    let anims: string[] = [];
    for (let n = 0; n < 3; n++) {
      await t.fc.run(4000); // landed again
      const local = { x: 80, y: 110 };
      const grab = { x: t.win.x + local.x, y: t.win.y + local.y };
      t.setCursor(grab);
      t.c.pointerDown(local);
      t.c.pointerMove({ x: 80, y: 100 });
      for (let i = 1; i <= 10; i++) {
        t.setCursor({ x: grab.x, y: grab.y - i * 4 });
        await t.fc.run(30);
      }
      await t.fc.run(500);
      anims = [];
      t.c.animator.onChange = (a) => anims.push(a);
      t.c.pointerUp();
      await t.fc.run(200);
      if (anims.includes("clingCursor")) {
        expect(t.c.held).toBe(true); // still hanging on
        const cur = { x: grab.x, y: grab.y - 40 };
        // The body centre sits the drawn grip offset below the cursor: hanging under it.
        expect(t.c.body.y).toBeGreaterThan(cur.y);
        expect(Math.abs(t.c.body.x - cur.x)).toBeLessThan(40);
        await t.fc.run(1500);
        expect(t.c.held).toBe(false); // let go
        t.c.dispose();
        return;
      }
    }
    throw new Error(`never clung on (last: ${anims.join(",")}, annoyance ${t.c.annoyance.toFixed(2)})`);
  });
});

describe("held by the cursor", () => {
  for (const [where, x] of [
    ["near the right edge", 1880],
    ["in the middle", 960],
  ] as const) {
    it(`hangs upright from the scruff (${where})`, async () => {
      const world: World = { area: { x: 0, y: 0, w: 1920, h: 1040 }, scale: 1, ledges: [] };
      const t = setup(world, { x: x - 80, y: 1040 - 160 });
      await t.c.start({ x: x - 80, y: 1040 - 160 });
      await t.fc.run(500);
      // Mouse down near the bottom-right of his body, then up ~70 px in small steps, then still.
      const local = { x: 120, y: 140 };
      const grab = { x: t.win.x + local.x, y: t.win.y + local.y };
      t.setCursor(grab);
      t.c.pointerDown(local);
      t.c.pointerMove({ x: local.x, y: local.y - 8 });
      expect(t.c.mode).toBe("held");
      for (let i = 1; i <= 14; i++) {
        t.setCursor({ x: grab.x, y: grab.y - i * 5 });
        await t.fc.run(30);
      }
      const angles: number[] = [];
      for (let i = 0; i < 40; i++) {
        await t.fc.run(50);
        angles.push(t.view.placement.angle);
      }
      const rot = t.poses.slice(-20).map((p) => p.rot);
      console.info(`${where}: body angle while held ${Math.min(...angles).toFixed(1)}..${Math.max(...angles).toFixed(1)} deg, pose rot ${Math.min(...rot)}..${Math.max(...rot)}`);
      for (const a of angles) expect(Math.abs(a)).toBeLessThanOrEqual(9.5);
      for (const r of rot) expect(Math.abs(r)).toBeLessThanOrEqual(1);
      // Settled: nearly still and straight down.
      expect(Math.abs(angles[angles.length - 1])).toBeLessThan(3);
      t.c.pointerUp();
      t.c.dispose();
    });
  }
});
