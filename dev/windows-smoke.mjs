#!/usr/bin/env node
// End-to-end smoke test of the REAL built Glitch app on Windows, no mouse
// needed. Launches the exe with WebView2 remote debugging on, talks to its
// pages over the Chrome DevTools Protocol, and drives the app through the
// same IPC calls the UI makes (window.__TAURI_INTERNALS__.invoke):
//
//   first run (setup wizard opens, IPC keeps answering) -> setup_status ->
//   finish setup -> bubble opens and loads -> mascot clicks toggle it ->
//   chat with the real Ollama (open a URL right away, ask before opening an
//   app, small talk, remember a fact, memory view) -> settings -> quit.
//
// After every call that can create or show a window it checks that a
// follow-up `get_settings` still answers within 2 s (the old Windows build
// deadlocked all IPC there).
//
//   node dev/windows-smoke.mjs                     # newest built exe, dry-run actions
//   node dev/windows-smoke.mjs --exe path\to\glitch.exe --model qwen3.5:4b
//   node dev/windows-smoke.mjs --real-actions      # really open x.com / Calculator
//
// By default the app runs with GLITCH_DRY_RUN_ACTIONS=1: URLs/apps/files are
// logged instead of opened (no browser tabs or Calculator windows left over).
// Without Ollama (e.g. CI) the chat steps check for a clean
// "ollama_unreachable" error instead.
//
// Your own settings.json / memory.json in %APPDATA%\dev.glitch.companion are
// moved aside for the run (first-run test) and always put back afterwards.
// Needs Node 22+ (global WebSocket). Exits 1 if any check fails.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(opt("--port") ?? 9229);
const REAL = flag("--real-actions");
const IPC_LIMIT_MS = 2000;
const CHAT_TIMEOUT_MS = 240_000;

if (process.platform !== "win32") {
  console.error("windows-smoke.mjs drives WebView2 and only runs on Windows.");
  process.exit(2);
}

// ------------------------------------------------------------------ report

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(46)} ${detail}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function withTimeout(p, ms, what) {
  let t;
  return Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej(new Error(`${what}: no answer in ${ms} ms`)), ms)))]).finally(() => clearTimeout(t));
}

// ------------------------------------------------------------------ the exe

function findExe() {
  const given = opt("--exe");
  if (given) return path.resolve(given);
  const dirs = [process.env.CARGO_TARGET_DIR, path.join(root, "target")].filter(Boolean);
  const candidates = dirs.flatMap((d) => ["release", "debug"].map((p) => path.join(d, p, "glitch.exe"))).filter(existsSync);
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0];
}

function glitchRunning() {
  try {
    return /glitch\.exe/i.test(execFileSync("tasklist", ["/FI", "IMAGENAME eq glitch.exe", "/NH"], { encoding: "utf8" }));
  } catch {
    return false;
  }
}

// ------------------------------------------------------- settings backup

const APPDIR = path.join(process.env.APPDATA ?? "", "dev.glitch.companion");
const OWN_FILES = ["settings.json", "memory.json"];
const backupDir = path.join(APPDIR, `smoke-backup-${Date.now()}`);
let backedUp = false;

function backup() {
  mkdirSync(backupDir, { recursive: true });
  for (const f of OWN_FILES) {
    if (existsSync(path.join(APPDIR, f))) renameSync(path.join(APPDIR, f), path.join(backupDir, f));
  }
  backedUp = true;
}

function restore() {
  if (!backedUp) return;
  for (const f of ["memory.json.tmp", "settings.json.tmp"]) rmSync(path.join(APPDIR, f), { force: true });
  for (const f of OWN_FILES) {
    const p = path.join(APPDIR, f);
    rmSync(p, { force: true });
    if (existsSync(path.join(backupDir, f))) renameSync(path.join(backupDir, f), p);
  }
  rmSync(backupDir, { recursive: true, force: true });
  backedUp = false;
  console.log(`      restored your settings/memory in ${APPDIR}`);
}

// --------------------------------------------------------------- CDP

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  return (await res.json()).filter((t) => t.type === "page");
}

async function waitForTarget(page, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const t = (await targets()).find((t) => t.url.includes(`${page}.html`));
      if (t) return t;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error(`no ${page}.html page after ${ms} ms`);
}

class Page {
  static async open(target) {
    const p = new Page();
    p.ws = new WebSocket(target.webSocketDebuggerUrl);
    p.next = 1;
    p.pending = new Map();
    p.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      const cb = p.pending.get(msg.id);
      if (cb) {
        p.pending.delete(msg.id);
        cb(msg);
      }
    };
    p.ws.onclose = () => {
      for (const cb of p.pending.values()) cb({ error: { message: "page connection closed" } });
      p.pending.clear();
    };
    await new Promise((res, rej) => {
      p.ws.onopen = res;
      p.ws.onerror = () => rej(new Error(`cannot connect to ${target.url}`));
    });
    return p;
  }
  send(method, params = {}) {
    const id = this.next++;
    return new Promise((res, rej) => {
      this.pending.set(id, (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression, ms = 10_000) {
    const r = await withTimeout(this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }), ms, expression.slice(0, 60));
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  /** Resolves `{ ok, value | error, ms }`; rejects only on timeout. */
  async invoke(cmd, payload = {}, ms = IPC_LIMIT_MS) {
    const t0 = Date.now();
    const r = await this.eval(
      `(async () => { try { return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(payload)}) }; }
        catch (e) { return { ok: false, error: e }; } })()`,
      ms,
    );
    return { ...r, ms: Date.now() - t0 };
  }
  async ready(ms = 15_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const s = await this.eval(`({ href: location.href, state: document.readyState, tauri: !!window.__TAURI_INTERNALS__ })`).catch(() => null);
      if (s?.state === "complete" && s.tauri) return s;
      await sleep(200);
    }
    throw new Error("page never finished loading");
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

// ------------------------------------------------------------- the run

let app;
let mascot;
const pages = [];

async function alive(after) {
  try {
    const r = await mascot.invoke("get_settings");
    record(`IPC alive after ${after}`, r.ok && r.ms < IPC_LIMIT_MS, `get_settings in ${r.ms} ms`);
  } catch (e) {
    record(`IPC alive after ${after}`, false, e.message);
  }
}

async function visible(label) {
  const r = await mascot.invoke("plugin:window|is_visible", { label });
  return r.ok ? r.value : `error: ${JSON.stringify(r.error)}`;
}

async function step(name, fn) {
  try {
    await fn();
  } catch (e) {
    record(name, false, e.message);
  }
}

async function noBlankPages() {
  const blank = (await targets()).filter((t) => t.url === "about:blank" || !/\.html/.test(t.url));
  record("no about:blank / unknown pages", blank.length === 0, (await targets()).map((t) => new URL(t.url).pathname).join(" "));
}

async function main() {
  const exe = findExe();
  if (!exe || !existsSync(exe)) {
    console.error("No glitch.exe found. Build first (npx tauri build --debug --no-bundle) or pass --exe.");
    process.exit(2);
  }
  if (glitchRunning()) {
    console.error("Glitch is already running. Quit it first (tray icon > Quit Glitch): a second launch only pokes the running one.");
    process.exit(2);
  }
  try {
    await targets();
    console.error(`Something already listens on port ${PORT}. Pass --port.`);
    process.exit(2);
  } catch {
    /* good, free */
  }

  console.log(`Glitch Windows smoke test\n      exe: ${exe}\n      actions: ${REAL ? "REAL (opens x.com and Calculator)" : "dry run (logged, not opened)"}\n`);
  backup();

  const env = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` };
  if (!REAL) env.GLITCH_DRY_RUN_ACTIONS = "1";
  const log = [];
  app = spawn(exe, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  app.stdout.on("data", (d) => log.push(String(d)));
  app.stderr.on("data", (d) => log.push(String(d)));
  let exited = null;
  app.on("exit", (code) => (exited = code ?? 0));

  // --- start-up and first run
  await step("app starts, mascot page loads", async () => {
    const t = await waitForTarget("mascot");
    mascot = await Page.open(t);
    pages.push(mascot);
    const s = await mascot.ready();
    record("app starts, mascot page loads", true, s.href);
  });
  if (!mascot) return;
  await alive("start-up");

  let panel;
  await step("first run opens the setup panel", async () => {
    const t = await waitForTarget("panel", 15_000);
    panel = await Page.open(t);
    pages.push(panel);
    const s = await panel.ready();
    const view = await mascot.invoke("panel_view");
    record("first run opens the setup panel", (await visible("panel")) === true && view.value === "setup", `${s.href}, view=${view.value}`);
  });
  await alive("setup panel opened");

  await step("mascot window size", async () => {
    const m = await mascot.eval(`({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })`);
    const outer = await mascot.invoke("plugin:window|outer_size", { label: "mascot" });
    const inner = await mascot.invoke("plugin:window|inner_size", { label: "mascot" });
    const ok = m.w === 160 && m.h === 160;
    record("mascot window is 160x160 CSS px", ok, `css ${m.w}x${m.h} @${m.dpr}x, inner ${JSON.stringify(inner.value)}, outer ${JSON.stringify(outer.value)}`);
  });

  // --- setup status
  let status;
  let model = opt("--model");
  await step("setup_status", async () => {
    const r = await (panel ?? mascot).invoke("setup_status", {}, 20_000);
    status = r.value;
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const tools = status.installed.filter((m) => m.supports_tools).map((m) => m.name);
    model ??= tools.find((n) => n === status.recommendation.primary.name) ?? tools.find((n) => /qwen3\.5:4b/.test(n)) ?? tools[0] ?? "qwen3.5:4b";
    record("setup_status", true, `${r.ms} ms, ollama ${status.ollama.state} ${status.ollama.version ?? ""}, ${status.installed.length} models, recommends ${status.recommendation.primary.name}`);
  });
  await alive("setup_status");
  const chatting = status?.ollama.state === "running" && status.installed.some((m) => m.name === model);

  // --- finish setup: panel closes, the bubble says hi
  let bubble;
  await step("finish setup opens the bubble", async () => {
    const u = await (panel ?? mascot).invoke("update_settings", { patch: { model, onboarding_done: true } });
    if (!u.ok) throw new Error(JSON.stringify(u.error));
    const f = await (panel ?? mascot).invoke("finish_setup", {}, 10_000);
    if (!f.ok) throw new Error(JSON.stringify(f.error));
    const t = await waitForTarget("bubble", 10_000);
    bubble = await Page.open(t);
    pages.push(bubble);
    const s = await bubble.ready();
    const [b, p] = [await visible("bubble"), await visible("panel")];
    record("finish setup opens the bubble", b === true && p === false && f.ms < IPC_LIMIT_MS, `finish_setup ${f.ms} ms, ${s.href}, bubble=${b} panel=${p}`);
  });
  await alive("finish_setup");
  await noBlankPages();

  // --- clicking Glitch toggles the bubble
  await step("mascot_clicked toggles the bubble", async () => {
    await mascot.invoke("hide_bubble");
    const states = [];
    for (let i = 0; i < 3; i++) {
      const r = await mascot.invoke("mascot_clicked");
      if (!r.ok || r.ms >= IPC_LIMIT_MS) throw new Error(`mascot_clicked: ${JSON.stringify(r)}`);
      states.push(await visible("bubble"));
    }
    record("mascot_clicked toggles the bubble", JSON.stringify(states) === "[true,false,true]", `visible after clicks: ${states.join(", ")}`);
  });
  await alive("mascot_clicked");

  // A click during the bubble's close animation reopens it, and the
  // animation's late hide_bubble doesn't close it again.
  await step("click during close animation reopens", async () => {
    await bubble.invoke("bubble_closing");
    await mascot.invoke("mascot_clicked");
    const reopened = await visible("bubble");
    await bubble.invoke("hide_bubble"); // the interrupted animation finishing
    const still = await visible("bubble");
    await bubble.invoke("bubble_closing");
    await bubble.invoke("hide_bubble"); // a normal close still works
    const closed = (await visible("bubble")) === false;
    await mascot.invoke("mascot_clicked");
    record("click during close animation reopens", reopened === true && still === true && closed, `reopened=${reopened} stays=${still} normal close=${closed}`);
  });

  // --- chat
  const send = async (text) => {
    const pending = bubble.invoke("send_message", { text }, CHAT_TIMEOUT_MS);
    // IPC must stay responsive while the model thinks.
    await sleep(300);
    const during = await mascot.invoke("get_settings").catch((e) => ({ ok: false, ms: -1, error: e.message }));
    const r = await pending;
    return { ...r, during };
  };
  if (bubble && chatting) {
    console.log(`      chatting with ${model} (first answer loads the model, can take a while)`);
    await step("open twitter: opens the URL without asking", async () => {
      const r = await send("open twitter on elon musk's page");
      const v = r.value ?? {};
      const opened = (v.actions ?? []).find((a) => /(x|twitter)\.com\/elonmusk/i.test(a));
      record("open twitter: opens the URL without asking", r.ok && v.type === "reply" && !!opened, `${r.ms} ms, ${JSON.stringify(v).slice(0, 160)}`);
      record("IPC answers while the model is thinking", r.during.ok && r.during.ms < IPC_LIMIT_MS, `get_settings in ${r.during.ms} ms`);
    });
    await step("open calculator: asks first", async () => {
      const r = await send("open the calculator");
      const v = r.value ?? {};
      record("open calculator: asks first", r.ok && v.type === "confirm" && /calc/i.test(v.title ?? ""), `${r.ms} ms, ${JSON.stringify(v).slice(0, 160)}`);
      if (v.type === "confirm") {
        const c = await bubble.invoke("confirm_action", { id: v.id, approved: true }, CHAT_TIMEOUT_MS);
        const acts = c.value?.actions ?? [];
        record("approving runs it", c.ok && acts.some((a) => /calc/i.test(a)), `${c.ms} ms, ${JSON.stringify(c.value ?? c.error).slice(0, 160)}`);
        if (REAL) {
          await sleep(1500);
          try {
            execFileSync("taskkill", ["/IM", "CalculatorApp.exe", "/F"], { stdio: "ignore" });
          } catch {
            /* not running */
          }
        }
      }
    });
    await step("small talk", async () => {
      const r = await send("hi! how are you today?");
      const v = r.value ?? {};
      record("small talk", r.ok && v.type === "reply" && v.text.trim().length > 0 && !(v.actions ?? []).length, `${r.ms} ms, ${JSON.stringify(v).slice(0, 160)}`);
    });
    await step("remember a fact", async () => {
      const r = await send("remember that my dog is called Rex");
      const v = r.value ?? {};
      const mem = await bubble.invoke("get_memory");
      const fact = (mem.value?.facts ?? []).find((f) => /rex/i.test(f.text));
      record("remember a fact", r.ok && !!fact && (v.actions ?? []).some((a) => /remembered/i.test(a)), `${JSON.stringify(v.actions)} -> memory: ${JSON.stringify(mem.value?.facts?.map((f) => f.text))}`);
    });
    await step("memory view", async () => {
      const mem = await mascot.invoke("get_memory");
      record("memory view", mem.ok && mem.value.enabled === true, `enabled=${mem.value?.enabled}, ${mem.value?.facts?.length} facts, summary ${JSON.stringify(mem.value?.summary ?? "").slice(0, 60)}`);
    });
  } else if (bubble) {
    await step("chat without Ollama fails cleanly", async () => {
      const r = await send("hi!");
      record("chat without Ollama fails cleanly", !r.ok && ["ollama_unreachable", "model_missing", "ai_error"].includes(r.error?.code), `${r.ms} ms, ${JSON.stringify(r.error)}`);
    });
  }
  await alive("chat");

  // --- settings panel
  await step("settings panel", async () => {
    const r = await mascot.invoke("show_panel", { view: "settings" });
    const view = await mascot.invoke("panel_view");
    const [p, b] = [await visible("panel"), await visible("bubble")];
    record("settings panel opens", r.ok && r.ms < IPC_LIMIT_MS && p === true && b === false && view.value === "settings", `${r.ms} ms, panel=${p} bubble=${b} view=${view.value}`);
    await mascot.invoke("hide_panel");
    record("settings panel hides", (await visible("panel")) === false);
  });
  await alive("settings panel");
  await noBlankPages();

  // --- quit
  await step("quit", async () => {
    const t0 = Date.now();
    mascot.invoke("quit", {}, 5000).catch(() => {});
    while (exited === null && Date.now() - t0 < 10_000) await sleep(100);
    record("quit exits the app", exited !== null, exited !== null ? `exit code ${exited} after ${Date.now() - t0} ms` : "still running after 10 s");
  });

  if (results.some((r) => !r.ok)) {
    console.log("\n--- app output ---\n" + log.join("").split("\n").slice(-40).join("\n"));
  }
}

function cleanup() {
  for (const p of pages) p.close();
  if (app && app.exitCode === null) {
    try {
      execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* gone */
    }
  }
  // Give Windows a moment to release the files before moving them back.
  const until = Date.now() + 2000;
  while (Date.now() < until && glitchRunning()) execFileSync("cmd", ["/c", "ping -n 1 127.0.0.1 >nul"]);
  restore();
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

main()
  .catch((e) => record("smoke test crashed", false, e.stack ?? String(e)))
  .finally(() => {
    cleanup();
    const failed = results.filter((r) => !r.ok);
    const report = opt("--report");
    if (report) writeFileSync(report, JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
    console.log(`\n${results.length - failed.length}/${results.length} passed.`);
    process.exit(failed.length ? 1 : 0);
  });
