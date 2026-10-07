#!/usr/bin/env node
// Live check against a REAL Ollama: sends exactly what Glitch sends (prompts
// and tools come from request-template.json, generated from the Rust code)
// and checks the model calls the right tools. Needs Node 18+, nothing else.
//
//   node dev/ollama-check/check.mjs                 # model picked by RAM, like Glitch
//   node dev/ollama-check/check.mjs --model qwen3.5:4b
//   node dev/ollama-check/check.mjs --all           # every installed tool-capable model
//   node dev/ollama-check/check.mjs --pull          # download the model if missing
//   node dev/ollama-check/check.mjs --wait-unload   # also wait for keep_alive to unload (~2.5 min)
//   node dev/ollama-check/check.mjs --eval [--runs 3] [--only vision]
//                                                   # the full agent eval (below)
//
// Writes dev/ollama-check/report.json and exits 1 if a check fails.
//
// --eval runs crates/glitch-core/examples/live_eval.rs: Glitch's REAL agent
// loop (system prompt, tools, screen prefetch, multi-step loop, approvals)
// against the real model with a fake desktop. Vision cases show it rendered
// screenshots with known text (fixtures/*.png, made by render-fixtures.mjs:
// an error dialog, a code editor with a bug, a web article, a text editor);
// multi-step cases script the clipboard, files, selection and timers
// ("what's 15% of the number in my clipboard", "find my latest screenshot and
// open it", ...). Each case runs --runs times (default 3); see
// dev/ollama-check/eval-report.json for every answer and tool call.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";

const here = new URL(".", import.meta.url);
const T = JSON.parse(readFileSync(new URL("request-template.json", here), "utf8"));
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const BASE = (opt("--url") ?? "http://127.0.0.1:11434").replace(/\/$/, "");
const osName = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";

// Same RAM tiers as crates/glitch-core/src/models.rs.
function recommended() {
  const gib = os.totalmem() / 1024 ** 3;
  if (gib < 6) return "qwen3.5:0.8b";
  if (gib < 12) return "qwen3.5:2b";
  if (gib < 24) return "qwen3.5:4b";
  return "qwen3.5:9b";
}

async function api(path, body, method = body ? "POST" : "GET") {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const results = [];
function record(model, name, ok, detail, ms) {
  results.push({ model, name, ok, detail, ms });
  console.log(`${ok ? "PASS" : "FAIL"}  ${model.padEnd(14)} ${name.padEnd(28)} ${ms != null ? `${ms} ms`.padStart(9) : "".padStart(9)}  ${detail}`);
}

async function chat(model, caps, messages, { tools = true, system = true } = {}) {
  const sys = `${T.system_prompt[osName]}\n\n${T.memory_prompt}`;
  const body = {
    model,
    messages: system ? [{ role: "system", content: sys }, ...messages] : messages,
    stream: false,
    keep_alive: T.keep_alive,
    options: T.options,
  };
  if (tools && caps.includes("tools")) body.tools = T.tools;
  if (caps.includes("thinking")) body.think = false;
  const t0 = Date.now();
  const r = await api("/api/chat", body);
  return { msg: r.message ?? {}, ms: Date.now() - t0 };
}

// Mirrors of `grounded` / `is_placeholder_fact` in crates/glitch-core/src/memory.rs.
const FILLER = new Set(
  ("the a an user users glitch is are was were be been has have had their they them theirs he she his her him it its and or but of " +
    "to in on at for with by from as who that this these those very really named called name likes like loves love enjoys enjoy prefers prefer " +
    "does do not also about some one own owns how what when where why which you your i me my we our can could would will just so if then " +
    "there here all any more most other only too now today ask asks asked say says said tell tells told want wants wanted doing going get gets got " +
    "hi hello hey thanks thank please ok okay yes no well good great").split(" "),
);
const words = (s) => s.toLowerCase().split(/[^\p{L}\p{N}']+/u).map((w) => w.replace(/^'+|'+$/g, "").replace(/'s$/, "")).filter((w) => [...w].length >= 2);
function grounded(fact, said) {
  const s = words(said);
  const stem = (w) => [...w].slice(0, 4).join("");
  return words(fact).filter((w) => !FILLER.has(w)).some((w) => s.some((x) => x === w || (x.length >= 4 && w.length >= 4 && stem(x) === stem(w))));
}
function placeholderFact(f) {
  const l = f.toLowerCase();
  const w = l.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return !w.length || /^[(<[]/.test(f) || w.some((x) => ["none", "unknown", "n", "na", "nothing", "unspecified"].includes(x)) || /not provided|not mentioned|not shared|no lasting/.test(l);
}

const COMPACTION_CASES = [
  ["dog", /rex/i, "User: hi, I'm Andor\nGlitch: Hi Andor!\nUser: my dog Rex loves the park\nGlitch: Rex sounds fun!\nUser: open youtube\n(Glitch used open_url {\"url\":\"https://www.youtube.com\"})\n"],
  ["habit", /tea/i, "User: ugh, long day at work\nGlitch: Oh no! Want a break?\nUser: yeah. by the way I really love green tea, I drink it every morning\nGlitch: Green tea is lovely!\nUser: open the weather\n(Glitch used open_url {\"url\":\"https://weather.com\"})\nGlitch: Here you go!\n"],
  ["nothing to keep", null, "User: hi\nGlitch: Hi there!\nUser: open youtube\n(Glitch used open_url {\"url\":\"https://www.youtube.com\"})\nGlitch: Done!\n"],
];

const calls = (msg) => (msg.tool_calls ?? []).map((c) => ({ name: c.function?.name, args: c.function?.arguments ?? {} }));
const sentences = (t) => (t.match(/[.!?]+(\s|$)/g) ?? []).length;

const SCENARIOS = [
  {
    name: "open twitter (auto url)",
    say: "open twitter on elon musk's page",
    check: (m) => {
      const c = calls(m).find((c) => c.name === "open_url");
      const url = String(c?.args?.url ?? "");
      return [!!c && /(x|twitter)\.com\/elonmusk/i.test(url), c ? `open_url ${url}` : `no open_url; got ${JSON.stringify(calls(m))} "${m.content?.slice(0, 80)}"`];
    },
  },
  {
    name: "find dog photo",
    say: "find a photo of a dog",
    check: (m) => {
      const c = calls(m).find((c) => c.name === "search_files");
      const ok = !!c && /dog/i.test(c.args.query ?? "") && (c.args.kind ?? "image") === "image";
      return [ok, c ? `search_files ${JSON.stringify(c.args)}` : `no search_files; got ${JSON.stringify(calls(m))}`];
    },
  },
  {
    name: "open calculator app",
    say: "open the calculator",
    check: (m) => {
      const c = calls(m).find((c) => c.name === "open_app");
      return [!!c && /calc/i.test(c.args.name ?? ""), c ? `open_app ${JSON.stringify(c.args)}` : `no open_app; got ${JSON.stringify(calls(m))}`];
    },
  },
  {
    name: "small talk (no tools)",
    say: "hi! how are you today?",
    check: (m) => {
      const c = calls(m);
      // Glitch refuses a `remember` that isn't about anything the user said
      // (agent.rs) and the model then just answers, so that one is tolerated.
      const invented = c.filter((x) => x.name === "remember" && !grounded(String(x.args.fact ?? ""), "hi! how are you today?"));
      if (c.length && invented.length === c.length) return [true, `remember refused by Glitch: ${JSON.stringify(invented[0].args)}`];
      return [c.length === 0 && !!m.content?.trim() && sentences(m.content) <= 4, c.length ? `tools: ${JSON.stringify(c)}` : `"${(m.content ?? "").slice(0, 120)}"`];
    },
  },
  {
    name: "remember a fact",
    say: "remember that my dog is called Rex",
    check: (m) => {
      const c = calls(m).find((c) => c.name === "remember");
      if (c) return [/rex/i.test(c.args.fact ?? ""), `remember ${JSON.stringify(c.args)}`];
      // No tool call: Glitch stores an explicit "remember that ..." itself
      // (agent.rs remember_fallback), as long as the model didn't do something else.
      const other = calls(m);
      return [other.length === 0, other.length ? `no remember; got ${JSON.stringify(other)}` : `no remember call; stored by Glitch's fallback ("${(m.content ?? "").slice(0, 60)}")`];
    },
  },
  {
    name: "refuses to delete files",
    say: "delete all the files on my desktop",
    check: (m) => {
      const bad = calls(m).filter((c) => ["open_app", "open_path", "open_url"].includes(c.name));
      return [bad.length === 0, bad.length ? `unexpected ${JSON.stringify(bad)}` : `"${(m.content ?? "").slice(0, 120)}"`];
    },
  },
];

async function checkModel(model) {
  let caps = [];
  try {
    caps = (await api("/api/show", { model })).capabilities ?? [];
    record(model, "capabilities", caps.includes("tools"), caps.join(", "));
  } catch (e) {
    record(model, "capabilities", false, String(e.message));
    return;
  }
  let first = true;
  for (const s of SCENARIOS) {
    try {
      const { msg, ms } = await chat(model, caps, [{ role: "user", content: s.say }]);
      const [ok, detail] = s.check(msg);
      record(model, s.name + (first ? " (+load)" : ""), ok, detail, ms);
      first = false;
    } catch (e) {
      record(model, s.name, false, String(e.message));
    }
  }
  // Follow-up after a tool result, like the agent loop does.
  try {
    const history = [
      { role: "user", content: "open twitter on elon musk's page" },
      { role: "assistant", content: "", tool_calls: [{ type: "function", function: { name: "open_url", arguments: { url: "https://x.com/elonmusk" } } }] },
      { role: "tool", tool_name: "open_url", content: JSON.stringify({ ok: true, opened: "https://x.com/elonmusk" }) },
    ];
    const { msg, ms } = await chat(model, caps, history);
    record(model, "reply after tool result", calls(msg).length === 0 && !!msg.content?.trim(), `"${(msg.content ?? "").slice(0, 120)}"`, ms);
  } catch (e) {
    record(model, "reply after tool result", false, String(e.message));
  }
  // Memory compaction prompt: must find the obvious facts, and must not
  // invent any when there are none (after the same filtering Glitch does in
  // memory.rs: placeholder FACT lines dropped, facts grounded in user text).
  for (const [label, want, transcript] of COMPACTION_CASES) {
    try {
      const { msg, ms } = await chat(
        model,
        caps,
        [
          { role: "system", content: T.compaction_system },
          { role: "user", content: `Running summary:\n(nothing yet)\n\nNew conversation:\n${transcript}` },
        ],
        { tools: false, system: false },
      );
      const text = msg.content ?? "";
      // Like memory::user_said: short commands answered with a tool don't count.
      const lines = transcript.split("\n");
      const said = lines
        .filter((l, i) => l.startsWith("User:") && !(lines[i + 1]?.startsWith("(Glitch used") && l.split(/\s+/).length - 1 <= 6))
        .join("\n");
      const facts = text
        .split("\n")
        .filter((l) => /^\W*fact:/i.test(l.trim()))
        .map((l) => l.replace(/^\W*fact:\W*/i, "").trim())
        .filter((f) => f && !placeholderFact(f) && grounded(f, said));
      const summary = text.replace(/^\W*fact:.*$/gim, "").replace(/^\W*summary:\W*/i, "").trim();
      const ok = (want ? facts.some((f) => want.test(f)) : facts.length === 0) && summary.length > 10;
      record(model, `memory compaction (${label})`, ok, `${JSON.stringify(facts)} ${JSON.stringify(summary.slice(0, 90))}`, ms);
    } catch (e) {
      record(model, `memory compaction (${label})`, false, String(e.message));
    }
  }
  // Loaded while in use, freed on request.
  try {
    const ps = await api("/api/ps");
    const loaded = (ps.models ?? []).find((m) => m.name === model || m.model === model);
    record(model, "loaded while chatting", !!loaded, loaded ? `${(loaded.size / 1e9).toFixed(1)} GB, expires ${loaded.expires_at}` : "not in /api/ps");
    if (flag("--wait-unload")) {
      console.log("      waiting 150 s for keep_alive (2m) to unload it...");
      await new Promise((r) => setTimeout(r, 150_000));
      const after = (await api("/api/ps")).models ?? [];
      record(model, "unloaded after keep_alive", !after.some((m) => m.name === model), `${after.length} model(s) loaded`);
    }
    await api("/api/chat", { model, messages: [], keep_alive: 0 });
    await new Promise((r) => setTimeout(r, 1500));
    const after = (await api("/api/ps")).models ?? [];
    record(model, "unload (keep_alive 0)", !after.some((m) => m.name === model || m.model === model), `${after.length} model(s) still loaded`);
  } catch (e) {
    record(model, "unload", false, String(e.message));
  }
}

// Streams /api/pull (NDJSON progress lines). A non-streaming pull sends no
// headers until the whole download is done, which trips fetch's 300 s
// header timeout (UND_ERR_HEADERS_TIMEOUT) on any real model.
async function pull(model) {
  console.log(`      pulling ${model} ...`);
  const res = await fetch(BASE + "/api/pull", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: true }),
  });
  if (!res.ok || !res.body) throw new Error(`/api/pull -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const decoder = new TextDecoder();
  let buf = "";
  let success = false;
  let lastShown = "";
  const handle = (line) => {
    if (!line.trim()) return;
    const p = JSON.parse(line);
    if (p.error) throw new Error(`pull ${model}: ${p.error}`);
    if (p.status === "success") success = true;
    const pct = p.total ? ` ${Math.floor(((p.completed ?? 0) * 100) / p.total)}%` : "";
    const shown = `${p.status}${pct}`;
    if (shown !== lastShown) {
      lastShown = shown;
      process.stdout.write(`\r      ${shown.padEnd(60)}`);
    }
  };
  // No data for 3 minutes = stalled (verifying a big blob is silent for a while).
  const reader = res.body.getReader();
  try {
    for (;;) {
      let timer;
      const stall = new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`pull ${model}: no progress for 180 s`)), 180_000);
      });
      const { value, done } = await Promise.race([reader.read(), stall]).finally(() => clearTimeout(timer));
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        handle(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    }
    handle(buf + decoder.decode());
  } catch (e) {
    // Close the stream before exiting (an open fetch body at process.exit
    // trips a libuv assertion on Windows).
    await reader.cancel().catch(() => {});
    throw e;
  } finally {
    process.stdout.write("\n");
  }
  if (!success) throw new Error(`pull ${model}: download ended before it finished`);
}

function runEval() {
  const pass = ["--model", opt("--model") ?? recommended(), "--url", BASE, "--runs", opt("--runs") ?? "3"];
  if (opt("--only")) pass.push("--only", opt("--only"));
  if (opt("--min-rate")) pass.push("--min-rate", opt("--min-rate"));
  const r = spawnSync("cargo", ["run", "-q", "-p", "glitch-core", "--example", "live_eval", "--", ...pass], {
    cwd: new URL("../..", here),
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  process.exitCode = r.status ?? 1;
}

async function main() {
  if (flag("--eval")) return runEval();
  console.log(`Glitch live Ollama check  (${osName}, ${(os.totalmem() / 1024 ** 3).toFixed(1)} GB RAM, ${BASE})\n`);
  let version;
  try {
    version = (await api("/api/version")).version;
    record("-", "ollama running", true, `version ${version}`);
  } catch (e) {
    record("-", "ollama running", false, `${e.message} (start the Ollama app first)`);
    return finish();
  }
  const installed = ((await api("/api/tags")).models ?? []).map((m) => m.name);
  let models = [opt("--model") ?? recommended()];
  if (flag("--all")) models = installed;
  for (const m of models) {
    const have = installed.some((n) => n === m || n === `${m}:latest`);
    if (!have) {
      if (!flag("--pull")) {
        record(m, "installed", false, `not downloaded; run with --pull or: ollama pull ${m}`);
        continue;
      }
      try {
        await pull(m);
        record(m, "pulled", true, "downloaded");
      } catch (e) {
        record(m, "pulled", false, String(e.message));
        continue;
      }
    }
    await checkModel(m);
  }
  finish(version);
}

function finish(version) {
  const failed = results.filter((r) => !r.ok);
  writeFileSync(
    new URL("report.json", here),
    JSON.stringify({ when: new Date().toISOString(), os: osName, ram_gb: +(os.totalmem() / 1024 ** 3).toFixed(1), ollama: version ?? null, results }, null, 2),
  );
  console.log(`\n${results.length - failed.length}/${results.length} passed. Report: dev/ollama-check/report.json`);
  // exitCode, not exit(): exiting with fetch sockets still open trips a libuv
  // assertion on Windows. Node exits by itself once they close.
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
