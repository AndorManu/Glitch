#!/usr/bin/env node
// Real-app check of the panic button, its hotkey, the Safety card and
// "Start with Windows" (Windows). Build a copy with its own identifier so it
// has its own settings folder and never meets an installed or running Glitch:
//
//   npx tauri build --debug --no-bundle --config '{"identifier":"dev.glitch.pause.qa","productName":"GlitchPauseQA"}'
//   node dev/panic-check.mjs <target>/debug/glitch.exe [out-dir]
//
// What it does (all on its own copy; chaos and wandering are off, so nothing
// of anybody else's is touched):
// - starts the copy with a fresh profile and takes a small screen shot of the
//   region around Glitch (never the whole screen);
// - presses the real hotkey Ctrl+Alt+Shift+G (after asking the app that it
//   owns it): Glitch's windows must be hidden, settings.json says paused, a
//   click on him opens no chat; a second press brings him back;
// - restarts the copy while paused: it must stay hidden;
// - changes the hotkey (accepts a good one, refuses bad ones and keeps the old);
// - turns "Start with Windows" on and off against a scratch registry key
//   (GLITCH_AUTOSTART_KEY), never the real Run key;
// - screenshots the Safety card in each state.
// Exits 1 on any failure.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const [exe, outArg] = process.argv.slice(2);
if (!exe || !existsSync(exe)) {
  console.error("usage: node dev/panic-check.mjs <glitch.exe built with its own identifier> [out-dir]");
  process.exit(2);
}
const OUT = path.resolve(outArg ?? "dev/out/panic");
mkdirSync(OUT, { recursive: true });
const ID = "dev.glitch.pause.qa";
const APPDIR = path.join(process.env.APPDATA ?? "", ID);
const PORT = 9251;
const SCRATCH_KEY = "Software\\GlitchPauseQA\\Run";
const VALUE_NAME = `Glitch (${ID})`;
if (ID === "dev.glitch.companion") process.exit(2);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const ps = (file, ...args) =>
  spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file, ...args], { encoding: "utf8", timeout: 30000 }).stdout ?? "";
const settingsFile = () => JSON.parse(readFileSync(path.join(APPDIR, "settings.json"), "utf8"));
const reg = (...a) => spawnSync("reg", a, { encoding: "utf8" });

let proc = null;
let browser = null;
const procs = [];
async function launch(extraEnv = {}) {
  const env = {
    ...process.env,
    GLITCH_DRY_RUN_ACTIONS: "1",
    GLITCH_AUTOSTART_KEY: SCRATCH_KEY,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    ...extraEnv,
  };
  proc = spawn(exe, [], { env, stdio: ["ignore", "ignore", "pipe"] });
  procs.push(proc);
  let log = "";
  proc.stderr.on("data", (d) => (log += d));
  proc.log = () => log;
  browser = null;
  for (let i = 0; i < 80 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://localhost:${PORT}`);
    } catch {
      await sleep(500);
    }
  }
  if (!browser) throw new Error("could not connect to the app");
  await page("mascot");
}
async function quit() {
  await browser?.close().catch(() => {});
  if (proc) spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  await sleep(1200);
}
async function page(part, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) if (p.url().includes(part)) return p;
    await sleep(300);
  }
  throw new Error(`no ${part} page`);
}
const invoke = (p, cmd, args = {}) => p.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
const invokeErr = (p, cmd, args = {}) =>
  p.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a).then(() => null, (e) => e), [cmd, args]);
const windows = () => ps("dev/win-visible.ps1", "-ProcessId", String(proc.pid)).split(/\r?\n/).filter(Boolean);
let dpr = 1;
const parsed = () =>
  windows().map((l) => {
    const m = /^(\d+) (visible|hidden) (\d+)x(\d+) (.+?) ([T-][A-][N-]) (.*)$/.exec(l) ?? [];
    return { visible: m[2] === "visible", w: Number(m[3]), h: Number(m[4]), cls: m[5], flags: m[6], title: m[7] ?? "" };
  });
// Glitch's own window is the square one (160 CSS px); the chat bubble is 300 CSS px wide; the banner has its own title.
const mascotVisible = () => parsed().some((x) => x.visible && Math.abs(x.w - 160 * dpr) <= 2 && Math.abs(x.h - 160 * dpr) <= 2);
const bubbleVisible = () => parsed().some((x) => x.visible && x.title === "Glitch" && Math.abs(x.w - 300 * dpr) <= 2);
const bannerVisible = () => parsed().some((x) => x.visible && x.title === "Glitch is driving");

/** Stand him well away from where an installed Glitch usually stands (bottom right), so the screen shots show only this copy. */
async function standAside(mascot) {
  await mascot.waitForFunction(() => window.__glitch?.creature?.world, null, { timeout: 40000 });
  await mascot.evaluate(() => {
    const c = window.__glitch.creature;
    const x = c.world.area.x + 260;
    c.body.x = x;
    c.s = x;
    c.place();
  });
  await sleep(1200);
}

async function shotAround(mascot, name) {
  const r = await mascot.evaluate(() => {
    const c = window.__glitch.creature;
    return { x: c.win.x, y: c.win.y, dpr: devicePixelRatio, size: 160 };
  });
  const s = Math.round(r.size * r.dpr);
  const pad = 30;
  const file = path.join(OUT, name);
  spawnSync("python", ["dev/panic-shot.py", file, String(Math.max(0, r.x - pad)), String(Math.max(0, r.y - pad)), String(s + pad * 2), String(s + pad * 2)], { stdio: "inherit" });
  return file;
}
async function cardShot(panel, name) {
  await panel.evaluate(() => document.querySelector(".safety-feature")?.scrollIntoView({ block: "center" }));
  await sleep(500);
  await panel.screenshot({ path: path.join(OUT, name) });
}

async function cleanup() {
  await quit().catch(() => {});
  for (const p of procs) spawnSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" });
  reg("delete", "HKCU\\Software\\GlitchPauseQA", "/f");
  rmSync(APPDIR, { recursive: true, force: true });
}
process.on("SIGINT", () => void cleanup().then(() => process.exit(130)));

try {
  rmSync(APPDIR, { recursive: true, force: true });
  mkdirSync(APPDIR, { recursive: true });
  reg("delete", "HKCU\\Software\\GlitchPauseQA", "/f");
  writeFileSync(
    path.join(APPDIR, "settings.json"),
    JSON.stringify({
      onboarding_done: true,
      movement_enabled: false,
      chaos_enabled: false,
      memory_enabled: false,
      voice: { enabled: false },
      auto_update: { auto_check: false },
      update_me: { endpoint_enabled: false },
    }),
  );
  await launch();
  let mascot = await page("mascot");
  await mascot.waitForFunction(() => window.__glitch?.creature?.world, null, { timeout: 40000 });
  await sleep(2500);
  dpr = await mascot.evaluate(() => devicePixelRatio);
  await standAside(mascot);

  // ------------------------------------------------------ before: he is there
  check("Glitch's window is on screen at the start", mascotVisible(), windows().join(" | "));
  await shotAround(mascot, "1-before-visible.png");

  await invoke(mascot, "show_panel", { view: "settings" });
  let panel = await page("panel");
  await panel.waitForSelector(".safety-feature input[role=switch], .safety-feature input[readonly]", { timeout: 20000 });
  let st = await invoke(panel, "safety_status");
  check("the hotkey is registered by the app", st.hotkey.registered === true && st.hotkey.combo === "Ctrl+Alt+Shift+G", JSON.stringify(st.hotkey));
  check("not paused at the start", st.paused === false);
  await cardShot(panel, "2-card-active.png");

  // ------------------------------- the pet's windows are not taskbar / Alt+Tab entries
  await invoke(mascot, "mascot_clicked").catch(() => {});
  await sleep(1500);
  const pets = parsed().filter((x) => x.visible && !(x.w >= 380 && x.h >= 500) && x.w >= 100);
  check("the mascot and the chat bubble are both on screen for this check", pets.length >= 2, JSON.stringify(pets.map((x) => [x.w, x.h, x.flags])));
  check("every pet window is a tool window without WS_EX_APPWINDOW", pets.every((x) => x.flags[0] === "T" && x.flags[1] === "-"), pets.map((x) => `${x.w}x${x.h}:${x.flags}`).join(" "));
  const strip = path.join(OUT, "8-taskbar.png");
  spawnSync("python", ["dev/panic-shot.py", strip, "0", String(Math.round(1080 * 0 + (await mascot.evaluate(() => screen.height * devicePixelRatio)) - 80)), String(Math.round(await mascot.evaluate(() => screen.width * devicePixelRatio))), "80"], { stdio: "inherit" });
  await invoke(mascot, "mascot_clicked").catch(() => {});
  await sleep(800);

  // ---------------------------------------------------- the real hotkey: hide
  if (!st.hotkey.registered) throw new Error("the hotkey is not registered: not sending keys");
  // Park the panel so the keys can't land in its field (the app owns the chord, but be safe).
  ps("dev/keys.ps1", "-Chord", "ctrl+alt+shift+g");
  await sleep(1500);
  st = await invoke(panel, "safety_status");
  check("the hotkey paused Glitch", st.paused === true);
  check("the mascot window is hidden", !mascotVisible(), windows().join(" | "));
  check("settings.json remembers it", settingsFile().safety?.paused === true);
  await shotAround(mascot, "3-after-hidden.png");
  check("no bubble or banner is on screen", !bubbleVisible() && !bannerVisible(), windows().join(" | "));
  await invoke(mascot, "mascot_clicked").catch(() => {});
  await sleep(1200);
  check("a click on him opens no chat while paused", !bubbleVisible(), windows().join(" | "));
  await panel.waitForFunction(() => document.querySelector(".safety-feature")?.innerText.includes("Paused"), null, { timeout: 10000 }).catch(() => {});
  check("the card says paused and offers Show Glitch", await panel.evaluate(() => /Paused/.test(document.querySelector(".safety-feature")?.innerText ?? "") && /Show Glitch/.test(document.querySelector(".safety-feature")?.innerText ?? "")));
  await cardShot(panel, "4-card-paused.png");

  // -------------------------------------------------- a restart stays paused
  await quit();
  await launch();
  mascot = await page("mascot");
  await mascot.waitForFunction(() => window.__glitch?.creature?.world, null, { timeout: 40000 });
  await sleep(4000);
  await standAside(mascot);
  check("after a restart he is still hidden", !mascotVisible(), windows().join(" | "));
  await invoke(mascot, "show_panel", { view: "settings" });
  panel = await page("panel");
  await panel.waitForSelector(".safety-feature input[readonly]", { timeout: 20000 });
  st = await invoke(panel, "safety_status");
  check("and the app knows it is paused", st.paused === true && st.hotkey.registered === true);

  // ----------------------------------------------------- the hotkey: back
  ps("dev/keys.ps1", "-Chord", "ctrl+alt+shift+g");
  await sleep(1500);
  st = await invoke(panel, "safety_status");
  check("the hotkey brings him back", st.paused === false && mascotVisible(), windows().join(" | "));
  check("settings.json no longer says paused", settingsFile().safety?.paused === false);
  await sleep(800);
  await shotAround(mascot, "5-back-visible.png");

  // ----------------------------------------------------------- hotkey change
  const bad = {
    "ctrl+g": "at least two modifiers",
    "Ctrl+Alt+Delete": "belongs to",
    "ctrl+shift+space": "push-to-talk",
    "banana": "isn't a key",
  };
  for (const [combo, why] of Object.entries(bad)) {
    const e = await invokeErr(panel, "safety_set_hotkey", { combo });
    check(`refuses ${combo}`, !!e && e.message.toLowerCase().includes(why.toLowerCase()), e?.message ?? "accepted");
  }
  check("the old hotkey stayed", (await invoke(panel, "safety_status")).hotkey.combo === "Ctrl+Alt+Shift+G");
  const changed = await invoke(panel, "safety_set_hotkey", { combo: "alt + ctrl + shift + h" });
  check("accepts and normalises a new one", changed.hotkey.combo === "Ctrl+Alt+Shift+H" && changed.hotkey.registered, JSON.stringify(changed.hotkey));
  check("it is saved", settingsFile().safety?.panic_hotkey === "Ctrl+Alt+Shift+H");
  ps("dev/keys.ps1", "-Chord", "ctrl+alt+shift+h");
  await sleep(1500);
  check("the new hotkey works", (await invoke(panel, "safety_status")).paused === true && !mascotVisible());
  ps("dev/keys.ps1", "-Chord", "ctrl+alt+shift+g");
  await sleep(1000);
  check("the old one no longer does anything", (await invoke(panel, "safety_status")).paused === true);
  await invoke(panel, "safety_set_paused", { paused: false });
  await sleep(1200);
  check("Show Glitch in Settings brings him back", mascotVisible());
  await panel.reload();
  await panel.waitForSelector(".safety-feature input[readonly]", { timeout: 20000 });
  await cardShot(panel, "6-card-new-hotkey.png");
  await invoke(panel, "safety_set_hotkey", { combo: "Ctrl+Alt+Shift+G" });

  // ------------------------------------------------------ Start with Windows
  const queryValue = () => reg("query", `HKCU\\${SCRATCH_KEY}`, "/v", VALUE_NAME);
  check("off by default: no registry entry", queryValue().status !== 0);
  st = await invoke(panel, "safety_set_autostart", { enabled: true });
  const q = queryValue();
  check("turning it on writes the entry (scratch key)", q.status === 0 && q.stdout.toLowerCase().includes(path.resolve(exe).toLowerCase()), q.stdout.trim().split(/\r?\n/).pop());
  check("the status says active", st.start_with_windows === true && st.autostart_active === true);
  check("the real Run key got nothing", reg("query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", VALUE_NAME).status !== 0);
  await panel.reload();
  await panel.waitForSelector(".safety-feature input[role=switch]", { timeout: 20000 });
  await cardShot(panel, "7-card-autostart-on.png");
  st = await invoke(panel, "safety_set_autostart", { enabled: false });
  check("turning it off removes the entry", queryValue().status !== 0 && st.start_with_windows === false && st.autostart_active === false);
  // Self-heal: setting on, entry missing -> the next start writes it again.
  await invoke(panel, "safety_set_autostart", { enabled: true });
  reg("delete", `HKCU\\${SCRATCH_KEY}`, "/v", VALUE_NAME, "/f");
  check("(entry removed behind its back)", queryValue().status !== 0);
  await quit();
  await launch();
  await sleep(3000);
  check("starting again writes the entry back", queryValue().status === 0);
  mascot = await page("mascot");
  await invoke(mascot, "show_panel", { view: "settings" });
  panel = await page("panel");
  await invoke(panel, "safety_set_autostart", { enabled: false });
  check("and it can be switched off again", queryValue().status !== 0);

  check("no panics or crashes in the log", !/panicked|RUST_BACKTRACE/.test(proc.log()), proc.log().split(/\r?\n/).filter((l) => /panic|error/i.test(l)).slice(0, 3).join(" | "));
} catch (e) {
  check("run", false, String(e?.stack ?? e));
} finally {
  await cleanup();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${OUT}`);
process.exit(failed.length ? 1 : 0);
