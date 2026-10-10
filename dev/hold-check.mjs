// Real-app check of picking Glitch up: launches a debug build (identifier
// overridden so it never meets the installed app), drives the real mouse
// (SetCursorPos / mouse_event) to press on his body near the bottom-right,
// move up ~70 px in small steps and hold still 2 s, and logs his pose angle
// over CDP while he is held. Done near the screen's right edge and in the middle.
//
//   npx tauri build --debug --no-bundle --config <a json with {"identifier":"dev.glitch.companion.qa"}>
//   node dev/hold-check.mjs <target>/debug/glitch.exe dev/mouse.ps1
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";

const [exe, mouse] = process.argv.slice(2);
const PORT = 9229;
const proc = spawn(exe, [], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` }, stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser;
try {
  for (let i = 0; i < 60; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://localhost:${PORT}`);
      break;
    } catch {
      await sleep(500);
    }
  }
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) if (p.url().includes("mascot")) page = p;
    if (!page) await sleep(500);
  }
  await page.waitForFunction(() => window.__glitch?.creature?.world, null, { timeout: 30000 });
  // Keep him put: no wandering, no chaos acts during the test.
  await page.evaluate(() => {
    const c = window.__glitch.creature;
    c.setMovement(false);
    c.chaosOn = false;
  });
  const state = () =>
    page.evaluate(() => {
      const c = window.__glitch.creature;
      const v = c.view;
      return { mode: c.mode, anim: c.animation, frame: c.animator.pose?.frame, rot: c.animator.pose?.rot, angle: Math.round(v.placement.angle * 10) / 10, body: [Math.round(c.body.x), Math.round(c.body.y)], win: c.win, rect: v.bodyRect, dpr: devicePixelRatio, area: c.world.area };
    });

  async function trial(label, placeAt) {
    if (placeAt) {
      // Put him on the floor at x (physical px): the app's own teleport path (stand there).
      await page.evaluate((x) => {
        const c = window.__glitch.creature;
        c.body.x = x;
        c.s = x;
        c.place();
      }, placeAt);
      await sleep(800);
    }
    const s0 = await state();
    const px = (cx, cy) => [Math.round(s0.win.x + cx * s0.dpr), Math.round(s0.win.y + cy * s0.dpr)];
    const r = s0.rect;
    const [x0, y0] = px(r.x + r.w * 0.78, r.y + r.h * 0.82);
    const steps = [`${x0},${y0},move,120`, `${x0},${y0},down,80`];
    for (let i = 1; i <= 14; i++) steps.push(`${x0},${y0 - i * 5},move,30`);
    const gesture = steps.join(";");
    const hold = `${x0},${y0 - 70},move,2000;${x0},${y0 - 70},up,300`;
    execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", mouse, "-Plan", gesture]);
    const samples = [];
    const t0 = Date.now();
    const p = new Promise((res) => {
      const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", mouse, "-Plan", hold]);
      child.on("exit", res);
    });
    let shot = false;
    while (Date.now() - t0 < 1900) {
      samples.push(await state());
      if (!shot && Date.now() - t0 > 1000) {
        // What is actually drawn, held still for a second.
        shot = true;
        const url = await page.evaluate(() => document.querySelector("canvas").toDataURL());
        writeFileSync(`dev/out/hold-${label.replace(/\W+/g, "-")}.png`, Buffer.from(url.split(",")[1], "base64"));
      }
      await sleep(150);
    }
    await p;
    const held = samples.filter((s) => s.mode === "held");
    const angles = held.map((s) => s.angle);
    console.log(`${label}: grabbed at (${x0},${y0}) win ${JSON.stringify(s0.win)} area ${JSON.stringify(s0.area)}`);
    console.log(`  held samples ${held.length}/${samples.length}; angle ${angles.length ? `${Math.min(...angles)}..${Math.max(...angles)}` : "-"}; anims ${[...new Set(held.map((s) => s.anim))].join(",")}; frames ${[...new Set(held.map((s) => s.frame))].slice(0, 6).join(",")}; pose rot ${[...new Set(held.map((s) => s.rot))].join(",")}`);
    console.log(`  angle trace ${samples.map((s) => `${s.mode[0]}${s.angle}`).join(" ")}`);
    await sleep(2500);
  }

  const a = (await state()).area;
  await trial("near the right edge", a.x + a.w - 90);
  await trial("in the middle", a.x + a.w / 2);
} finally {
  try {
    await browser?.close();
  } catch {}
  proc.kill();
  try {
    execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {}
}
