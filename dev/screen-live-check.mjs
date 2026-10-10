#!/usr/bin/env node
// Live check of "Glitch can see the screen" in the REAL built app on Windows.
//
// 1. Opens its OWN test window (a small PowerShell form with known text,
//    always on top) - it never touches any other window.
// 2. Starts the built glitch.exe with WebView2 remote debugging, a separate
//    app identity is expected (build it with
//      npx tauri build --debug --no-bundle --config '{"identifier":"dev.glitch.screentest"}'
//    so it runs next to an installed Glitch and has its own settings), and
//    GLITCH_DRY_RUN_ACTIONS=1 (nothing gets opened or copied).
// 3. Asks "what's on my screen?" and checks the answer mentions the known
//    text, that the bubble showed the step list and the "looking at your
//    screen" badge, and (debug build) that Glitch's own windows are not in the
//    captured picture.
// 4. Quits Glitch, closes the test window, deletes the test settings.
//
//   node dev/screen-live-check.mjs [--exe path] [--model qwen3.5:4b] [--port 9333]
//
// Needs Node 22+ and Ollama with a vision model. Exits 1 on failure.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const PORT = Number(opt("--port") ?? 9333);
const MODEL = opt("--model") ?? "qwen3.5:4b";
const IDENT = "dev.glitch.screentest";
const exe = path.resolve(opt("--exe") ?? path.join(process.env.CARGO_TARGET_DIR ?? "target", "debug", "glitch.exe"));
const work = path.join(os.tmpdir(), `glitch-screen-check-${Date.now()}`);
const appDir = path.join(process.env.APPDATA ?? "", IDENT);
const KNOWN = { title: "Glitch screen test", lines: ["Packing list for Lisbon", "sunscreen SPF 50", "green umbrella", "train ticket 4127"] };

const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(44)} ${detail}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ CDP
async function targets() {
  return (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((t) => t.type === "page");
}
async function waitForTarget(page, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = (await targets().catch(() => [])).find((t) => t.url.includes(`${page}.html`));
    if (t) return t;
    await sleep(250);
  }
  throw new Error(`no ${page}.html page`);
}
class Page {
  static async open(target) {
    const p = new Page();
    p.ws = new WebSocket(target.webSocketDebuggerUrl);
    p.next = 1;
    p.pending = new Map();
    p.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      p.pending.get(msg.id)?.(msg);
      p.pending.delete(msg.id);
    };
    await new Promise((res, rej) => ((p.ws.onopen = res), (p.ws.onerror = rej)));
    return p;
  }
  send(method, params = {}) {
    const id = this.next++;
    return new Promise((res, rej) => {
      this.pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  invoke(cmd, payload = {}) {
    return this.eval(`(async () => { try { return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(payload)}) }; }
      catch (e) { return { ok: false, error: e }; } })()`);
  }
  async ready() {
    for (let i = 0; i < 75; i++) {
      const s = await this.eval(`({ state: document.readyState, tauri: !!window.__TAURI_INTERNALS__ })`).catch(() => null);
      if (s?.state === "complete" && s.tauri) return;
      await sleep(200);
    }
    throw new Error("page never loaded");
  }
}

// ------------------------------------------------------------ the run
let app;
let testWindow;
const log = [];

function startTestWindow() {
  mkdirSync(work, { recursive: true });
  const ps1 = path.join(work, "window.ps1");
  writeFileSync(
    ps1,
    `Add-Type -AssemblyName System.Windows.Forms
$f = New-Object Windows.Forms.Form
$f.Text = "${KNOWN.title}"
$f.Width = 900; $f.Height = 520; $f.StartPosition = "CenterScreen"; $f.TopMost = $true; $f.BackColor = "White"
$l = New-Object Windows.Forms.Label
$l.Text = "${KNOWN.lines.join("`r`n")}"
$l.Font = New-Object Drawing.Font("Segoe UI", 26)
$l.AutoSize = $true; $l.Left = 40; $l.Top = 40
$f.Controls.Add($l)
[void]$f.ShowDialog()
`,
  );
  testWindow = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1], { stdio: "ignore" });
}

async function main() {
  if (!existsSync(exe)) throw new Error(`no exe at ${exe}`);
  mkdirSync(appDir, { recursive: true });
  writeFileSync(
    path.join(appDir, "settings.json"),
    JSON.stringify({ model: MODEL, onboarding_done: true, movement_enabled: false, chaos_enabled: false, memory_enabled: false, screen_enabled: true }),
  );
  startTestWindow();
  await sleep(2500);

  const shot = path.join(work, "capture.png");
  app = spawn(exe, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
      GLITCH_DRY_RUN_ACTIONS: "1",
      GLITCH_DEBUG_SAVE_CAPTURE: shot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout.on("data", (d) => log.push(String(d)));
  app.stderr.on("data", (d) => log.push(String(d)));

  const mascot = await Page.open(await waitForTarget("mascot"));
  await mascot.ready();
  await mascot.invoke("show_bubble");
  const bubble = await Page.open(await waitForTarget("bubble"));
  await bubble.ready();
  record("app starts and the bubble opens", true);
  // Opening the chat loads the model and keeps it loaded ~10 minutes.
  const tw = Date.now();
  let warm = null;
  while (!warm && Date.now() - tw < 60_000) {
    await sleep(500);
    const ps = await (await fetch("http://127.0.0.1:11434/api/ps")).json().catch(() => ({}));
    warm = (ps.models ?? []).find((m) => m.name === MODEL && new Date(m.expires_at) - Date.now() > 8 * 60_000);
  }
  record("opening the chat warms the model (10 min)", !!warm, warm ? `ready after ${Date.now() - tw} ms, expires ${warm.expires_at}` : "not loaded");

  // Watch the bubble while Glitch works: did it show the steps and the badge?
  await bubble.eval(`window.__seen = { looking: "", steps: [] }; window.__watch = setInterval(() => {
      const l = document.querySelector(".looking"); if (l) window.__seen.looking = l.textContent;
      for (const s of document.querySelectorAll(".step .label")) if (!window.__seen.steps.includes(s.textContent)) window.__seen.steps.push(s.textContent);
    }, 30); true`);
  const t0 = Date.now();
  await bubble.eval(`document.querySelector("textarea").value = "what's on my screen?"; document.querySelector("form.pill").requestSubmit(); true`);
  const shots = { work: false, live: false };
  let firstText = null;
  for (let i = 0; i < 1800; i++) {
    await sleep(100);
    const st = await bubble.eval(`({ busy: document.getElementById("root").getAttribute("aria-busy"), work: !!document.querySelector(".work:not([hidden])"), live: !!document.querySelector(".balloon.live") })`);
    if (st.live && firstText === null) firstText = Date.now() - t0;
    for (const k of ["work", "live"]) {
      if (st[k] && !shots[k]) {
        shots[k] = true;
        const png = await bubble.send("Page.captureScreenshot", { format: "png" });
        writeFileSync(path.join(work, `bubble-${k}.png`), Buffer.from(png.data, "base64"));
      }
    }
    if (st.busy === "false") break;
  }
  const ms = Date.now() - t0;
  const r = await bubble.eval(`document.querySelector(".balloon .say .sr")?.textContent ?? document.querySelector(".balloon .say")?.textContent ?? ""`);
  const final = await bubble.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(work, "bubble-reply.png"), Buffer.from(final.data, "base64"));
  record("reply streamed in", firstText !== null, `first text after ${firstText} ms, whole reply ${ms} ms`);
  const seen = await bubble.eval(`clearInterval(window.__watch); window.__seen`);
  const words = ["lisbon", "sunscreen", "umbrella", "4127"].filter((w) => r.toLowerCase().includes(w));
  record("answer mentions the test window's text", words.length >= 2, `${ms} ms, found ${JSON.stringify(words)}: "${r.slice(0, 200)}"`);
  record("bubble showed the looking badge", /looking at your screen/i.test(seen.looking), JSON.stringify(seen.looking));
  record("bubble showed the step list", seen.steps.some((s) => /looking at your screen/i.test(s)), JSON.stringify(seen.steps));
  const captured = log.join("").match(/captured (\w+) (\d+)x(\d+) in (\d+) ms/);
  record("screenshot taken", !!captured, captured ? captured[0] : "no capture log line");

  if (existsSync(shot)) {
    // The bubble sits at a known place: compare that area in the capture
    // with the bubble's own colours (cream paper #fffaf2 / dark #33283b).
    const pos = await bubble.invoke("plugin:window|outer_position", { label: "bubble" });
    const size = await bubble.invoke("plugin:window|outer_size", { label: "bubble" });
    record("capture saved for checking (debug build)", true, `${shot} bubble at ${JSON.stringify(pos.value)} ${JSON.stringify(size.value)}`);
    writeFileSync(path.join(work, "bubble-rect.json"), JSON.stringify({ pos: pos.value, size: size.value }));
  }

  // Closing the chat goes back to the short keep-alive.
  await bubble.invoke("hide_bubble");
  await sleep(1500);
  const ps = await (await fetch("http://127.0.0.1:11434/api/ps")).json().catch(() => ({}));
  const m = (ps.models ?? []).find((m) => m.name === MODEL);
  record("closing the chat shortens the keep-alive", !m || new Date(m.expires_at) - Date.now() < 3 * 60_000, m ? `expires ${m.expires_at}` : "unloaded");

  const q = mascot.invoke("quit").catch(() => {});
  await Promise.race([q, sleep(3000)]);
}

function cleanup() {
  try {
    if (app && app.exitCode === null) execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {}
  try {
    if (testWindow && testWindow.exitCode === null) execFileSync("taskkill", ["/PID", String(testWindow.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {}
  rmSync(appDir, { recursive: true, force: true });
  // The capture shows the whole real screen: keep it only when asked.
  if (!args.includes("--keep")) rmSync(work, { recursive: true, force: true });
  try {
    rmSync(path.join(process.env.LOCALAPPDATA ?? "", IDENT), { recursive: true, force: true });
  } catch {
    /* WebView2 may still hold it for a moment */
  }
}

main()
  .catch((e) => record("live check crashed", false, e.stack ?? String(e)))
  .finally(async () => {
    await sleep(500);
    cleanup();
    if (results.some((r) => !r.ok)) console.log("\n--- app output ---\n" + log.join("").split("\n").slice(-30).join("\n"));
    console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed. Work files: ${work}`);
    process.exit(results.some((r) => !r.ok) ? 1 : 0);
  });
