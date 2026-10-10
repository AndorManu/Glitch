// Launch a test copy and evaluate JS in its mascot page. Usage: node dev/app-probe.mjs <exe> <identifier> "<js expression>"
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const [exe, ID, js, pageName = "mascot"] = process.argv.slice(2);
if (!exe || !ID || ID === "dev.glitch.companion") process.exit(2);
const config = join(process.env.APPDATA, ID);
rmSync(config, { recursive: true, force: true });
mkdirSync(config, { recursive: true });
writeFileSync(join(config, "settings.json"), JSON.stringify({ model: "qwen3.5:4b", onboarding_done: true, movement_enabled: true, chaos_enabled: false, update_me: { briefing_enabled: false } }));
const PORT = 9271;
const proc = spawn(exe, [], { env: { ...process.env, GLITCH_DRY_RUN_ACTIONS: "1", WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` }, stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  mascot.on("console", (m) => console.log("console:", m.type(), m.text().slice(0, 300)));
  mascot.on("response", (r) => r.status() >= 400 && console.log("http", r.status(), r.url()));
  mascot.on("pageerror", (e) => console.log("pageerror:", e.message));
  await sleep(6000);
  // A second expression on the mascot can run first: PROBE_PRE (e.g. start a reaction).
  if (process.env.PROBE_PRE) await mascot.evaluate(process.env.PROBE_PRE);
  let target = mascot;
  for (let i = 0; i < 40 && pageName !== "mascot"; i++) {
    target = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes(`${pageName}.html`));
    if (target) break;
    await sleep(500);
  }
  console.log(JSON.stringify(await target.evaluate(js)));
} finally {
  await browser?.close().catch(() => {});
  execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  rmSync(config, { recursive: true, force: true });
}
