#!/usr/bin/env node
// "Hey Glitch" and the character voice in the REAL app (Windows), run under
// its own identifier so it never touches your installed Glitch or its files.
//
//   npx tauri build --debug --no-bundle --config '{"identifier":"dev.glitch.companion.wake"}'
//   node dev/wake-app-check.mjs --exe <target>\debug\glitch.exe
//
// 1. Writes a test settings.json for that identifier (setup done, voice on,
//    wake word on, read aloud with Glitch's voice) and copies the speech
//    model(s) (from <temp>/glitch-voice/models) and the Piper voice (from
//    <temp>/glitch-tts) into its data folder.
// 2. Starts the app (actions dry-run, WebView2 debugging on) and checks:
//    - the wake word arms (voice_status.wake.armed)
//    - CPU of the app process: 60 s armed in a quiet room vs 60 s disarmed
//    - "Hey Glitch, open YouTube" WAVs played through the speakers wake him
//      (acoustic loop: speakers -> microphone; skip with --no-play)
//    - the character voice: time to first audio, cold and prepared
// 3. Screenshots (via the webviews) into <temp>/glitch-wake-shots: the
//    settings card, the bubble with the armed dot, the listening state, and
//    mascot frames while he talks (dev/frames-to-gif.py makes the GIF).
// 4. Quits the app and deletes the test identifier's folders.

import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const PORT = Number(opt("--port") ?? 9331);
const ID = "dev.glitch.companion.wake";
const SECS = Number(opt("--secs") ?? 60);
const exe = opt("--exe");
const shots = path.join(tmpdir(), "glitch-wake-shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.platform !== "win32" || !exe || !existsSync(exe)) {
  console.error("Windows only; pass --exe path\\to\\glitch.exe built with the test identifier");
  process.exit(2);
}
mkdirSync(shots, { recursive: true });

const cfgDir = path.join(process.env.APPDATA, ID);
const dataDir = path.join(process.env.LOCALAPPDATA, ID);
mkdirSync(cfgDir, { recursive: true });
mkdirSync(path.join(dataDir, "speech-models"), { recursive: true });
writeFileSync(
  path.join(cfgDir, "settings.json"),
  JSON.stringify({
    onboarding_done: true,
    movement_enabled: false,
    chaos_enabled: false,
    voice: { enabled: true, model: "base", language: "en", speak_replies: true, wake_word: true, read_aloud_voice: "glitch" },
  }),
);
for (const m of ["ggml-base.bin"]) copyFileSync(path.join(tmpdir(), "glitch-voice", "models", m), path.join(dataDir, "speech-models", m));
const tts = path.join(tmpdir(), "glitch-tts");
if (existsSync(path.join(tts, "piper", "piper.exe"))) {
  cpSync(path.join(tts, "piper"), path.join(dataDir, "voices", "piper"), { recursive: true });
  for (const f of ["en_US-joe-medium.onnx", "en_US-joe-medium.onnx.json"]) copyFileSync(path.join(tts, f), path.join(dataDir, "voices", f));
}

// ------------------------------------------------------------- CDP

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  return (await res.json()).filter((t) => t.type === "page");
}
async function connect(page) {
  for (let i = 0; i < 120; i++) {
    try {
      const t = (await targets()).find((t) => t.url.includes(`${page}.html`));
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
        let next = 1;
        const pending = new Map();
        ws.onmessage = (m) => {
          const msg = JSON.parse(m.data);
          pending.get(msg.id)?.(msg);
          pending.delete(msg.id);
        };
        const send = (method, params = {}) =>
          new Promise((res) => {
            const id = next++;
            pending.set(id, (msg) => res(msg.result));
            ws.send(JSON.stringify({ id, method, params }));
          });
        const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }))?.result?.value;
        return {
          evaluate,
          invoke: (cmd, payload = {}) =>
            evaluate(`(async () => { try { return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(payload)}) }; } catch (e) { return { ok: false, error: e }; } })()`),
          shot: async (file) => {
            const r = await send("Page.captureScreenshot", { format: "png" });
            if (r?.data) writeFileSync(path.join(shots, file), Buffer.from(r.data, "base64"));
            return path.join(shots, file);
          },
        };
      }
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`no ${page} page`);
}

function cpuSeconds(pid) {
  const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).CPU`], { encoding: "utf8" });
  return Number(out.trim().replace(",", "."));
}

function playAsync(wav) {
  return spawn("powershell.exe", ["-NoProfile", "-Command", `(New-Object System.Media.SoundPlayer '${wav}').PlaySync()`], { stdio: "ignore" });
}

// ------------------------------------------------------------- run

const log = [];
const app = spawn(exe, [], {
  env: { ...process.env, GLITCH_DRY_RUN_ACTIONS: "1", WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: ["ignore", "pipe", "pipe"],
});
for (const s of [app.stdout, app.stderr]) s.on("data", (d) => log.push(...String(d).split(/\r?\n/).filter(Boolean)));
const say = (line) => console.log(line);

try {
  const mascot = await connect("mascot");
  await mascot.invoke("show_panel", { view: "settings" });
  const panel = await connect("panel");
  let st;
  for (let i = 0; i < 40; i++) {
    st = (await panel.invoke("voice_status")).value;
    if (st?.wake?.armed) break;
    await sleep(250);
  }
  say(`armed: ${st?.wake?.armed} (problem ${st?.wake?.problem}), model ${st?.model}, tts installed ${st?.tts?.installed}`);
  await sleep(1500);
  await panel.evaluate(`document.querySelector('[data-feature="voice-extra"]')?.scrollIntoView({ block: "start" }); true`);
  await sleep(400);
  say(`settings card: ${await panel.shot("settings-voice-card.png")}`);

  if (!args.includes("--no-cpu")) {
    await sleep(3000);
    let c0 = cpuSeconds(app.pid);
    await sleep(SECS * 1000);
    const armedCpu = cpuSeconds(app.pid) - c0;
    say(`CPU armed, quiet room: ${armedCpu.toFixed(2)} s in ${SECS} s = ${((100 * armedCpu) / SECS).toFixed(2)}% of one core (wake checks: ${log.filter((l) => l.includes("wake check")).length})`);
    await panel.invoke("update_voice_settings", { patch: { wake_word: false } });
    await sleep(3000);
    c0 = cpuSeconds(app.pid);
    await sleep(SECS * 1000);
    const offCpu = cpuSeconds(app.pid) - c0;
    say(`CPU disarmed: ${offCpu.toFixed(2)} s in ${SECS} s = ${((100 * offCpu) / SECS).toFixed(2)}% -> the wake word costs ${((100 * (armedCpu - offCpu)) / SECS).toFixed(2)}% of one core`);
    await panel.invoke("update_voice_settings", { patch: { wake_word: true } });
    await sleep(2500);
  }

  await panel.invoke("show_bubble");
  const bubble = await connect("bubble");
  await sleep(1200);
  say(`bubble armed: ${await bubble.evaluate(`document.querySelector('.pill')?.classList.contains('armed')`)} -> ${await bubble.shot("bubble-armed.png")}`);

  if (!args.includes("--no-play")) {
    const dir = path.join(tmpdir(), "glitch-wake");
    let n = 0;
    for (const f of ["pos_oneshot_David_0.wav", "pos_pause_Zira_0.wav", "pos_okay_Hazel_0.wav", "pos_please_David_0.wav"]) {
      const before = log.length;
      const p = playAsync(path.join(dir, f));
      let listened = false;
      for (let i = 0; i < 80; i++) {
        await sleep(100);
        if (!listened && (await bubble.evaluate(`document.querySelector('.pill')?.classList.contains('listening')`))) {
          listened = true;
          await bubble.shot(`bubble-listening-${n}.png`);
          await mascot.shot(`mascot-listening-${n}.png`);
        }
      }
      await new Promise((r) => p.on("exit", r));
      const lines = log.slice(before).filter((l) => l.includes("wake check"));
      const heard = await bubble.evaluate(`document.querySelector('.input')?.value || document.querySelector('.echo, .user-echo')?.textContent || ''`);
      say(`played ${f}: ${lines.join(" | ") || "no utterance reached the mic"}; bubble listening seen: ${listened}; input/echo: ${JSON.stringify(heard)}`);
      await bubble.invoke("voice_cancel");
      n++;
      await sleep(3000);
    }
  }

  if (st?.tts?.installed) {
    for (const [i, prepared] of [false, true, true].entries()) {
      if (prepared) {
        await bubble.invoke("voice_tts_prepare");
        await sleep(2500);
      }
      const before = log.length;
      const t0 = Date.now();
      const r = await panel.invoke("voice_tts_speak", { text: "Sure! Opening YouTube for you. Anything else I can do?" });
      // Mascot frames while he talks (first run only), for the GIF.
      const frames = [];
      for (let k = 0; k < 45; k++) {
        if (i === 0) frames.push(await mascot.shot(`talk-${String(k).padStart(2, "0")}.png`));
        await sleep(90);
      }
      const line = log.slice(before).find((l) => l.includes("first audio"));
      say(`character voice (${prepared ? "prepared" : "cold"}): invoke ${r?.ok ? "ok" : JSON.stringify(r?.error)}, ${line ?? "no audio"} (wall ${Date.now() - t0} ms)${frames.length ? `, ${frames.length} mascot frames` : ""}`);
      await sleep(2500);
    }
  }
  await panel.invoke("quit");
  await sleep(2500);
} catch (e) {
  say(`FAILED: ${e.message}`);
} finally {
  try {
    app.kill();
  } catch {
    /* gone */
  }
  await sleep(1000);
  rmSync(cfgDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  writeFileSync(path.join(shots, "app.log"), log.join("\n"));
  console.log(`screenshots + app log: ${shots}`);
}
