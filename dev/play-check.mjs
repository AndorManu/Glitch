// Real-app check of games, play and growth: launches a debug build with its
// own identifier (so it never meets the installed app or your settings),
// seeds its config folder (onboarding done, chaos OFF so nothing of yours is
// touched, some XP, a hat, a name and a project in memory), then over CDP:
// the hat and eye colour on the mascot, a fetch round (the ball window, a
// throw, carrying it back, XP), hide and seek (sinking out of sight, found),
// the personal hello in the chat bubble, and the Features/Wardrobe cards.
// Screenshots go to the folder given as the second argument. The app is
// quit (and killed if needed) at the end; nothing else is touched.
//
//   npx tauri build --debug --no-bundle --config '{"identifier":"dev.glitch.companion.gamestest"}'
//   node dev/play-check.mjs <target>/debug/glitch.exe <out-dir>
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const [exe, out = "."] = process.argv.slice(2);
const PORT = 9341;
const ID = "dev.glitch.companion.gamestest";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(52)} ${detail}`);
};

// ------------------------------------------------------------ seed config
const conf = path.join(process.env.APPDATA, ID);
mkdirSync(conf, { recursive: true });
const today = new Date().toLocaleDateString("sv"); // YYYY-MM-DD
writeFileSync(
  path.join(conf, "settings.json"),
  JSON.stringify({ onboarding_done: true, movement_enabled: true, chaos_enabled: false, memory_enabled: true, voice: { enabled: false }, play: { hat: "party", eye: "cyan" } }),
);
writeFileSync(path.join(conf, "pet.json"), JSON.stringify({ energy: 80, energy_at: Math.floor(Date.now() / 1000), xp: 600, day: today, day_start: Math.floor(Date.now() / 1000), xp_today: 0 }));
writeFileSync(
  path.join(conf, "memory.json"),
  JSON.stringify({ facts: [{ id: 1, text: "The user's name is Andor.", added: today }, { id: 2, text: "The user is working on the Bignesstec site.", added: today }], next_id: 2 }),
);

const proc = spawn(exe, [], {
  env: { ...process.env, GLITCH_DRY_RUN_ACTIONS: "1", WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: "ignore",
});
let browser;
const page = async (part) => {
  for (let i = 0; i < 60; i++) {
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) if (p.url().includes(part)) return p;
    await sleep(500);
  }
  throw new Error(`no ${part} page`);
};
try {
  for (let i = 0; i < 60 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://localhost:${PORT}`);
    } catch {
      await sleep(500);
    }
  }
  const m = await page("mascot");
  await m.waitForFunction(() => window.__glitch?.creature?.world && window.__glitch.games, null, { timeout: 30000 });
  await sleep(2500);
  const acc = () => m.evaluate(() => {
    const g = window.__glitch.games;
    const c = window.__glitch.creature;
    return { hat: g.env.acc.hat, eye: g.env.acc.eye, sink: g.env.acc.sink, carrying: g.env.acc.carrying, anim: c.animation, plan: c.plan?.name ?? null, mode: c.mode, surface: c.surface.kind };
  });
  const pet = () => m.evaluate(() => window.__TAURI_INTERNALS__.invoke("pet_state"));
  const shot = async (p, name) => p.screenshot({ path: path.join(out, `${name}.png`), omitBackground: true });

  let a = await acc();
  check("wardrobe: party hat + cyan eye at level 4", a.hat === "party" && a.eye === "cyan", JSON.stringify(a));
  await shot(m, "1-hat");

  // ------------------------------------------------------------- fetch
  const xp0 = (await pet()).xp;
  await m.evaluate(() => window.__glitch.game("play:fetch"));
  const ball = await page("ball.html");
  let mode0 = "";
  for (let i = 0; i < 40 && mode0 !== "rest"; i++) {
    await sleep(200);
    mode0 = await m.evaluate(() => window.__glitch.games.fetch.mode);
  }
  const b0 = await m.evaluate(() => ({ ...window.__glitch.games.fetch.ball, area: window.__glitch.creature.world.area }));
  check("fetch: the ball window opens and the ball drops to rest", !!ball && mode0 === "rest", `${mode0} ${JSON.stringify(b0)}`);
  await shot(ball, "2-ball");
  // A throw (as release() would set it from the cursor): up and to the left.
  await m.evaluate(() => {
    const f = window.__glitch.games.fetch;
    f.grab();
    f.mode = "air";
    const u = window.__glitch.creature.world.scale;
    f.ball.vx = -1300 * u;
    f.ball.vy = -900 * u;
    f.loop();
  });
  let carried = false;
  let carryShot = false;
  let t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    a = await acc();
    if (a.carrying && !carried) {
      carried = true;
    }
    if (a.carrying && !carryShot && a.mode === "stand") {
      await sleep(400);
      await shot(m, "3-carrying");
      carryShot = true;
    }
    if (carried && !a.carrying) break;
    await sleep(150);
  }
  await sleep(1500);
  const xp1 = (await pet()).xp;
  check("fetch: he ran to it, carried it back and dropped it", carried && !a.carrying, `xp ${xp0} -> ${xp1}`);
  check("fetch: XP for bringing it back", xp1 >= xp0 + 10);
  await m.evaluate(() => window.__glitch.game("play:stop"));
  await sleep(800);
  check("fetch: stop ends the game", await m.evaluate(() => !window.__glitch.games.fetch.active));

  // ------------------------------------------------------- hide and seek
  await m.evaluate(() => {
    const c = window.__glitch.creature;
    const old = c.hooks.event;
    window.__ev = [];
    c.hooks.event = (w) => {
      window.__ev.push(w);
      old?.(w);
    };
    window.__glitch.game("play:hide");
  });
  t0 = Date.now();
  while (Date.now() - t0 < 10000 && !(await m.evaluate(() => window.__glitch.games.hide.hidden))) await sleep(200);
  a = await acc();
  check("hide: he hides, sunk behind an edge", a.sink >= 40, JSON.stringify(a));
  if (a.sink < 40) console.log("  events:", JSON.stringify(await m.evaluate(() => window.__ev)));
  await shot(m, "4-hiding");
  await m.evaluate(() => window.__glitch.games.hover(true));
  await sleep(1500);
  a = await acc();
  const xp2 = (await pet()).xp;
  check("hide: pointing at him finds him (back up, XP)", a.sink === 0 && xp2 >= xp1 + 20, `sink ${a.sink}, xp ${xp1} -> ${xp2}`);

  // ------------------------------------------------- personal hello
  await m.evaluate(() => window.__TAURI_INTERNALS__.invoke("show_bubble"));
  const b = await page("bubble");
  await sleep(4000);
  const said = await b.evaluate(() => document.body.innerText);
  check("growth: hello by name + a question about the project", /Andor/.test(said) && /Bignesstec/.test(said), JSON.stringify(said.slice(0, 120)));
  await shot(b, "5-bubble");
  await b.evaluate(() => window.__TAURI_INTERNALS__.invoke("hide_bubble"));

  // ------------------------------------------------- settings cards
  await m.evaluate(() => window.__TAURI_INTERNALS__.invoke("show_panel", { view: "settings" }));
  const p = await page("panel");
  await p.waitForSelector(".play-feature", { timeout: 15000 });
  await p.waitForSelector(".wardrobe-group", { timeout: 15000 });
  await p.evaluate(() => document.querySelector(".play-feature").scrollIntoView());
  await shot(p, "6-features");
  await p.evaluate(() => document.querySelector(".wardrobe").scrollIntoView());
  await sleep(500);
  await shot(p, "7-wardrobe");
  const denied = await p.evaluate(() => window.__TAURI_INTERNALS__.invoke("pet_event", { kind: "fetch" }).then(() => "allowed", (e) => String(e)));
  check("pet_event is refused from the panel (mascot only)", /not allowed/.test(denied), denied);
  const fromMascot = await m.evaluate(() => window.__TAURI_INTERNALS__.invoke("update_play_settings", { patch: { feed_confirm: false } }).then(() => "allowed", (e) => String(e)));
  check("play settings can't be changed from the mascot", /not allowed/.test(fromMascot), fromMascot);
  const ok = await p.evaluate(() => window.__TAURI_INTERNALS__.invoke("update_play_settings", { patch: { hat: "crown" } }).then((s) => s.play.hat));
  check("the panel can change the wardrobe", ok === "crown", ok);
  await sleep(500);
  a = await acc();
  check("a hat that isn't unlocked yet isn't worn", a.hat === null, JSON.stringify(a.hat));
  await p.evaluate(() => window.__TAURI_INTERNALS__.invoke("update_play_settings", { patch: { hat: "cap" } }));
  await sleep(500);
  check("an unlocked hat is worn right away", (await acc()).hat === "cap");
  await shot(m, "8-cap");
  await m.evaluate(() => window.__TAURI_INTERNALS__.invoke("quit")).catch(() => {});
} catch (e) {
  check("run", false, String(e));
} finally {
  await browser?.close().catch(() => {});
  await sleep(1500);
  try {
    process.kill(proc.pid);
  } catch {
    // already gone
  }
}
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
