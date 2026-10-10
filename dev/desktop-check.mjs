// Real-app check of "Desktop control". Launches a debug build with its own
// identifier and a fresh QA profile (app control + Desktop control on), plus
// DraftPad, a small WinForms test app of our own (dev/desktop-test), and
// limits Glitch to that one process (GLITCH_HANDS_ONLY_PIDS). File moves
// are limited to a temp "home" folder (GLITCH_DESKTOP_FILE_ROOT). Nothing of
// the owner's is touched: no windows, apps or files.
//
// Through the real bubble, with the real model, it asks Glitch to:
//   1. click Bold            (review card "Do this step", ring before the click)
//   2. drag Photo A onto Folder X   (answers "Auto for this task")
//   3. snap DraftPad to the left
//   4. move test.txt into Documents/Folder X   (move card with exact paths)
//   then presses Undo twice (file back, window back), and takes pictures of
//   the Settings card, the banner and the image the model sees (marks).
// With --abort it instead checks Esc: a click is stopped mid-travel.
//
//   npx tauri build --debug --no-bundle --config '{"identifier":"dev.glitch.desktop.qa"}'
//   node dev/desktop-check.mjs <target>/debug/glitch.exe <DraftPad.exe> [out-dir] [--abort]
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const argv = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const ABORT = process.argv.includes("--abort");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7).split(",").filter(Boolean);
const want = (n) => ONLY.length === 0 || ONLY.includes(String(n));
const [exe, draftpad, outArg] = argv;
const OUT = outArg ?? mkdtempSync(join(tmpdir(), "glitch-desktop-qa-"));
mkdirSync(OUT, { recursive: true });
const FRAMES = join(OUT, "frames");
rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });
const PORT = ABORT ? 9243 : 9242;
const ID = "dev.glitch.desktop.qa";
const config = join(process.env.APPDATA, ID);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

// Our own test world: a fake home, the test app, a status file.
const work = mkdtempSync(join(tmpdir(), "glitch-desktop-qa-"));
const home = join(work, "home");
for (const d of ["Desktop", "Documents/Folder X", "Downloads"]) mkdirSync(join(home, d), { recursive: true });
writeFileSync(join(home, "Desktop", "test.txt"), "my test file");
const statusFile = join(work, "status.txt");
const DP = { x: 560, y: 110, w: 900, h: 520 };
const dp = spawn(draftpad, [statusFile, String(DP.x), String(DP.y), String(DP.w), String(DP.h)], { stdio: "ignore" });
await sleep(1200);
const status = () => (existsSync(statusFile) ? readFileSync(statusFile, "utf8").trim() : "");
const rect = () => {
  const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "dev/desktop-test/winrect.ps1", "-ProcessId", String(dp.pid)], { encoding: "utf8", timeout: 20000 });
  const [l, t, rr, b, state] = (r.stdout ?? "").trim().split(" ");
  return { l: +l, t: +t, r: +rr, b: +b, state };
};

rmSync(config, { recursive: true, force: true });
mkdirSync(config, { recursive: true });
const model = process.env.GLITCH_QA_MODEL ?? "qwen3.5:4b";
writeFileSync(
  join(config, "settings.json"),
  JSON.stringify({ model, onboarding_done: true, movement_enabled: false, chaos_enabled: false, memory_enabled: false, hands_enabled: true, hands_desktop_enabled: true }),
);

const marksPng = join(OUT, "marks-seen-by-model.jpg");
const env = {
  ...process.env,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
  GLITCH_DRY_RUN_ACTIONS: "1",
  GLITCH_HANDS_ONLY_PIDS: String(dp.pid),
  GLITCH_DESKTOP_FILE_ROOT: home,
  GLITCH_DEBUG_SAVE_MARKS: marksPng,
  GLITCH_DEBUG_HANDS_LOG: "1",
  ...(ABORT ? { GLITCH_DEBUG_STOP_AFTER_MS: "1100" } : {}),
};
const proc = spawn(exe, [], { env, stdio: ["ignore", "ignore", "pipe"] });
let log = "";
proc.stderr.on("data", (d) => (log += d));

// Desktop frames: the test window's region (with banner and ring), never the whole screen.
const grabber = spawn("python", ["dev/hands-frames.py", "grab", FRAMES, String(DP.x - 60), "0", String(DP.w + 120), String(DP.y + DP.h + 60)], { stdio: "ignore", env: { ...process.env, FRAME_GAP: "0.12" } });

let browser;
const page = async (part) => {
  for (let i = 0; i < 60; i++) {
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) if (p.url().includes(part)) return p;
    await sleep(500);
  }
  throw new Error(`no ${part} page`);
};
const hasPage = (part) => browser.contexts().some((c) => c.pages().some((p) => p.url().includes(part)));
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
const grabNow = (name) => {
  spawnSync("python", ["-c", `import ctypes;ctypes.windll.user32.SetProcessDPIAware()\nfrom PIL import ImageGrab\nImageGrab.grab(bbox=(${DP.x - 60},0,${DP.x + DP.w + 60},${DP.y + DP.h + 60}),all_screens=True).save(r"${join(OUT, name)}")`]);
};

/**
 * Ask Glitch something through the real bubble and answer the cards.
 * `policy(cardText, buttons)` returns "yes" | "no" | "auto".
 */
async function task(bubble, text, name, policy) {
  await bubble.fill("textarea.input", text);
  await bubble.press("textarea.input", "Enter");
  const cards = [];
  let reply = "";
  let banner = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 170000) {
    banner ||= hasPage("banner.html");
    const yes = await bubble.$(".choice.yes:not([disabled])");
    const bubbleText = await bubble.evaluate(() => document.querySelector(".balloon")?.innerText ?? "");
    if (yes && (await yes.isVisible())) {
      const labels = await bubble.$$eval(".choices .choice", (bs) => bs.map((b) => b.innerText));
      const card = bubbleText.replace(/\s+/g, " ").trim();
      cards.push({ card, labels });
      await sleep(1300); // the card refuses clicks in its first moment
      await bubble.screenshot({ path: join(OUT, `${name}-card-${cards.length}.png`), omitBackground: true });
      if (cards.length === 1) grabNow(`${name}-desktop-at-card.png`);
      const choice = policy(card, labels);
      const sel = choice === "auto" ? ".choice.auto" : choice === "no" ? ".choice.no" : ".choice.yes";
      await (await bubble.$(sel)).click();
      await sleep(900);
      continue;
    }
    const busy = await bubble.evaluate(() => !!document.querySelector(".thought, .steps .step.running, .typing"));
    if (!busy && bubbleText && !(await bubble.$(".choices .choice:not(.undo)")) && Date.now() - t0 > 4000) {
      // A reply is on screen and nothing is running.
      const done = await bubble.evaluate(() => !document.querySelector(".steps .step.running"));
      if (done) {
        reply = bubbleText.replace(/\s+/g, " ").trim();
        await sleep(1200);
        break;
      }
    }
    await sleep(300);
  }
  await bubble.screenshot({ path: join(OUT, `${name}-reply.png`), omitBackground: true });
  return { cards, reply, banner };
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
  const reset = async () => {
    await invoke(bubble, "reset_chat").catch(() => {});
    await sleep(600);
  };

  if (ABORT) {
    // Esc (simulated by the debug hook 520 ms into the pointer action (just after the ring preview, mid-travel)) stops a click mid-travel.
    const r = await task(bubble, "drag Photo A.png onto Folder X in DraftPad", "abort", () => "yes");
    await sleep(1500);
    check("Esc stopped the drag: nothing was dropped and the mouse button is not stuck", !/Dropped/.test(status()), status());
    check("Glitch says he stopped because the user took over", /Hands off|stopped|took over/i.test(r.reply), r.reply.slice(0, 160));
    const stopped = /pointer stopped by the user (\d+) ms/.exec(log);
    const escAt = /debug: Esc pressed/.test(log);
    check("the log shows the pointer stopped", !!stopped && escAt, stopped ? `${stopped[1]} ms into the action` : "no stop line");
    check("the ring and banner are gone afterwards", !hasPage("pointer.html") && !hasPage("banner.html"));
    clearInterval(ticker);
  } else {
    // 1. click, with the review card.
    let r = await task(bubble, "click the Bold button in DraftPad, then tick the Remember me checkbox", "1-click", () => "yes");
    check("1 review: asked before the step (Do this step / Stop / Auto)", r.cards.some((c) => c.labels.includes("Do this step") && c.labels.includes("Auto for this task")), JSON.stringify(r.cards.map((c) => c.labels)));
    check("1 the banner said Glitch is driving", r.banner);
    check("1 both clicks happened for real (Bold, then the checkbox)", /Remember on/.test(status()), status());
    await reset();

    // 2. drag, choosing "Auto for this task".
    r = await task(bubble, "drag Photo A.png onto Folder X in DraftPad", "2-drag", (_c, labels) => (labels.includes("Auto for this task") ? "auto" : "yes"));
    check("2 the drag dropped Photo A onto Folder X", /Dropped Photo A.png onto Folder X/.test(status()), status());
    await reset();

    // 3. snap left.
    const before = rect();
    r = await task(bubble, "snap the DraftPad window to the left half of the screen", "3-snap", () => "yes");
    const after = rect();
    check("3 DraftPad is on the left half", after.l <= 8 && after.r > 400 && after.r < 1100 && after.l < before.l, JSON.stringify({ before, after }));
    await reset();

    // 4. move a file.
    r = await task(bubble, "move test.txt from my Desktop into the Folder X folder inside Documents", "4-move", () => "yes");
    check("4 the move card showed the exact paths", r.cards.some((c) => /From:.*Desktop.*test\.txt/.test(c.card) && /Folder X/.test(c.card)), JSON.stringify(r.cards.map((c) => c.card.slice(0, 200))));
    check("4 the file is in Folder X", existsSync(join(home, "Documents", "Folder X", "test.txt")) && !existsSync(join(home, "Desktop", "test.txt")));
    clearInterval(ticker);
    await sleep(2500);
    await bubble.screenshot({ path: join(OUT, "4-move-reply-with-undo.png"), omitBackground: true });
    check("4 the bubble offers Undo", !!(await bubble.$(".undo")));

    // Settings card and the Undo button.
    await invoke(mascot, "show_panel", { view: "settings" });
    const panel = await page("panel");
    await panel.waitForFunction(() => document.body.innerText.includes("Desktop control"), null, { timeout: 20000 });
    await panel.evaluate(() => document.querySelector(".desktop-card")?.scrollIntoView({ block: "center" }));
    await sleep(600);
    await panel.screenshot({ path: join(OUT, "5-settings-desktop-control.png") });
    check("Settings shows the Desktop control card", await panel.evaluate(() => !!document.querySelector(".desktop-card")));
    const btn = await panel.$(".undo-field button:not([disabled])");
    check("Settings has an enabled Undo button", !!btn);
    if (btn) {
      await btn.click();
      await sleep(1500);
    }
    check("undo 1: the file is back on the Desktop", existsSync(join(home, "Desktop", "test.txt")));
    const btn2 = await panel.$(".undo-field button:not([disabled])");
    if (btn2) {
      await btn2.click();
      await sleep(2500);
    }
    const restored = rect();
    check("undo 2: DraftPad is back where it was", Math.abs(restored.l - before.l) <= 12 && Math.abs(restored.r - before.r) <= 12, JSON.stringify({ before, restored }));
    await panel.screenshot({ path: join(OUT, "6-settings-after-undo.png") });
  }
  check("the model's picture was written (debug) and has boxes", existsSync(marksPng));
} catch (e) {
  check("run", false, String(e?.stack ?? e));
} finally {
  writeFileSync(join(FRAMES, "stop"), "");
  await sleep(800);
  await browser?.close().catch(() => {});
  for (const pid of [proc.pid, dp.pid]) {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
  }
  grabber.kill();
  await sleep(500);
  spawnSync("python", ["dev/hands-frames.py", "gif", FRAMES, join(OUT, ABORT ? "desktop-abort.gif" : "desktop-demo.gif")], { stdio: "inherit" });
  rmSync(work, { recursive: true, force: true });
  rmSync(config, { recursive: true, force: true });
  writeFileSync(join(OUT, "app-log.txt"), log);
  writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed, files in ${OUT}`);
}
