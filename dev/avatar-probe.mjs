// Does the panel header portrait draw? Usage: GLITCH_DEV_URL=... node dev/avatar-probe.mjs [out.png]
import { BASE, launch } from "./browser.mjs";

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 400, height: 560 }, deviceScaleFactor: 2 });
const msgs = [];
page.on("console", (m) => msgs.push(`${m.type()}: ${m.text()}`));
page.on("pageerror", (e) => msgs.push(`pageerror: ${e.message}`));
await page.addInitScript(() => {
  window.__TAURI_INTERNALS__ = { invoke: async () => ({}), transformCallback: () => 0 };
});
await page.goto(`${BASE}/panel.html`);
await page.waitForTimeout(1500);
const info = await page.evaluate(() => {
  const c = document.querySelector("canvas");
  if (!c) return "no canvas";
  const ctx = c.getContext("2d");
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let opaque = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 10) opaque++;
  return { w: c.width, h: c.height, opaque, total: d.length / 4 };
});
console.log(JSON.stringify(info));
console.log(msgs.slice(0, 8).join("\n"));
if (process.argv[2]) await page.screenshot({ path: process.argv[2] });
await browser.close();
