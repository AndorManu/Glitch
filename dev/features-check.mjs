// Real-app check of Settings > Features: every card renders, every switch toggles, the change reaches
// settings.json, and it survives a restart. Defaults are checked too (streaming overlay and app control
// off). Screenshots of the whole settings page and of every card go to OUT.
//
// Build a copy with its own identifier (never the real app's), name the exe differently from glitch.exe
// if an installed Glitch is running:
//   $env:TAURI_CONFIG='{"identifier":"dev.glitch.fullqa","productName":"GlitchFullQA"}'
//   cargo build -p glitch --features tauri/custom-protocol
//   node dev/features-check.mjs <copy>.exe dev.glitch.fullqa [out-dir]
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { chromium } from "playwright";

const [exe, ID, outArg] = process.argv.slice(2);
if (!exe || !ID || ID === "dev.glitch.companion") {
  console.error("usage: node dev/features-check.mjs <exe> <own identifier, not dev.glitch.companion> [out-dir]");
  process.exit(2);
}
const OUT = outArg ?? "dev/out/features";
mkdirSync(OUT, { recursive: true });
const PORT = 9261;
const config = join(process.env.APPDATA, ID);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

rmSync(config, { recursive: true, force: true });
mkdirSync(config, { recursive: true });
writeFileSync(join(config, "settings.json"), JSON.stringify({ model: "qwen3.5:4b", onboarding_done: true, movement_enabled: false, chaos_enabled: false }));

const readSettings = () => JSON.parse(readFileSync(join(config, "settings.json"), "utf8"));
const flat = (o, p = "", out = {}) => {
  for (const [k, v] of Object.entries(o ?? {})) {
    if (v && typeof v === "object" && !Array.isArray(v)) flat(v, `${p}${k}.`, out);
    else out[`${p}${k}`] = JSON.stringify(v);
  }
  return out;
};

let proc;
async function launch() {
  proc = spawn(exe, [], { env: { ...process.env, GLITCH_DRY_RUN_ACTIONS: "1", WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` }, stdio: "ignore" });
  let browser;
  for (let i = 0; i < 80 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    } catch {
      await sleep(500);
    }
  }
  if (!browser) throw new Error("app did not start");
  const pages = () => browser.contexts().flatMap((c) => c.pages());
  let mascot;
  for (let i = 0; i < 60 && !mascot; i++) {
    mascot = pages().find((p) => p.url().includes("mascot.html"));
    if (!mascot) await sleep(500);
  }
  await mascot.waitForFunction(() => !!window.__TAURI_INTERNALS__, null, { timeout: 20000 });
  await mascot.evaluate(() => window.__TAURI_INTERNALS__.invoke("show_panel", { view: "settings" }));
  let panel;
  for (let i = 0; i < 60 && !panel; i++) {
    panel = pages().find((p) => p.url().includes("panel.html"));
    if (!panel) await sleep(500);
  }
  await panel.waitForSelector(".switch-row", { timeout: 20000 });
  await sleep(1500);
  return { browser, mascot, panel };
}

async function stop(browser, panel) {
  try {
    await panel.evaluate(() => window.__TAURI_INTERNALS__.invoke("quit"));
  } catch {
    /* closing */
  }
  for (let i = 0; i < 40 && proc.exitCode === null; i++) await sleep(250);
  if (proc.exitCode === null) execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  await browser.close().catch(() => {});
}

const switches = (panel) =>
  panel.evaluate(() =>
    [...document.querySelectorAll("input[role=switch]")].map((el, i) => ({
      i,
      label: el.closest("label")?.querySelector(".switch-label")?.textContent?.trim() ?? `#${i}`,
      checked: el.checked,
      visible: !!(el.offsetParent || el.closest("label")?.offsetParent),
    })),
  );

try {
  let { browser, mascot, panel } = await launch();
  const size = await panel.evaluate(() => ({ w: innerWidth, h: innerHeight, sh: document.documentElement.scrollHeight }));
  console.log("panel", JSON.stringify(size));
  const errors = [];
  panel.on("pageerror", (e) => errors.push(e.message));
  await panel.screenshot({ path: join(OUT, "settings-top.png") });
  // Features card headings and the order they come in.
  const heads = await panel.evaluate(() => [...document.querySelectorAll("h2,h3,.feature-title,.card-title")].map((e) => e.textContent.trim()).filter(Boolean));
  console.log("headings:", JSON.stringify(heads));
  const first = await switches(panel);
  console.log(`${first.length} switches:`);
  for (const s of first) console.log(`   ${s.checked ? "[x]" : "[ ]"} ${s.label}${s.visible ? "" : " (hidden)"}`);
  const byLabel = (list, re) => list.find((s) => re.test(s.label));
  check("renders the feature switches", first.length >= 5, `${first.length} switches`);
  check("streaming overlay is off by default", byLabel(first, /stream|overlay|obs/i)?.checked === false, JSON.stringify(byLabel(first, /stream|overlay|obs/i)));
  check("app control (Hands) is off by default", byLabel(first, /control apps/i)?.checked === false, JSON.stringify(byLabel(first, /control apps/i)));
  const base = flat(readSettings());

  // Scroll through and screenshot the page in slices (the window is small).
  const scroller = await panel.evaluate(() => {
    const cands = [document.scrollingElement, ...document.querySelectorAll("*")].filter((e) => e && e.scrollHeight > e.clientHeight + 20);
    const e = cands.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    return e ? { tag: e.tagName, sh: e.scrollHeight, ch: e.clientHeight } : null;
  });
  console.log("scroller", JSON.stringify(scroller));
  for (let n = 0; n < 12; n++) {
    await panel.screenshot({ path: join(OUT, `settings-slice-${String(n).padStart(2, "0")}.png`) });
    const moved = await panel.evaluate(() => {
      const cands = [document.scrollingElement, ...document.querySelectorAll("*")].filter((e) => e && e.scrollHeight > e.clientHeight + 20);
      const e = cands.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
      if (!e) return false;
      const before = e.scrollTop;
      e.scrollTop += e.clientHeight - 60;
      return e.scrollTop !== before;
    });
    await sleep(200);
    if (!moved) break;
  }
  await panel.evaluate(() => {
    for (const e of document.querySelectorAll("*")) if (e.scrollTop) e.scrollTop = 0;
  });

  // Toggle every switch (the card controls may appear/disappear: re-read each time), diff settings.json.
  const toggled = [];
  // Last to first: a master switch hides the controls under it once it is off.
  for (let i = first.length - 1; i >= 0; i--) {
    const list = await switches(panel);
    const target = list.find((s) => s.label === first[i].label);
    if (!target || !target.visible) {
      check(`toggle: ${first[i].label}`, false, "not visible");
      continue;
    }
    const before = flat(readSettings());
    await panel.locator("input[role=switch]").nth(target.i).evaluate((el) => el.click());
    await sleep(900);
    const after = flat(readSettings());
    const diff = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]);
    const now = (await switches(panel)).find((s) => s.label === first[i].label);
    const ok = diff.length > 0 && now?.checked === !target.checked;
    toggled.push({ label: first[i].label, from: target.checked, to: now?.checked, diff });
    check(`toggle persists to settings.json: ${first[i].label}`, ok, diff.map((k) => `${k}: ${before[k]} -> ${after[k]}`).join("; ") || "no settings.json change");
  }
  await panel.screenshot({ path: join(OUT, "settings-all-toggled.png") });
  const afterAll = await switches(panel);
  const settingsAfter = flat(readSettings());

  // Restart: the state must come back as it was.
  await stop(browser, panel);
  await sleep(1500);
  ({ browser, mascot, panel } = await launch());
  const restarted = await switches(panel);
  const same = afterAll.filter((s) => s.visible).every((s) => restarted.find((r) => r.label === s.label)?.checked === s.checked);
  check("all switches keep their state after a restart", same, afterAll.filter((s) => restarted.find((r) => r.label === s.label)?.checked !== s.checked).map((s) => s.label).join(", "));
  await panel.screenshot({ path: join(OUT, "settings-after-restart.png") });
  check("no page errors in the panel", errors.length === 0, errors.slice(0, 3).join(" | "));
  writeFileSync(join(OUT, "features.json"), JSON.stringify({ first, toggled, base, settingsAfter, restarted }, null, 1));
  await stop(browser, panel);
} catch (e) {
  check("run", false, String(e?.stack ?? e));
} finally {
  if (proc && proc.exitCode === null) execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  rmSync(config, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
