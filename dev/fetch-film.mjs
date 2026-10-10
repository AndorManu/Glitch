// Real-desktop proof of games, play and growth: launches a debug build with its
// own identifier, films the whole screen while a full fetch round runs (ball
// on the invisible overlay, throw, run, catch, trot back, drop, sit and wag, the
// ball popping at the end), audits every window the app owns (no caption, no
// taskbar entry, click-through, no activation), and takes screenshots of hats
// on several animations, the chubby state, hearts on hover and the wardrobe.
//
//   node dev/fetch-film.mjs <glitch.exe> <out-dir>
// Then: python dev/frames-to-gif.py <out-dir>/film <out-dir>/fetch.gif
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const [exe, out = "."] = process.argv.slice(2);
const PORT = 9342;
const ID = "dev.glitch.companion.gamestest";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
mkdirSync(out, { recursive: true });

const conf = path.join(process.env.APPDATA, ID);
mkdirSync(conf, { recursive: true });
const today = new Date().toLocaleDateString("sv");
const now = Math.floor(Date.now() / 1000);
writeFileSync(
  path.join(conf, "settings.json"),
  JSON.stringify({ onboarding_done: true, movement_enabled: true, chaos_enabled: false, memory_enabled: true, voice: { enabled: false }, play: { hat: "wizard", eye: "gold" } }),
);
writeFileSync(path.join(conf, "pet.json"), JSON.stringify({ energy: 90, energy_at: now, xp: 5000, day: today, day_start: now, xp_today: 0, fed_today: 1 }));

const proc = spawn(exe, [], {
  env: { ...process.env, GLITCH_DRY_RUN_ACTIONS: "1", WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: "ignore",
});
let browser;
let film = null;
const page = async (part) => {
  for (let i = 0; i < 60; i++) {
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) if (p.url().includes(part)) return p;
    await sleep(500);
  }
  throw new Error(`no ${part} page`);
};
const audit = () => {
  const raw = execFileSync("python", [path.join(here, "window-audit.py"), String(proc.pid)], { encoding: "utf8" });
  return JSON.parse(raw.trim() || "[]");
};
try {
  for (let i = 0; i < 60 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://localhost:${PORT}`);
    } catch {
      await sleep(500);
    }
  }
  const m = await page("mascot");
  await m.waitForFunction(() => window.__glitch?.creature?.world && window.__glitch.games, null, { timeout: 30000 });
  await sleep(2500);
  const shot = (p, name) => p.screenshot({ path: path.join(out, `${name}.png`), omitBackground: true });
  const g = (fn) => m.evaluate(fn);

  // ---- hats on several animations (the same hat, sitting on his head in each pose)
  for (const anim of ["idle", "walk", "sit", "wave", "happy"]) {
    await g(`(() => { const c = window.__glitch.creature; c.interrupt?.(); c.animator.play(${JSON.stringify(anim)}); })()`);
    await sleep(700);
    await shot(m, `hat-${anim}`);
  }
  // ---- eye colours
  for (const eye of ["magenta", "cyan", "green", "gold"]) {
    await g(`window.__glitch.games.env.acc.eye = ${JSON.stringify(eye)}; window.__glitch.creature.animator.play("idle"); window.__glitch.creature.repaint()`);
    await sleep(900);
    await shot(m, `eye-${eye}`);
  }
  await g(`window.__glitch.games.env.acc.eye = "gold"; window.__glitch.creature.animator.play("idle"); window.__glitch.creature.repaint()`);
  // ---- chubby (fed today) and hearts on hover
  const view = await g(`window.__TAURI_INTERNALS__.invoke("pet_state")`);
  console.log("pet view", JSON.stringify(view));
  await shot(m, "chubby");
  await g(`window.__glitch.games.hover(true)`);
  await sleep(750);
  await shot(m, "hearts-on-hover");
  await g(`window.__glitch.games.hover(false)`);
  await sleep(1800);

  // ---- the film of a whole fetch round on the real desktop
  film = spawn("python", [path.join(here, "screen-film.py"), path.join(out, "film"), "62", "8"], { stdio: "ignore" });
  await sleep(1200);
  await g(`window.__glitch.game("play:fetch")`);
  let mode = "";
  for (let i = 0; i < 40 && mode !== "rest"; i++) {
    await sleep(200);
    mode = await g(`window.__glitch.games.fetch.sim?.mode`);
  }
  await sleep(600);
  let during = audit();
  for (let i = 0; i < 25 && !during.some((w) => w.title === "Glitch play" && w.visible); i++) {
    await sleep(200);
    during = audit();
  }
  writeFileSync(path.join(out, "windows-during-fetch.json"), JSON.stringify(during, null, 1));
  console.log(JSON.stringify(during.filter((w) => w.title === "Glitch play")));
  await g(`(() => { const f = window.__glitch.games.fetch; f.grab(); f.sim.mode = "air"; const u = window.__glitch.creature.world.scale; f.sim.vx = -950 * u; f.sim.vy = -700 * u; f.held = false; f.poke(); f.loop(); f.watch(); })()`).catch(() => {});
  const t0 = Date.now();
  let carried = false;
  while (Date.now() - t0 < 40000) {
    const a = await g(`({ c: window.__glitch.games.env.acc.carrying })`);
    if (a.c) carried = true;
    if (carried && !a.c) break;
    await sleep(150);
  }
  console.log("carried and dropped:", carried);
  await sleep(3500); // sits and wags
  await g(`window.__glitch.games.fetch.end(true)`); // the pop and the bow (the 60 s timer is unit-tested)
  await sleep(4000);
  writeFileSync(path.join(out, "windows-after-fetch.json"), JSON.stringify(audit(), null, 1));
  await new Promise((r) => film.on("exit", r));

  // ---- the wardrobe card
  await g(`window.__TAURI_INTERNALS__.invoke("show_panel", { view: "settings" })`);
  const p = await page("panel");
  await p.waitForSelector(".wardrobe-group", { timeout: 15000 });
  await p.evaluate(() => document.querySelector(".play-feature")?.scrollIntoView());
  await sleep(400);
  await shot(p, "features");
  await p.evaluate(() => document.querySelector(".wardrobe")?.scrollIntoView());
  await sleep(500);
  await shot(p, "wardrobe");
  await p.evaluate(() => window.__TAURI_INTERNALS__.invoke("quit")).catch(() => {});
} catch (e) {
  console.error("FAILED", e);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await sleep(1500);
  try {
    process.kill(proc.pid);
  } catch {
    // already gone
  }
  try {
    film?.kill();
  } catch {
    // done
  }
}
