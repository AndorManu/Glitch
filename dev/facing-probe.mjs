// Probe: log every change of facing / family while he climbs and climbs down (corner flips).
// Usage: GLITCH_DEV_URL=... node dev/facing-probe.mjs [seed] [action[@seconds],...]
import { BASE, launch } from "./browser.mjs";

const seed = process.argv[2] ?? "11";
const actions = (process.argv[3] ?? "climb,climbDown").split(",");
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.clock.install({ time: new Date("2026-10-07T09:00:00") });
await page.goto(`${BASE}/dev/stage.html?seed=${seed}&movement=1`);
await page.waitForSelector("body[data-ready='1']", { timeout: 30000 });
const now = await page.evaluate(() => Date.now());
await page.clock.pauseAt(now + 200);
await page.clock.runFor(800);
await page.mouse.move(640, 400);
let last = "";
for (const spec of actions) {
  const [a, secs] = spec.split("@");
  await page.evaluate((n) => window.__stage.do(n), a);
  console.log("== do", a);
  for (let t = 0; t < Number(secs ?? 45) * 20; t++) {
    await page.clock.runFor(50);
    const s = await page.evaluate(() => {
      const c = window.__stage.creature;
      return { left: c.facingLeft, mode: c.mode, surf: c.surface.kind, anim: c.animator.animation, frame: c.animator.pose?.frame, ang: Math.round(c.body.angle), plan: c.plan?.name ?? null };
    });
    const k = `${s.left}|${s.mode}|${s.surf}|${s.anim}`;
    if (k !== last) {
      console.log(`${(t * 50) / 1000}s`, JSON.stringify(s));
      last = k;
    }
  }
}
await browser.close();
