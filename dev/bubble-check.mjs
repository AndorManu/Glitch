// Behaviour smoke test of the chat bubble in a real browser, Tauri IPC mocked.
// Needs the Vite dev server: npx vite --port 1420 --strictPort (or set GLITCH_DEV_URL)
// Usage: node dev/bubble-check.mjs
import { BASE, launch } from "./browser.mjs";

const URL = `${BASE}/bubble.html`;

function mock() {
  const callbacks = new Map();
  const listeners = {};
  let next = 1;
  window.__calls = [];
  window.__results = []; // queue of { step } | { error } | { hang: true }
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "bubble" }, currentWebview: { windowLabel: "bubble", label: "bubble" } },
    transformCallback(cb, once) {
      const id = next++;
      callbacks.set(id, (d) => { if (once) callbacks.delete(id); return cb && cb(d); });
      return id;
    },
    unregisterCallback(id) { callbacks.delete(id); },
    async invoke(cmd, args) {
      if (!cmd.startsWith("plugin:")) window.__calls.push([cmd, args]);
      switch (cmd) {
        case "plugin:event|listen":
          (listeners[args.event] ??= []).push(args.handler);
          return args.handler;
        case "resize_bubble": return window.__layout ?? { tail_up: false, tail_x: 150 };
        case "send_message":
        case "confirm_action": {
          const r = window.__results.shift() ?? { step: { type: "reply", text: "ok", actions: [] } };
          if (r.hang) return new Promise(() => {});
          await new Promise((res) => setTimeout(res, 120));
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

let failures = 0;
function check(name, ok, extra = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? `  (${extra})` : ""}`);
  if (!ok) failures++;
}

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 300, height: 420 } });
page.on("pageerror", (e) => check(`no page errors: ${e.message}`, false));
await page.addInitScript(mock);
await page.goto(URL);

const calls = (cmd) => page.evaluate((c) => window.__calls.filter(([n]) => n === c).map(([, a]) => a), cmd);
const running = () => page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length);
/** What's running, for failure messages. */
const runningNames = () =>
  page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => a.playState === "running")
      .map((a) => `${a.animationName ?? a.transitionProperty}@${a.effect?.target?.getAttribute?.("class") ?? a.effect?.target?.tagName}`)
      .join(", "),
  );
const push = (r) => page.evaluate((x) => window.__results.push(x), r);
const focused = () => page.evaluate(() => document.activeElement?.className || document.activeElement?.tagName);

await page.waitForTimeout(1500);
check("copying a reply doesn't duplicate it", await page.evaluate(() => {
  const r = document.createRange();
  r.selectNodeContents(document.querySelector(".say"));
  getSelection().removeAllRanges();
  getSelection().addRange(r);
  const t = getSelection().toString();
  getSelection().removeAllRanges();
  return t.split("Hi, I'm Glitch").length === 2;
}));
check("welcome is shown", (await page.textContent(".balloon .say")).includes("Hi, I'm Glitch"));
check("input focused on start", (await focused()) === "input");
check("caret gone after typing", (await page.locator(".caret").count()) === 0);
check("no animations while idle", (await running()) === 0, await runningNames());
check("reported its height", (await calls("resize_bubble")).length > 0);

await page.keyboard.press("Enter");
check("empty Enter sends nothing", (await calls("send_message")).length === 0);

// --- confirm flow
await push({ step: { type: "confirm", id: "c1", title: "Open the app “Spotify”", detail: "/usr/bin/spotify", actions: [] } });
await page.keyboard.type("open spotify");
await page.keyboard.press("Enter");
await page.waitForTimeout(30);
check("sent the message", JSON.stringify(await calls("send_message")) === JSON.stringify([{ text: "open spotify" }]));
check("input cleared", (await page.inputValue("textarea")) === "");
check("thought cloud while waiting", (await page.locator(".thought").count()) === 1);
check("cloud is animating", (await running()) > 0);
await page.waitForTimeout(500);
check("confirm question", (await page.textContent(".balloon .say .sr")) === "Can I open the app “Spotify”?");
check("Allow is focused", (await focused()).includes("yes"));
check("cloud animations stopped", (await running()) <= 1, await runningNames());
await page.keyboard.type("n");
check("typing on a button moves to the input", (await focused()) === "input");
await page.fill("textarea", "");

await push({ step: { type: "reply", text: "Spotify is open!", actions: ["Opened Spotify"] } });
await page.click(".choice.yes");
await page.waitForTimeout(30);
check("confirm_action approved", JSON.stringify(await calls("confirm_action")) === JSON.stringify([{ id: "c1", approved: true }]));
await page.waitForTimeout(300);
check("reply after allowing", (await page.textContent(".balloon .say .sr")) === "Spotify is open!");
check("action chip", (await page.textContent(".chip")).includes("Opened Spotify"));

// --- stale confirm: a new message cancels it
await push({ step: { type: "confirm", id: "c2", title: "Open a web page", detail: "https://x.com", actions: [] } });
await page.fill("textarea", "open x");
await page.keyboard.press("Enter");
await page.waitForTimeout(400);
await push({ hang: true });
await page.fill("textarea", "never mind");
await page.keyboard.press("Enter");
await page.waitForTimeout(50);
check("new message sent while confirm pending", (await calls("send_message")).length === 3);
check("busy: send disabled", await page.isDisabled(".send"));
check("no confirm_action for the stale one", (await calls("confirm_action")).length === 1);

// --- fresh page for the rest
await page.reload();
await page.waitForTimeout(300);

// typewriter skip
await push({ step: { type: "reply", text: "A fairly long reply so that the typewriter takes a while to finish typing it all out.", actions: [] } });
await page.fill("textarea", "hi");
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
check("typing in progress", (await page.locator(".caret").count()) === 1);
await page.click(".balloon");
check("click skips typing", (await page.locator(".caret").count()) === 0 && (await page.locator(".rest").textContent()) === "");

// errors
await push({ error: { code: "ollama_unreachable", message: "refused" } });
await page.fill("textarea", "hi");
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
check("friendly error", (await page.textContent(".balloon.error .say .sr")).includes("can't reach Ollama"));
await page.click("text=Fix it");
check("Fix it opens setup", JSON.stringify(await calls("show_panel")) === JSON.stringify([{ view: "setup" }]));
await page.click(".gear");
check("gear opens settings", JSON.stringify((await calls("show_panel"))[1]) === JSON.stringify({ view: "settings" }));

// layout event
await page.evaluate(() => window.__emit("bubble-layout", { tail_up: true, tail_x: 270 }));
await page.waitForTimeout(50);
check("tail up from event", await page.evaluate(() => document.getElementById("root").classList.contains("up")));
check("× moves away from the tail", await page.evaluate(() => document.getElementById("root").classList.contains("close-left")));

// hide / show (mouse off the gear, which it clicked above)
await page.mouse.move(1, 1);
await page.focus("textarea");
await page.keyboard.press("Escape");
check("faded out", await page.evaluate(() => document.getElementById("root").classList.contains("away")));
check("close animation plays before the window hides", (await calls("hide_bubble")).length === 0);
await page.waitForTimeout(220);
check("Esc hides", (await calls("hide_bubble")).length === 1);
await page.evaluate(() => { const real = Date.now; Date.now = () => real() + 5 * 60_000; });
await page.evaluate(() => window.__emit("bubble-shown", null));
await page.waitForTimeout(50);
check("back in", !(await page.evaluate(() => document.getElementById("root").classList.contains("away"))));
check("input focused on show", (await focused()) === "input");
check("old speech collapsed after a long time away", (await page.locator(".balloon").count()) === 0);
await page.waitForTimeout(650);
check("idle again: no animations", (await running()) === 0, await runningNames());

// multi-line
await page.fill("textarea", "");
await page.keyboard.type("line one");
await page.keyboard.press("Shift+Enter");
await page.keyboard.type("line two");
check("Shift+Enter makes a new line", (await page.inputValue("textarea")) === "line one\nline two");
check("pill grows", await page.evaluate(() => document.querySelector(".pill").classList.contains("multi")));

// long replies: typing stops at the bottom of the scroll box, which stays at the top
await page.fill("textarea", "");
await push({ step: { type: "reply", text: Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of a long answer.`).join(String.fromCharCode(10)), actions: [] } });
await page.fill("textarea", "long please");
await page.keyboard.press("Enter");
await page.waitForTimeout(700);
check("long reply: typing done before the end of the text", (await page.locator(".caret").count()) === 0);
check("long reply: still scrolled to the top", (await page.evaluate(() => document.querySelector(".balloon .scroll").scrollTop)) === 0);
check("long reply: whole text there", (await page.locator(".balloon .say [aria-hidden]").textContent()).includes("Line 30"));

// links wrap at their separators
await push({ step: { type: "reply", text: "Look: https://example.com/a/very/long/path?with=query&and=more", actions: [] } });
await page.fill("textarea", "link");
await page.keyboard.press("Enter");
await page.waitForTimeout(1300);
check("links get wrap points", (await page.locator(".balloon .say wbr").count()) >= 5);
check("copying a link gives it back intact", (await page.evaluate(() => {
  const r = document.createRange();
  r.selectNodeContents(document.querySelector(".say"));
  getSelection().removeAllRanges();
  getSelection().addRange(r);
  return getSelection().toString();
})).includes("https://example.com/a/very/long/path?with=query&and=more"));

// "Clear chat" in Settings: a fresh start, and a late answer from before is dropped
await push({ hang: true });
await page.fill("textarea", "something slow");
await page.keyboard.press("Enter");
await page.waitForTimeout(50);
await page.evaluate(() => window.__emit("chat-cleared", null));
await page.waitForTimeout(100);
check("cleared: no thought cloud", (await page.locator(".thought").count()) === 0);
check("cleared: fresh start line", (await page.textContent(".balloon .say .sr")).includes("Fresh start"));
check("cleared: can send again", !(await page.isDisabled(".send")) || (await page.inputValue("textarea")) === "");

// reduced motion: no typing, no animations
const calm = await browser.newPage({ viewport: { width: 300, height: 420 }, reducedMotion: "reduce" });
await calm.addInitScript(mock);
await calm.goto(URL);
await calm.waitForTimeout(100);
check("reduced motion: text appears at once", (await calm.locator(".caret").count()) === 0);
await calm.evaluate(() => window.__results.push({ hang: true }));
await calm.fill("textarea", "hi");
await calm.keyboard.press("Enter");
await calm.waitForTimeout(100);
check("reduced motion: still cloud, no animation", (await calm.evaluate(() => document.getAnimations().length)) === 0);

await browser.close();
console.log(failures ? `${failures} failed` : "all good");
process.exit(failures ? 1 : 0);
