// Animation QA: films Glitch on dev/stage.html every 50 ms under a fake clock
// (Playwright page.clock, so 5 simulated minutes take ~1-2 real minutes and
// every run is deterministic for a seed), then looks for discontinuities
// between consecutive frames and saves a strip of 8 frames around each one.
//
// Needs the Vite dev server: npx vite --port 1440 --strictPort
// Usage: GLITCH_DEV_URL=http://localhost:1440 node dev/qa-film.mjs [scenario,...] [--minutes=5] [--seed=11]
// Scenarios: roam (free life, accelerated), actions (every animation), moods,
//            drag, throw, chat, sleep, sit, turn, climb, jump, windows.
// Output: dev/out/qa/ (cut-<n>.png strips, report.json, report.txt).
//
// What is detected between consecutive 50 ms samples (world-aligned masks):
//   vanish   sprite area drops by > 70% with no dissolve / glitch-out intended
//   iou      silhouette IoU < 0.35 while standing (pose pop)
//   jump     feet / bbox centre jumps > 10 px while he is standing still or walking
//   family   drawn frame changes family (front/side/back/sit/curl/air/...) with no in-between
//   flip     facing mirrors in one frame (no turn frames)
//   blip     a frame of another family shown for <= 1 tick between two of the same
//   flicker  family alternates >= 4 times within 1 s
//   slide    walk/run: window speed vs the speed the drawn stride implies (ratio off by > 25%)
// Each finding: t, from-anim -> to-anim, frames, glitch level (a cut hidden under a
// glitch is reported with masked=true), strip path.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE, launch } from "./browser.mjs";

const OUT = "dev/out/qa";
mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const opt = (k, d) => args.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const ONLY = args.find((a) => !a.startsWith("--"))?.split(",");
const MINUTES = Number(opt("minutes", 5));
const SEED = Number(opt("seed", 11));
const STEP = 50;

// ------------------------------------------------------------ frame families
/** Which drawn "family" a frame belongs to: a change of family needs in-between frames. */
export function family(frame) {
  const f = frame.replace(/\d+$/, "");
  if (["walk", "run", "pose_walk", "side", "pose_side", "push", "grab_tab", "climb", "nap_rock", "pose_push"].includes(f)) return "side";
  if (["back", "pose_back"].includes(f)) return "back";
  if (["sit", "pose_sit"].includes(f)) return "sit";
  if (["sleep", "pose_sleep"].includes(f)) return "curl";
  if (["jump", "land", "crouch", "air_up", "air_down", "air_tuck", "air_apex"].includes(f)) return "air";
  if (["dangle"].includes(f)) return "dangle";
  if (["peek"].includes(f)) return "peek";
  if (["glitch", "pose_glitch", "chaos", "pose_chaos", "spin", "teleport"].includes(f)) return "fx";
  return "front";
}
// Family pairs that read as continuous (a drawn transition exists or the pose is a held prop).
const OK_PAIRS = new Set(["front>air", "air>front", "side>air", "air>side", "fx>front", "front>fx", "side>fx", "fx>side", "air>fx", "fx>air"]);

// ------------------------------------------------------------- page helpers
const PAGE_QA = () => {
  const st = window.__stage;
  const cr = st.creature;
  const view = cr.view;
  const canvas = view.canvas;
  const qa = { ring: new Map(), poses: [], pose: null, prevMask: null, prevWin: null, n: 0 };
  const orig = view.render.bind(view);
  view.render = (pose, tick) => {
    qa.pose = pose;
    qa.poses.push({ t: performance.now(), frame: pose.frame, dy: pose.dy, sy: pose.sy, glitch: pose.glitch, dissolve: pose.dissolve, flip: pose.flip !== view.facingLeft, anim: cr.animation });
    orig(pose, tick);
  };
  const N = 160; // mask in CSS px
  qa.sample = () => {
    const i = qa.n++;
    const w = canvas.width;
    const k = w / N;
    const data = canvas.getContext("2d").getImageData(0, 0, w, canvas.height);
    const mask = new Uint8Array(N * N);
    let count = 0, x0 = N, y0 = N, x1 = -1, y1 = -1;
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const a = data.data[(Math.floor(y * k + k / 2) * w + Math.floor(x * k + k / 2)) * 4 + 3];
        if (a > 100) {
          mask[y * N + x] = 1;
          count++;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    const win = { x: st.win.x, y: st.win.y };
    let iou = 1;
    if (qa.prevMask) {
      const ox = Math.round(win.x - qa.prevWin.x);
      const oy = Math.round(win.y - qa.prevWin.y);
      let inter = 0, uni = 0;
      for (let y = 0; y < N; y++)
        for (let x = 0; x < N; x++) {
          const a = mask[y * N + x];
          const px = x + ox, py = y + oy; // same world point in the previous window
          const b = px >= 0 && py >= 0 && px < N && py < N ? qa.prevMask[py * N + px] : 0;
          if (a && b) inter++;
          if (a || b) uni++;
        }
      // previous pixels that fell outside the current window
      iou = uni ? inter / uni : 1;
    }
    qa.prevMask = mask;
    qa.prevWin = win;
    qa.ring.set(i, { data, win });
    qa.ring.delete(i - 48);
    const p = qa.pose ?? { frame: "?", glitch: 0, dissolve: 0, flip: false };
    return {
      i,
      t: Math.round(performance.now()),
      count,
      bbox: count ? [x0 + win.x, y0 + win.y, x1 + win.x, y1 + win.y] : null,
      iou,
      win,
      frame: p.frame,
      glitch: p.glitch,
      dissolve: p.dissolve,
      facing: view.facingLeft !== !!p.flip ? "L" : "R",
      angle: Math.round(view.placement.angle),
      mode: cr.mode,
      anim: cr.animation,
      plan: cr.plan?.name ?? null,
      surface: cr.surface.kind,
      asleep: cr.asleep,
    };
  };
  /** World-aligned strip of ring frames a..b, dark background, labelled. */
  qa.strip = (a, b, labels, title) => {
    const ids = [];
    for (let i = a; i <= b; i++) if (qa.ring.has(i)) ids.push(i);
    const fr = ids.map((i) => qa.ring.get(i));
    const dpr = fr[0].data.width / 160;
    let X0 = Infinity, Y0 = Infinity, X1 = -Infinity, Y1 = -Infinity;
    for (const f of fr) {
      X0 = Math.min(X0, f.win.x); Y0 = Math.min(Y0, f.win.y);
      X1 = Math.max(X1, f.win.x + 160); Y1 = Math.max(Y1, f.win.y + 160);
    }
    // Clamp huge spans (flights): centre on the middle frame.
    const mid = fr[Math.floor(fr.length / 2)].win;
    if (X1 - X0 > 320) { X0 = mid.x - 80; X1 = mid.x + 240; }
    if (Y1 - Y0 > 320) { Y0 = mid.y - 80; Y1 = mid.y + 240; }
    const tw = Math.round((X1 - X0) * dpr * 0.75), th = Math.round((Y1 - Y0) * dpr * 0.75);
    const c = document.createElement("canvas");
    c.width = fr.length * (tw + 4);
    c.height = th + 72;
    const g = c.getContext("2d");
    g.fillStyle = "#15131f";
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#fff";
    g.font = "13px monospace";
    g.fillText(title, 4, 13);
    const tmp = document.createElement("canvas");
    fr.forEach((f, j) => {
      tmp.width = f.data.width; tmp.height = f.data.height;
      tmp.getContext("2d").putImageData(f.data, 0, 0);
      const ox = j * (tw + 4);
      g.fillStyle = "#24203a";
      g.fillRect(ox, 18, tw, th);
      g.imageSmoothingEnabled = false;
      g.drawImage(tmp, ox + (f.win.x - X0) * dpr * 0.75, 18 + (f.win.y - Y0) * dpr * 0.75, f.data.width * 0.75, f.data.height * 0.75);
      g.strokeStyle = "rgba(93,255,138,0.35)"; // ground line reference: bottom of the first frame's bbox
      g.fillStyle = ids[j] === labels.hl ? "#ff5f57" : "#ddd";
      g.font = "11px monospace";
      const l = labels.lines[j] ?? [];
      l.forEach((s, k) => g.fillText(s, ox + 2, 18 + th + 12 + k * 12));
    });
    return c.toDataURL("image/png");
  };
  window.__qa = qa;
};

// ------------------------------------------------------------- the recorder
const browser = await launch();
const findings = [];
const allSamples = {};
let cutN = 0;

async function open(query = "") {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.error("page error:", e.message));
  await page.clock.install({ time: new Date("2026-10-07T09:00:00") });
  await page.goto(`${BASE}/dev/stage.html?seed=${SEED}${query}`);
  await page.waitForSelector("body[data-ready='1']", { timeout: 30000 });
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 200);
  await page.clock.runFor(800);
  await page.evaluate(PAGE_QA);
  await page.mouse.move(5, 5);
  return page;
}

/** A filming session: step(ms) advances the clock in 50 ms ticks, sampling and checking each one. */
function session(page, name) {
  const s = [];
  allSamples[name] = s;
  const pending = []; // findings waiting for 4 frames of look-ahead before their strip is cut
  const recentFam = [];
  const flagged = new Set();
  const flag = (i, kind, detail, extra = {}) => {
    const key = `${kind}:${i}`;
    if (flagged.has(key)) return;
    // one finding per kind per 400 ms
    for (const f of findings) if (f.scenario === name && f.kind === kind && Math.abs(f.i - i) < 8) return;
    flagged.add(key);
    const a = s[i - 1] ?? s[i], b = s[i];
    const glitchy = Math.max(a.glitch, b.glitch);
    const f = {
      scenario: name, kind, i, t: b.t, detail,
      from: `${a.anim}(${a.frame}${a.facing})`, to: `${b.anim}(${b.frame}${b.facing})`,
      mode: `${a.mode}>${b.mode}`, plan: b.plan ?? a.plan, glitch: +glitchy.toFixed(2), masked: glitchy >= 0.3, ...extra,
    };
    findings.push(f);
    pending.push(f);
  };
  const check = () => {
    const i = s.length - 1;
    const b = s[i], a = s[i - 1];
    if (!a) return;
    const intendedGone = ["glitchOut", "gone", "glitchIn"].includes(b.anim) || ["glitchOut", "gone", "glitchIn"].includes(a.anim) || b.dissolve > 0 || a.dissolve > 0 || b.plan === "teleport";
    const standing = a.mode === "stand" && b.mode === "stand";
    if (a.count > 200 && b.count < a.count * 0.3 && !intendedGone) flag(i, "vanish", `area ${a.count} -> ${b.count}`);
    if (a.count > 200 && b.count > 200 && standing && b.iou < 0.35 && a.angle === b.angle) flag(i, "iou", `IoU ${b.iou.toFixed(2)}`);
    if (a.bbox && b.bbox && standing && b.angle === a.angle) {
      const feet = Math.abs(b.bbox[3] - a.bbox[3]);
      const cx = Math.abs((b.bbox[0] + b.bbox[2]) / 2 - (a.bbox[0] + a.bbox[2]) / 2);
      const moved = Math.hypot(b.win.x - a.win.x, b.win.y - a.win.y);
      if ((feet > 10 || cx > 22) && moved < 12) flag(i, "jump", `feet dy ${feet}px, centre dx ${cx.toFixed(0)}px (window moved ${moved.toFixed(0)})`);
    }
    if (a.count > 200 && b.count > 200 && a.frame !== b.frame) {
      const fa = family(a.frame), fb = family(b.frame);
      if (fa !== fb && !OK_PAIRS.has(`${fa}>${fb}`) && b.angle === a.angle) flag(i, "family", `${fa} -> ${fb}`);
    }
    if (a.count > 200 && b.count > 200 && a.facing !== b.facing && a.angle === b.angle) flag(i, "flip", `facing ${a.facing} -> ${b.facing} on ${b.frame}`);
    // blip: x A x  (one sample of another family)
    const c = s[i - 2];
    if (c && a.count > 200 && family(c.frame) === family(b.frame) && family(a.frame) !== family(b.frame) && a.glitch < 0.3)
      flag(i - 1, "blip", `${family(a.frame)} shown 1 tick inside ${family(b.frame)} (${a.frame})`);
    recentFam.push([b.t, family(b.frame) + (b.facing)]);
    while (recentFam.length && recentFam[0][0] < b.t - 1000) recentFam.shift();
    let changes = 0;
    for (let j = 1; j < recentFam.length; j++) if (recentFam[j][1] !== recentFam[j - 1][1]) changes++;
    if (changes >= 4) flag(i, "flicker", `${changes} family/facing changes in 1 s`);
  };
  const cut = async (f) => {
    const n = ++cutN;
    const a = Math.max(0, f.i - 4), b = f.i + 3;
    const lines = [];
    for (let j = a; j <= b; j++) {
      const x = s[j];
      if (!x) continue;
      lines.push([`${x.t % 100000}ms ${x.facing}`, x.anim.slice(0, 11), x.frame.slice(0, 11), `g${x.glitch.toFixed(1)} ${x.mode.slice(0, 5)}`]);
    }
    const title = `#${n} ${f.kind} ${f.scenario} t=${f.t} ${f.from} -> ${f.to}  ${f.detail}`;
    const url = await page.evaluate(([a, b, lines, hl, title]) => window.__qa.strip(a, b, { lines, hl }, title), [a, b, lines, f.i, title]);
    f.strip = join(OUT, `cut-${n}.png`).replaceAll("\\", "/");
    writeFileSync(f.strip, Buffer.from(url.split(",")[1], "base64"));
  };
  return {
    samples: s,
    async step(ms) {
      for (let t = 0; t < ms; t += STEP) {
        await page.clock.runFor(STEP);
        s.push(await page.evaluate(() => window.__qa.sample()));
        check();
        while (pending.length && s.length - 1 >= pending[0].i + 3) await cut(pending.shift());
      }
    },
    async flush() {
      for (const f of pending.splice(0)) await cut(f);
    },
    async strip(label, from, to) {
      // a reference strip (not a finding), e.g. a walk cycle
      const n = ++cutN;
      const lines = [];
      for (let j = from; j <= to; j++) {
        const x = s[j];
        if (x) lines.push([`${x.t % 100000}ms ${x.facing}`, x.anim.slice(0, 11), x.frame.slice(0, 11), `win ${Math.round(x.win.x)}`]);
      }
      const url = await page.evaluate(([a, b, lines, title]) => window.__qa.strip(a, b, { lines, hl: -1 }, title), [from, to, lines, `ref ${label}`]);
      const p = join(OUT, `ref-${label}.png`).replaceAll("\\", "/");
      writeFileSync(p, Buffer.from(url.split(",")[1], "base64"));
      cutN--;
      return p;
    },
  };
}

const ACTIONS = [
  "idle", "think", "ask", "happy", "sleep", "wake", "sad", "angry", "scared", "dance", "eat", "celebrate", "point", "typing", "sit",
  "startled", "laugh", "grabCursor", "carryCursor", "dragWindow", "pushWindow", "peek", "dangle", "fall", "land", "glitchOut", "chaosSpin",
  "napRock", "cling", "climb", "run", "crouch", "airUp", "airDown", "talk", "wave", "tumble", "flail", "splat", "dizzy", "sitEdge", "peekEdge",
  "lookAround", "lookBack", "build", "malfunction", "yawn", "held", "heldKick", "listen", "walk",
];
const BEHAVIOURS = ["stroll", "run", "climb", "jump", "sitEdge", "peekEdge", "hopDown", "teleport", "build", "chaos", "malfunction", "lookAround", "climbOn", "climbDown", "crawl", "drop", "lookBack", "sleep", "celebrate"];
const MOODS = ["thinking", "happy", "asking", "idle", "listening", "talking"];
const act = (page, n) => page.evaluate((n) => window.__stage.do(n), n);

async function grab(page) {
  const w = await page.evaluate(() => window.__stage.win);
  const hb = await page.evaluate(() => window.__stage.hitbox);
  return { x: w.x + hb.x + hb.w / 2, y: w.y + hb.y + hb.h * 0.3 };
}

const scenarios = {
  async roam() {
    const page = await open("&movement=1");
    const S = session(page, "roam");
    await S.step(MINUTES * 60_000);
    await S.flush();
    roamStats(S.samples, page);
    const poses = await page.evaluate(() => window.__qa.poses);
    roamFidgets(poses);
    await page.close();
  },
  async actions() {
    const page = await open("&movement=0");
    const S = session(page, "actions");
    for (const a of ACTIONS) {
      await act(page, a);
      await S.step(a === "sleep" ? 6000 : 4500);
      await act(page, "idle");
      await S.step(1500);
    }
    await S.flush();
    await page.close();
  },
  async behaviours() {
    const page = await open();
    const S = session(page, "behaviours");
    for (const b of BEHAVIOURS) {
      await act(page, b);
      await S.step(9000);
    }
    await S.flush();
    await page.close();
  },
  async moods() {
    const page = await open("&movement=0");
    const S = session(page, "moods");
    for (const m of MOODS) {
      await page.evaluate((m) => window.__stage.mood(m), m);
      await S.step(5000);
    }
    await page.evaluate(() => window.__stage.mood("idle"));
    await S.step(3000);
    await S.flush();
    await page.close();
  },
  async drag() {
    const page = await open("&movement=0");
    const S = session(page, "drag");
    await S.step(1000);
    const g = await grab(page);
    await page.mouse.move(g.x, g.y);
    await S.step(300);
    await page.mouse.down();
    for (let i = 0; i <= 20; i++) {
      await page.mouse.move(g.x - i * 22, g.y - i * 8);
      await S.step(50);
    }
    await S.step(800);
    for (let i = 0; i <= 10; i++) {
      await page.mouse.move(g.x - 440 + i * 10, g.y - 160);
      await S.step(50);
    }
    await page.mouse.up();
    await page.mouse.move(5, 5);
    await S.step(4000);
    await S.flush();
    await page.close();
  },
  async throw() {
    const page = await open("&movement=0");
    const S = session(page, "throw");
    await S.step(1000);
    const g = await grab(page);
    await page.mouse.move(g.x, g.y);
    await page.mouse.down();
    for (let i = 0; i <= 12; i++) {
      await page.mouse.move(g.x - i * 25, g.y - i * 20);
      await S.step(50);
    }
    for (let i = 0; i <= 6; i++) {
      await page.mouse.move(g.x - 300 + i * 90, g.y - 240 - i * 30);
      await page.clock.runFor(16);
    }
    await page.mouse.up();
    await page.mouse.move(5, 5);
    await S.step(7000);
    await S.flush();
    await page.close();
  },
  async chat() {
    const page = await open();
    const S = session(page, "chat");
    for (let k = 0; k < 3; k++) {
      await S.step(1500);
      await page.evaluate(() => window.__stage.panel(true));
      await S.step(1200);
      await page.evaluate(() => window.__stage.mood("thinking"));
      await S.step(2500);
      await page.evaluate(() => window.__stage.mood("talking"));
      await S.step(2500);
      await page.evaluate(() => window.__stage.mood("idle"));
      await page.evaluate(() => window.__stage.panel(false));
      await S.step(3000);
    }
    await S.flush();
    await page.close();
  },
  async sleep() {
    const page = await open("&movement=0");
    const S = session(page, "sleep");
    await act(page, "sleep");
    await S.step(7000);
    await page.evaluate(() => window.__stage.mood("idle")); // wakes him
    await S.step(4000);
    await act(page, "yawn");
    await S.step(7000);
    await page.mouse.move(...Object.values(await grab(page))); // hover wakes
    await S.step(3000);
    await page.mouse.move(5, 5);
    await S.step(2000);
    await S.flush();
    await page.close();
  },
  async sit() {
    const page = await open("&movement=0");
    const S = session(page, "sit");
    for (let k = 0; k < 2; k++) {
      await act(page, "sit");
      await S.step(9000);
      await act(page, "idle");
      await S.step(2000);
    }
    await act(page, "sitEdge");
    await S.step(8000);
    await S.flush();
    await page.close();
  },
  async turn() {
    const page = await open("&movement=1");
    const S = session(page, "turn");
    // Walk left, then right: stroll repeatedly, keep a reference strip of a walk cycle.
    let ref = null;
    for (let k = 0; k < 6; k++) {
      await act(page, "stroll");
      for (let j = 0; j < 12; j++) {
        await S.step(500);
        // reference strip of a steady walk cycle (8 frames, still in the ring)
        const n = S.samples.length;
        if (!ref && n > 16 && S.samples.slice(n - 16).every((x) => x.anim === "walk")) ref = await S.strip("walk", n - 8, n - 1);
      }
    }
    await S.flush();
    await page.close();
  },
  async climb() {
    const page = await open();
    const S = session(page, "climb");
    for (const b of ["climb", "climbDown", "climb", "crawl", "drop", "climbOn", "climbDown"]) {
      await act(page, b);
      await S.step(10000);
    }
    await S.flush();
    await page.close();
  },
  async jump() {
    const page = await open();
    const S = session(page, "jump");
    for (let k = 0; k < 4; k++) {
      await act(page, "jump");
      await S.step(6000);
      await act(page, "hopDown");
      await S.step(5000);
    }
    await S.flush();
    await page.close();
  },
  async windows() {
    const page = await open();
    const S = session(page, "windows");
    // Get him onto a window, then move it, then close it.
    for (let k = 0; k < 4; k++) {
      await act(page, "jump");
      await S.step(5000);
      const st = await page.evaluate(() => window.__stage.state());
      if (st.surface !== "floor") break;
    }
    const st = await page.evaluate(() => window.__stage.state());
    const led = await page.evaluate(() => window.__stage.ledges());
    const under = led.find((l) => Math.abs(l.y - (st.win.y + 156)) < 30) ?? led[0];
    console.log("windows: on", st.surface, "ledge", under?.id);
    if (under) {
      for (let i = 0; i < 20; i++) {
        await page.evaluate((id) => window.__stage.moveWin(id, 6, -2), under.id);
        await S.step(50);
      }
      await S.step(2000);
      await page.evaluate((id) => window.__stage.closeWin(id), under.id);
      await S.step(5000);
    }
    await S.flush();
    await page.close();
  },
};

// --------------------------------------------------------------- roam stats
const stats = {};
function roamStats(s) {
  const anims = {}, plans = {};
  let cur = null, start = 0, curPlan = null;
  const seq = [];
  for (const x of s) {
    if (x.anim !== cur) {
      if (cur) (anims[cur] ??= { n: 0, ms: 0 }), (anims[cur].n++, (anims[cur].ms += x.t - start));
      cur = x.anim;
      start = x.t;
      seq.push(x.anim);
    }
    if (x.plan !== curPlan) {
      if (x.plan) plans[x.plan] = (plans[x.plan] ?? 0) + 1;
      curPlan = x.plan;
    }
  }
  // Walk sliding: window speed during walk/run vs the stride the cycle implies.
  const slide = { walk: [], run: [] };
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1], b = s[i];
    if (a.anim === b.anim && (b.anim === "walk" || b.anim === "run") && b.surface === "floor") slide[b.anim].push(Math.abs(b.win.x - a.win.x) / ((b.t - a.t) / 1000));
  }
  const pct = (arr, p) => (arr.length ? [...arr].sort((m, n) => m - n)[Math.floor(p * (arr.length - 1))] : null);
  stats.roam = {
    simulatedMs: s.at(-1).t - s[0].t,
    anims: Object.fromEntries(Object.entries(anims).sort((m, n) => n[1].n - m[1].n)),
    plans,
    animSequence: seq.join(" "),
    windowSpeed: {
      walk: { cycleImplies: 70, p10: pct(slide.walk, 0.1), median: pct(slide.walk, 0.5), p90: pct(slide.walk, 0.9), share_below_50: slide.walk.filter((v) => v < 50).length / (slide.walk.length || 1) },
      run: { cycleImplies: 180, p10: pct(slide.run, 0.1), median: pct(slide.run, 0.5), p90: pct(slide.run, 0.9) },
    },
  };
}
function roamFidgets(poses) {
  // Classify idle fidgets from the rendered poses.
  const fid = {};
  let last = null;
  for (const p of poses) {
    if (p.anim !== "idle") continue;
    let k = null;
    if (p.frame.startsWith("sneeze")) k = "sneeze";
    else if (p.frame.startsWith("sit")) k = "sit";
    else if (p.frame === "side") k = p.flip ? "glance-both" : "glance";
    else if (p.dy < -2) k = "hop";
    else if (p.sy > 1.04) k = "stretch";
    else if (p.frame === "idle2") k = "ear-twitch";
    else if (p.frame === "idle5") k = "blink";
    else if (p.glitch > 0.5) k = "burst";
    if (k && k !== last) fid[k] = (fid[k] ?? 0) + 1;
    last = k ?? (p.frame === "idle0" || p.frame === "idle1" ? null : last);
  }
  stats.idleFidgets = fid;
}

// -------------------------------------------------------------------- main
const run = ONLY ?? Object.keys(scenarios);
for (const name of run) {
  const t0 = Date.now();
  try {
    await scenarios[name]();
  } catch (e) {
    console.error(name, "failed:", e.message);
  }
  console.log(`${name}: ${((Date.now() - t0) / 1000).toFixed(0)} s, findings so far ${findings.length}`);
}
await browser.close();

const byKind = {};
for (const f of findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
writeFileSync(join(OUT, "report.json"), JSON.stringify({ byKind, stats, findings }, null, 1));
writeFileSync(
  join(OUT, "report.txt"),
  [
    JSON.stringify(byKind),
    JSON.stringify(stats, null, 1),
    ...findings.map((f) => `${f.strip}\t${f.scenario}\t${f.kind}\tt=${f.t}\t${f.from} -> ${f.to}\t${f.mode}\tplan=${f.plan}\tg=${f.glitch}${f.masked ? " MASKED" : ""}\t${f.detail}`),
  ].join("\n"),
);
console.log(byKind);
