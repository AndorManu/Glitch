// Screenshots of the real mascot window page (src/mascot/main.ts) with Tauri
// IPC mocked: idle, a glitch burst, walk, thinking, happy, sleep, dangle/drop.
// Needs the Vite dev server: npx vite --port 1420 --strictPort
// Usage: node dev/mascot-shots.mjs [outDir]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUT = process.argv[2] ?? join(tmpdir(), "glitch-mascot-shots");
mkdirSync(OUT, { recursive: true });

// Runs in the page before any app code: a fake Tauri runtime.
function mockTauri() {
  const callbacks = new Map();
  const listeners = {};
  let nextId = 1;
  const calls = (window.__calls = []);
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "mascot" }, currentWebview: { windowLabel: "mascot", label: "mascot" } },
    transformCallback: (cb, once) => {
      const id = nextId++;
      callbacks.set(id, (data) => {
        if (once) callbacks.delete(id);
        return cb && cb(data);
      });
      return id;
    },
    unregisterCallback: (id) => callbacks.delete(id),
    runCallback: (id, data) => callbacks.get(id)?.(data),
    callbacks,
    invoke: async (cmd, args) => {
      calls.push(cmd);
      switch (cmd) {
        case "get_settings":
          return { movement_enabled: false, onboarding_done: true, model: "m", ollama_url: "", keep_alive: "2m" };
        case "plugin:event|listen":
          (listeners[args.event] ??= []).push(args.handler);
          return args.handler;
        case "plugin:event|unlisten":
          return null;
        case "plugin:window|scale_factor":
          return 2;
        case "plugin:window|outer_position":
          return { x: 400, y: 400 };
        case "plugin:window|outer_size":
          return { width: 320, height: 220 };
        default:
          return null;
      }
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  window.__emit = (event, payload) => {
    for (const h of listeners[event] ?? []) callbacks.get(h)?.({ event, id: 0, payload });
  };
}

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 160, height: 110 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("page error:", e.message));
page.on("console", (m) => m.type() === "error" && console.error("page:", m.text()));
await page.addInitScript(mockTauri);
await page.goto("http://localhost:1420/mascot.html");
await page.waitForFunction(() => window.__glitch && window.__calls.includes("plugin:window|show"));
await page.evaluate(() => (document.body.style.background = "#3f7d6a"));

const shot = async (name) => {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log("saved", name);
};
const wait = (ms) => page.waitForTimeout(ms);

await wait(300);
await shot("01-idle");
await page.evaluate(() => window.__glitch.burst(600));
for (const ms of [60, 120, 200]) {
  await wait(ms === 60 ? 60 : 70);
  await shot(`02-burst-${ms}`);
}
await wait(800);
await page.evaluate(() => window.__glitch.play("walk"));
for (let i = 0; i < 4; i++) {
  await wait(70);
  await shot(`03-walk-${i}`);
}
await page.evaluate(() => window.__glitch.face(true));
await wait(140);
await shot("03-walk-left");
await page.evaluate(() => {
  window.__glitch.face(false);
  window.__emit("mood", "thinking");
});
await wait(80);
await shot("04-thinking-burst");
await wait(1200);
await shot("04-thinking");
await page.evaluate(() => window.__emit("mood", "happy"));
await wait(250);
await shot("05-happy-hop");
await wait(500);
await shot("05-happy");
await page.evaluate(() => window.__glitch.play("sleep"));
await wait(300);
await shot("06-sleep");
// Drag: mousedown + move past the threshold -> dangle; window moves; settles -> fall/land.
await page.mouse.move(80, 60);
await page.mouse.down();
await page.mouse.move(95, 60);
await wait(500);
for (let i = 0; i < 4; i++) {
  await page.evaluate(() => window.__emit("tauri://move", { x: 500, y: 400 }));
  await wait(120);
}
await shot("07-dangle");
console.log("after move:", await page.evaluate(() => window.__glitch.animation));
await wait(320);
console.log("settled:", await page.evaluate(() => window.__glitch.animation));
await wait(80);
await shot("08-land");
await page.mouse.up();
await wait(1500);
console.log("finally:", await page.evaluate(() => window.__glitch.animation));
// Click (no drag) -> startled + mascot_clicked.
await page.mouse.move(80, 60);
await page.mouse.down();
await page.mouse.up();
await wait(60);
await shot("09-startled");
console.log("clicked:", await page.evaluate(() => window.__calls.includes("mascot_clicked")));
await page.evaluate(() => window.__emit("mascot-action", "nonsense"));
await page.evaluate(() => window.__emit("mascot-action", "chaosSpin"));
await wait(300);
await shot("10-action-chaosSpin");
await browser.close();
