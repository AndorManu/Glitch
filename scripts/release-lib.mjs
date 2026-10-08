// Shared, pure helpers for scripts/bump-version.mjs and scripts/changelog.mjs.
// Tested by scripts/release-lib.test.mjs (node --test scripts/release-lib.test.mjs).

/** "1.2.3" or "1.2.3-beta.1". */
export function isVersion(v) {
  return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v);
}

/** Compare plain x.y.z parts (pre-release tags count as lower). */
export function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = v.split("-", 2);
    return { nums: core.split(".").map(Number), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** Set `"version": "..."` at the top level of a JSON text, keeping its formatting. */
export function setJsonVersion(text, version) {
  const re = /^(\s{2}"version":\s*")[^"]*(")/m;
  if (!re.test(text)) throw new Error("no top-level version field");
  return text.replace(re, `$1${version}$2`);
}

/** package-lock.json: the root package's version, in both places it appears. */
export function setLockVersion(text, version) {
  const lock = JSON.parse(text);
  lock.version = version;
  if (lock.packages?.[""]) lock.packages[""].version = version;
  return `${JSON.stringify(lock, null, 2)}\n`;
}

/** Cargo.toml [workspace.package] version. */
export function setCargoWorkspaceVersion(text, version) {
  const re = /(\[workspace\.package\][^[]*?\nversion\s*=\s*")[^"]*(")/;
  if (!re.test(text)) throw new Error("no [workspace.package] version");
  return text.replace(re, `$1${version}$2`);
}

/** Cargo.lock: the versions of our own crates. */
export function setCargoLockVersions(text, crates, version) {
  let out = text;
  for (const name of crates) {
    const re = new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "${name}"\\r?\\nversion = ")[^"]*(")`);
    out = out.replace(re, `$1${version}$2`);
  }
  return out;
}

/** Changelog sections, in order. First matching rule wins. */
export const SECTIONS = [
  {
    title: "Developer tools and docs",
    match: /^(dev|docs|ci|readme|lint|track|ignore|untrack|feature card test|add milestone)\b|\b(dev\/[\w-]+\.mjs|qa tooling|playwright|gallery)\b|^fix [\w_]+ test/i,
  },
  { title: "Streaming and updates", match: /\b(stream overlay|overlay (art|page|server)|obs|twitch|streamer\.bot|auto-update|updater|release workflow|code signing|changelog|version bump)\b/i },
  { title: "He reacts to what you're doing", match: /\b(context|focus mode|now.playing)\b/i },
  { title: "Voice", match: /\b(voice|whisper|hands-free|mic)\b/i },
  { title: "Chaos mode", match: /\bchaos\b|paw prints|sticky note/i },
  { title: "Chat, memory and skills", match: /\b(chat|bubble|memory|ollama|prompt|agent loop|tools?|sees the screen|see the screen|clipboard|timers?|store apps|open_path|ai interface)\b/i },
  { title: "Settings and setup", match: /\b(panel|settings|setup|wizard|features)\b/i },
];

/** Everything else is about Glitch himself (art, animation, movement). */
const REST = "Glitch himself";

/** En and em dashes (house style: never in anything Glitch ships). */
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`, "g");

/** Commits that say nothing to users. */
const SKIP = /\b(wip|merge|untrack|ignore local)\b/i;

/** One Markdown section for `version` from commit subjects (newest first). */
export function changelogSection(version, date, subjects) {
  const groups = new Map(SECTIONS.map((s) => [s.title, []]));
  const other = [];
  const seen = new Set();
  for (const raw of subjects) {
    const s = raw.trim().replace(DASHES, ",");
    if (!s || SKIP.test(s) || seen.has(s)) continue;
    seen.add(s);
    const hit = SECTIONS.find((x) => x.match.test(s));
    (hit ? groups.get(hit.title) : other).push(s);
  }
  const lines = [`## [${version}] - ${date}`, ""];
  const order = [...groups, [REST, other]].sort(([a], [b]) => Number(a === SECTIONS[0].title) - Number(b === SECTIONS[0].title));
  for (const [title, items] of order) {
    if (!items.length) continue;
    lines.push(`### ${title}`, "", ...items.map((i) => `- ${i}`), "");
  }
  return lines.join("\n");
}

/** Put `section` into a CHANGELOG.md text: replace that version's section, or add it on top. */
export function insertSection(changelog, section) {
  const header = "# Changelog\n\nAll notable changes to Glitch. Generated from git history by scripts/changelog.mjs, then tidied by hand.\n\n";
  const version = section.match(/^## \[([^\]]+)\]/)?.[1];
  const body = changelog.startsWith("# Changelog") ? changelog.slice(changelog.indexOf("\n## ") + 1 || changelog.length) : changelog;
  const parts = body.split(/^(?=## \[)/m).filter((p) => p.trim() && p.startsWith("## ["));
  const kept = parts.filter((p) => p.match(/^## \[([^\]]+)\]/)?.[1] !== version);
  return `${header}${[section.trimEnd(), ...kept.map((p) => p.trimEnd())].join("\n\n")}\n`;
}
