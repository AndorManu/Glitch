// Probe: does he ever stay on the ceiling/wall for minutes while roaming? (regression check for the
// "stuck on the ceiling" finding in qa-film roam.) Usage: GLITCH_DEV_URL=... node dev/ceiling-probe.mjs [seed]
import { BASE, launch } from "./browser.mjs";

const seed = process.argv[2] ?? "11";
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.clock.install({ time: new Date("2026-10-07T09:00:00") });
await page.goto(`${BASE}/dev/stage.html?seed=${seed}&movement=1`);
await page.waitForSelector("body[data-ready='1']", { timeout: 30000 });
const now = await page.evaluate(() => Date.now());
await page.clock.pauseAt(now + 200);
await page.clock.runFor(800);
await page.mouse.move(5, 5);
let off = 0;
for (let t = 0; t < 300; t++) {
  await page.clock.runFor(1000);
  const s = await page.evaluate(() => {
    const c = window.__stage.creature;
    return { ...window.__stage.state(), asleep: c.asleep, hovered: c.hovered, panel: c.panelOpen, mood: c.mood, press: !!c.press, hold: !!c.hold, hush: c.hush, sulking: c.sulking, brain: c.brainTimer, anim: c.animator.animation };
  });
  if (s.surface !== "floor" && s.surface !== "ledge") off++;
  else off = 0;
  if (off === 40) {
    console.log("STUCK at", t, "s:", JSON.stringify(s));
    break;
  }
}
console.log("done, off-floor streak", off);
await browser.close();
