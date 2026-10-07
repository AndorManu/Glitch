// Visual QA, steps 3-5 (live): films Glitch on dev/stage.html (the real
// Creature, Renderer, brain) every 50 ms under a fake clock while doing
// everything a user could do to him and everything that can happen to him,
// flags discontinuities like dev/qa-film.mjs (same detectors, copied from it)
// and saves reference strips of every scenario.
//
//   npx vite --port 1450 --strictPort
//   GLITCH_DEV_URL=http://localhost:1450 node dev/vqa-stage.mjs [scenario,...] [--seed=11]
// Output: dev/out/vqa/stage/ (cut-<n>.png findings, ref-<label>.png strips, report.json/.txt)

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE, launch } from "./browser.mjs";

const OUT = "dev/out/vqa/stage";
mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const opt = (k, d) => args.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const ONLY = args.find((a) => !a.startsWith("--"))?.split(",");
const SEED = Number(opt("seed", 11));
const ROAM_MIN = Number(opt("roam", 30));
const STEP = 50;

// ------------------------------------------------------------ frame families
/** Which drawn "family" a frame belongs to: a change of family needs in-between frames. */
function family(frame) {
  const f = frame.replace(/\d+$/, "");
  // Drawn transition clips and in-between sheets: they ARE the in-betweens, so
  // they connect to the families on either side (pose pops inside them still
  // show up as iou/jump findings).
  if (/^(sit_down|stand_up_|turn_|walk_start|walk_stop|lie_down|get_up|wake|stretch|look_back|sit_idle_look|sit_edge_swing|pull_up|hang_ledge|slide_down|bounce|wall_jump|tail_copter|glide|fall_flail)/.test(f)) return "clip";
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
      mirrorable: view.sprites?.mirrorable?.(p.frame) !== false,
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
      if (fa !== fb && fa !== "clip" && fb !== "clip" && !OK_PAIRS.has(`${fa}>${fb}`) && b.angle === a.angle) flag(i, "family", `${fa} -> ${fb}`);
    }
    // A mirror flip only shows between two side-on (mirrorable) frames; front-facing ones never mirror.
    if (a.count > 200 && b.count > 200 && a.facing !== b.facing && a.angle === b.angle && a.mirrorable && b.mirrorable) flag(i, "flip", `facing ${a.facing} -> ${b.facing} on ${b.frame}`);
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
    f.strip = join(OUT, `cut-${name}-${n}.png`).replaceAll("\\", "/");
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
      const p = join(OUT, `ref-${name}-${label}.png`).replaceAll("\\", "/");
      writeFileSync(p, Buffer.from(url.split(",")[1], "base64"));
      cutN--;
      return p;
    },
  };
}


// ------------------------------------------------------------- vqa helpers
const notes = []; // per-scenario observations (state sequences, measurements)
const note = (scenario, what, data) => notes.push({ scenario, what, ...data });
const act = (page, n) => page.evaluate((n) => window.__stage.do(n), n);
const st = (page) => page.evaluate(() => window.__stage.state());
const ev = (page, fn, arg) => page.evaluate(fn, arg);
async function grab(page) {
  const w = await page.evaluate(() => window.__stage.win);
  const hb = await page.evaluate(() => window.__stage.hitbox);
  if (!hb) return { x: w.x + 80, y: w.y + 110 };
  return { x: w.x + hb.x + hb.w / 2, y: w.y + hb.y + hb.h * 0.35 };
}
let refN = 0;
/** Reference strip of the last n samples (n <= 40). */
async function ref(S, label, n = 16) {
  const len = S.samples.length;
  return S.strip(`${String(++refN).padStart(3, "0")}-${label}`, Math.max(0, len - n), len - 1);
}
/** Anim / mode / surface sequence of samples since index i (run-length). */
function seq(S, i = 0) {
  const out = [];
  for (const x of S.samples.slice(Math.max(0, i))) {
    const k = `${x.anim}/${x.mode}/${x.surface}`;
    if (out.at(-1)?.[0] !== k) out.push([k, 1]);
    else out.at(-1)[1]++;
  }
  return out.map(([k, n]) => `${k}x${n}`).join(" ");
}
/** Fast flick through points (16 ms apart, no sampling) - what a throw looks like to the drag tracker. */
async function flick(page, pts) {
  for (const p of pts) {
    await page.mouse.move(p.x, p.y);
    await page.clock.runFor(16);
  }
}
const lerp = (a, b, n) => Array.from({ length: n }, (_, i) => ({ x: a.x + ((b.x - a.x) * (i + 1)) / n, y: a.y + ((b.y - a.y) * (i + 1)) / n }));
/** While held: distance from the cursor to his scruff (top-centre of the body box), per sample. */
function holdGap(S, from, cursorAt) {
  const gaps = [];
  for (const [i, x] of S.samples.slice(from).entries()) {
    const c = cursorAt[from + i];
    if (!c || !x.bbox || x.mode !== "held") continue;
    gaps.push(Math.round(Math.hypot((x.bbox[0] + x.bbox[2]) / 2 - c.x, x.bbox[1] - c.y)));
  }
  return gaps;
}
async function pickUp(page, S) {
  const g = await grab(page);
  await page.mouse.move(g.x, g.y);
  await S.step(100);
  await page.mouse.down();
  await page.mouse.move(g.x + 3, g.y - 8);
  await S.step(50);
  await page.mouse.move(g.x + 6, g.y - 20);
  await S.step(150);
  return { x: g.x + 6, y: g.y - 20 };
}
async function toLedge(page, S) {
  for (let k = 0; k < 6; k++) {
    await act(page, "jump");
    await S.step(4500);
    const s = await st(page);
    if (s.surface === "ledge") return s;
  }
  return st(page);
}
async function toWall(page, S) {
  for (let k = 0; k < 4; k++) {
    await act(page, "climb");
    await S.step(4000);
    const s = await st(page);
    if (["left", "right", "ceiling"].includes(s.surface)) return s;
  }
  return st(page);
}
const W = 1280;
const H = 800;

const scenarios = {
  async clicks() {
    const page = await open("&movement=0");
    const S = session(page, "clicks");
    await S.step(800);
    let g = await grab(page);
    let i0 = S.samples.length;
    await page.mouse.move(g.x, g.y);
    await S.step(150);
    await page.mouse.down();
    await S.step(50);
    await page.mouse.up();
    await S.step(1500);
    await ref(S, "single-click", 34);
    note("clicks", "single", { seq: seq(S, i0) });
    i0 = S.samples.length;
    for (let k = 0; k < 2; k++) {
      await page.mouse.down();
      await page.clock.runFor(30);
      await page.mouse.up();
      await page.clock.runFor(70);
    }
    await S.step(1500);
    await ref(S, "double-click", 32);
    note("clicks", "double", { seq: seq(S, i0) });
    i0 = S.samples.length;
    for (let k = 0; k < 30; k++) {
      g = await grab(page);
      await page.mouse.move(g.x, g.y);
      await page.mouse.down();
      await S.step(50);
      await page.mouse.up();
      await S.step(50);
      if (k === 14) await ref(S, "rapid-click-mid", 30);
    }
    await ref(S, "rapid-click-end", 30);
    const ann = await ev(page, () => window.__stage.creature.annoyance);
    await S.step(4000);
    await ref(S, "rapid-click-after", 40);
    note("clicks", "rapid 10/s x3s", { seq: seq(S, i0), annoyance: ann });
    await S.flush();
    await page.close();
  },

  async clickDuring() {
    const page = await open("&movement=1");
    const S = session(page, "clickDuring");
    await S.step(800);
    for (const a of ["stroll", "sit", "dance", "sleep", "wave", "talk", "typing", "think", "eat", "jump", "climb", "sitEdge", "peekEdge", "lookAround", "build", "teleport"]) {
      await page.mouse.move(5, 5);
      await act(page, a);
      await S.step(a === "sleep" ? 4000 : 1300);
      const before = await st(page);
      const g = await grab(page);
      const i0 = S.samples.length;
      await page.mouse.move(g.x, g.y);
      await S.step(150);
      await page.mouse.down();
      await S.step(50);
      await page.mouse.up();
      await S.step(1500);
      await ref(S, `click-during-${a}`, 36);
      note("clickDuring", a, { before: `${before.anim}/${before.mode}/${before.surface}`, seq: seq(S, i0) });
      await page.mouse.move(5, 5);
      await S.step(2500);
    }
    await S.flush();
    await page.close();
  },

  async hold() {
    const page = await open("&movement=0");
    const S = session(page, "hold");
    const cur = [];
    const track = async (ms, p) => {
      for (let t = 0; t < ms; t += STEP) {
        await S.step(STEP);
        cur[S.samples.length - 1] = p;
      }
    };
    await S.step(800);
    let g = await grab(page);
    let i0 = S.samples.length;
    await page.mouse.move(g.x, g.y);
    await page.mouse.down();
    await S.step(2000);
    await ref(S, "press-hold-still", 30);
    note("hold", "press without moving 2 s", { seq: seq(S, i0) });
    await page.mouse.up();
    await S.step(2000);
    i0 = S.samples.length;
    let p = await pickUp(page, S);
    await track(3000, p);
    await ref(S, "held-still", 40);
    note("hold", "held still", { seq: seq(S, i0), gaps: holdGap(S, i0, cur).slice(0, 80) });
    i0 = S.samples.length;
    for (let k = 0; k < 40; k++) {
      const q = { x: p.x + (k % 2 ? 60 : -60), y: p.y + (k % 4 < 2 ? 20 : -20) };
      await page.mouse.move(q.x, q.y);
      await track(50, q);
    }
    await ref(S, "shake-fast", 40);
    note("hold", "shake", { seq: seq(S, i0), gaps: holdGap(S, i0, cur) });
    i0 = S.samples.length;
    for (const q of lerp(p, { x: p.x - 600, y: p.y - 100 }, 120)) {
      await page.mouse.move(q.x, q.y);
      await track(50, q);
    }
    p = { x: p.x - 600, y: p.y - 100 };
    await ref(S, "slow-drag", 40);
    note("hold", "slow drag", { seq: seq(S, i0), gaps: holdGap(S, i0, cur) });
    for (const [label, q] of [["left-edge", { x: 2, y: 400 }], ["top-left", { x: 2, y: 2 }], ["above-top", { x: 640, y: 0 }], ["top-right", { x: W - 2, y: 2 }], ["right-edge", { x: W - 2, y: 400 }], ["bottom-right", { x: W - 2, y: H - 2 }], ["bottom-left", { x: 2, y: H - 2 }], ["taskbar", { x: 640, y: H - 15 }]]) {
      i0 = S.samples.length;
      for (const r of lerp(p, q, 10)) {
        await page.mouse.move(r.x, r.y);
        await track(50, r);
      }
      p = q;
      await track(800, p);
      await ref(S, `drag-${label}`, 24);
      const s = S.samples.at(-1);
      note("hold", `drag to ${label}`, { seq: seq(S, i0), win: s.win, bbox: s.bbox, visible: s.count, gap: holdGap(S, S.samples.length - 1, cur) });
    }
    for (const r of lerp(p, { x: 640, y: 300 }, 10)) {
      await page.mouse.move(r.x, r.y);
      await track(50, r);
    }
    await track(400, { x: 640, y: 300 });
    i0 = S.samples.length;
    await page.mouse.up();
    await page.mouse.move(5, 5);
    await S.step(3500);
    await ref(S, "drop-from-middle", 40);
    note("hold", "drop from mid-air (no throw)", { seq: seq(S, i0) });
    await S.flush();
    await page.close();
  },

  async throws() {
    const page = await open("&movement=0");
    const S = session(page, "throws");
    await S.step(800);
    const kinds = {
      gentle: (p) => lerp(p, { x: p.x + 60, y: p.y - 20 }, 4),
      hard: (p) => lerp(p, { x: p.x - 500, y: p.y - 200 }, 5),
      upward: (p) => lerp(p, { x: p.x, y: p.y - 350 }, 4),
      sideways: (p) => lerp(p, { x: p.x - 450, y: p.y }, 4),
      intoWall: (p) => lerp(p, { x: W - 5, y: p.y - 40 }, 4),
      ceilingDrop: () => [],
      ontoWindow: (p) => lerp(p, { x: 360, y: 200 }, 3),
    };
    for (const [name, mk] of Object.entries(kinds)) {
      let p = await pickUp(page, S);
      const start = name === "intoWall" ? { x: 900, y: 400 } : name === "ceilingDrop" ? { x: 640, y: 30 } : name === "ontoWindow" ? { x: 300, y: 120 } : { x: 760, y: 450 };
      for (const r of lerp(p, start, 12)) {
        await page.mouse.move(r.x, r.y);
        await S.step(50);
      }
      p = start;
      await S.step(500);
      const i0 = S.samples.length;
      await flick(page, mk(p));
      await page.mouse.up();
      await page.mouse.move(5, 5);
      await S.step(1500);
      await ref(S, `throw-${name}-flight`, 30);
      await S.step(3500);
      await ref(S, `throw-${name}-land`, 40);
      const s = await st(page);
      note("throws", name, { seq: seq(S, i0), end: `${s.anim}/${s.mode}/${s.surface}` });
      await S.step(2500);
      await page.clock.runFor(120000); // let the annoyance decay between throws
      await S.step(200);
    }
    await S.flush();
    await page.close();
  },

  async annoyance() {
    const page = await open("&movement=0");
    const S = session(page, "annoyance");
    await S.step(800);
    for (let k = 1; k <= 8; k++) {
      const i0 = S.samples.length;
      const p = await pickUp(page, S);
      for (const r of lerp(p, { x: p.x - 40, y: p.y - 120 }, 8)) {
        await page.mouse.move(r.x, r.y);
        await S.step(50);
      }
      await S.step(1200);
      await ref(S, `pickup-${k}-held`, 24);
      const a = await ev(page, () => window.__stage.creature.annoyance);
      await page.mouse.up();
      await S.step(2000);
      await ref(S, `pickup-${k}-after`, 40);
      await S.step(2000);
      await ref(S, `pickup-${k}-later`, 40);
      note("annoyance", `pickup ${k}`, { annoyance: +a.toFixed(2), seq: seq(S, i0) });
      await page.mouse.move(5, 5);
      await S.step(1500);
    }
    await S.step(15000);
    await ref(S, "recovery", 40);
    const i0 = S.samples.length;
    const g = await grab(page);
    await page.mouse.move(g.x, g.y);
    await S.step(150);
    await page.mouse.down();
    await S.step(50);
    await page.mouse.up();
    await S.step(2000);
    await ref(S, "recovery-click", 40);
    note("annoyance", "recovery", { annoyance: await ev(page, () => window.__stage.creature.annoyance), seq: seq(S, i0) });
    await S.flush();
    await page.close();
  },

  async chatStates() {
    const page = await open("&movement=1");
    const S = session(page, "chatStates");
    await S.step(800);
    const chat = async (label) => {
      const i0 = S.samples.length;
      await ev(page, () => window.__stage.panel(true));
      await S.step(1500);
      await ev(page, () => window.__stage.mood("thinking"));
      await S.step(2000);
      await ev(page, () => window.__stage.mood("talking"));
      await S.step(2500);
      await ref(S, `chat-${label}`, 40);
      await ev(page, () => window.__stage.mood("idle"));
      await ev(page, () => window.__stage.panel(false));
      await S.step(2500);
      await ref(S, `chat-${label}-close`, 30);
      note("chatStates", label, { seq: seq(S, i0) });
    };
    await act(page, "stroll");
    await S.step(1200);
    await chat("walking");
    await act(page, "sit");
    await S.step(2500);
    await chat("sitting");
    await act(page, "sleep");
    await S.step(5000);
    await chat("sleeping");
    const w = await toWall(page, S);
    note("chatStates", "wall reached", { surface: w.surface });
    await chat(`on-${w.surface}`);
    await page.clock.runFor(30000);
    await S.step(100);
    const l = await toLedge(page, S);
    note("chatStates", "ledge reached", { surface: l.surface });
    await chat(`on-${l.surface}`);
    let p = await pickUp(page, S);
    await S.step(500);
    let i0 = S.samples.length;
    await ev(page, () => window.__stage.panel(true));
    await ev(page, () => window.__stage.mood("thinking"));
    await S.step(1500);
    await ref(S, "chat-while-held", 30);
    await page.mouse.up();
    await page.mouse.move(5, 5);
    await S.step(3000);
    await ref(S, "chat-while-held-released", 40);
    note("chatStates", "held", { seq: seq(S, i0) });
    await ev(page, () => window.__stage.mood("idle"));
    await ev(page, () => window.__stage.panel(false));
    await S.step(2000);
    p = await pickUp(page, S);
    await flick(page, lerp(p, { x: p.x - 300, y: p.y - 250 }, 4));
    await page.mouse.up();
    await page.mouse.move(5, 5);
    i0 = S.samples.length;
    await S.step(150);
    await ev(page, () => window.__stage.panel(true));
    await ev(page, () => window.__stage.mood("thinking"));
    await S.step(3500);
    await ref(S, "chat-airborne", 40);
    note("chatStates", "airborne", { seq: seq(S, i0) });
    await ev(page, () => window.__stage.mood("talking"));
    await S.step(700);
    i0 = S.samples.length;
    await ev(page, () => window.__stage.panel(false));
    await ev(page, () => window.__stage.mood("idle"));
    await S.step(2000);
    await ref(S, "chat-close-mid-reply", 40);
    note("chatStates", "close mid reply", { seq: seq(S, i0) });
    await S.flush();
    await page.close();
  },

  async moodsLong() {
    const page = await open("&movement=0");
    const S = session(page, "moodsLong");
    await S.step(800);
    await ev(page, () => window.__stage.panel(true));
    for (const [m, ms] of [["thinking", 25000], ["talking", 6000], ["listening", 8000], ["looking", 8000], ["asking", 5000], ["happy", 5000], ["idle", 3000]]) {
      const i0 = S.samples.length;
      await ev(page, (m) => window.__stage.mood(m), m);
      await S.step(ms);
      await ref(S, `mood-${m}`, 40);
      note("moodsLong", m, { seq: seq(S, i0) });
    }
    const i0 = S.samples.length;
    await ev(page, () => window.__stage.creature.talk(120));
    await S.step(7000);
    await ref(S, "talk-120-chars", 40);
    note("moodsLong", "talk(120)", { seq: seq(S, i0) });
    await S.flush();
    await page.close();
  },

  async settings() {
    const page = await open("&movement=1");
    const S = session(page, "settings");
    await S.step(800);
    await act(page, "stroll");
    await S.step(1000);
    let i0 = S.samples.length;
    await ev(page, () => window.__stage.movement(false));
    await S.step(3000);
    await ref(S, "movement-off-mid-walk", 40);
    note("settings", "movement off mid walk", { seq: seq(S, i0) });
    await ev(page, () => window.__stage.movement(true));
    const w = await toWall(page, S);
    i0 = S.samples.length;
    await ev(page, () => window.__stage.movement(false));
    await S.step(4000);
    await ref(S, "movement-off-on-wall", 40);
    note("settings", `movement off on ${w.surface}`, { seq: seq(S, i0) });
    await ev(page, () => window.__stage.movement(true));
    await S.step(3000);
    const hasDirector = await ev(page, () => !!window.__stage.creature.director);
    note("settings", "chaos director present", { hasDirector });
    i0 = S.samples.length;
    await ev(page, () => window.__stage.creature.setChaos(true));
    await act(page, "chaos");
    await S.step(2000);
    await ev(page, () => window.__stage.creature.setChaos(false));
    await S.step(3000);
    await ref(S, "chaos-off-mid-act", 40);
    note("settings", "chaos on then off", { seq: seq(S, i0) });
    i0 = S.samples.length;
    await ev(page, () => window.__stage.panel(true));
    await S.step(10000);
    await ref(S, "panel-open-10s", 40);
    note("settings", "panel open 10 s", { seq: seq(S, i0) });
    await S.flush();
    await page.close();
  },

  async emotesOnSurfaces() {
    const page = await open("&movement=1");
    const S = session(page, "emotesOnSurfaces");
    await S.step(800);
    const EMOTES = ["wave", "think", "laugh", "talk", "celebrate", "point", "sad", "angry", "scared", "dance", "eat", "sneeze", "listen", "typing"];
    const tryAll = async (where) => {
      const res = {};
      for (const e of EMOTES) {
        const s0 = await st(page);
        const ok = await act(page, e);
        await S.step(1800);
        const s1 = await st(page);
        res[e] = `${ok ? "played" : "refused"} -> ${s1.anim}${s0.surface !== s1.surface ? ` (surface ${s0.surface} -> ${s1.surface})` : ""}`;
        if (ok && ["wave", "think", "talk"].includes(e)) await ref(S, `emote-${e}-${where}`, 36);
      }
      note("emotesOnSurfaces", where, res);
    };
    await tryAll("floor");
    await act(page, "sit");
    await S.step(3000);
    let i0 = S.samples.length;
    await act(page, "wave");
    await S.step(3000);
    await ref(S, "emote-wave-from-sitting", 40);
    note("emotesOnSurfaces", "wave from sitting", { seq: seq(S, i0) });
    const l = await toLedge(page, S);
    await ev(page, () => window.__stage.movement(false));
    await tryAll(`ledge-${l.surface}`);
    await ev(page, () => window.__stage.movement(true));
    const w = await toWall(page, S);
    await ev(page, () => window.__stage.movement(false));
    await S.step(200);
    await tryAll(`wall-${w.surface}`);
    for (const m of ["thinking", "talking", "listening", "looking"]) {
      i0 = S.samples.length;
      await ev(page, (m) => window.__stage.mood(m), m);
      await S.step(2500);
      note("emotesOnSurfaces", `mood ${m} on ${(await st(page)).surface}`, { seq: seq(S, i0) });
    }
    await ref(S, "moods-on-wall", 40);
    await ev(page, () => window.__stage.mood("idle"));
    await S.flush();
    await page.close();
  },

  async world() {
    const page = await open("&movement=1");
    const S = session(page, "world");
    await S.step(800);
    const onWin = async () => {
      await ev(page, () => window.__stage.movement(true));
      const s = await toLedge(page, S);
      const led = await ev(page, () => window.__stage.ledges());
      const under = led.find((l) => Math.abs(l.y - (s.win.y + 156)) < 40 && s.win.x + 80 > l.x - 20 && s.win.x + 80 < l.x + l.w + 20) ?? led[0];
      await ev(page, () => window.__stage.movement(false));
      return { s, id: under?.id };
    };
    const ledgeFeet = async (id) => {
      const a = (await ev(page, () => window.__stage.apps.map((w) => ({ ...w })))).find((w) => w.id === id);
      const x = S.samples.at(-1);
      return a && x.bbox ? Math.round(x.bbox[3] - a.y) : null;
    };
    let { s, id } = await onWin();
    note("world", "on window", { surface: s.surface, id });
    let i0 = S.samples.length;
    const gaps = [];
    await ev(page, (id) => window.__stage.moveWin(id, 200, -40, 4000), id);
    for (let t = 0; t < 4500; t += 250) {
      await S.step(250);
      gaps.push(await ledgeFeet(id));
    }
    await ref(S, "window-slow-move", 40);
    note("world", "window moves slowly", { seq: seq(S, i0), feetMinusWindowTop: gaps.slice() });
    i0 = S.samples.length;
    gaps.length = 0;
    await ev(page, (id) => window.__stage.moveWin(id, -300, 30, 300), id);
    for (let t = 0; t < 2000; t += 100) {
      await S.step(100);
      gaps.push(await ledgeFeet(id));
    }
    await ref(S, "window-fast-move", 40);
    note("world", "window moves fast", { seq: seq(S, i0), feetMinusWindowTop: gaps.slice() });
    i0 = S.samples.length;
    await ev(page, (id) => window.__stage.moveWin(id, 0, 250, 0), id);
    await S.step(3000);
    await ref(S, "window-yanked-down", 40);
    note("world", "window yanked down", { seq: seq(S, i0) });
    ({ s, id } = await onWin());
    i0 = S.samples.length;
    await ev(page, (id) => {
      const st = window.__stage;
      const a = st.apps.find((w) => w.id === id);
      const other = st.apps.find((w) => w.id !== id && !w.closed);
      other.x = a.x + 10;
      other.y = a.y - 60;
      st.apps.splice(st.apps.indexOf(other), 1);
      st.apps.push(other);
    }, id);
    await S.step(4000);
    await ref(S, "window-covered", 40);
    note("world", "window under him covered by another", { seq: seq(S, i0), state: await st(page) });
    ({ s, id } = await onWin());
    i0 = S.samples.length;
    await ev(page, (id) => window.__stage.closeWin(id), id);
    await S.step(4000);
    await ref(S, "window-closed", 40);
    note("world", "window closed under him", { on: s.surface, seq: seq(S, i0) });
    await ev(page, () => {
      let y = 260;
      for (const w of window.__stage.apps.filter((w) => !w.closed)) {
        w.x = 400;
        w.y = y;
        y += 60;
      }
    });
    await ev(page, () => window.__stage.movement(true));
    i0 = S.samples.length;
    for (let k = 0; k < 4; k++) {
      await act(page, "jump");
      await S.step(5000);
    }
    await ref(S, "stacked-windows", 40);
    note("world", "stacked windows, 4 jumps", { seq: seq(S, i0) });
    await S.flush();
    await page.close();
  },

  async climbGone() {
    const page = await open("&movement=1");
    const S = session(page, "climbGone");
    await S.step(800);
    let i0 = S.samples.length;
    let found = null;
    for (const b of ["climbOn", "hangOn", "climbOn"]) {
      await act(page, b);
      for (let t = 0; t < 8000; t += 250) {
        await S.step(250);
        const s = await st(page);
        if (["climb", "pull_up", "hang_ledge"].includes(s.anim)) {
          found = s;
          break;
        }
      }
      if (found) break;
    }
    note("climbGone", "climbOn/hangOn", { seq: seq(S, i0), found });
    if (found) {
      const led = await ev(page, () => window.__stage.ledges());
      const near = led.sort((a, b) => Math.abs(a.y - found.win.y) - Math.abs(b.y - found.win.y))[0];
      i0 = S.samples.length;
      await ev(page, (id) => window.__stage.closeWin(id), near.id);
      await S.step(4000);
      await ref(S, "climbed-window-closed", 40);
      note("climbGone", "window he hangs on / climbs closed", { seq: seq(S, i0) });
    }
    await S.flush();
    await page.close();
  },

  async idleLong() {
    const page = await open("&movement=0");
    const S = session(page, "idleLong");
    let asleepAt = null;
    const timeline = [];
    for (let t = 0; t < 20 * 60_000; t += 6000) {
      await page.clock.runFor(5000);
      await S.step(1000);
      const s = S.samples.at(-1);
      timeline.push(`${Math.round(t / 1000)}s:${s.anim}`);
      if (s.asleep && asleepAt === null) {
        asleepAt = t;
        await S.step(3000);
        await ref(S, "sleep-onset", 40);
        break;
      }
    }
    note("idleLong", "sleep onset", { asleepAt, timeline: timeline.filter((x, i, a) => i === 0 || x.split(":")[1] !== a[i - 1].split(":")[1]).join(" ") });
    await S.step(6000);
    await ref(S, "asleep", 40);
    let i0 = S.samples.length;
    let g = await grab(page);
    await page.mouse.move(g.x, g.y);
    await S.step(3500);
    await ref(S, "wake-by-hover", 40);
    note("idleLong", "wake by hover", { seq: seq(S, i0) });
    await page.mouse.move(5, 5);
    await S.step(3000);
    await act(page, "sleep");
    await S.step(5000);
    i0 = S.samples.length;
    g = await grab(page);
    await page.mouse.move(g.x, g.y);
    await page.clock.runFor(30);
    await page.mouse.down();
    await S.step(50);
    await page.mouse.up();
    await S.step(3500);
    await ref(S, "wake-by-click", 40);
    note("idleLong", "wake by click", { seq: seq(S, i0) });
    await page.mouse.move(5, 5);
    await S.step(3000);
    await act(page, "sleep");
    await S.step(5000);
    i0 = S.samples.length;
    await pickUp(page, S);
    await S.step(1500);
    await ref(S, "pickup-asleep", 40);
    await page.mouse.up();
    await S.step(2500);
    note("idleLong", "pick up while asleep", { seq: seq(S, i0) });
    await S.flush();
    await page.close();
  },

  async roam() {
    const page = await open("&movement=1");
    await page.evaluate(() => {
      const cr = window.__stage.creature;
      window.__roam = { plans: [], anims: [] };
      let lastP = null;
      let lastA = null;
      setInterval(() => {
        const p = cr.plan?.name ?? null;
        if (p !== lastP) {
          if (p) window.__roam.plans.push(p);
          lastP = p;
        }
        const a = cr.animation;
        if (a !== lastA) {
          window.__roam.anims.push(a);
          lastA = a;
        }
      }, 50);
    });
    for (let m = 0; m < ROAM_MIN; m++) await page.clock.runFor(60_000);
    const r = await page.evaluate(() => ({ plans: window.__roam.plans, anims: window.__roam.anims, poses: window.__qa.poses.length }));
    const poses = await page.evaluate(() => window.__qa.poses.map((p) => [p.anim, p.frame]));
    const count = (arr) => Object.entries(arr.reduce((o, x) => ((o[x] = (o[x] ?? 0) + 1), o), {})).sort((a, b) => b[1] - a[1]);
    const fid = {};
    let last = null;
    for (const [anim, frame] of poses) {
      if (anim !== "idle") {
        last = null;
        continue;
      }
      const sheet = frame.replace(/\d+$/, "");
      if (sheet !== last && sheet !== "idle") fid[sheet] = (fid[sheet] ?? 0) + 1;
      last = sheet;
    }
    const grams = {};
    for (let i = 0; i + 3 <= r.plans.length; i++) {
      const g = r.plans.slice(i, i + 3).join(">");
      grams[g] = (grams[g] ?? 0) + 1;
    }
    let maxRun = 0;
    let run = 1;
    for (let i = 1; i < r.plans.length; i++) {
      run = r.plans[i] === r.plans[i - 1] ? run + 1 : 1;
      maxRun = Math.max(maxRun, run);
    }
    note("roam", `${ROAM_MIN} min`, { plans: count(r.plans), anims: count(r.anims).slice(0, 40), fidgetSheets: Object.entries(fid).sort((a, b) => b[1] - a[1]), topPlanTrigrams: Object.entries(grams).sort((a, b) => b[1] - a[1]).slice(0, 8), longestSamePlanRun: maxRun, renders: r.poses });
    await page.close();
  },
};

// -------------------------------------------------------------------- main
const run = ONLY ?? Object.keys(scenarios);
for (const name of run) {
  const t0 = Date.now();
  try {
    await scenarios[name]();
  } catch (e) {
    console.error(name, "failed:", e.stack ?? e.message);
    note(name, "FAILED", { error: String(e.message) });
  }
  console.log(`${name}: ${((Date.now() - t0) / 1000).toFixed(0)} s, findings so far ${findings.length}`);
  writeFileSync(join(OUT, `report-${run.length === 1 ? run[0] : "all"}.json`), JSON.stringify({ findings, notes }, null, 1));
}
await browser.close();
const byKind = {};
for (const f of findings) {
  const k = `${f.scenario}:${f.kind}${f.masked ? "(masked)" : ""}`;
  byKind[k] = (byKind[k] ?? 0) + 1;
}
const tag = run.length === 1 ? run[0] : "all";
writeFileSync(join(OUT, `report-${tag}.json`), JSON.stringify({ byKind, findings, notes }, null, 1));
writeFileSync(
  join(OUT, `report-${tag}.txt`),
  [
    JSON.stringify(byKind, null, 1),
    ...notes.map((n) => JSON.stringify(n)),
    ...findings.map((f) => `${f.strip}\t${f.scenario}\t${f.kind}\tt=${f.t}\t${f.from} -> ${f.to}\t${f.mode}\tplan=${f.plan}\tg=${f.glitch}${f.masked ? " MASKED" : ""}\t${f.detail}`),
  ].join("\n"),
);
console.log(byKind);
