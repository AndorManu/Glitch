// Screenshots of the chat bubble window with Tauri IPC mocked, composited on a
// fake desktop above (or below) Glitch so the tail can be judged.
// Needs the Vite dev server: npx vite --port 1420 --strictPort
// Usage: node dev/bubble-shots.mjs [outDir] [only-scenario-substring]
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUT = process.argv[2] ?? join(tmpdir(), "glitch-bubble-shots");
const ONLY = process.argv[3];
const BASE = "http://localhost:1420";
mkdirSync(OUT, { recursive: true });

const LONG =
  "Raccoons are famously clever! Here are a few fun facts:\n\n" +
  "1. They can remember solutions to tasks for up to three years.\n" +
  "2. Their front paws are super sensitive, so they often “wash” food to feel it better.\n" +
  "3. A group of raccoons is called a gaze.\n\n" +
  "They also love shiny things, just like me. Want me to find you some raccoon videos on YouTube? I can open it right up for you.";

const reply = (text, actions = []) => ({ step: { type: "reply", text, actions } });
const confirm = { step: { type: "confirm", id: "c1", title: "Open the app “Spotify”", detail: "/usr/share/applications/spotify.desktop", actions: [] } };

/** send: message typed and sent; type: typed only; wait: ms before the shot. */
const scenarios = {
  "01-welcome": { wait: 1500 },
  "02-typing": { type: "open elon musk's profile on x please", wait: 400 },
  "02b-typing-multiline": { type: "Can you open YouTube, then search for lofi hip hop radio beats to relax and study to, and also open Spotify so I can compare?", wait: 400 },
  "03-thinking": { send: "open elon musk on x", result: { hang: true }, wait: 700 },
  "03b-thinking-glitch-frame": { send: "open elon musk on x", result: { hang: true }, wait: 2640 },
  "04-reply-chip": { send: "open elon musk on x", result: reply("Done! His profile is open in your browser.", ["Opened https://x.com/elonmusk"]), wait: 1500 },
  "04b-reply-short": { send: "hi", result: reply("Hey! 👋"), wait: 900 },
  "04c-chips-only": { send: "open youtube and the calculator", result: reply("", ["Opened https://www.youtube.com/", "Opened Calculator", "Couldn't open the app"]), wait: 900 },
  "05-long": { send: "tell me about raccoons", result: reply(LONG, ["Searched files for “raccoon”: 3 found"]), wait: 1800 },
  "06-confirm": { send: "open spotify", result: confirm, wait: 900 },
  "07-error": { send: "hi", result: { error: { code: "ollama_unreachable", message: "connection refused" } }, wait: 1300 },
  "07b-error-plain": { send: "hi", result: { error: { code: "ai_error", message: "model crashed (exit status 2)" } }, wait: 1500 },
  "08-tail-up": { layout: { tail_up: true, tail_x: 92 }, send: "open elon musk on x", result: reply("Done! His profile is open in your browser.", ["Opened https://x.com/elonmusk"]), wait: 1500 },
  "08b-tail-up-thinking": { layout: { tail_up: true, tail_x: 92 }, send: "hi", result: { hang: true }, wait: 700 },
  "08c-edge-right": { layout: { tail_up: false, tail_x: 262 }, send: "hi", result: reply("Hey! 👋"), wait: 900 },
  "09-dark-welcome": { dark: true, wait: 1500 },
  "09b-dark-confirm": { dark: true, send: "open spotify", result: confirm, wait: 900 },
  "09c-dark-thinking": { dark: true, send: "hi", result: { hang: true }, wait: 700 },
  "09d-dark-reply": { dark: true, send: "open elon musk on x", result: reply("Done! His profile is open in your browser.", ["Opened https://x.com/elonmusk"]), wait: 1500 },
  "09e-dark-error": { dark: true, send: "hi", result: { error: { code: "no_model", message: "" } }, wait: 1300 },
};

function mock(sc) {
  const callbacks = new Map();
  const listeners = {};
  let next = 1;
  window.__height = 0;
  window.__calls = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "bubble" }, currentWebview: { windowLabel: "bubble", label: "bubble" } },
    transformCallback(cb, once) {
      const id = next++;
      callbacks.set(id, (d) => { if (once) callbacks.delete(id); return cb && cb(d); });
      return id;
    },
    unregisterCallback(id) { callbacks.delete(id); },
    async invoke(cmd, args) {
      window.__calls.push(cmd);
      switch (cmd) {
        case "plugin:event|listen":
          (listeners[args.event] ??= []).push(args.handler);
          return args.handler;
        case "plugin:event|unlisten": return null;
        case "resize_bubble":
          window.__height = Math.min(420, Math.max(56, Math.round(args.height)));
          return sc.layout ?? { tail_up: false, tail_x: 150 };
        case "send_message":
        case "confirm_action": {
          const r = sc.result ?? { step: { type: "reply", text: "ok", actions: [] } };
          if (r.hang) return new Promise(() => {});
          await new Promise((res) => setTimeout(res, 250));
          if (r.error) throw r.error;
          return r.step;
        }
        default: return null;
      }
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__emit = (event, payload) => {
    for (const id of listeners[event] ?? []) callbacks.get(id)?.({ event, id, payload });
  };
}

const desktop = (dark) =>
  dark
    ? "radial-gradient(circle at 20% 10%, #3b2f5c 0, transparent 55%), linear-gradient(160deg, #1b1630, #0d1b2a 70%)"
    : "radial-gradient(circle at 80% 0%, #ffd9a8 0, transparent 50%), linear-gradient(160deg, #4f8fc0, #7fb6a4 60%, #c9d68a)";

async function composite(browser, png, height, sc) {
  const layout = sc.layout ?? { tail_up: false, tail_x: 150 };
  const W = 420;
  const MASCOT_W = 160, MASCOT_H = 110, OVERLAP = 14;
  const pad = 26;
  const H = height + MASCOT_H - OVERLAP + pad * 2;
  const bubbleLeft = (W - 300) / 2;
  const mascotLeft = bubbleLeft + layout.tail_x - MASCOT_W / 2;
  const [bubbleTop, mascotTop] = layout.tail_up
    ? [pad + MASCOT_H - OVERLAP, pad]
    : [pad, pad + height - OVERLAP];
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
  await page.setContent(`<body style="margin:0;width:${W}px;height:${H}px;background:${desktop(sc.dark)};position:relative;overflow:hidden">
    <div style="position:absolute;left:${mascotLeft}px;top:${mascotTop}px;width:${MASCOT_W}px;height:${MASCOT_H}px;display:flex;align-items:flex-end;justify-content:center">
      <div style="width:160px;height:104px;background:url(${BASE}/sprites/glitch.png) 0 0/640px 417px no-repeat;image-rendering:auto"></div>
    </div>
    <img src="data:image/png;base64,${png.toString("base64")}" style="position:absolute;left:${bubbleLeft}px;top:${bubbleTop}px;width:300px;height:${height}px">
  </body>`);
  await page.waitForLoadState("networkidle");
  const out = await page.screenshot();
  await page.close();
  return out;
}

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
for (const [name, sc] of Object.entries(scenarios)) {
  if (ONLY && !name.includes(ONLY)) continue;
  const ctx = await browser.newContext({ viewport: { width: 300, height: 420 }, deviceScaleFactor: 2, colorScheme: sc.dark ? "dark" : "light" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error(name, "page error:", e.message));
  page.on("console", (m) => m.type() === "error" && console.error(name, "console:", m.text()));
  await page.addInitScript(mock, sc);
  await page.goto(`${BASE}/bubble.html`);
  await page.waitForTimeout(150);
  if (sc.type || sc.send) {
    await page.locator("textarea").fill(sc.type ?? sc.send);
    if (sc.send) await page.keyboard.press("Enter");
  }
  await page.waitForTimeout(sc.wait ?? 800);
  const height = await page.evaluate(() => window.__height);
  await page.setViewportSize({ width: 300, height });
  await page.waitForTimeout(80);
  const png = await page.screenshot({ omitBackground: true });
  writeFileSync(join(OUT, `${name}.png`), await composite(browser, png, height, sc));
  console.log(name, `${height}px`);
  await ctx.close();
}
await browser.close();
