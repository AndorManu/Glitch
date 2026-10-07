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
//
// Writes dev/ollama-check/report.json and exits 1 if a check fails.

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
    check: (m) => [calls(m).length === 0 && !!m.content?.trim() && sentences(m.content) <= 4, `"${(m.content ?? "").slice(0, 120)}"`],
  },
  {
    name: "remember a fact",
    say: "remember that my dog is called Rex",
    check: (m) => {
      const c = calls(m).find((c) => c.name === "remember");
      return [!!c && /rex/i.test(c.args.fact ?? ""), c ? `remember ${JSON.stringify(c.args)}` : `no remember; got ${JSON.stringify(calls(m))}`];
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
  // Memory compaction prompt.
  try {
    const transcript = "User: hi, I'm Andor\nGlitch: Hi Andor!\nUser: my dog Rex loves the park\nGlitch: Rex sounds fun!\nUser: open youtube\n(Glitch used open_url {\"url\":\"https://www.youtube.com\"})\n";
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
    const facts = text.split("\n").filter((l) => /^\W*fact:/i.test(l.trim()));
    record(model, "memory compaction", facts.some((f) => /rex/i.test(f)) && text.replace(/fact:.*$/gim, "").trim().length > 10, JSON.stringify(text.slice(0, 200)), ms);
  } catch (e) {
    record(model, "memory compaction", false, String(e.message));
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

async function main() {
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
      console.log(`      pulling ${m} ...`);
      await api("/api/pull", { model: m, stream: false });
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
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
