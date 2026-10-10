// Screenshots of the panel window (setup wizard + settings) with Tauri IPC mocked.
// Needs the Vite dev server: npx vite --port 1420 --strictPort (or set GLITCH_DEV_URL)
// Usage: node dev/panel-shots.mjs [outDir] [only-scenario]
import { BASE, launch } from "./browser.mjs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUT = process.argv[2] ?? join(tmpdir(), "glitch-panel-shots");
const ONLY = process.argv[3];
const URL = `${BASE}/panel.html`;
mkdirSync(OUT, { recursive: true });

const settings = (over = {}) => ({
  model: null, movement_enabled: true, onboarding_done: false, ollama_url: "http://127.0.0.1:11434", keep_alive: "2m", ...over,
});
const rec16 = {
  tier: "16 GB class",
  total_ram_gb: 16,
  primary: { name: "qwen3.5:4b", download_gb: 3.4 },
  alternatives: [
    { name: "qwen3:4b", download_gb: 2.5 },
    { name: "llama3.2:3b", download_gb: 2.0 },
    { name: "qwen3.5:2b", download_gb: 2.7 },
  ],
  note: null,
};
const status = (ollama, installed = [], s = settings()) => ({
  os: "windows",
  ollama: { download_url: "https://ollama.com/download/windows", version: null, ...ollama },
  recommendation: rec16,
  installed,
  settings: s,
});
const running = { state: "running", version: "0.12.3" };
const someInstalled = [{ name: "llama3.2:3b", size_gb: 2.0, supports_tools: true }];
const settingsInstalled = [
  { name: "qwen3.5:4b", size_gb: 3.4, supports_tools: true },
  { name: "llama3.2:3b", size_gb: 2.0, supports_tools: true },
  { name: "gemma3:1b", size_gb: 0.8, supports_tools: false },
];

const models = [
  { id: "tiny", label: "Tiny", blurb: "Fastest, rougher.", file: "", size_bytes: 77e6, size_mb: 75, downloaded: false },
  { id: "base", label: "Base", blurb: "Quick and good for short commands.", file: "", size_bytes: 148e6, size_mb: 142, downloaded: true },
  { id: "small", label: "Small", blurb: "Best accuracy, needs a newer computer.", file: "", size_bytes: 488e6, size_mb: 466, downloaded: false },
];
const voice = (over = {}) => ({
  available: true, unavailable_reason: null, os: "windows", enabled: true, phase: "idle",
  hotkey: { label: "Ctrl+Shift+Space", registered: true, error: null },
  model: "base", recommended: "base", model_auto: true, models,
  language: "auto", languages: [{ code: "auto", label: "Detect automatically" }, { code: "en", label: "English" }, { code: "nl", label: "Dutch" }],
  speak_replies: false, download: null, offer_pending: false, ...over,
});
const memory = (over = {}) => ({
  enabled: true,
  facts: [
    { id: 1, text: "The user's name is Andor", added: "2026-10-06" },
    { id: 2, text: "Has a beagle called Rex", added: "2026-10-07" },
    { id: 3, text: "Likes lofi music while working, especially the long YouTube streams with the rainy-window loops", added: "2026-10-07" },
  ],
  summary: "Asked Glitch to open YouTube and to find photos of Rex.",
  journal: [{ date: "2026-10-06", text: "Set up Glitch and chatted about a Godot game project." }],
  ...over,
});
const done = (over = {}) => status(running, settingsInstalled, settings({ model: "qwen3.5:4b", onboarding_done: true, ...over }));

/**
 * view: which page; status: setup_status (null = error); click: selector to
 * click after load; keys: keys to press; full: also a tall shot of the whole page.
 */
const scenarios = {
  "1-missing": { view: "setup", status: status({ state: "missing" }) },
  "2-stopped": { view: "setup", status: status({ state: "stopped" }) },
  "2b-starting": { view: "setup", status: status({ state: "stopped" }), click: "button.primary", hangStart: true },
  "3-models": { view: "setup", status: status(running, someInstalled) },
  "4-downloading": { view: "setup", status: status(running, someInstalled), click: ".foot button.primary", pull: 42 },
  "4b-getting-ready": { view: "setup", status: status(running, someInstalled), click: ".foot button.primary", pull: null },
  "4c-download-failed": { view: "setup", status: status(running, someInstalled), click: ".foot button.primary", pullFail: true },
  "3b-models-keyboard": { view: "setup", status: status(running, someInstalled), keys: ["Tab", "Tab", "ArrowDown"] },
  "5-settings": { view: "settings", status: done(), full: true },
  "5b-settings-chat-only": { view: "settings", status: done({ model: "gemma3:1b", movement_enabled: false }), full: true },
  "5c-voice-off-memory-off": { view: "settings", status: done(), voice: voice({ enabled: false }), memory: memory({ enabled: false }), full: true },
  "5d-voice-downloading": { view: "settings", status: done(), voice: voice({ model: "small", model_auto: false, download: { model: "small", done: 190e6, total: 488e6 } }), full: true },
  "5e-voice-unavailable-memory-empty": { view: "settings", status: done(), voice: voice({ available: false, unavailable_reason: "cpu" }), memory: memory({ facts: [], summary: "", journal: [] }), full: true },
  "5f-hotkey-taken-not-downloaded": { view: "settings", status: done(), voice: voice({ hotkey: { label: "Ctrl+Shift+Space", registered: false, error: "taken" }, model: "small", model_auto: false }), full: true },
  "5g-wipe-confirm": { view: "settings", status: done(), click: "text=Forget everything", full: true },
  "5h-settings-during-setup": { view: "settings", status: status(running, someInstalled, settings({ model: null })) },
  "5i-settings-error": { view: "settings", status: null },
  "6-error": { view: "setup", status: null },
};

function mock(sc) {
  const callbacks = new Map();
  let next = 1;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "panel" }, currentWebview: { windowLabel: "panel", label: "panel" } },
    transformCallback(cb, once) {
      const id = next++;
      callbacks.set(id, (d) => { if (once) callbacks.delete(id); return cb && cb(d); });
      return id;
    },
    unregisterCallback(id) { callbacks.delete(id); },
    convertFileSrc: (p) => p,
    async invoke(cmd, args) {
      window.__calls = (window.__calls || []).concat(cmd);
      switch (cmd) {
        case "plugin:event|listen": return args.handler;
        case "plugin:event|unlisten": return null;
        case "panel_view": return sc.view;
        case "get_memory": return sc.memory;
        case "voice_status": return sc.voice;
        case "setup_status":
          if (!sc.status) throw { code: "internal", message: "could not read settings.json (permission denied)" };
          return sc.status;
        case "start_ollama":
          if (sc.hangStart) return new Promise(() => {});
          return null;
        case "pull_model": {
          if (sc.pullFail) { await new Promise((r) => setTimeout(r, 50)); throw { code: "pull_failed", message: "connection reset" }; }
          const send = (index, message) => callbacks.get(args.onProgress.id)?.({ index, message });
          send(0, { status: "pulling manifest", completed: null, total: null });
          if (sc.pull !== null) send(1, { status: "pulling 3a1c...", completed: sc.pull * 34e6, total: 3400e6 });
          return new Promise(() => {});
        }
        default: return null;
      }
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
}

const browser = await launch();
for (const [name, sc] of Object.entries(scenarios)) {
  if (ONLY && !name.includes(ONLY)) continue;
  for (const scheme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 380, height: 530 }, deviceScaleFactor: 2 });
    page.on("pageerror", (e) => console.error(name, "pageerror:", e.message));
    page.on("console", (m) => m.type() === "error" && console.error(name, "console:", m.text()));
    await page.emulateMedia({ colorScheme: scheme });
    await page.addInitScript(mock, { ...sc, voice: sc.voice ?? voice(), memory: sc.memory ?? memory() });
    await page.goto(URL);
    await page.waitForTimeout(400);
    if (sc.click) {
      await page.click(sc.click);
      await page.waitForTimeout(300);
    }
    for (const k of sc.keys ?? []) await page.keyboard.press(k);
    if (sc.keys) await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/${name}-${scheme}.png` });
    if (sc.full) {
      // The whole settings page in one tall shot, with the history open.
      const h = await page.evaluate(() => {
        document.querySelectorAll("details").forEach((d) => (d.open = true));
        const scroll = document.querySelector("section:not([hidden]) > .scroll");
        return Math.ceil(document.body.scrollHeight - scroll.clientHeight + scroll.scrollHeight);
      });
      await page.setViewportSize({ width: 380, height: h });
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${OUT}/${name}-${scheme}-full.png` });
    }
    await page.close();
  }
}
await browser.close();
console.log("done", OUT);
