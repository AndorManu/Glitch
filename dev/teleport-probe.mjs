// Probe: the frames shown around a teleport that lands on a wall / the ceiling (family cut check).
// Usage: GLITCH_DEV_URL=... node dev/teleport-probe.mjs [seed] [tries]
import { BASE, launch } from "./browser.mjs";

const seed = process.argv[2] ?? "11";
const tries = Number(process.argv[3] ?? 25);
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.clock.install({ time: new Date("2026-10-07T09:00:00") });
await page.goto(`${BASE}/dev/stage.html?seed=${seed}&movement=0`);
await page.waitForSelector("body[data-ready='1']", { timeout: 30000 });
const now = await page.evaluate(() => Date.now());
await page.clock.pauseAt(now + 200);
await page.clock.runFor(800);
await page.mouse.move(640, 400);
const st = () => page.evaluate(() => ({ surf: window.__stage.creature.surface.kind, frame: window.__stage.creature.animator.pose?.frame, anim: window.__stage.creature.animator.animation, left: window.__stage.creature.facingLeft }));
let found = 0;
for (let i = 0; i < tries && found < 3; i++) {
  await page.evaluate(() => window.__stage.do("teleport"));
  const seq = [];
  let landed = null;
  for (let t = 0; t < 90; t++) {
    await page.clock.runFor(50);
    const s = await st();
    seq.push(`${s.anim}:${s.frame}${s.left ? "L" : "R"}`);
    if (!landed && s.anim === "glitchIn") landed = s.surf;
  }
  const s = await st();
  if (landed && landed !== "floor" && landed !== "ledge") {
    found++;
    const compact = seq.filter((x, i) => x !== seq[i - 1]);
    console.log(`teleport -> ${landed}:`, compact.join(" "));
  }
  if (s.surf !== "floor") await page.evaluate(() => window.__stage.creature.playAction("drop"));
  await page.clock.runFor(3000);
}
console.log("found", found);
await browser.close();
