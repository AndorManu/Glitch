// Real-app check of the context reactions: GLITCH_CONTEXT_DEBUG (Rust trigger, 10 s after start) and
// __glitch.react (every reaction). Records the animations he plays and screenshots the mascot page during each.
//
//   node dev/context-check.mjs <copy>.exe <own identifier> [out-dir]
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const [exe, ID, outArg] = process.argv.slice(2);
if (!exe || !ID || ID === "dev.glitch.companion") {
  console.error("usage: node dev/context-check.mjs <exe> <own identifier> [out-dir]");
  process.exit(2);
}
const OUT = outArg ?? "dev/out/context";
mkdirSync(OUT, { recursive: true });
const config = join(process.env.APPDATA, ID);
const PORT = 9291;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`);
};

rmSync(config, { recursive: true, force: true });
mkdirSync(config, { recursive: true });
writeFileSync(join(config, "settings.json"), JSON.stringify({ model: "qwen3.5:4b", onboarding_done: true, movement_enabled: true, chaos_enabled: false }));
const proc = spawn(exe, [], {
  env: { ...process.env, GLITCH_DRY_RUN_ACTIONS: "1", GLITCH_CONTEXT_DEBUG: "dance,glasses", WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: ["ignore", "ignore", "pipe"],
});
let log = "";
proc.stderr.on("data", (d) => (log += d));
let browser;
try {
  for (let i = 0; i < 80 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    } catch {
      await sleep(500);
    }
  }
  let mascot;
  for (let i = 0; i < 60 && !mascot; i++) {
    mascot = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("mascot.html"));
    if (!mascot) await sleep(500);
  }
  await mascot.waitForFunction(() => window.__glitch?.creature?.world, null, { timeout: 30000 });
  await mascot.evaluate(() => {
    window.__ev = [];
    window.__glitch.creature.onEvent = (e) => window.__ev.push(e);
  });
  const anim = () => mascot.evaluate(() => window.__glitch.creature.animation);
  const seqFor = async (ms, shot) => {
    const seq = [];
    const t0 = Date.now();
    let shotDone = false;
    while (Date.now() - t0 < ms) {
      const a = await anim();
      if (seq.at(-1) !== a) seq.push(a);
      if (shot && !shotDone && Date.now() - t0 > 2500 && !["idle", "idle_tail"].includes(a)) {
        await mascot.screenshot({ path: join(OUT, `${shot}.png`), omitBackground: true });
        shotDone = true;
      }
      await sleep(150);
    }
    return seq;
  };

  // 1. The Rust debug trigger: starts 10 s after launch (dance, then glasses 6 s later).
  const envSeq = await seqFor(26_000, "env-first");
  console.log("GLITCH_CONTEXT_DEBUG sequence:", envSeq.join(" > "));
  check("GLITCH_CONTEXT_DEBUG plays the dance", envSeq.some((a) => /dance/.test(a)), envSeq.join(" > "));
  check("GLITCH_CONTEXT_DEBUG plays the glasses typing", envSeq.some((a) => /glasses|typing/.test(a)), envSeq.join(" > "));
  check("debug trigger logged", /debug context trigger: dance/.test(log), log.split("\n").filter((l) => /context/.test(l)).slice(0, 3).join(" | "));

  // 2. Every reaction through __glitch.react.
  const names = ["dance", "glasses", "watch", "night", "morning", "battery", "cpu", "quiet", "unquiet", "suggest"];
  for (const n of names) {
    // Back to a calm floor first.
    await mascot.evaluate(() => window.__glitch.play("idle"));
    // Wait until he is free to react (a running reaction or plan, a pending retry, the mouse over him...).
    let free = false;
    // A watch/dance loop can run for a long time: stop whatever plays first.
    for (let i = 0; i < 80 && !free; i++) {
      await sleep(250);
      free = await mascot.evaluate(() => window.__glitch.creature.canReact() && !window.__glitch.reactor.pending);
    }
    const why = free ? "" : await mascot.evaluate(() => { const c = window.__glitch.creature; return JSON.stringify({ plan: c.plan?.name, mode: c.mode, hovered: c.hovered, annoy: c.annoyance, mood: c.mood, panel: c.panelOpen, sulk: c.sulking, quiet: window.__glitch.reactor.quiet }); });
    if (!free) console.log(`  (${n}: he never became free: ${why})`);
    await mascot.evaluate(() => (window.__ev = []));
    const ok = await mascot.evaluate((x) => window.__glitch.react(x), n);
    const seq = await seqFor(n === "night" || n === "morning" ? 9_000 : 8_000, `react-${n}`);
    console.log(`react ${n} (accepted=${ok}): ${seq.join(" > ")}   events: ${(await mascot.evaluate(() => window.__ev)).filter((e) => !/^(land|walk|ledges|haul)/.test(e)).slice(0, 8).join(" ")}`);
    const played = seq.filter((a) => !["idle", "idle_tail", "idle_tail_sit"].includes(a));
    const evs = await mascot.evaluate(() => window.__ev);
    // A reaction that arrives while an earlier one still runs waits its turn (pending) and may play later.
    check(`reaction "${n}" plays something or is queued`, n === "unquiet" || played.length > 0 || evs.some((e) => /context/.test(e)), `accepted=${ok}, ${seq.join(" > ")}`);
  }
  // The bubble line some reactions say.
  const bubble = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("bubble.html"));
  if (bubble) {
    const t = await bubble.evaluate(() => document.querySelector(".speech .balloon .say .sr")?.textContent ?? "");
    console.log("bubble text after reactions:", JSON.stringify(t));
    check("bubble line has no em/en dash", !/[–—]/.test(t), t);
  }
  const errs = log.split("\n").filter((l) => /panic|error/i.test(l));
  check("no errors in the app log", errs.length === 0, errs.slice(0, 3).join(" | "));
} catch (e) {
  check("run", false, String(e?.stack ?? e));
} finally {
  await browser?.close().catch(() => {});
  try {
    execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {}
  rmSync(config, { recursive: true, force: true });
}
writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 1));
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
