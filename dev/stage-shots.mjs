// Films Glitch living on the fake desktop of dev/stage.html (real creature,
// physics, brain, renderer). Saves contact sheets (PNG) per scenario.
// Needs the Vite dev server: npx vite --port 1420 --strictPort
// Usage: node dev/stage-shots.mjs [outDir] [scenario,scenario...]
// Scenarios: auto overview climb corner jump throw drag splat teleport build
//            sit (+ peek, hop) malfunction listen ride (+ window closed) run
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUT = process.argv[2] ?? join(tmpdir(), "glitch-stage-shots");
const ONLY = process.argv[3]?.split(",");
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium" });

async function fresh(query = "") {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.error("page error:", e.message));
  page.on("console", (m) => m.type() === "error" && !m.text().includes("404") && console.error("page:", m.text()));
  page.on("framenavigated", (f) => process.env.DEBUG && console.log("navigated", f.url()));
  await page.goto(`http://localhost:1420/dev/stage.html?debug=1${query.includes("seed=") ? "" : "&seed=7"}${query}`);
  await page.waitForSelector("body[data-ready='1']");
  await page.waitForTimeout(600);
  return page;
}

async function save(page, name, filmOpts) {
  const url = await page.evaluate((o) => window.__stage.film(o), filmOpts);
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(url.split(",")[1], "base64"));
  const st = await page.evaluate(() => window.__stage.state());
  console.log("saved", name, JSON.stringify({ mode: st.mode, surface: st.surface, anim: st.anim }), st.log.slice(-4).join(" | "));
}

const doIt = (page, name) => page.evaluate((n) => window.__stage.do(n), name);
const center = (page) => page.evaluate(() => ({ x: window.__stage.win.x + 80, y: window.__stage.win.y + 80, hb: window.__stage.hitbox }));

const scenarios = {
  /** Nothing forced: 90 s of his own life. */
  async auto() {
    const page = await fresh("&seed=11");
    await save(page, "auto-full", { ms: 90000, every: 1500, mode: "full", tile: 320, cols: 6 });
    console.log(JSON.stringify((await page.evaluate(() => window.__stage.state())).log));
    await page.close();
  },
  async overview() {
    const page = await fresh();
    await page.screenshot({ path: join(OUT, "overview.png") });
    console.log("saved overview");
    await page.close();
  },
  async climb() {
    const page = await fresh();
    // Force the "grand tour"-ish plans until one ends up on the ceiling.
    await doIt(page, "climb");
    await save(page, "climb-full", { ms: 22000, every: 700, mode: "full", tile: 480, cols: 4 });
    await page.close();
  },
  async corner() {
    const page = await fresh();
    await doIt(page, "climb");
    await save(page, "climb-zoom", { ms: 9000, every: 180, mode: "follow", size: 260, tile: 180, cols: 10 });
    await page.close();
  },
  async jump() {
    const page = await fresh();
    await doIt(page, "jump");
    await save(page, "jump-zoom", { ms: 4200, every: 70, mode: "follow", size: 300, tile: 160, cols: 12 });
    await doIt(page, "jump");
    await save(page, "jump-full", { ms: 6000, every: 250, mode: "full", tile: 480, cols: 4 });
    await page.close();
  },
  async throw() {
    const page = await fresh();
    const c = await center(page);
    const hb = c.hb;
    const gx = (await page.evaluate(() => window.__stage.win.x)) + hb.x + hb.w / 2;
    const gy = (await page.evaluate(() => window.__stage.win.y)) + hb.y + hb.h * 0.3;
    await page.mouse.move(gx, gy);
    await page.mouse.down();
    // Carry him up and to the left, swinging, then fling him right and up.
    const film = page.evaluate(() => window.__stage.film({ ms: 4200, every: 60, mode: "full", tile: 320, cols: 10 }));
    for (let i = 0; i <= 30; i++) {
      await page.mouse.move(gx - i * 18, gy - i * 12);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(500);
    for (let i = 0; i <= 8; i++) {
      await page.mouse.move(gx - 540 + i * 70, gy - 360 - i * 20);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
    const url = await film;
    writeFileSync(join(OUT, "throw-full.png"), Buffer.from(url.split(",")[1], "base64"));
    console.log("saved throw-full", JSON.stringify(await page.evaluate(() => window.__stage.state())));
    await page.close();
  },
  async drag() {
    const page = await fresh();
    const w = await page.evaluate(() => window.__stage.win);
    const hb = await page.evaluate(() => window.__stage.hitbox);
    const gx = w.x + hb.x + hb.w / 2;
    const gy = w.y + hb.y + hb.h * 0.25;
    await page.mouse.move(gx, gy);
    await page.mouse.down();
    const film = page.evaluate(() => window.__stage.film({ ms: 2600, every: 65, mode: "follow", size: 260, tile: 170, cols: 10 }));
    for (let i = 0; i <= 20; i++) {
      await page.mouse.move(gx - i * 22, gy - i * 8);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(500);
    for (let i = 0; i <= 20; i++) {
      await page.mouse.move(gx - 440 + i * 26, gy - 160);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(700);
    const url = await film;
    await page.mouse.up();
    writeFileSync(join(OUT, "drag-zoom.png"), Buffer.from(url.split(",")[1], "base64"));
    console.log("saved drag-zoom");
    await page.close();
  },
  async splat() {
    const page = await fresh();
    const w = await page.evaluate(() => window.__stage.win);
    const hb = await page.evaluate(() => window.__stage.hitbox);
    const gx = w.x + hb.x + hb.w / 2;
    const gy = w.y + hb.y + hb.h * 0.3;
    await page.mouse.move(gx, gy);
    await page.mouse.down();
    for (let i = 0; i <= 25; i++) {
      await page.mouse.move(gx - 300, gy - i * 22);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(600);
    // Slam him down.
    const film = page.evaluate(() => window.__stage.film({ ms: 2600, every: 55, mode: "follow", size: 300, tile: 170, cols: 10 }));
    for (let i = 0; i <= 5; i++) {
      await page.mouse.move(gx - 300, gy - 550 + i * 80);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
    const url = await film;
    writeFileSync(join(OUT, "splat-zoom.png"), Buffer.from(url.split(",")[1], "base64"));
    console.log("saved splat-zoom", JSON.stringify((await page.evaluate(() => window.__stage.state())).log));
    await page.close();
  },
  async teleport() {
    const page = await fresh();
    await doIt(page, "teleport");
    await save(page, "teleport-full", { ms: 2600, every: 120, mode: "full", tile: 480, cols: 4 });
    await page.close();
  },
  async build() {
    const page = await fresh("&nowin=1");
    await doIt(page, "build");
    await save(page, "build-zoom", { ms: 9000, every: 150, mode: "follow", size: 320, tile: 170, cols: 10 });
    await page.close();
  },
  async sit() {
    const page = await fresh();
    await doIt(page, "jump");
    await page.waitForTimeout(4000);
    console.log("sit:", await doIt(page, "sitEdge"));
    await save(page, "sit-zoom", { ms: 6000, every: 400, mode: "follow", size: 300, tile: 200, cols: 8 });
    console.log("peek:", await doIt(page, "peekEdge"));
    await save(page, "peek-zoom", { ms: 6000, every: 200, mode: "follow", size: 300, tile: 170, cols: 10 });
    console.log("hop:", await doIt(page, "hopDown"));
    await save(page, "hop-full", { ms: 6000, every: 300, mode: "full", tile: 480, cols: 4 });
    await page.close();
  },
  async malfunction() {
    const page = await fresh();
    await doIt(page, "malfunction");
    await save(page, "malfunction-zoom", { ms: 1200, every: 50, mode: "follow", size: 240, tile: 160, cols: 12 });
    await page.close();
  },
  async listen() {
    const page = await fresh();
    await page.evaluate(() => window.__stage.mood("listening"));
    await save(page, "listen-zoom", { ms: 1600, every: 100, mode: "follow", size: 240, tile: 160, cols: 8 });
    await page.close();
  },
  async ride() {
    const page = await fresh();
    await doIt(page, "jump");
    await page.waitForTimeout(4000);
    const st = await page.evaluate(() => window.__stage.state());
    const id = await page.evaluate(() => window.__stage.creature.surface.ledge?.id);
    console.log("on", st.surface, id);
    if (id) {
      await page.evaluate((i) => window.__stage.moveWin(i, 120, -40), id);
      await page.waitForTimeout(3000);
      console.log("after move:", JSON.stringify(await page.evaluate(() => window.__stage.state())));
      await page.evaluate((i) => window.__stage.closeWin(i), id);
      await save(page, "gone-full", { ms: 4000, every: 200, mode: "full", tile: 480, cols: 4 });
    }
    await page.close();
  },
  async run() {
    const page = await fresh("&nowin=1");
    await doIt(page, "run");
    await save(page, "run-zoom", { ms: 1500, every: 55, mode: "follow", size: 240, tile: 160, cols: 12 });
    await page.close();
  },
};

for (const [name, fn] of Object.entries(scenarios)) {
  if (ONLY && !ONLY.includes(name)) continue;
  try {
    await fn();
  } catch (e) {
    console.error(name, "failed:", e.message);
  }
}
await browser.close();
