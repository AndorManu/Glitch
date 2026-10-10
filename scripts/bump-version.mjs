#!/usr/bin/env node
// Bump Glitch's version everywhere it lives, and write its CHANGELOG section.
//
//   node scripts/bump-version.mjs 0.2.0
//   node scripts/bump-version.mjs 0.2.0 --no-changelog
//
// Updates package.json, package-lock.json, Cargo.toml ([workspace.package],
// used by both crates), Cargo.lock and src-tauri/tauri.conf.json (the version
// the updater compares). It does not commit, tag or push: it prints the
// commands, so you decide when a release happens.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeChangelog } from "./changelog.mjs";
import { compareVersions, isVersion, setCargoLockVersions, setCargoWorkspaceVersion, setJsonVersion, setLockVersion } from "./release-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = (p) => path.join(root, p);
const edit = (p, fn) => writeFileSync(file(p), fn(readFileSync(file(p), "utf8")));

const args = process.argv.slice(2);
const next = args[0];
if (!next || !isVersion(next)) {
  console.error("usage: node scripts/bump-version.mjs <x.y.z> [--no-changelog]");
  process.exit(2);
}
const current = JSON.parse(readFileSync(file("src-tauri/tauri.conf.json"), "utf8")).version;
if (compareVersions(next, current) <= 0 && !args.includes("--force")) {
  console.error(`${next} isn't newer than ${current}: the updater would never offer it. (--force to do it anyway)`);
  process.exit(1);
}

edit("package.json", (t) => setJsonVersion(t, next));
edit("package-lock.json", (t) => setLockVersion(t, next));
edit("src-tauri/tauri.conf.json", (t) => setJsonVersion(t, next));
edit("Cargo.toml", (t) => setCargoWorkspaceVersion(t, next));
edit("Cargo.lock", (t) => setCargoLockVersions(t, ["glitch", "glitch-core"], next));
console.log(`version ${current} -> ${next}: package.json, package-lock.json, tauri.conf.json, Cargo.toml, Cargo.lock`);

if (!args.includes("--no-changelog")) {
  writeChangelog(next);
  console.log("CHANGELOG.md: new section from the commits since the last tag. Read it and tidy it up.");
}

console.log(`
Next (when you're ready):
  git add -A && git commit -m "Glitch ${next}"
  git tag v${next}
  git push origin HEAD v${next}     # starts .github/workflows/release.yml (draft release)
Then check the draft on GitHub and press "Publish release": only then do users get the update.`);
