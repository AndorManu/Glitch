// Real-app chat check (own identifier, dry-run actions, the real local Ollama): the greeting varies, no
// reply contains an em or en dash, the thinking cloud shows, an approval card defaults to "Nope", look-at-screen
// answers, and the tools run: clipboard, timer, note, calculator, web search. Screenshots of each go to OUT.
//
//   node dev/chat-check.mjs <copy>.exe <own identifier> [out-dir] [--model qwen3.5:4b] [--no-screen] [--no-clipboard]
//
// The clipboard case puts a test text on the clipboard and restores the previous text afterwards (skipped
// with --no-clipboard). The screen case sends a screenshot of this computer to the local model only.
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const pos = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--model");
const [exe, ID, outArg] = pos;
if (!exe || !ID || ID === "dev.glitch.companion") {
  console.error("usage: node dev/chat-check.mjs <exe> <own identifier> [out-dir]");
  process.exit(2);
}
const only = (argv.find((a) => a.startsWith("--only=")) ?? "").slice(7).split(",").filter(Boolean);
const on = (n) => only.length === 0 || only.includes(n);
// --only=clipboard runs live (no dry run): the clipboard write is skipped in dry-run mode on purpose.
const LIVE = only.length === 1 && only[0] === "clipboard";
const model = argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : "qwen3.5:4b";
const OUT = outArg ?? "dev/out/chat";
mkdirSync(OUT, { recursive: true });
const config = join(process.env.APPDATA, ID);
const PORT = 9281;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${String(detail).slice(0, 260)}` : ""}`);
};
const DASH = /[–—]/;

rmSync(config, { recursive: true, force: true });
mkdirSync(config, { recursive: true });
writeFileSync(join(config, "settings.json"), JSON.stringify({ model, onboarding_done: true, movement_enabled: false, chaos_enabled: false, screen_enabled: !flag("--no-screen"), update_me: { briefing_enabled: false } }));

const ps = (cmd) => execFileSync("powershell", ["-NoProfile", "-Command", cmd], { encoding: "utf8" });
let savedClip = null;
if (!flag("--no-clipboard")) {
  try {
    savedClip = ps("Get-Clipboard -Raw") ?? "";
  } catch {
    savedClip = null;
  }
}

const proc = spawn(exe, [], {
  env: { ...process.env, ...(LIVE ? {} : { GLITCH_DRY_RUN_ACTIONS: "1" }), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: "ignore",
});
let browser;
const pages = () => browser.contexts().flatMap((c) => c.pages());
const page = async (part) => {
  for (let i = 0; i < 60; i++) {
    const p = pages().find((x) => x.url().includes(part));
    if (p) return p;
    await sleep(500);
  }
  throw new Error(`no ${part} page`);
};
const invoke = (p, cmd, args = {}) => p.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
const speech = (b) =>
  b.evaluate(() => {
    const bal = document.querySelector(".speech .balloon");
    return bal
      ? { cls: bal.className, text: (bal.querySelector(".say .sr")?.textContent ?? bal.querySelector(".say")?.textContent ?? "").trim(), actions: [...bal.querySelectorAll(".actions li, .action")].map((e) => e.textContent.trim()), choices: [...bal.querySelectorAll(".choice")].map((e) => e.textContent.trim()), focused: document.activeElement?.className ?? "", detail: bal.querySelector(".detail")?.textContent ?? "" }
      : null;
  });
const thinking = (b) => b.evaluate(() => !!document.querySelector(".thought .cloud"));

/**
 * Type a message in the real bubble; poll for the cloud, then wait for a NEW final reply. A confirm card is
 * answered with Allow when `allow` is set (the tools that ask first: notes, clipboard, web search), else it is
 * the result.
 */
async function ask(bubble, text, shot, { allow = false, wait = 90_000 } = {}) {
  const before = (await speech(bubble))?.text ?? "";
  await bubble.fill(".input", text);
  await bubble.keyboard.press("Enter");
  let cloud = false;
  const cards = [];
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < wait) {
    await sleep(200);
    if (await thinking(bubble)) {
      cloud = true;
      if (shot && !shot.done) {
        await bubble.screenshot({ path: join(OUT, `${shot.name}-thinking.png`) });
        shot.done = true;
      }
      continue;
    }
    const s = await speech(bubble);
    if (!s || s.text === before || !cloud) continue;
    if (/confirm/.test(s.cls)) {
      if (!allow) {
        last = s;
        break;
      }
      cards.push(s.text);
      await bubble.screenshot({ path: join(OUT, `${shot?.name ?? "card"}-card.png`) });
      await bubble.click(".choice.yes");
      await sleep(600);
      continue;
    }
    await sleep(1200);
    if (!(await thinking(bubble))) {
      last = await speech(bubble);
      if (last && !/confirm/.test(last.cls)) break;
    }
  }
  return { cloud, s: last, ms: Date.now() - t0, cards };
}

try {
  for (let i = 0; i < 80 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    } catch {
      await sleep(500);
    }
  }
  const mascot = await page("mascot.html");
  await mascot.waitForFunction(() => !!window.__TAURI_INTERNALS__, null, { timeout: 30000 });
  await sleep(2500);

  // 1. Greeting: picked once per start of the bubble page (pickGreeting); reopening shows the same line.
  const greetings = [];
  let bubble;
  for (let i = 0; i < (on("greeting") ? 4 : 1); i++) {
    await invoke(mascot, "mascot_clicked");
    bubble ??= await page("bubble.html");
    await sleep(1400);
    const s = await speech(bubble);
    if (s?.text) greetings.push(s.text);
    if (i === 0) await bubble.screenshot({ path: join(OUT, "greeting.png") });
    await invoke(mascot, "mascot_clicked");
    await sleep(900);
  }
  console.log("greetings:", JSON.stringify(greetings));
  if (only.length === 0) check("greeting is a short hello or none (30% of starts say nothing, by design)", greetings.every((g) => g.length < 140), greetings[0] ?? "(quiet start)");
  check("greetings have no em/en dash", greetings.every((g) => !DASH.test(g)));

  await invoke(mascot, "mascot_clicked");
  await sleep(1200);
  const replies = [];
  const note = (name, r, extra = "") => {
    replies.push({ name, text: r.s?.text, cls: r.s?.cls, actions: r.s?.actions });
    console.log(`  [${name}] ${r.ms} ms cloud=${r.cloud} cards=${JSON.stringify(r.cards ?? [])} ${JSON.stringify(r.s?.text ?? null).slice(0, 220)} actions=${JSON.stringify(r.s?.actions ?? [])}${extra}`);
  };

  // 2. Small talk + thinking cloud + no dashes
  let r;
  if (on("chat")) {
  r = await ask(bubble, "hi! how are you today?", { name: "smalltalk" });
  note("small talk", r);
  check("thinking cloud shows while he works", r.cloud);
  check("small talk answers", !!r.s?.text && /reply/.test(r.s.cls), r.s?.text);
  await bubble.screenshot({ path: join(OUT, "smalltalk-reply.png") });

  }
  if (on("chat")) {
  // 3. Calculator
  r = await ask(bubble, "what is 15% of 240? use the calculator", { name: "calc" });
  note("calculator", r);
  check("calculator: 36", /\b36\b/.test(r.s?.text ?? ""), r.s?.text);
  await bubble.screenshot({ path: join(OUT, "calc-reply.png") });

  // 4. Timer
  r = await ask(bubble, "set a timer for 2 minutes called tea", { name: "timer" }, { allow: true });
  note("timer", r);
  check("timer set", /timer|tea|2 min|minutes/i.test(`${r.s?.text} ${(r.s?.actions ?? []).join(" ")}`), r.s?.text);
  await bubble.screenshot({ path: join(OUT, "timer-reply.png") });

  // 5. Note
  r = await ask(bubble, "write a note: buy oat milk tomorrow", { name: "note" }, { allow: true });
  note("note", r);
  check("note written", /note|oat milk|wrote|saved|put/i.test(`${r.s?.text} ${(r.s?.actions ?? []).join(" ")}`), r.s?.text);
  await bubble.screenshot({ path: join(OUT, "note-reply.png") });

  }
  // 6. Clipboard (test text, restored afterwards)
  if (!flag("--no-clipboard") && on("clipboard")) {
    r = await ask(bubble, "copy the text glitch qa clipboard test to my clipboard", { name: "clip" }, { allow: true });
    note("clipboard copy", r);
    let now = "";
    try {
      now = ps("Get-Clipboard -Raw");
    } catch {}
    check("clipboard tool put the text on the clipboard", /glitch qa clipboard test/i.test(now), JSON.stringify(now).slice(0, 80));
    r = await ask(bubble, "what's on my clipboard right now?", { name: "clip2" }, { allow: true });
    note("clipboard read", r);
    check("clipboard read answers with the text", /glitch qa clipboard test/i.test(r.s?.text ?? ""), r.s?.text);
    await bubble.screenshot({ path: join(OUT, "clipboard-reply.png") });
  }

  if (on("chat")) {
  // 7. Web search
  r = await ask(bubble, "search the web: how tall is Mont Blanc in metres?", { name: "web" }, { allow: true });
  note("web search", r);
  check("web search answers with a height (or opens a search page)", /4[,.\s]?8\d\d|4808|4807|4805|opened a search/i.test(r.s?.text ?? ""), r.s?.text);
  await bubble.screenshot({ path: join(OUT, "web-reply.png") });

  // 8. Approval card: default is Nope
  r = await ask(bubble, "please open the calculator app", { name: "approve" });
  note("approval", r, ` choices=${JSON.stringify(r.s?.choices)} focused=${r.s?.focused}`);
  const isCard = /confirm/.test(r.s?.cls ?? "") || (r.s?.choices ?? []).length >= 2;
  check("opening an app asks first (approval card)", isCard, JSON.stringify(r.s));
  if (isCard) {
    await bubble.screenshot({ path: join(OUT, "approval-card.png") });
    check("approval card: Nope is the default (focused)", /\bno\b/.test(r.s.focused), `focused=${r.s.focused}`);
    // Enter on the default must refuse.
    await bubble.keyboard.press("Enter");
    await sleep(2500);
    const after = await speech(bubble);
    check("Enter on the card says no (nothing opened)", !/opened|launching|started/i.test(after?.text ?? "") , after?.text);
    await bubble.screenshot({ path: join(OUT, "approval-after-nope.png") });
  }

  }
  // 9. Look at the screen
  if (!flag("--no-screen") && on("screen")) {
    r = await ask(bubble, "look at my screen and tell me in one sentence what you see", { name: "screen" }, { allow: true, wait: 150_000 });
    note("screen", r);
    check("look at screen answers", !!r.s?.text && r.s.text.length > 15 && /reply/.test(r.s.cls), String(r.s?.text).slice(0, 80));
    await bubble.screenshot({ path: join(OUT, "screen-reply.png") });
  }

  // 10. No em/en dashes anywhere
  const all = replies.map((x) => x.text ?? "");
  check("no reply contains an em or en dash", all.every((t) => !DASH.test(t)), all.filter((t) => DASH.test(t)).join(" | "));
  writeFileSync(join(OUT, "chat.json"), JSON.stringify({ greetings, replies }, null, 1));
} catch (e) {
  check("run", false, String(e?.stack ?? e));
} finally {
  await browser?.close().catch(() => {});
  try {
    execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {}
  if (savedClip !== null && !flag("--no-clipboard")) {
    try {
      const f = join(OUT, "clip.tmp");
      writeFileSync(f, savedClip, "utf8");
      ps(`Set-Clipboard -Value (Get-Content -Raw -LiteralPath '${f}')`);
      rmSync(f, { force: true });
    } catch {}
  }
  if (existsSync(config)) {
    for (const f of readdirSync(config)) if (/note|remind|timer/i.test(f)) console.log("  app data:", f);
    rmSync(config, { recursive: true, force: true });
  }
}
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
