#!/usr/bin/env node
// Real-app check of chaos mode 2 (Windows). Everything runs against a debug build with its OWN
// identifier and settings folder, on a stage of our own test windows (dev/chaos2-windows.py: a
// wallpaper plus four small windows, one of them "unsaved"), and the app is started with
// GLITCH_CHAOS_ONLY_PIDS so it can only ever see those windows: nobody's real window is touched.
//
//   npx tauri build --debug --no-bundle --config '{"identifier":"dev.glitch.companion.chaos2"}'
//   node dev/chaos2-check.mjs <target>/debug/glitch.exe [out-dir] [--only hook,abort,dance,yoink,fx,panel]
//
// The stage covers the whole work area for the length of the run (Escape on it closes it); the
// real cursor is moved by the app (that is what is being tested) and, for the abort tests, by a
// helper that plays "the user" with mouse_event / key presses, but only when the window under the
// cursor / in front is one of ours. Exits 1 on any failure. Needs the user to leave the mouse
// alone (acts only start after 4 s without input, which is the point).

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const [exe, outArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;
if (!exe || !existsSync(exe)) {
  console.error("usage: node dev/chaos2-check.mjs <glitch.exe built with its own identifier> [out-dir] [--only a,b]");
  process.exit(2);
}
const ID = "dev.glitch.companion.chaos2";
if (ID === "dev.glitch.companion") process.exit(2);
const OUT = path.resolve(outArg ?? "dev/out/chaos2");
mkdirSync(OUT, { recursive: true });
const APPDIR = path.join(process.env.APPDATA ?? "", ID);
const PORT = 9461;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const want = (name) => !only || only.includes(name);
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const py = (...args) => spawnSync("python", args, { encoding: "utf8", timeout: 120000 });
const tool = (...args) => py("dev/chaos2-tool.py", ...args);
const bg = (file, ...args) => {
  const p = spawn("python", [file, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  p.done = new Promise((r) => p.on("close", r));
  return p;
};

let stage = null;
let info = null;
let proc = null;
let browser = null;
let log = "";
let dpr = 1;
const procs = [];

async function startStage() {
  const file = path.join(OUT, "stage.json");
  rmSync(file, { force: true });
  stage = spawn("python", ["dev/chaos2-windows.py", file], { stdio: "ignore" });
  procs.push(stage);
  for (let i = 0; i < 60 && !existsSync(file); i++) await sleep(250);
  await sleep(500);
  info = JSON.parse(readFileSync(file, "utf8"));
}

function writeSettings(extra = {}) {
  rmSync(APPDIR, { recursive: true, force: true });
  mkdirSync(APPDIR, { recursive: true });
  writeFileSync(
    path.join(APPDIR, "settings.json"),
    JSON.stringify({
      onboarding_done: true,
      movement_enabled: true,
      chaos_enabled: true,
      chaos_level: "full_virus",
      // An installed Glitch owns Ctrl+Alt+Shift+G: this copy uses F9 so the real hotkey path can be tested.
      safety: { paused: false, panic_hotkey: "Ctrl+Alt+Shift+F9", start_with_windows: false },
      chaos_full_confirmed: true,
      reduce_effects: false,
      memory_enabled: false,
      voice: { enabled: false },
      auto_update: { auto_check: false },
      update_me: { endpoint_enabled: false },
      ...extra,
    }),
  );
}

async function launch() {
  const env = {
    ...process.env,
    GLITCH_DRY_RUN_ACTIONS: "1",
    GLITCH_CHAOS_FAST: "1",
    GLITCH_CHAOS_ONLY_PIDS: String(info.pid),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
  };
  log = "";
  proc = spawn(exe, [], { env, stdio: ["ignore", "ignore", "pipe"] });
  procs.push(proc);
  proc.stderr.on("data", (d) => (log += d));
  browser = null;
  for (let i = 0; i < 80 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://localhost:${PORT}`);
    } catch {
      await sleep(500);
    }
  }
  if (!browser) throw new Error("could not connect to the app");
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
const alive = () => proc && proc.exitCode === null;

async function quit() {
  await browser?.close().catch(() => {});
  if (proc) spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  await sleep(1000);
}

async function cleanup() {
  await quit().catch(() => {});
  for (const p of procs) spawnSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" });
  rmSync(APPDIR, { recursive: true, force: true });
}
process.on("SIGINT", () => void cleanup().then(() => process.exit(130)));

const idleMs = () => Number(tool("idle").stdout.trim() || 0);
/** Wait until the user has left the computer alone for `ms` (the app's own rule, 4 s). */
async function quiet(ms = 6000, max = 240000) {
  const end = Date.now() + max;
  while (Date.now() < end) {
    if (idleMs() >= ms) return true;
    await sleep(500);
  }
  return false;
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const readJson = (f) => {
  const j = JSON.parse(readFileSync(f, "utf8"));
  if (j && Array.isArray(j.start)) j.start = { x: j.start[0], y: j.start[1] };
  return j;
};
const anims = (mascot, ms, step = 80) =>
  (async () => {
    const seen = [];
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const a = await mascot.evaluate(() => window.__glitch.creature.animation).catch(() => "?");
      if (seen.at(-1) !== a) seen.push(a);
      await sleep(step);
    }
    return seen;
  })();

/** Put the cursor somewhere over the stage (our wallpaper) a cast away from Glitch, wait for quiet. */
async function parkCursor(mascot, dx = 700, dy = -120) {
  const body = await mascot.evaluate(() => {
    const c = window.__glitch.creature;
    return { x: c.body.x, y: c.body.y };
  });
  const [ax, ay, aw, ah] = info.work_area;
  const x = Math.min(ax + aw - 80, Math.max(ax + 80, Math.round(body.x + dx)));
  const y = Math.min(ay + ah - 200, Math.max(ay + 200, Math.round(body.y + dy)));
  tool("setpos", String(x), String(y));
  await quiet(5500);
  return { x, y };
}

async function act(mascot, what) {
  return mascot.evaluate((w) => window.__glitch.creature.forceChaos(w), what);
}

async function film(name, secs, fps = 8, scale = 0.5) {
  const [ax, ay, aw, ah] = info.work_area;
  const p = bg("dev/chaos2-film.py", OUT, name, String(secs), String(fps), String(ax), String(ay), String(aw), String(ah), "--scale", String(scale));
  return p;
}

try {
  writeSettings();
  await startStage();
  const [ax, ay, aw, ah] = info.work_area;
  await sleep(1500);
  const cover = tool("stagecheck", String(ax), String(ay), String(aw), String(ah));
  console.log(cover.stdout.trim());
  if (cover.status !== 0) throw new Error("the QA stage does not cover the screen: not filming anybody's desktop");
  const before = path.join(OUT, "windows-before.json");
  tool("snapshot", before, "--skip-pid", String(info.pid));
  await launch();
  globalThis.__t0 = Date.now();
  const mascot = await page("mascot");
  await mascot.waitForFunction(() => window.__glitch?.creature?.world, null, { timeout: 40000 });
  dpr = await mascot.evaluate(() => devicePixelRatio);
  const pids = String(info.pid);
  const H = Object.fromEntries(Object.entries(info.windows).map(([k, v]) => [k, String(v)]));
  const hw = (...ks) => ks.flatMap((k) => ["--hwnd", H[k]]);
  // Stand him on the left; the cursor goes to the right.
  await mascot.evaluate(() => {
    const c = window.__glitch.creature;
    const x = c.world.area.x + 280;
    c.body.x = x;
    c.s = x;
    c.place();
  });
  await sleep(1500);
  const st0 = await invoke(mascot, "chaos2_status");
  check("Full Virus is on, tray label says so", st0.level === "full_virus" && st0.label === "Chaos: Full Virus", JSON.stringify(st0).slice(0, 160));

  // ------------------------------------------------------------- the hook
  if (want("hook")) {
    const start = await parkCursor(mascot);
    const f = await film("hook", 13, 10);
    const tr = bg("dev/chaos2-tool.py", "trace", path.join(OUT, "hook-trace.json"), "--pids", pids, "--ms", "12500", "--hz", "250");
    await sleep(600);
    const ok = await act(mascot, "hook:pull");
    const seen = await anims(mascot, 11000);
    await Promise.all([tr.done, f.done]);
    const t = readJson(path.join(OUT, "hook-trace.json"));
    const far = Math.max(...t.rows.map((r) => dist(r, t.start)));
    const lim = 400 * dpr + 3;
    check("the hook act starts", ok === true, log.split("\n").filter((l) => /chaos2/.test(l)).slice(-3).join(" | "));
    check("the cursor was dragged (>= 100 px) but never further than 400 CSS px", far >= 100 && far <= lim, `${far.toFixed(0)} px, limit ${lim.toFixed(0)}`);
    const steps = t.rows.slice(1).map((r, i) => dist(r, t.rows[i]));
    check("the cursor moved in small steps (no teleport)", Math.max(...steps) <= 26 * dpr * 2.5 + 6, `max ${Math.max(...steps).toFixed(1)} px per sample`);
    check("he cast, reeled, then giggled", ["hook_cast", "hook_reel", "virus_giggle"].every((a) => seen.includes(a)), seen.join(">"));
    const changed = t.rows.filter((r, i) => i > 0 && (r.x !== t.rows[i - 1].x || r.y !== t.rows[i - 1].y));
    const dur = changed.length ? changed.at(-1).t - changed[0].t : 0;
    check("it lasted at most 8.5 s", dur <= 8500, `${(dur / 1000).toFixed(1)} s of movement`);
    void start;
  }

  if (want("diag2")) {
    await quiet(5500);
    await act(mascot, "note");
    await sleep(9000);
    tool("shot", path.join(OUT, "diag-note.png"), String(ax), String(ay + ah - 400), "900", "400");
    await act(mascot, "popup:adopted");
    await sleep(2500);
    tool("shot", path.join(OUT, "diag-popup.png"), String(ax + aw - 600), String(ay + ah - 400), "600", "400");
    console.log(tool("styles", String(proc.pid)).stdout);
  }
  if (want("diag")) {
    await parkCursor(mascot);
    await act(mascot, "hook:pull");
    await sleep(3200);
    const fxp = await page("chaosfx", 5000);
    const info2 = await mascot.evaluate(() => {
      const c = window.__glitch.creature;
      return { body: { x: c.body.x, y: c.body.y }, tip: c.rodTip(), anim: c.animation, frame: c.animator.pose?.frame, left: c.facingLeft, win: c.windowPos, dpr: devicePixelRatio };
    });
    const fxs = await fxp.evaluate(() => window.__fx?.state());
    console.log("creature", JSON.stringify(info2));
    console.log("overlay", JSON.stringify(fxs));
    const cx = Math.round(info2.tip.x), cy = Math.round(info2.tip.y);
    tool("shot", path.join(OUT, "diag-rod.png"), String(cx - 120), String(cy - 90), "240", "180");
    console.log("rod tip at", cx, cy, "(the shot is centred on it)");
    await sleep(8000);
  }

  // ---------------------------------------------------------- user wins
  if (want("abort")) {
    const sims = [
      ["move", "move:30,0", "user_input"],
      ["button", "button", "button"],
      ["esc", "esc", "esc"],
      ["hotkey", "hotkey", "stopped"],
    ];
    for (const [name, sim, why] of sims) {
      await parkCursor(mascot);
      const tr = bg("dev/chaos2-tool.py", "trace", path.join(OUT, `abort-${name}.json`), "--pids", pids, "--ms", "7000", "--hz", "500", "--trigger", "moved:40", "--sim", sim, "--delay", "400");
      await sleep(500);
      const f = name === "move" ? await film("abort-move", 8, 10) : null;
      await act(mascot, "hook:circle");
      const seen = await anims(mascot, 6500);
      await tr.done;
      await f?.done;
      const t = readJson(path.join(OUT, `abort-${name}.json`));
      if (t.note) {
        check(`abort by ${name}`, false, t.note);
        continue;
      }
      // After the user event the cursor must not be moved by Glitch any more: the position stays put
      // (for "move", from the injected jump on). Latency = last time the position changed after the event.
      const after = t.rows.filter((r) => r.t >= t.fired_ms);
      const jump = name === "move" ? 1 : 0;
      let last = t.fired_ms;
      for (let i = 1 + jump; i < after.length; i++) if (after[i].x !== after[i - 1].x || after[i].y !== after[i - 1].y) last = after[i].t;
      const latency = last - t.fired_ms;
      check(`${name}: the cursor is let go within 100 ms`, latency <= 100, `${latency.toFixed(0)} ms`);
      const tail = after.filter((r) => r.t > t.fired_ms + 400);
      check(`${name}: and stays where the user left it`, tail.length > 20 && tail.every((r) => r.x === tail[0].x && r.y === tail[0].y), `${tail.length} samples`);
      check(`${name}: he reacts (startled, flop, pout)`, seen.includes("startled") || seen.includes("annoyed") || seen.includes("splat"), seen.join(">"));
      const reasons = name === "hotkey" ? "UserInput|Stopped" : { user_input: "UserInput", button: "Button", esc: "Esc" }[why];
      check(`${name}: Rust logged why`, new RegExp(`ended after \\d+ ms: Some\\((${reasons})\\)`).test(log), why);
      if (name === "hotkey") {
        const s = readJson(path.join(APPDIR, "settings.json"));
        check("hotkey: the panic button is on (Glitch paused)", s.safety?.paused === true);
        const panel0 = mascot;
        await invoke(panel0, "show_panel", { view: "settings" }).catch(() => {});
        const panel = await page("panel");
        await invoke(panel, "safety_set_paused", { paused: false });
        await sleep(1500);
        await invoke(panel, "hide_panel").catch(() => {});
      }
      await sleep(1500);
    }
  }

  // ------------------------------------------------------ cursor classics
  if (want("classics")) {
    for (const [what, check1] of [
      ["orbit", (rows, st) => Math.max(...rows.map((r) => dist(r, st))) > 30 && Math.max(...rows.map((r) => dist(r, st))) <= 160 * dpr + 3],
      ["jitter", (rows, st) => Math.max(...rows.map((r) => dist(r, st))) <= 6 * dpr + 2],
      ["hops", (rows, st) => rows.some((r) => dist(r, st) >= 10 * dpr - 1) && Math.max(...rows.map((r) => dist(r, st))) <= 120 * dpr + 3],
    ]) {
      await parkCursor(mascot);
      const tr = bg("dev/chaos2-tool.py", "trace", path.join(OUT, `${what}-trace.json`), "--pids", pids, "--ms", "8500", "--hz", "250");
      await sleep(500);
      await act(mascot, what);
      await tr.done;
      const t = readJson(path.join(OUT, `${what}-trace.json`));
      check(`${what}: stays inside its limits`, check1(t.rows, t.start), `max ${Math.max(...t.rows.map((r) => dist(r, t.start))).toFixed(0)} px`);
    }
  }

  // ------------------------------------------------------ screen effects
  if (want("fx")) {
    for (const [what, secs] of [
      ["trail", 7],
      ["matrix", 6.5],
      ["scanlines", 5],
      ["melt", 7],
      ["bugs", 11],
      ["swarm", 10.5],
      ["popup:ram", 13],
      ["popup:raccoons", 13],
      ["popup:adopted", 9],
    ]) {
      await quiet(5500);
      const name = what.replace(":", "-");
      const f = await film(name, secs, what === "trail" ? 12 : 8);
      // The ghost trail needs a moving cursor: the helper (our own, over our stage) wiggles it.
      let wig = null;
      if (what === "trail") wig = bg("dev/chaos2-tool.py", "wiggle", "0");
      await sleep(400);
      const ok = await act(mascot, what);
      await f.done;
      check(`${what}: runs`, ok === true, ok ? "" : log.split("\n").filter((l) => /chaos2/.test(l)).slice(-2).join(" | "));
      wig?.kill();
      await sleep(1200);
    }
  }

  // ----------------------------------------------------------- dances
  if (want("dance")) {
    for (const kind of ["wobble", "edge_slide", "quake", "run_away"]) {
      await parkCursor(mascot, 500, -50);
      if (kind === "run_away") {
        // The cursor waits just right of window A: it should slide away from it.
        const f = path.join(OUT, "snap-a.json");
        tool("snapshot", f, "--skip-pid", "-1");
        const a = readJson(f).find((w) => String(w.hwnd) === H.A);
        tool("setpos", String(a.rect[2] + 30), String(Math.round((a.rect[1] + a.rect[3]) / 2)));
        await quiet(5500);
      }
      const tr = bg("dev/chaos2-tool.py", "trace", path.join(OUT, `dance-${kind}.json`), "--pids", pids, "--ms", "13000", "--hz", "100", ...hw("A", "B", "unsaved", "focus"));
      const f = kind === "quake" || kind === "edge_slide" ? await film(`dance-${kind}`, 12, 10) : null;
      await sleep(400);
      const ok = await act(mascot, `dance:${kind}`);
      await sleep(11500);
      await tr.done;
      await f?.done;
      const t = readJson(path.join(OUT, `dance-${kind}.json`));
      const first = t.rows[0].w;
      const last = t.rows.at(-1).w;
      const moved = Object.keys(first).filter((k) => t.rows.some((r) => r.w[k].some((v, i) => v !== first[k][i])));
      check(`${kind}: a window danced`, ok === true && moved.length >= 1, `moved: ${moved.map((k) => Object.entries(H).find(([, v]) => v === k)?.[0]).join(",")}`);
      check(`${kind}: the unsaved window never moved`, !moved.includes(H.unsaved));
      for (const k of moved) {
        const name = Object.entries(H).find(([, v]) => v === k)?.[0];
        check(`${kind}: ${name} came back to where it was (carried back)`, first[k].slice(0, 4).every((v, i) => Math.abs(v - last[k][i]) <= 2), `${first[k]} -> ${last[k]}`);
        const sizes = new Set(t.rows.map((r) => `${r.w[k][2] - r.w[k][0]}x${r.w[k][3] - r.w[k][1]}`));
        check(`${kind}: ${name} was never resized`, sizes.size === 1, [...sizes].join(","));
        const inside = t.rows.every((r) => r.w[k][0] >= ax - 8 && r.w[k][1] >= ay - 1 && r.w[k][2] <= ax + aw + 8 && r.w[k][3] <= ay + ah + 1);
        check(`${kind}: ${name} stayed inside the work area`, inside);
        if (kind === "quake") {
          const amp = Math.max(...t.rows.map((r) => Math.max(Math.abs(r.w[k][0] - first[k][0]), Math.abs(r.w[k][1] - first[k][1]))));
          check("quake: at most 6 CSS px", amp <= 6 * dpr + 2, `${amp} px`);
        }
      }
      await sleep(1500);
    }
  }

  // ----------------------------------------------------------- yoink
  if (want("yoink")) {
    // The foreground sampler needs 30 s of watching first.
    await sleep(Math.max(0, 36000 - (Date.now() - (globalThis.__t0 ?? Date.now()))));
    const states = async () => {
      const f = path.join(OUT, "snap.json");
      tool("snapshot", f, "--skip-pid", "-1");
      const s = readJson(f);
      const pick = (hwnd) => s.find((w) => String(w.hwnd) === String(hwnd));
      return { A: pick(H.A), B: pick(H.B), unsaved: pick(H.unsaved), focus: pick(H.focus), fg: s.find((w) => w.fg) };
    };
    for (const variant of ["timer", "user", "esc", "exit"]) {
      await quiet(5500);
      const tr = bg("dev/chaos2-tool.py", "trace", path.join(OUT, `yoink-${variant}.json`), "--pids", pids, "--ms", variant === "timer" ? "20000" : "9000", "--hz", "50", ...hw("A", "B", "unsaved", "focus"), ...(variant === "esc" ? ["--sim", "esc", "--trigger", "none", "--delay", "3500"] : []));
      const f = variant === "timer" ? await film("yoink", 19, 8) : null;
      await sleep(400);
      const t0 = Date.now();
      const ok = await act(mascot, "yoink");
      check(`yoink (${variant}): starts`, ok === true, log.split("\n").filter((l) => /yoink|chaos2/.test(l)).slice(-2).join(" | "));
      await sleep(2500);
      const mid = await states();
      const gone = ["A", "B"].filter((k) => mid[k]?.iconic);
      check(`yoink (${variant}): exactly one window is minimised, never the unsaved or focused one`, gone.length === 1 && !mid.unsaved.iconic && !mid.focus.iconic, gone.join(","));
      check(`yoink (${variant}): the focus did not move`, mid.fg?.hwnd === info.windows.focus, `${mid.fg?.title}`);
      if (variant === "user") {
        await sleep(1500);
        tool("restore", H[gone[0]], pids); // the user clicks its taskbar button
        await sleep(1800);
        const after = await states();
        check("yoink (user): the user's restore is respected, he doesn't minimise or touch it again", !after[gone[0]].iconic);
        await sleep(9000);
        const later = await states();
        check("yoink (user): still there 9 s later", !later[gone[0]].iconic && /left alone|restored\/closed by the user/.test(log));
      } else if (variant === "esc") {
        await sleep(2200);
        const after = await states();
        check("yoink (Esc): restored at once", gone.length === 1 && !after[gone[0]].iconic);
      } else if (variant === "exit") {
        await sleep(1500);
        await invoke(mascot, "quit").catch(() => {});
        await sleep(3500);
        const after = await states();
        check("yoink (exit): Glitch quit while a window was minimised: it is back", gone.length === 1 && !after[gone[0]].iconic, `iconic=${after[gone[0]]?.iconic}`);
      } else {
        await sleep(17000);
        const after = await states();
        check("yoink (timer): popped back by itself", gone.length === 1 && !after[gone[0]].iconic);
        const t = Date.now() - t0;
        void t;
      }
      await tr.done;
      await f?.done;
      if (variant === "timer" || variant === "user" || variant === "esc") {
        const t = readJson(path.join(OUT, `yoink-${variant}.json`));
        const k = gone[0] ? H[gone[0]] : null;
        if (k) {
          const goneAt = t.rows.find((r) => r.w[k][4] === 1)?.t;
          const backAt = t.rows.find((r) => r.t > (goneAt ?? 1e9) && r.w[k][4] === 0)?.t;
          if (variant === "timer") check("yoink (timer): back after 8 to 15 s", goneAt !== undefined && backAt !== undefined && backAt - goneAt >= 7500 && backAt - goneAt <= 15800, `${((backAt - goneAt) / 1000).toFixed(1)} s`);
          if (variant === "esc") {
            const escAt = t.fired_ms;
            check("yoink (Esc): back within 500 ms of Esc", escAt && backAt !== undefined && backAt - escAt <= 500, `${(backAt - escAt).toFixed(0)} ms`);
          }
        }
      }
      if (variant === "exit") {
        await launch();
        await page("mascot");
        break;
      }
      await sleep(2000);
    }
  }

  // ------------------------------------------------------ the settings card
  if (want("panel") && alive()) {
    await invoke(await page("mascot"), "show_panel", { view: "settings" }).catch(() => {});
    const panel = await page("panel");
    await panel.waitForSelector(".chaos-feature", { timeout: 20000 });
    await panel.evaluate(() => document.querySelector(".chaos-feature")?.scrollIntoView({ block: "center" }));
    await sleep(500);
    await panel.screenshot({ path: path.join(OUT, "panel-1-card.png") });
    // Switch to Gentle first (so Full Virus asks again if it was never confirmed in this profile).
    await panel.getByRole("radio", { name: "Mischief" }).click();
    await sleep(500);
    let s = readJson(path.join(APPDIR, "settings.json"));
    check("panel: Mischief switches level without a dialog", s.chaos_level === "mischief");
    // Forget the confirmation to see the dialog.
    const raw = readJson(path.join(APPDIR, "settings.json"));
    writeFileSync(path.join(APPDIR, "settings.json"), JSON.stringify({ ...raw, chaos_full_confirmed: false }));
    await sleep(300);
    await panel.evaluate(() => document.querySelector(".chaos-feature")?.scrollIntoView({ block: "center" }));
    await invoke(panel, "get_settings");
    await panel.getByRole("radio", { name: "Full Virus" }).click();
    await panel.waitForSelector('[role="alertdialog"]', { timeout: 5000 }).catch(() => {});
    const dlg = await panel.$('[role="alertdialog"]');
    check("panel: Full Virus first asks for a confirmation (with Test and Cancel)", !!dlg && (await dlg.innerText()).includes("move your mouse pointer"));
    await panel.screenshot({ path: path.join(OUT, "panel-2-confirm.png") });
    if (dlg) {
      await dlg.getByRole("button", { name: "Test" }).click();
      await sleep(1800);
      const shot = path.join(OUT, "panel-3-test-popup.png");
      tool("shot", shot, String(ax), String(ay), String(aw), String(ah));
      await panel.getByRole("button", { name: "Stop" }).first().click().catch(() => {});
    }
    await panel.getByRole("button", { name: "Cancel" }).click();
    await sleep(400);
    s = readJson(path.join(APPDIR, "settings.json"));
    check("panel: Cancel leaves the level alone", s.chaos_level === "mischief" && !s.chaos_full_confirmed);
    await panel.getByRole("radio", { name: "Full Virus" }).click();
    await panel.getByRole("button", { name: "Switch on Full Virus" }).click();
    await sleep(800);
    s = readJson(path.join(APPDIR, "settings.json"));
    check("panel: confirming sets Full Virus and remembers the confirmation", s.chaos_level === "full_virus" && s.chaos_full_confirmed === true);
    await panel.evaluate(() => document.querySelector(".chaos-feature")?.scrollIntoView({ block: "center" }));
    await panel.screenshot({ path: path.join(OUT, "panel-4-full-virus.png") });
    const stop = await invoke(panel, "chaos2_stop").then(() => true, () => false);
    check("panel: Stop works", stop);
  }

  // ------------------------------------------------ nobody else's windows
  const afterFile = path.join(OUT, "windows-after.json");
  tool("snapshot", afterFile, "--skip-pid", String(info.pid));
  const b = readJson(before).filter((w) => w.pid !== proc?.pid);
  const a = readJson(afterFile);
  const diffs = [];
  for (const w of b) {
    const n = a.find((x) => x.hwnd === w.hwnd);
    if (!n) continue; // closed by its owner
    if (/^Glitch/.test(w.title)) continue; // an installed Glitch walking about on its own
    if (w.iconic !== n.iconic || w.rect.some((v, i) => Math.abs(v - n.rect[i]) > 2)) diffs.push(`${w.title.slice(0, 30)}: ${w.rect} -> ${n.rect} iconic ${w.iconic}->${n.iconic}`);
  }
  check("no window of anybody else was moved, minimised or resized", diffs.length === 0, diffs.join(" | ") || `${b.length} windows compared`);
  check("no errors in the app's log", !/panicked|thread '.*' panicked/.test(log), (log.match(/panicked.*/) ?? [""])[0]);
} catch (e) {
  console.error("check crashed:", e);
  results.push({ name: "crash", ok: false });
} finally {
  writeFileSync(path.join(OUT, "app-log.txt"), log);
  await cleanup();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
