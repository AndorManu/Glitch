// Visual QA, steps 2 and 3 (keyframe level): plays every animation of
// src/mascot/animations.ts through the real Animator with a fake clock, alone
// (3 seeds) and as an A -> B switch for every pair of animations, and writes
// what was drawn, with timings, to dev/out/vqa/anims.json. dev/vqa-anims.py
// judges it against the frame metrics (dev/vqa-frames.py) and draws strips.
//
//   node dev/vqa-anims.mjs            (no dev server needed: Vite SSR)
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "vite";

mkdirSync("dev/out/vqa", { recursive: true });
const server = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
try {
  const { ANIMATIONS, Animator } = await server.ssrLoadModule("/src/mascot/animations.ts");
  const { mulberry32 } = await server.ssrLoadModule("/src/mascot/glitchfx.ts");
  const { familyOf, mirrorable } = await server.ssrLoadModule("/src/sprites/families.ts");
  const { ANIM_INDEX } = await server.ssrLoadModule("/src/sprites/anim.ts");
  const { ALIASES } = await server.ssrLoadModule("/src/sprites/glitch-anim.ts");
  const names = Object.keys(ANIMATIONS);

  function rig(seed, facingLeft = false) {
    let pending = null;
    let t = 0;
    const drawn = [];
    const clock = { setTimeout: (fn, ms) => (pending = { fn, ms, at: t + ms }), clearTimeout: () => (pending = null) };
    const a = new Animator((pose) => drawn.push({ at: t, anim: a.animation, ...pose, props: pose.props?.map((p) => p.name) }), ANIMATIONS, clock, mulberry32(seed));
    a.mem.facingLeft = facingLeft;
    const run = (ms) => {
      const end = t + ms;
      let guard = 0;
      while (pending && pending.at <= end && guard++ < 2000) {
        const p = pending;
        pending = null;
        t = p.at;
        p.fn();
      }
      t = end;
    };
    return { a, drawn, run, now: () => t };
  }

  const solo = {};
  for (const name of names)
    for (const seed of [1, 2, 3]) {
      const r = rig(seed);
      r.a.play(name);
      r.run(name === "sleep" || name === "fish" ? 22000 : 9000);
      solo[`${name}#${seed}`] = r.drawn;
    }

  // A -> B: play A, let it run 1.2 s (mid-animation), switch to B, record 2.5 s.
  const pairs = {};
  for (const A of names)
    for (const B of names) {
      if (A === B) continue;
      const r = rig(7);
      r.a.play(A);
      r.run(1200);
      const cut = r.drawn.length;
      const before = r.drawn.slice(Math.max(0, cut - 3));
      const t0 = r.now();
      r.a.play(B);
      r.run(2500);
      pairs[`${A}>${B}`] = { t0, keys: [...before, ...r.drawn.slice(cut)] };
    }

  const frames = {};
  const all = new Set([...Object.keys(ANIM_INDEX), ...Object.keys(ALIASES)]);
  for (const f of all) frames[f] = { family: familyOf(f), mirrorable: mirrorable(f), target: ALIASES[f] && !(f in ANIM_INDEX) ? ALIASES[f] : f };
  const used = new Set();
  for (const ks of Object.values(solo)) for (const k of ks) used.add(k.frame);
  writeFileSync("dev/out/vqa/anims.json", JSON.stringify({ names, solo, pairs, frames, unknown: [...used].filter((f) => !all.has(f)) }));
  console.log("animations", names.length, "pairs", Object.keys(pairs).length, "unknown frames", [...used].filter((f) => !all.has(f)));
} finally {
  await server.close();
}
