// Screenshots of the chat bubble window with Tauri IPC mocked, composited on a
// fake desktop above (or below) Glitch so the tail can be judged.
// Needs the Vite dev server: npx vite --port 1420 --strictPort (or set GLITCH_DEV_URL)
// Usage: node dev/bubble-shots.mjs [outDir] [only-scenario-substring]
import { BASE, launch } from "./browser.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUT = process.argv[2] ?? join(tmpdir(), "glitch-bubble-shots");
const ONLY = process.argv[3];

mkdirSync(OUT, { recursive: true });

const LONG =
  "Raccoons are famously clever! Here are a few fun facts:\n\n" +
  "1. They can remember solutions to tasks for up to three years.\n" +
  "2. Their front paws are super sensitive, so they often “wash” food to feel it better.\n" +
  "3. A group of raccoons is called a gaze.\n\n" +
  "They also love shiny things, just like me. Want me to find you some raccoon videos on YouTube? I can open it right up for you.";

const SCREEN_ANSWER =
  "A pop-up titled \"Glitch screen test\" sits in the middle with a packing list: Lisbon, sunscreen SPF 50, a green umbrella and train ticket 4127. Behind it is your code editor with some logs and a PowerShell window running background tasks.";

const reply = (text, actions = []) => ({ step: { type: "reply", text, actions } });
const confirm = { step: { type: "confirm", id: "c1", title: "Open the app “Spotify”", detail: "/usr/share/applications/spotify.desktop", actions: [] } };

const LINK =
  "Here you go: https://www.youtube.com/results?search_query=lofi+hip+hop+radio+beats+to+relax+and+study+to&sp=EgIQAQ%253D%253D and the playlist is at https://open.spotify.com/playlist/37i9dQZF1DWWQRwui0ExPn";

/** Voice on, as Rust reports it (makes the mic button show up). */
const VOICE = {
  available: true, unavailable_reason: null, os: "windows", enabled: true, phase: "idle",
  hotkey: { label: "Ctrl+Shift+Space", registered: true, error: null },
  model: "base", recommended: "base", model_auto: true,
  models: [{ id: "base", label: "Base", blurb: "", file: "", size_bytes: 148897792, size_mb: 142, downloaded: true }],
  language: "auto", languages: [], speak_replies: false, download: null, offer_pending: false,
};
const emit = (event, payload = null) => async (page) => page.evaluate(([e, p]) => window.__emit(e, p), [event, payload]);
const seq = (...steps) => async (page) => { for (const st of steps) typeof st === "number" ? await page.waitForTimeout(st) : await st(page); };
/** Freeze every running animation/transition `ms` into its run, for in-between frames. */
const freezeAt = (ms) => async (page) =>
  page.evaluate((t) => document.getAnimations().filter((a) => a.playState === "running").forEach((a) => { a.pause(); a.currentTime = t; }), ms);
const needsModel = { phase: "needs_model", model: { id: "base", label: "Base", blurb: "", file: "", size_bytes: 148897792 } };

/**
 * send: message typed and sent; type: typed only; wait: ms before the shot;
 * then: extra steps (page) after the wait; voice: mic on.
 */
const scenarios = {
  "00-opening-frame": { wait: 1200, then: seq(emit("bubble-hidden"), 300, emit("bubble-shown"), 0, freezeAt(110)) },
  "00b-opening-overshoot": { wait: 1200, then: seq(emit("bubble-hidden"), 300, emit("bubble-shown"), 0, freezeAt(230)) },
  "00c-closing-frame": { wait: 1200, then: seq(async (p) => p.keyboard.press("Escape"), 0, freezeAt(90)) },
  "01-welcome": { wait: 1500 },
  "02-typing": { type: "open elon musk's profile on x please", wait: 400 },
  "02b-typing-multiline": { type: "Can you open YouTube, then search for lofi hip hop radio beats to relax and study to, and also open Spotify so I can compare?", wait: 400 },
  "03-thinking": { send: "open elon musk on x", result: { hang: true }, wait: 700 },
  "03b-thinking-glitch-frame": { send: "open elon musk on x", result: { hang: true }, wait: 2640 },
  "04-reply-chip": { send: "open elon musk on x", result: reply("Done! His profile is open in your browser.", ["Opened https://x.com/elonmusk"]), wait: 1500 },
  "04b-reply-short": { send: "hi", result: reply("Hey! 👋"), wait: 900 },
  "04c-chips-only": { send: "open youtube and the calculator", result: reply("", ["Opened https://www.youtube.com/", "Opened Calculator", "Couldn't open the app"]), wait: 900 },
  "04d-reply-links": { send: "lofi please", result: reply(LINK, ["Opened https://www.youtube.com/results?search_query=lofi+hip+hop"]), wait: 1600 },
  "04e-reply-empty": { send: "…", result: reply(""), wait: 1200 },
  "05-long": { send: "tell me about raccoons", result: reply(LONG, ["Searched files for “raccoon”: 3 found"]), wait: 1800 },
  "05b-long-typing": { send: "tell me about raccoons", result: reply(LONG, []), wait: 650 },
  "05c-long-scrolled": {
    send: "tell me about raccoons", result: reply(LONG, ["Searched files for “raccoon”: 3 found"]), wait: 1800,
    then: seq(async (p) => p.evaluate(() => { const s = document.querySelector(".balloon .scroll"); s.scrollTop = s.scrollHeight; }), 200),
  },
  "06-confirm": { send: "open spotify", result: confirm, wait: 900 },
  "07-error": { send: "hi", result: { error: { code: "ollama_unreachable", message: "connection refused" } }, wait: 1300 },
  "07b-error-plain": { send: "hi", result: { error: { code: "ai_error", message: "model crashed (exit status 2)" } }, wait: 1500 },
  "07c-error-glitch-frame": { send: "hi", result: { error: { code: "ollama_unreachable", message: "connection refused" } }, wait: 560, then: freezeAt(390) },
  "07d-error-fix-focused": {
    send: "hi", result: { error: { code: "ollama_unreachable", message: "connection refused" } }, wait: 1300,
    then: seq(async (p) => p.keyboard.press("Shift+Tab"), async (p) => p.keyboard.press("Shift+Tab"), 150),
  },
  "08-tail-up": { layout: { tail_up: true, tail_x: 92 }, send: "open elon musk on x", result: reply("Done! His profile is open in your browser.", ["Opened https://x.com/elonmusk"]), wait: 1500 },
  "08b-tail-up-thinking": { layout: { tail_up: true, tail_x: 92 }, send: "hi", result: { hang: true }, wait: 700 },
  "08c-edge-right": { layout: { tail_up: false, tail_x: 262 }, send: "hi", result: reply("Hey! 👋"), wait: 900 },
  "10-listening": { voice: true, wait: 900, then: seq(emit("voice", { phase: "listening", level: 0.62, hands_free: false }), 250) },
  "10b-listening-hands-free": { voice: true, wait: 900, then: seq(emit("voice", { phase: "listening", level: 0.2, hands_free: true }), 250) },
  "10c-transcribing": { voice: true, wait: 900, then: seq(emit("voice", { phase: "listening", level: 0.4, hands_free: false }), 50, emit("voice", { phase: "transcribing" }), 300) },
  "10d-heard-thinking": { voice: true, result: { hang: true }, wait: 900, then: seq(emit("voice", { phase: "transcribing" }), 50, emit("voice", { phase: "heard", text: "open youtube please" }), 600) },
  "10e-voice-error": { voice: true, wait: 900, then: seq(emit("voice", { phase: "error", code: "mic_denied", message: "" }), 1400) },
  "10f-nothing-heard": { voice: true, wait: 900, then: seq(emit("voice", { phase: "idle", reason: "nothing_heard" }), 1400) },
  "10g-voice-setup": { voice: true, wait: 900, then: seq(emit("voice", needsModel), 1500) },
  "10h-voice-downloading": {
    voice: true, wait: 900,
    then: seq(emit("voice", needsModel), 1500, emit("voice-download", { model: "base", state: "running", done: 61e6, total: 148897792, error: null }), 300),
  },
  "10i-voice-download-failed": {
    voice: true, wait: 900,
    then: seq(emit("voice", needsModel), 1500, emit("voice-download", { model: "base", state: "failed", done: 0, total: 0, error: { code: "download_offline", message: "" } }), 300),
  },
  "10j-voice-ready": {
    voice: true, wait: 900,
    then: seq(emit("voice", needsModel), 1500, emit("voice-download", { model: "base", state: "done", done: 1, total: 1, error: null }), 1500),
  },
  "11-cleared": { send: "tell me about raccoons", result: reply(LONG), wait: 1500, then: seq(emit("chat-cleared"), 1200) },
  "11b-empty-pill": { wait: 1500, then: seq(emit("bubble-hidden"), async (p) => p.evaluate(() => { const real = Date.now; Date.now = () => real() + 5 * 60_000; }), 300, emit("bubble-shown"), 700) },
  "12-focus-close": { wait: 1500, then: seq(async (p) => p.keyboard.press("Tab"), 150) },
  "12b-focus-gear": { wait: 1500, then: seq(async (p) => p.keyboard.press("Shift+Tab"), 150) },
  // Seeing the screen and multi-step work (agent-progress events).
  "13-looking": {
    send: "what's on my screen?", result: { hang: true }, wait: 300,
    then: seq(emit("agent-progress", { kind: "step", id: 1, tool: "look_at_screen", label: "Looking at your screen" }), emit("agent-progress", { kind: "looking", active: true, target: "screen" }), 500),
  },
  "13b-steps": {
    send: "what's 15% of the number in my clipboard?", result: { hang: true }, wait: 300,
    then: seq(
      emit("agent-progress", { kind: "step", id: 1, tool: "read_clipboard", label: "Reading your clipboard" }),
      emit("agent-progress", { kind: "step_done", id: 1, ok: true }),
      emit("agent-progress", { kind: "thinking" }),
      emit("agent-progress", { kind: "step", id: 2, tool: "calculate", label: "Calculating 15% of 1299" }),
      500,
    ),
  },
  "13c-streaming": {
    send: "summarise this page", result: { hang: true }, wait: 300,
    then: seq(
      emit("agent-progress", { kind: "step", id: 1, tool: "look_at_screen", label: "Looking at your window" }),
      emit("agent-progress", { kind: "step_done", id: 1, ok: true }),
      emit("agent-progress", { kind: "thinking" }),
      emit("agent-progress", { kind: "text", delta: "Glitch: Bees vote on a new home: scouts do a **waggle dance**, and " }),
      300,
    ),
  },
  "13d-streamed-long-reply": {
    send: "tell me about raccoons", result: { ...reply(LONG, ["Looked at your screen"]), delay: 1200 }, wait: 300,
    then: seq(emit("agent-progress", { kind: "text", delta: LONG }), 1600),
  },
  "13d2-streamed-paragraph": {
    send: "what's on my screen?",
    result: { ...reply(SCREEN_ANSWER, ["Looked at your screen"]), delay: 1200 }, wait: 300,
    then: seq(emit("agent-progress", { kind: "step", id: 1, tool: "look_at_screen", label: "Looking at your screen" }), emit("agent-progress", { kind: "step_done", id: 1, ok: true }), emit("agent-progress", { kind: "text", delta: SCREEN_ANSWER }), 1600),
  },
  "13d3-streamed-chunks-long": {
    send: "what's on my screen?",
    result: { ...reply(SCREEN_ANSWER + " " + SCREEN_ANSWER + "\n\nWant me to close anything?", ["Looked at your screen"]), delay: 2500 }, wait: 300,
    then: seq(
      ...(SCREEN_ANSWER + " " + SCREEN_ANSWER + "\n\nWant me to close anything?").match(/.{1,12}/gs).map((d) => emit("agent-progress", { kind: "text", delta: d })),
      2800,
    ),
  },
  "13e-reminder": { wait: 1200, then: seq(emit("reminder", { message: "Time to stretch!" }), 1500) },
  "13f-dark-steps": {
    dark: true, send: "find my latest screenshot and open it", result: { hang: true }, wait: 300,
    then: seq(
      emit("agent-progress", { kind: "step", id: 1, tool: "search_files", label: "Searching files for “screenshot”" }),
      emit("agent-progress", { kind: "step_done", id: 1, ok: true }),
      emit("agent-progress", { kind: "step", id: 2, tool: "open_path", label: "Opening Screenshot 2026-10-06 183012.png" }),
      emit("agent-progress", { kind: "step_done", id: 2, ok: false }),
      500,
    ),
  },
  "09-dark-welcome": { dark: true, wait: 1500 },
  "09b-dark-confirm": { dark: true, send: "open spotify", result: confirm, wait: 900 },
  "09c-dark-thinking": { dark: true, send: "hi", result: { hang: true }, wait: 700 },
  "09d-dark-reply": { dark: true, send: "open elon musk on x", result: reply("Done! His profile is open in your browser.", ["Opened https://x.com/elonmusk"]), wait: 1500 },
  "09e-dark-error": { dark: true, send: "hi", result: { error: { code: "no_model", message: "" } }, wait: 1300 },
  "09f-dark-listening": { dark: true, voice: true, wait: 900, then: seq(emit("voice", { phase: "listening", level: 0.62, hands_free: false }), 250) },
  "09g-dark-voice-downloading": {
    dark: true, voice: true, wait: 900,
    then: seq(emit("voice", needsModel), 1500, emit("voice-download", { model: "base", state: "running", done: 61e6, total: 148897792, error: null }), 300),
  },
  "09h-dark-long": { dark: true, send: "tell me about raccoons", result: reply(LONG, ["Searched files for “raccoon”: 3 found"]), wait: 1800 },
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
        case "voice_status": return sc.voice ? sc.voice : null;
        case "resize_bubble":
          window.__height = Math.min(420, Math.max(56, Math.round(args.height)));
          return sc.layout ?? { tail_up: false, tail_x: 150 };
        case "send_message":
        case "confirm_action": {
          const r = sc.result ?? { step: { type: "reply", text: "ok", actions: [] } };
          if (r.hang) return new Promise(() => {});
          await new Promise((res) => setTimeout(res, r.delay ?? 250));
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

const browser = await launch();
for (const [name, sc] of Object.entries(scenarios)) {
  if (ONLY && !name.includes(ONLY)) continue;
  const ctx = await browser.newContext({ viewport: { width: 300, height: 420 }, deviceScaleFactor: 2, colorScheme: sc.dark ? "dark" : "light" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error(name, "page error:", e.message));
  page.on("console", (m) => m.type() === "error" && console.error(name, "console:", m.text()));
  await page.addInitScript(mock, { layout: sc.layout, result: sc.result, voice: sc.voice ? VOICE : null });
  await page.goto(`${BASE}/bubble.html`);
  await page.waitForTimeout(150);
  if (sc.type || sc.send) {
    await page.locator("textarea").fill(sc.type ?? sc.send);
    if (sc.send) await page.keyboard.press("Enter");
  }
  await page.waitForTimeout(sc.wait ?? 800);
  if (sc.then) await sc.then(page);
  const height = await page.evaluate(() => window.__height);
  await page.setViewportSize({ width: 300, height });
  await page.waitForTimeout(80);
  const png = await page.screenshot({ omitBackground: true });
  writeFileSync(join(OUT, `${name}.png`), await composite(browser, png, height, sc));
  console.log(name, `${height}px`);
  await ctx.close();
}
await browser.close();
