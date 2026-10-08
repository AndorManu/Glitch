#!/usr/bin/env node
// End-to-end check of the stream overlay against the real app (Windows).
// Build a copy with its own identifier, so it has its own settings folder and
// never meets an installed or running Glitch (single-instance would hand the
// launch to that one):
//
//   $env:TAURI_CONFIG='{"identifier":"dev.glitch.overlaycheck","productName":"GlitchOverlayCheck"}'
//   cargo build -p glitch --features tauri/custom-protocol
//   node dev/overlay-check.mjs --exe <that glitch.exe> [--port 7811] [--out dev/out]
//
// It starts that copy with the overlay on (a fresh settings.json in
// %APPDATA%\dev.glitch.overlaycheck, removed afterwards), then:
// - HTTP: tokens, Host and Origin checks, the write token only in a header;
// - opens the OBS page in Edge (Playwright) and checks mirror mode follows
//   the desktop Glitch, a follow plays the streamer clip and the bubble;
// - switches to walk mode and checks the stream Glitch walks;
// - saves screenshots (transparent page composited on a dark background).
// GLITCH_DRY_RUN_ACTIONS=1: nothing is opened on this machine. Exits 1 on any failure.

import { spawn } from "node:child_process";
import { request } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const opt = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exe = opt("--exe");
const PORT = Number(opt("--port", "7811"));
const CDP = Number(opt("--cdp", "9231"));
const OUT = path.resolve(opt("--out", path.join(root, "dev", "out")));
if (!exe || !existsSync(exe)) {
  console.error("usage: node dev/overlay-check.mjs --exe <glitch.exe>");
  process.exit(2);
}

const IDENTIFIER = opt("--identifier", "dev.glitch.overlaycheck");
if (IDENTIFIER === "dev.glitch.companion") {
  console.error("refusing to use the real app's settings folder: build the check copy with its own identifier (see the top of this file)");
  process.exit(2);
}
const APPDIR = path.join(process.env.APPDATA ?? "", IDENTIFIER);
function backup() {
  rmSync(APPDIR, { recursive: true, force: true });
}
function restore() {
  rmSync(APPDIR, { recursive: true, force: true });
}

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) {
    try {
      v = await fn();
      if (v) return v;
    } catch {
      /* not yet */
    }
    await sleep(150);
  }
  return v;
}

const base = `http://127.0.0.1:${PORT}`;
async function http(p, init = {}) {
  const r = await fetch(base + p, init);
  return { status: r.status, headers: r.headers, text: await r.text() };
}

let app = null;
let browser = null;
let cdp = null;
async function cleanup() {
  await browser?.close().catch(() => {});
  await cdp?.close().catch(() => {});
  if (app && app.exitCode === null) {
    app.kill();
    await until(() => app.exitCode !== null, 5000);
  }
  restore();
}
process.on("SIGINT", () => void cleanup().then(() => process.exit(130)));

try {
  mkdirSync(OUT, { recursive: true });
  backup();
  mkdirSync(APPDIR, { recursive: true });
  writeFileSync(
    path.join(APPDIR, "settings.json"),
    JSON.stringify({
      onboarding_done: true,
      chaos_enabled: false,
      memory_enabled: false,
      voice: { enabled: false },
      stream_overlay: { enabled: true, port: PORT, mode: "mirror", size: 1.5, position: "center" },
      auto_update: { auto_check: false },
    }),
  );
  const env = { ...process.env, GLITCH_DRY_RUN_ACTIONS: "1", WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP}` };
  const log = [];
  app = spawn(exe, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  app.stdout.on("data", (d) => log.push(String(d)));
  app.stderr.on("data", (d) => log.push(String(d)));

  const up = await until(() => http("/overlay").then((r) => r.status === 401), 30000);
  record("server answers on 127.0.0.1", !!up, log.find((l) => l.includes("stream overlay"))?.trim() ?? "");
  const saved = JSON.parse(readFileSync(path.join(APPDIR, "settings.json"), "utf8")).stream_overlay;
  const view = saved.view_token;
  const write = saved.write_token;
  record("two different tokens were made", view.length === 32 && write.length === 32 && view !== write);

  // ---------------------------------------------------------------- HTTP
  const page = await http(`/overlay?token=${view}`);
  record("page with the view token", page.status === 200 && page.text.includes('id="stage"') && /connect-src 'self'/.test(page.headers.get("content-security-policy") ?? ""), `${page.status}`);
  record("no token: 401", (await http("/overlay")).status === 401);
  record("write token can't read", (await http(`/overlay?token=${write}`)).status === 401);
  const rebinding = await new Promise((done) => {
    const req = request({ host: "127.0.0.1", port: PORT, path: `/overlay?token=${view}`, headers: { Host: `evil.example:${PORT}` } }, (res) => {
      res.resume();
      done(res.statusCode);
    });
    req.on("error", () => done(0));
    req.end();
  });
  record("DNS rebinding blocked (Host)", rebinding === 403, String(rebinding));
  const asset = page.text.match(/src="(\/assets\/overlay-[^"]+\.js)"/)?.[1];
  record("page script is served", !!asset && (await http(asset)).status === 200, asset ?? "none");
  const json = { "Content-Type": "application/json" };
  const ev = JSON.stringify({ type: "follow", user: "CheckBot" });
  record("event with the view token: 401", (await http("/stream-event", { method: "POST", headers: { ...json, "X-Glitch-Token": view }, body: ev })).status === 401);
  record("event with the token in the URL: 401", (await http(`/stream-event?token=${write}`, { method: "POST", headers: json, body: ev })).status === 401);
  record("event as GET: 405", (await http(`/stream-event?token=${write}&type=follow`)).status === 405);
  record("event from a browser page (Origin): 403", (await http("/stream-event", { method: "POST", headers: { ...json, "X-Glitch-Token": write, Origin: "https://evil.example" }, body: ev })).status === 403);
  record("event without JSON: 403", (await http("/stream-event", { method: "POST", headers: { "Content-Type": "text/plain", "X-Glitch-Token": write }, body: ev })).status === 403);
  record("path traversal: 404", (await http("/assets/..%2f..%2fsettings.json")).status === 404);

  // ----------------------------------------------------------- the page
  browser = process.env.PW_CHROMIUM ? await chromium.launch({ executablePath: process.env.PW_CHROMIUM }) : await chromium.launch({ channel: "msedge" });
  const obs = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  obs.on("pageerror", (e) => errors.push(String(e)));
  obs.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await obs.goto(`${base}/overlay?token=${view}`);
  const ready = await until(() => obs.evaluate(() => window.__overlay?.config?.mode), 10000);
  record("overlay connects and gets its config", ready === "mirror", String(ready));

  // The desktop Glitch: reach his window over WebView2's DevTools port.
  cdp = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`);
  const mascot = await until(() => cdp.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("mascot.html")), 15000);
  record("desktop mascot found", !!mascot);
  if (mascot) {
    await mascot.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "mascot-action", payload: "wave" }));
    // A wave is short: check it arrived, not that it is still playing.
    const mirrored = await until(() => obs.evaluate(() => window.__overlay.mirrored.includes("wave")), 5000);
    const desk = await mascot.evaluate(() => document.title).catch(() => "?");
    record("mirror: desktop Glitch waves, the overlay waves", !!mirrored, `overlay shows ${await obs.evaluate(() => window.__overlay.animation)}, mirrored ${await obs.evaluate(() => window.__overlay.mirrored.join(","))}, page ${desk}`);
    await obs.screenshot({ path: path.join(OUT, "overlay-mirror.png"), omitBackground: true });
  }

  const r = await http("/stream-event", { method: "POST", headers: { ...json, "X-Glitch-Token": write }, body: ev });
  record("follow event with the write token: 202", r.status === 202);
  const clip = await until(() => obs.evaluate(() => window.__overlay.clip), 3000);
  const bubble = await until(() => obs.evaluate(() => window.__overlay.bubble), 3000);
  record("follow: streamer clip plays", !!clip);
  record("follow: thank-you bubble", typeof bubble === "string" && bubble.includes("CheckBot"), bubble ?? "");
  await obs.screenshot({ path: path.join(OUT, "overlay-follow.png"), omitBackground: true });

  // Text from chat is shown as text, never as HTML.
  await sleep(3500);
  await http("/stream-event", { method: "POST", headers: { ...json, "X-Glitch-Token": write }, body: JSON.stringify({ type: "chat", user: "<b>x</b>", text: '<img src=x onerror="window.__pwned=1">hi' }) });
  await until(() => obs.evaluate(() => (window.__overlay.bubble ?? "").includes("hi")), 12000);
  const pwned = await obs.evaluate(() => window.__pwned === 1 || document.querySelectorAll("#bubble img").length > 0);
  record("chat text is never HTML", !pwned);
  await obs.screenshot({ path: path.join(OUT, "overlay-chat.png"), omitBackground: true });

  // Walk mode: the page reloads itself and a stream Glitch walks.
  if (mascot) {
    await mascot.evaluate(() => window.__TAURI_INTERNALS__.invoke("update_stream_settings", { patch: { mode: "walk", size: 1 } }));
    const walking = await until(() => obs.evaluate(() => window.__overlay?.config?.mode === "walk"), 10000);
    record("switching to walk mode reaches the page", !!walking);
    const p0 = await obs.evaluate(() => window.__overlay.pos);
    const moved = await until(async () => {
      const p = await obs.evaluate(() => window.__overlay.pos);
      return Math.abs(p.x - p0.x) > 20 ? p : null;
    }, 30000);
    const p = await obs.evaluate(() => window.__overlay.pos);
    record("walk: he moves along the bottom", !!moved && p.y >= 720 - 160 - 40, `from ${JSON.stringify(p0)} to ${JSON.stringify(p)}`);
    await obs.screenshot({ path: path.join(OUT, "overlay-walk.png"), omitBackground: true });
  }
  record("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  record("run", false, String(e?.stack ?? e));
} finally {
  await cleanup();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed. Screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
