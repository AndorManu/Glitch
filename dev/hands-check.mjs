// Real-app check of "Let Glitch control apps" (Hands). Launches a debug
// build with its own identifier and a fresh QA profile (app control on),
// starts a classic Notepad stand-in of its own (src-tauri/examples/
// fake_notepad.rs, copied as notepad.exe) and limits Glitch to that one
// process (GLITCH_HANDS_ONLY_PIDS), with dry-run actions so opening apps or
// web pages is only logged. Nothing of the owner's is touched: not his
// Notepad (its restored tabs), not his music (media controls are refused in
// this mode), not his windows.
//
// Asks "type hello in notepad" through the real bubble, answers the
// "Control Notepad for this" card, and checks the text landed in the
// stand-in. Screenshots of the bubble (card, live steps, reply), the
// Features card, and a GIF of the banner + Notepad + bubble go to OUT.
//
//   npx tauri build --debug --no-bundle --config '{"identifier":"dev.glitch.hands.qa"}'
//   cargo build -p glitch --example fake_notepad
//   node dev/hands-check.mjs <target>/debug/glitch.exe <target>/debug/examples/fake_notepad.exe [out-dir]
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const [exe, fakeNotepad, outArg] = process.argv.slice(2);
const OUT = outArg ?? mkdtempSync(join(tmpdir(), "glitch-hands-qa-"));
mkdirSync(OUT, { recursive: true });
const FRAMES = join(OUT, "frames");
rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });
const PORT = 9241;
const ID = "dev.glitch.hands.qa";
const config = join(process.env.APPDATA, ID);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

// The stand-in: its own folder, its own file, framed in the top middle of the screen.
const work = mkdtempSync(join(tmpdir(), "glitch-hands-qa-np-"));
const notepadExe = join(work, "notepad.exe");
copyFileSync(fakeNotepad, notepadExe);
const file = join(work, "ideas.txt");
writeFileSync(file, "");
const NP = { x: 560, y: 110, w: 800, h: 460 };
const np = spawn(notepadExe, [file, String(NP.x), String(NP.y), String(NP.w), String(NP.h)], { stdio: "ignore" });
await sleep(800);

// A fresh QA profile with app control on.
rmSync(config, { recursive: true, force: true });
mkdirSync(config, { recursive: true });
const model = process.env.GLITCH_QA_MODEL ?? "qwen3.5:4b";
writeFileSync(
  join(config, "settings.json"),
  JSON.stringify({ model, onboarding_done: true, movement_enabled: false, chaos_enabled: false, memory_enabled: false, hands_enabled: true }),
);

const env = {
  ...process.env,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
  GLITCH_DRY_RUN_ACTIONS: "1",
  GLITCH_HANDS_ONLY_PIDS: String(np.pid),
};
const proc = spawn(exe, [], { env, stdio: ["ignore", "ignore", "pipe"] });
let log = "";
proc.stderr.on("data", (d) => (log += d));

// Desktop frames: only the stand-in's region and the banner above it.
const grabber = spawn("python", ["dev/hands-frames.py", "grab", FRAMES, String(NP.x - 40), "0", String(NP.w + 80), String(NP.y + NP.h + 30)], { stdio: "ignore" });

/** The stand-in's text, read with UI Automation from PowerShell. */
function notepadText() {
  const ps = `Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes;
    $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, ${np.pid});
    $w = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $c);
    $e = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)));
    $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value`;
  const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8", timeout: 20000 });
  return (r.stdout ?? "").trim();
}

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

try {
  for (let i = 0; i < 80 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://localhost:${PORT}`);
    } catch {
      await sleep(500);
    }
  }
  const mascot = await page("mascot");
  await invoke(mascot, "show_bubble");
  const bubble = await page("bubble");
  await bubble.waitForSelector("textarea.input", { timeout: 20000 });
  await sleep(800);
  const ticker = setInterval(() => void shoot(bubble), 400);

  await bubble.fill("textarea.input", "type hello in notepad");
  await bubble.press("textarea.input", "Enter");

  // Answer cards: allow controlling the Notepad stand-in, decline anything else.
  const cards = [];
  let reply = "";
  let sawBanner = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    if (!sawBanner) sawBanner = browser.contexts().some((c) => c.pages().some((p) => p.url().includes("banner.html")));
    const card = await bubble.$(".choice.yes:not([disabled])");
    const busy = await bubble.evaluate(() => !!document.querySelector(".thought, .steps .step.running"));
    const text = await bubble.evaluate(() => document.querySelector(".balloon")?.innerText ?? "");
    if (card && /Allow/.test(await card.innerText())) {
      cards.push(text.replace(/\s+/g, " ").trim());
      await sleep(1300); // the card refuses clicks in its first moment (anti mis-click)
      await bubble.screenshot({ path: join(OUT, `1-card-${cards.length}.png`), omitBackground: true });
      if (/control Notepad|into Notepad/i.test(text)) await card.click();
      else await (await bubble.$(".choice.no")).click();
      await sleep(700);
      continue;
    }
    if (cards.length && !busy && /hello|Notepad|couldn|stopped/i.test(text) && !card) {
      reply = text;
      break;
    }
    await sleep(300);
  }
  clearInterval(ticker);
  await sleep(500);
  await shoot(bubble);
  await bubble.screenshot({ path: join(OUT, "3-reply.png"), omitBackground: true });
  check("asked to control Notepad first", cards.some((c) => /control Notepad/i.test(c)), JSON.stringify(cards));
  check("replied", !!reply, reply.replace(/\s+/g, " ").slice(0, 200));
  const typed = notepadText();
  check("hello is in the Notepad stand-in", /^hello$/i.test(typed), JSON.stringify(typed));
  check("the driving banner was up while Glitch acted", sawBanner);
  const bannerGone = !browser.contexts().some((c) => c.pages().some((p) => p.url().includes("banner.html")));
  check("the banner is gone after the task", bannerGone);

  // The Features card.
  await invoke(mascot, "show_panel", { view: "settings" });
  const panel = await page("panel");
  await panel.waitForFunction(() => document.body.innerText.includes("Let Glitch control apps"), null, { timeout: 20000 });
  await panel.evaluate(() => {
    const el = [...document.querySelectorAll(".hands-feature")][0];
    el?.closest("section")?.scrollIntoView({ block: "start" });
    el?.scrollIntoView({ block: "center" });
  });
  await sleep(500);
  await panel.screenshot({ path: join(OUT, "4-features-card.png") });
  check("Features card shows the app-control switch on", await panel.evaluate(() => !!document.querySelector(".hands-feature input[role=switch]:checked")));
} catch (e) {
  check("run", false, String(e?.stack ?? e));
} finally {
  writeFileSync(join(FRAMES, "stop"), "");
  await sleep(800);
  await browser?.close().catch(() => {});
  try {
    execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {}
  try {
    execFileSync("taskkill", ["/PID", String(np.pid), "/F"], { stdio: "ignore" });
  } catch {}
  grabber.kill();
  await sleep(500);
  spawnSync("python", ["dev/hands-frames.py", "gif", FRAMES, join(OUT, "hands-demo.gif")], { stdio: "inherit" });
  rmSync(work, { recursive: true, force: true });
  rmSync(config, { recursive: true, force: true });
  writeFileSync(join(OUT, "app-log.txt"), log);
  writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed, files in ${OUT}`);
}
