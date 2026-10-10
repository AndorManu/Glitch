// Real-app check of "open an app that starts slowly": a debug build with its
// own identifier, a fresh QA profile (screen on, app control OFF) and a
// stand-in app that this script builds and starts itself
// (src-tauri/examples/fake_slow_app.rs, copied as SlowTune.exe): no window
// for 4 s, then an empty white window for 3 s, then a small music library.
// Nothing of the owner's is touched: opening apps is a dry run except for the
// stand-in, and Glitch may only see the stand-in's process
// (GLITCH_HANDS_ONLY_PIDS, GLITCH_QA_FAKE_APP; debug builds only).
//
// 1. "open SlowTune and tell me what you see": checks the bubble's steps
//    (Opening, Waiting for SlowTune to load... N s, Looking at SlowTune) and
//    that the answer describes the stand-in, not "isn't open".
// 2. "open SlowTune and find me a playlist it can play" (app control off):
//    checks the "I need app control" card, answers "Not now", then asks again
//    and answers "Turn on app control" (the setting must flip on).
//
//   npx tauri build --debug --no-bundle --config '{"identifier":"dev.glitch.slowapp.qa"}'
//   cargo build -p glitch --example fake_slow_app
//   node dev/slow-app-check.mjs <target>/debug/glitch.exe <target>/debug/examples/fake_slow_app.exe [out-dir]
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const [exe, fakeSlow, outArg] = process.argv.slice(2);
const OUT = outArg ?? mkdtempSync(join(tmpdir(), "glitch-slow-qa-"));
mkdirSync(OUT, { recursive: true });
const FRAMES = join(OUT, "frames");
rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });
const PORT = 9251;
const ID = "dev.glitch.slowapp.qa";
const config = join(process.env.APPDATA, ID);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

const work = mkdtempSync(join(tmpdir(), "glitch-slow-qa-app-"));
const appExe = join(work, "SlowTune.exe");
copyFileSync(fakeSlow, appExe);
const G = { x: 700, y: 150, w: 800, h: 520 };
const DELAY = 4;
const BLANK = 3;

rmSync(config, { recursive: true, force: true });
mkdirSync(config, { recursive: true });
const model = process.env.GLITCH_QA_MODEL ?? "qwen3.5:4b";
const settingsFile = join(config, "settings.json");
writeFileSync(
  settingsFile,
  JSON.stringify({ model, onboarding_done: true, movement_enabled: false, chaos_enabled: false, memory_enabled: false, screen_enabled: true, hands_enabled: false }),
);

const env = {
  ...process.env,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
  GLITCH_DRY_RUN_ACTIONS: "1",
  GLITCH_HANDS_ONLY_PIDS: "0",
  GLITCH_QA_FAKE_APP: ["SlowTune", appExe, "SlowTune", DELAY, BLANK, G.x, G.y, G.w, G.h].join("|"),
};
const proc = spawn(exe, [], { env, stdio: ["ignore", "ignore", "pipe"] });
let log = "";
proc.stderr.on("data", (d) => (log += d));

// Desktop frames: only the stand-in's region.
const grabber = spawn("python", ["dev/hands-frames.py", "grab", FRAMES, String(G.x - 20), String(G.y - 20), String(G.w + 40), String(G.h + 40)], { stdio: "ignore" });

let browser;
const page = async (part) => {
  for (let i = 0; i < 60; i++) {
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) if (p.url().includes(part)) return p;
    await sleep(500);
  }
  throw new Error(`no ${part} page`);
};
const invoke = (p, cmd, args = {}) => p.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
let shooting = false;
const shoot = async (bubble) => {
  if (shooting) return;
  shooting = true;
  try {
    await bubble.screenshot({ path: join(FRAMES, `b_${Date.now()}.png`), omitBackground: true });
  } catch {}
  shooting = false;
};
const killApp = () => {
  spawnSync("taskkill", ["/IM", "SlowTune.exe", "/F"], { stdio: "ignore" });
};
const balloonText = (bubble) => bubble.evaluate(() => (document.querySelector(".balloon")?.innerText ?? "").replace(/\s+/g, " ").trim());
const stepLabels = (bubble) => bubble.evaluate(() => [...document.querySelectorAll(".steps .step .label")].map((e) => e.textContent ?? ""));
const chips = (bubble) => bubble.evaluate(() => [...document.querySelectorAll(".chips .chip span")].map((e) => e.textContent ?? ""));

/** Send a message and answer cards by `decide(cardText)`: "yes" | "no" | "wait". Returns what was seen. */
async function ask(bubble, text, decide, tag) {
  await bubble.fill("textarea.input", text);
  await bubble.press("textarea.input", "Enter");
  const seen = { cards: [], labels: new Set(), reply: "", chips: [] };
  const shots = new Set();
  const t0 = Date.now();
  while (Date.now() - t0 < 150000) {
    for (const l of await stepLabels(bubble)) seen.labels.add(l);
    const labels = await stepLabels(bubble);
    if (labels.some((l) => /Waiting for SlowTune/.test(l)) && !shots.has("wait")) {
      shots.add("wait");
      await bubble.screenshot({ path: join(OUT, `${tag}-2-waiting.png`), omitBackground: true });
    }
    if (labels.some((l) => /Waiting for SlowTune to load\.\.\. [3-9] s/.test(l)) && !shots.has("wait3")) {
      shots.add("wait3");
      await bubble.screenshot({ path: join(OUT, `${tag}-3-waiting-seconds.png`), omitBackground: true });
    }
    const card = await bubble.$(".choice.yes:not([disabled])");
    const bt = await balloonText(bubble);
    if (card) {
      const decision = decide(bt, seen.cards.length);
      if (decision === "wait") {
        await sleep(300);
        continue;
      }
      seen.cards.push(bt);
      await sleep(1400); // the card refuses clicks in its first moment (anti mis-click)
      await bubble.screenshot({ path: join(OUT, `${tag}-1-card-${seen.cards.length}.png`), omitBackground: true });
      await (await bubble.$(decision === "yes" ? ".choice.yes" : ".choice.no")).click();
      await sleep(700);
      continue;
    }
    const busy = await bubble.evaluate(() => !!document.querySelector(".thought, .steps .step.running"));
    if (!busy && !card && bt && seen.cards.length >= 0 && (await bubble.$(".balloon")) && !(await bubble.$(".choices"))) {
      // A finished answer (typed out): give the typewriter a moment.
      await sleep(2500);
      seen.reply = await balloonText(bubble);
      seen.chips = await chips(bubble);
      await bubble.screenshot({ path: join(OUT, `${tag}-4-reply.png`), omitBackground: true });
      break;
    }
    await sleep(300);
  }
  return seen;
}

try {
  for (let i = 0; i < 80 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://localhost:${PORT}`);
    } catch {
      await sleep(500);
    }
  }
  const mascot = await page("mascot");
  await invoke(mascot, "mascot_clicked");
  const bubble = await page("bubble");
  await bubble.waitForSelector("textarea.input", { timeout: 20000 });
  await sleep(800);
  const ticker = setInterval(() => void shoot(bubble), 400);

  // ---- 1. open it and say what is in it
  let t0 = Date.now();
  const a = await ask(bubble, "open SlowTune and tell me what you see", (t) => (/SlowTune/.test(t) ? "yes" : "no"), "a");
  const took = (Date.now() - t0) / 1000;
  console.log(`  [a] ${took.toFixed(1)} s; steps: ${[...a.labels].join(" | ")}; chips: ${a.chips.join(" | ")}`);
  console.log(`  [a] reply: ${a.reply}`);
  const labels = [...a.labels];
  check("asked before opening the app", a.cards.length >= 1 && /SlowTune/.test(a.cards[0]), a.cards[0]);
  check("a step says Waiting for SlowTune to load", labels.some((l) => /Waiting for SlowTune to load/.test(l)), labels.join(" | "));
  check("the waiting step counts the seconds", labels.some((l) => /Waiting for SlowTune to load\.\.\. \d+ s/.test(l)));
  check("a step says it looked at SlowTune", labels.some((l) => /Looking at SlowTune/.test(l)) || a.chips.some((c) => /Looked at SlowTune/.test(c)), labels.join(" | "));
  check("chips: Opened SlowTune and Looked at SlowTune", a.chips.some((c) => /Opened SlowTune/.test(c)) && a.chips.some((c) => /Looked at SlowTune/.test(c)), a.chips.join(" | "));
  const named = ["rainy day jazz", "desert roads", "gym mix", "made for you", "your library"].filter((w) => a.reply.toLowerCase().includes(w)).length;
  check("the answer describes SlowTune's window", named >= 2, a.reply);
  check("the answer does not say it isn't open", !/isn.t (even )?open|not open|isn.t running/i.test(a.reply), a.reply);
  check("it waited for the slow start (at least the 4 s delay)", took >= DELAY, `${took.toFixed(1)} s`);

  // ---- 2. needs clicking inside, app control off
  killApp();
  await sleep(600);
  await invoke(bubble, "reset_chat");
  await sleep(500);
  const ask2 = "open SlowTune and find me a playlist it can play";
  const b = await ask(bubble, ask2, (t) => (/SlowTune/.test(t) && !/app control/i.test(t) ? "yes" : /app control/i.test(t) ? "no" : "wait"), "b");
  console.log(`  [b] cards: ${b.cards.join(" || ")}`);
  console.log(`  [b] reply: ${b.reply}`);
  check("app control card says what is needed", b.cards.some((c) => /I can open SlowTune, but to find and play a playlist I need app control/.test(c)), b.cards.join(" || "));
  check("the card has Turn on app control and Not now", existsSync(join(OUT, "b-1-card-2.png")));
  check("Not now: friendly answer, setting still off", /No problem/.test(b.reply) && JSON.parse(readFileSync(settingsFile, "utf8")).hands_enabled === false, b.reply);

  killApp();
  await sleep(600);
  await invoke(bubble, "reset_chat");
  await sleep(500);
  const c = await ask(bubble, ask2, (t) => (/SlowTune/.test(t) && !/app control/i.test(t) ? "yes" : /app control/i.test(t) ? "yes" : "wait"), "c");
  console.log(`  [c] cards: ${c.cards.join(" || ")}`);
  console.log(`  [c] reply: ${c.reply}`);
  check("Turn on app control flips the setting", JSON.parse(readFileSync(settingsFile, "utf8")).hands_enabled === true);
  check("then Glitch carries on (an answer arrived)", !!c.reply, c.reply);

  clearInterval(ticker);
  await sleep(500);
  await shoot(bubble);
} catch (e) {
  check("run", false, String(e?.stack ?? e));
} finally {
  writeFileSync(join(FRAMES, "stop"), "");
  await sleep(800);
  await browser?.close().catch(() => {});
  try {
    execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {}
  killApp();
  grabber.kill();
  await sleep(500);
  spawnSync("python", ["dev/hands-frames.py", "gif", FRAMES, join(OUT, "slow-app-demo.gif")], { stdio: "inherit" });
  rmSync(work, { recursive: true, force: true });
  rmSync(config, { recursive: true, force: true });
  writeFileSync(join(OUT, "app-log.txt"), log);
  writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed, files in ${OUT}`);
}
