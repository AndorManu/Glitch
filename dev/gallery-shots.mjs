// Screenshots of every animation strip from dev/gallery.html (one PNG per animation).
// Needs the Vite dev server: npx vite --port 1420 --strictPort
// Usage: node dev/gallery-shots.mjs [outDir] [anim,anim...] [extra query e.g. "left=1&bg=%23fff"]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUT = process.argv[2] ?? join(tmpdir(), "glitch-gallery-shots");
const ONLY = process.argv[3] ? `&strip=${process.argv[3]}` : "";
const EXTRA = process.argv[4] ? `&${process.argv[4]}` : "";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
page.on("console", (m) => m.type() === "error" && console.error("page:", m.text()));
page.on("pageerror", (e) => console.error("page error:", e.message));
await page.goto(`http://localhost:1420/dev/gallery.html?live=0${ONLY}${EXTRA}`);
await page.waitForSelector("body[data-ready='1']");
for (const card of await page.$$(".strips .card")) {
  const name = await card.getAttribute("data-anim");
  await card.screenshot({ path: join(OUT, `strip-${name}${EXTRA.includes("left=1") ? "-left" : ""}.png`) });
  console.log("saved", name);
}
await browser.close();
