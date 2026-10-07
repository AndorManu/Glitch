// Animated previews of every mascot animation, timed by the real Animator.
//
//   node dev/anim-export.mjs [ms]      (default 4000 ms per animation)
//   python dev/anim-gifs.py            -> dev/out/anim-<name>.gif + strip-<name>.png
//
// Runs src/mascot/animations.ts through Vite's SSR loader with a fake clock
// and writes the played keys (frame, duration, offsets) to dev/out/anims.json.
import { createServer } from "vite";
import { mkdirSync, writeFileSync } from "node:fs";

const MS = Number(process.argv[2] ?? 4000);
mkdirSync("dev/out", { recursive: true });
const server = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
try {
  const { ANIMATIONS, Animator } = await server.ssrLoadModule("/src/mascot/animations.ts");
  const { mulberry32 } = await server.ssrLoadModule("/src/mascot/glitchfx.ts");
  const out = {};
  for (const name of Object.keys(ANIMATIONS)) {
    let pending = null;
    const clock = { setTimeout: (fn, ms) => (pending = { fn, ms }), clearTimeout: () => (pending = null) };
    const keys = [];
    let t = 0;
    const a = new Animator((pose) => keys.push({ at: t, frame: pose.frame, dx: pose.dx, dy: pose.dy, rot: pose.rot, sx: pose.sx, sy: pose.sy, glitch: pose.glitch, flip: pose.flip }), ANIMATIONS, clock, mulberry32(7));
    a.play(name);
    while (t < MS && pending && keys.length < 400) {
      const p = pending;
      pending = null;
      t += p.ms;
      p.fn();
      // A one-shot that handed over to idle: stop there.
      if (a.animation !== name && !ANIMATIONS[name].next) break;
    }
    // Durations: time until the next drawn key.
    for (let i = 0; i < keys.length; i++) keys[i].ms = (i + 1 < keys.length ? keys[i + 1].at : Math.max(t, keys[i].at + 300)) - keys[i].at;
    out[name] = keys;
  }
  writeFileSync("dev/out/anims.json", JSON.stringify(out));
  console.log("wrote dev/out/anims.json", Object.keys(out).length, "animations");
} finally {
  await server.close();
}
