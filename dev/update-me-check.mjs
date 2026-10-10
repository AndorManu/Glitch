// Real-app check of "Update me". Launches a debug build with its own
// identifier, a temp Claude Code config dir (CLAUDE_CONFIG_DIR), a fake
// notification feed and dry-run actions, so nothing of the owner's is
// touched. Checks, over CDP and the real endpoint:
//   briefing on the first chat of the day, `glitch --notify` (sign + bubble),
//   bad token / browser requests refused, Claude Code connect -> the exact
//   hook command run with a Stop event -> "done in <project>" -> disconnect,
//   a saved reminder firing with Done, the notification digest (blocked app
//   and codes never shown) and its summary. Screenshots go to OUT.
//
//   npx tauri build --debug --no-bundle --config '{"identifier":"dev.glitch.updateme.qa"}'
//   node dev/update-me-check.mjs <target>/debug/glitch.exe [out-dir]
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const [exe, outArg] = process.argv.slice(2);
const OUT = outArg ?? mkdtempSync(join(tmpdir(), "glitch-um-"));
mkdirSync(OUT, { recursive: true });
const PORT = 9233;
const ID = "dev.glitch.updateme.qa";
const config = join(process.env.APPDATA, ID);
const claudeDir = mkdtempSync(join(tmpdir(), "glitch-claude-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

// A fresh QA profile: set up, notifications on (fake feed), a reminder due soon.
rmSync(config, { recursive: true, force: true });
mkdirSync(config, { recursive: true });
const model = process.env.GLITCH_QA_MODEL ?? "qwen3.5:4b";
writeFileSync(
  join(config, "settings.json"),
  JSON.stringify({
    model,
    onboarding_done: true,
    movement_enabled: false,
    chaos_enabled: false,
    update_me: { notifications_enabled: true, location: { name: "Berlin, Germany", latitude: 52.52, longitude: 13.41 } },
  }),
);
const dueIn = 40;
const now = Math.floor(Date.now() / 1000);
writeFileSync(
  join(config, "reminders.json"),
  JSON.stringify({ next_id: 1, items: [{ id: 1, text: "stretch your legs", due: now + dueIn, next: now + dueIn, said: 0 }] }),
);
// The user's own Claude Code settings (in a temp dir): must survive.
const claudeSettings = join(claudeDir, "settings.json");
const original = { model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } };
writeFileSync(claudeSettings, JSON.stringify(original, null, 2));

const env = {
  ...process.env,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
  GLITCH_FAKE_NOTIFICATIONS: "1",
  GLITCH_DRY_RUN_ACTIONS: "1",
  CLAUDE_CONFIG_DIR: claudeDir,
  GLITCH_ENDPOINT_FILE: join(config, "endpoint.json"),
};
const proc = spawn(exe, [], { env, stdio: ["ignore", "ignore", "pipe"] });
let log = "";
proc.stderr.on("data", (d) => (log += d));

let browser;
const page = async (part) => {
  for (let i = 0; i < 60; i++) {
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) if (p.url().includes(part)) return p;
    await sleep(500);
  }
  throw new Error(`no ${part} page`);
};
// Commands are granted per window (review L4): try the page given, then the others. A command only the
// panel may call needs the panel open: the mascot's show_panel grant opens it.
const appPages = () => browser.contexts().flatMap((c) => c.pages()).filter((pg) => /(mascot|bubble|panel)\.html/.test(pg.url()));
const run = (pg, cmd, args) => pg.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
const invoke = async (p, cmd, args = {}) => {
  let last;
  for (let round = 0; round < 2; round++) {
    for (const pg of [p, ...appPages().filter((x) => x !== p)]) {
      try {
        return await run(pg, cmd, args);
      } catch (e) {
        last = e;
        if (!/not allowed on window/.test(String(e.message))) throw e;
      }
    }
    const mascotPage = appPages().find((x) => x.url().includes("mascot.html"));
    if (round === 0 && mascotPage) {
      await run(mascotPage, "show_panel", { view: "settings" }).catch(() => {});
      await sleep(1500);
    }
  }
  throw last;
};
const speech = (bubble) => bubble.evaluate(() => document.querySelector(".balloon .say .sr")?.textContent ?? "");
const waitSpeech = async (bubble, re, ms = 15000) => {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < ms) {
    last = await speech(bubble);
    if (re.test(last)) return last;
    await sleep(300);
  }
  return last;
};
const sign = (mascot) => mascot.evaluate(() => document.querySelector(".update-sign")?.getAttribute("aria-label") ?? null);
/** The sign's text once it says `want` (an older sign may still be up). */
const waitSign = async (mascot, want, ms = 15000) => {
  const t0 = Date.now();
  let s = null;
  while (Date.now() - t0 < ms) {
    s = await sign(mascot);
    if (s === want) return s;
    await sleep(200);
  }
  return s;
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
  await mascot.waitForFunction(() => window.__glitch?.creature?.world, null, { timeout: 30000 });

  // 1. Endpoint file
  let info = null;
  for (let i = 0; i < 40 && !info?.port; i++) {
    if (existsSync(join(config, "endpoint.json"))) info = JSON.parse(readFileSync(join(config, "endpoint.json"), "utf8"));
    await sleep(250);
  }
  check("endpoint.json written with a port and a 64-hex token", !!info?.port && /^[0-9a-f]{64}$/.test(info.token), `port ${info?.port}`);

  // 2. Briefing on the first chat of the day
  await invoke(mascot, "show_bubble");
  const bubble = await page("bubble");
  const brief = await waitSpeech(bubble, /It's \d\d:\d\d on/);
  check("daily briefing on the first chat open", /It's \d\d:\d\d on/.test(brief), brief);
  check("briefing has the weather (Open-Meteo)", /Berlin: -?\d+°C/.test(brief));
  await bubble.screenshot({ path: join(OUT, "1-briefing.png") });
  const again = await invoke(mascot, "briefing_today");
  check("briefing only once per day", again === null);
  await invoke(mascot, "hide_bubble");

  // 3. glitch --notify
  const r = spawnSync(exe, ["--notify", "Build done", "--body", "cargo test passed", "--level", "success", "--source", "cargo"], { env, timeout: 15000 });
  check("glitch --notify exits 0", r.status === 0, `status ${r.status}`);
  const s1 = await waitSign(mascot, "Build done");
  check("mascot holds up a sign", s1 === "Build done", String(s1));
  await sleep(600);
  await mascot.screenshot({ path: join(OUT, "2-sign.png") });
  const t1 = await waitSpeech(bubble, /Build done/);
  check("bubble says it", t1 === "Build done: cargo test passed", t1);
  await bubble.screenshot({ path: join(OUT, "3-notify-bubble.png") });

  // 4. Refusals
  const url = `http://127.0.0.1:${info.port}/notify`;
  const body = JSON.stringify({ title: "nope" });
  const noToken = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  check("no token: 401", noToken.status === 401);
  const browserLike = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${info.token}`, Origin: "https://evil.example" },
    body,
  });
  check("browser (Origin) request: 403", browserLike.status === 403);

  // 5. Claude Code connect / hook / disconnect
  const st = await invoke(mascot, "update_me_status");
  check("Claude Code is off by default and not connected", !st.settings.claude_code_enabled && st.claude && !st.claude.connected);
  check("preview shows the hook before connecting", st.claude.preview.includes("--glitch-claude-hook"));
  const after = await invoke(mascot, "claude_connect");
  const merged = JSON.parse(readFileSync(claudeSettings, "utf8"));
  const cmd = merged.hooks?.Stop?.[1]?.hooks?.[0]?.command;
  check("connect keeps the user's own hook and adds ours", merged.model === "opus" && merged.hooks.Stop[0].hooks[0].command === "echo mine" && !!cmd, cmd);
  check("backup written next to the file", existsSync(join(claudeDir, "settings.json.glitch-backup")));
  check("connect switched the buddy on", after.settings.claude_code_enabled && after.claude.connected);
  // Run the exact command Claude Code would run, with a Stop event on stdin.
  const stop = JSON.stringify({ session_id: "x", transcript_path: "C:\\secret.jsonl", cwd: "C:\\code\\shop-site", hook_event_name: "Stop" });
  const hook = spawnSync(cmd, { shell: true, input: stop, env, timeout: 15000 });
  check("hook command exits 0", hook.status === 0, `status ${hook.status}`);
  const s2 = await waitSign(mascot, "Claude Code is done");
  check("Claude Code done: sign", s2 === "Claude Code is done", String(s2));
  const t2 = await waitSpeech(bubble, /Claude Code/);
  check("Claude Code done: bubble names the project", t2 === "Claude Code is done in shop-site!", t2);
  await bubble.screenshot({ path: join(OUT, "4-claude-done.png") });
  const note = JSON.stringify({ cwd: "/home/me/api", hook_event_name: "Notification", message: "Claude needs your permission to use Bash" });
  spawnSync(cmd, { shell: true, input: note, env, timeout: 15000 });
  const t3 = await waitSpeech(bubble, /needs you/);
  check("Claude Code needs input: bubble", t3 === "Claude Code needs you in api: Claude needs your permission to use Bash", t3);
  await invoke(mascot, "claude_disconnect");
  const restored = JSON.parse(readFileSync(claudeSettings, "utf8"));
  // Same content (serde_json writes keys sorted).
  const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  check("disconnect restores the user's file", JSON.stringify(canon(restored)) === JSON.stringify(canon(original)), JSON.stringify(restored));

  // 6. The saved reminder fires (it was in reminders.json before start)
  const left = now + dueIn - Math.floor(Date.now() / 1000);
  if (left > 0) await sleep((left + 1) * 1000);
  const t4 = await waitSpeech(bubble, /stretch/, 25000);
  check("saved reminder fires after a restart-style load", t4 === "Reminder: stretch your legs!", t4);
  await bubble.screenshot({ path: join(OUT, "5-reminder.png") });
  const choices = await bubble.evaluate(() => [...document.querySelectorAll(".balloon .choice")].map((b) => b.textContent));
  check("reminder has Done / Snooze", JSON.stringify(choices) === '["Done","Snooze 10 min"]', JSON.stringify(choices));
  await bubble.click(".balloon .choice.yes");
  const t5 = await waitSpeech(bubble, /Crossed off/);
  check("Done crosses it off", /Crossed off/.test(t5), t5);
  const rem = JSON.parse(readFileSync(join(config, "reminders.json"), "utf8"));
  check("reminders.json is empty after Done", rem.items.length === 0);
  await invoke(mascot, "hide_bubble");

  // 7. Notification digest (fake feed)
  const fake = (app_name, title, body) => invoke(mascot, "update_me_fake_toast", { appName: app_name, title, body });
  await fake("WhatsApp", "Anna", "Are you free tonight?");
  await fake("WhatsApp", "Bob", "lol that video");
  await fake("WhatsApp", "Anna", "Bring snacks");
  await fake("Microsoft Teams", "Sam", "Standup moved to 10:30");
  await fake("PayPal", "Payment sent", "You sent 50 EUR to Carl");
  await fake("Discord", "Login", "Your login code is 482913");
  const s3 = await waitSign(mascot, "3 WhatsApp, 1 Discord, 1 Microsoft Teams");
  check("digest sign", s3 === "3 WhatsApp, 1 Discord, 1 Microsoft Teams", String(s3));
  await mascot.screenshot({ path: join(OUT, "6-digest-sign.png") });
  await invoke(mascot, "mascot_clicked");
  const t6 = await waitSpeech(bubble, /While you were busy/);
  check("click: the digest offer", /^While you were busy: 3 WhatsApp/.test(t6), t6);
  await bubble.screenshot({ path: join(OUT, "7-digest-offer.png") });
  await bubble.click(".balloon .choice.yes");
  const t7 = await waitSpeech(bubble, /^WhatsApp: /, 90000);
  check("Tell me: one line per app", /^WhatsApp: .+\nDiscord: .+\nMicrosoft Teams: .+$/.test(t7), JSON.stringify(t7));
  check("blocked app and the code never shown", !/PayPal|50 EUR|482913/.test(t7));
  await bubble.screenshot({ path: join(OUT, "8-digest-summary.png") });

  // 8. The Features card
  await invoke(mascot, "show_panel", { view: "settings" });
  const panel = await page("panel");
  await panel.waitForSelector(".feature-update-me .um-section", { timeout: 15000 });
  const card = await panel.$(".feature-update-me");
  await card.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await sleep(400);
  await panel.screenshot({ path: join(OUT, "9-features-card.png") });
  check("Features card rendered", true);
} catch (e) {
  check("run", false, String(e?.stack ?? e));
} finally {
  await browser?.close().catch(() => {});
  proc.kill();
  try {
    execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {}
  await sleep(500);
  rmSync(claudeDir, { recursive: true, force: true });
  writeFileSync(join(OUT, "app-log.txt"), log);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${OUT}`);
  process.exitCode = failed.length ? 1 : 0;
}
