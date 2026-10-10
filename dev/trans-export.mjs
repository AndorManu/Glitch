// Every junction between animations, for the continuity audit
// (python dev/audit-transitions.py): each transition clip variant between
// its two families, the drawn turns, walk start/stop, every idle fidget, the
// end of every one-shot into what follows and the seam of every loop.
//
//   node dev/trans-export.mjs   -> dev/out/transitions.json
import { createServer } from "vite";
import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync("dev/out", { recursive: true });
const server = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
try {
  const T = await server.ssrLoadModule("/src/mascot/transitions.ts");
  const A = await server.ssrLoadModule("/src/mascot/animations.ts");
  const { mulberry32 } = await server.ssrLoadModule("/src/mascot/glitchfx.ts");
  const rand = mulberry32(11);
  // What is on screen in each family when a transition starts / where it lands.
  const REP = { front: "idle0", side: "walk0", sit: "sit0", curled: "sleep0", back: "turn_to_back5", wall: "climb0" };
  const strip = (keys) => keys.map((k) => ({ frame: k.frame, ms: k.ms, flip: !!k.flip, dx: k.dx ?? 0, dy: k.dy ?? 0 }));
  const out = [];
  const add = (name, from, keys, to) => out.push({ name, keys: [{ frame: from, ms: 300, flip: false, dx: 0, dy: 0 }, ...strip(keys), { frame: to, ms: 400, flip: false, dx: 0, dy: 0 }] });

  for (const [edge, variants] of Object.entries(T.edges())) {
    const [a, b] = edge.split(">");
    for (const v of variants) add(`${a}-${b}-${v.id}`, REP[a], v.keys(rand), REP[b]);
  }
  // Turning round (the renderer mirrors: keys with flip show the old facing).
  const F = await server.ssrLoadModule("/src/sprites/families.ts");
  for (const fam of ["side"]) {
    for (const toLeft of [true, false]) {
      add(`turn-${fam}-${toLeft ? "to-left" : "to-right"}`, REP[fam], T.turnKeys(fam, toLeft, REP[fam]), REP[fam]);
      // On screen: mirrored = mirrorable && (facing left XOR flip); the first key still shows the old facing.
      const seq = out[out.length - 1].keys;
      seq.forEach((k, i) => (k.mirror = F.mirrorable(k.frame) && (i === 0 ? !toLeft : toLeft !== k.flip)));
    }
  }
  // Walking off and stopping.
  const walk = A.ANIMATIONS.walk;
  add("walk-start", "idle0", walk.intro(rand, { fromFrame: "idle0" }), "walk0");
  add("walk-stop", "walk7", walk.outro(rand, { next: "idle" }), "turn_side_to_front0");
  // Idle fidgets: from and back to standing.
  for (const f of A.FIDGETS) {
    const keys = f.make(rand, {});
    if (keys && keys.length) add(`fidget-${f.id}`, "idle0", keys, "idle0");
  }
  // One-shots and loops: how they begin and end.
  for (const [name, anim] of Object.entries(A.ANIMATIONS)) {
    const keys = typeof anim.keys === "function" ? anim.keys(rand, {}) : anim.keys;
    if (!keys.length) continue;
    const startFam = T.familyOf(keys[0].frame);
    if (anim.once) {
      const next = A.ANIMATIONS[anim.next ?? "idle"];
      const nk = typeof next.keys === "function" ? next.keys(rand, {}) : next.keys;
      add(`anim-${name}-end`, keys.length > 3 ? keys[keys.length - 3].frame : keys[0].frame, keys.slice(-2), nk[0].frame);
    } else if (keys.length > 1) {
      add(`loop-${name}-seam`, keys[keys.length - 2].frame, [keys[keys.length - 1]], keys[0].frame);
    }
    if (startFam !== "any" && REP[startFam] && anim.bridge !== false) add(`anim-${name}-start`, REP[startFam], [], keys[0].frame);
  }
  writeFileSync("dev/out/transitions.json", JSON.stringify(out, null, 1));
  console.log("wrote dev/out/transitions.json", out.length, "junction sequences");
} finally {
  await server.close();
}
