// Screenshots of the real mascot window page (src/mascot/main.ts) with Tauri
// IPC mocked, including a fake world (work area + window tops), a window
// that really moves (set_position), the global cursor and the hitbox.
// Checks the wiring: idle, moods (thinking / listening / happy), click ->
// mascot_clicked, drag (hitbox opens, window follows the cursor), throw.
// For whole-desktop behaviour (climbing, jumping...) see dev/stage.html.
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
  // Physical px, scale 2. The page is the 160x160 CSS window at the top-left of a fake screen,
  // so screen = window position + page px * 2.
  const win = (window.__win = { x: 3000, y: 1760 }); // bottom-right of a 3840x2080 work area
  window.__cursor = { x: 0, y: 0 };
  window.__hitboxes = [];
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
          return { movement_enabled: true, onboarding_done: true, model: "m", ollama_url: "", keep_alive: "2m" };
        case "plugin:event|listen":
          (listeners[args.event] ??= []).push(args.handler);
          return args.handler;
        case "plugin:event|unlisten":
          return null;
        case "plugin:window|scale_factor":
          return 2;
        case "plugin:window|outer_position":
          return { ...win };
        case "plugin:window|outer_size":
          return { width: 320, height: 320 };
        case "plugin:window|set_position": {
          const p = args.value.position ?? args.value;
          win.x = p.x;
          win.y = p.y;
          return null;
        }
        case "plugin:window|cursor_position":
          return { ...window.__cursor };
        case "world_snapshot":
          return { area: { x: 0, y: 0, w: 3840, h: 2080 }, scale: 2, ledges: [{ id: 5, x: 1200, y: 1300, w: 1400 }] };
        case "set_hitbox":
          window.__hitboxes.push(args.rect);
          return null;
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
const page = await browser.newPage({ viewport: { width: 160, height: 160 }, deviceScaleFactor: 2 });
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
const state = () => page.evaluate(() => ({ anim: window.__glitch.animation, mode: window.__glitch.creature.mode, win: { ...window.__win }, hb: window.__hitboxes.at(-1) }));
/** Move the page mouse and the fake global cursor together (page px -> physical). */
const mouse = async (x, y) => {
  await page.evaluate(([x, y]) => (window.__cursor = { x: window.__win.x + x * 2, y: window.__win.y + y * 2 }), [x, y]);
  await page.mouse.move(x, y);
};

await wait(400);
console.log("start:", JSON.stringify(await state()), "polls:", await page.evaluate(() => window.__calls.filter((c) => c === "world_snapshot").length));
await shot("01-idle");
await page.evaluate(() => window.__glitch.burst(600));
await wait(120);
await shot("02-burst");
await page.evaluate(() => window.__emit("mood", "thinking"));
await wait(500);
await shot("03-thinking");
await page.evaluate(() => window.__emit("mood", "listening"));
await wait(450);
await shot("04-listening");
await page.evaluate(() => window.__emit("mood", "some-future-mood"));
console.log("unknown mood ->", (await state()).anim);
await page.evaluate(() => window.__emit("mood", "happy"));
await wait(300);
await shot("05-happy");
await wait(2500);

// Click (no drag) -> mascot_clicked; the hitbox opens while a drag could start.
const hb = (await state()).hb;
const cx = hb.x + hb.w / 2;
const cy = hb.y + hb.h / 2;
await mouse(cx, cy);
await page.mouse.down();
console.log("pressed: hitbox", JSON.stringify((await state()).hb));
await page.mouse.up();
await wait(60);
console.log("clicked:", await page.evaluate(() => window.__calls.includes("mascot_clicked")), "hitbox after:", JSON.stringify((await state()).hb));
await shot("06-startled");
await wait(800);

// Drag: the window follows the (fake global) cursor; release with a flick = throw.
await mouse(cx, cy - 20);
await page.mouse.down();
const before = (await state()).win;
await mouse(cx - 8, cy - 26); // past the drag threshold (the window hasn't moved yet)
await wait(30);
for (let i = 1; i <= 20; i++) {
  await page.evaluate(([dx, dy]) => (window.__cursor = { x: window.__cursor.x - dx, y: window.__cursor.y - dy }), [24, 30]);
  await page.mouse.move(cx + (i % 2), cy - 20); // keep pointer events coming
  await wait(17);
}
const held = await state();
console.log("held:", JSON.stringify(held), "moved by", held.win.x - before.x, held.win.y - before.y);
await shot("07-held");
for (let i = 1; i <= 6; i++) {
  await page.evaluate(() => (window.__cursor = { x: window.__cursor.x + 90, y: window.__cursor.y - 20 }));
  await page.mouse.move(cx + (i % 2), cy - 20);
  await wait(17);
}
await page.mouse.up();
await wait(50);
console.log("thrown:", JSON.stringify(await state()), "vx", await page.evaluate(() => Math.round(window.__glitch.creature.body.vx)));
await shot("08-flying");
await wait(3000);
console.log("landed:", JSON.stringify(await state()), "surface", await page.evaluate(() => window.__glitch.creature.surface.kind));
await shot("09-landed");
await page.evaluate(() => window.__emit("mascot-action", "nonsense"));
await page.evaluate(() => window.__emit("mascot-action", "chaosSpin"));
await wait(300);
await shot("10-action-chaosSpin");
const calls = await page.evaluate(() => window.__calls);
const count = (c) => calls.filter((x) => x === c).length;
console.log("ipc:", JSON.stringify({ set_position: count("plugin:window|set_position"), cursor: count("plugin:window|cursor_position"), world: count("world_snapshot"), hitbox: count("set_hitbox"), startDragging: count("plugin:window|start_dragging") }));
await browser.close();
