// Screenshots of the panel window (setup wizard + settings) with Tauri IPC mocked.
// Needs the Vite dev server: npx vite --port 1420 --strictPort
// Usage: node dev/panel-shots.mjs [outDir] [only-scenario]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUT = process.argv[2] ?? join(tmpdir(), "glitch-panel-shots");
const ONLY = process.argv[3];
const URL = "http://localhost:1420/panel.html";
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

const scenarios = {
  "1-missing": { view: "setup", status: status({ state: "missing" }) },
  "2-stopped": { view: "setup", status: status({ state: "stopped" }) },
  "2b-starting": { view: "setup", status: status({ state: "stopped" }), click: "button.primary", hangStart: true },
  "3-models": { view: "setup", status: status(running, someInstalled) },
  "4-downloading": { view: "setup", status: status(running, someInstalled), click: ".foot button.primary", pull: 42 },
  "4b-getting-ready": { view: "setup", status: status(running, someInstalled), click: ".foot button.primary", pull: null },
  "4c-download-failed": { view: "setup", status: status(running, someInstalled), click: ".foot button.primary", pullFail: true },
  "5-settings": { view: "settings", status: status(running, settingsInstalled, settings({ model: "qwen3.5:4b", onboarding_done: true })) },
  "5b-settings-chat-only": { view: "settings", status: status(running, settingsInstalled, settings({ model: "gemma3:1b", movement_enabled: false, onboarding_done: true })) },
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
        case "get_memory":
          return {
            enabled: true,
            facts: [
              { id: 1, text: "The user's name is Andor", added: "2026-10-06" },
              { id: 2, text: "Has a beagle called Rex", added: "2026-10-07" },
              { id: 3, text: "Likes lofi music while working", added: "2026-10-07" },
            ],
            summary: "Asked Glitch to open YouTube and to find photos of Rex.",
            journal: [{ date: "2026-10-06", text: "Set up Glitch and chatted about a Godot game project." }],
          };
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

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
for (const [name, sc] of Object.entries(scenarios)) {
  if (ONLY && !name.includes(ONLY)) continue;
  for (const scheme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 380, height: 530 }, deviceScaleFactor: 2 });
    page.on("pageerror", (e) => console.error(name, "pageerror:", e.message));
    page.on("console", (m) => m.type() === "error" && console.error(name, "console:", m.text()));
    await page.emulateMedia({ colorScheme: scheme });
    await page.addInitScript(mock, sc);
    await page.goto(URL);
    await page.waitForTimeout(400);
    if (sc.click) {
      await page.click(sc.click);
      await page.waitForTimeout(300);
    }
    await page.screenshot({ path: `${OUT}/${name}-${scheme}.png` });
    if (sc.view === "settings") {
      // Also the bottom of the settings (Memory card), with the history open.
      await page.evaluate(() => {
        document.querySelectorAll("details").forEach((d) => (d.open = true));
        document.querySelectorAll(".scroll, section").forEach((el) => (el.scrollTop = el.scrollHeight));
      });
      await page.waitForTimeout(100);
      await page.screenshot({ path: `${OUT}/${name}-${scheme}-bottom.png` });
    }
    await page.close();
  }
}
await browser.close();
console.log("done", OUT);
