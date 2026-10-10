#!/usr/bin/env node
// Add (or refresh) a CHANGELOG.md section from git history.
//
//   node scripts/changelog.mjs 0.2.0            # commits since the last tag
//   node scripts/changelog.mjs 0.1.0 --all      # every commit
//   node scripts/changelog.mjs 0.2.0 --since v0.1.0 --date 2026-10-08 --dry-run
//
// Commit subjects are sorted into sections by keyword (scripts/release-lib.mjs);
// read the result and tidy it by hand before tagging. The release workflow
// uses the section for the tag as the GitHub release notes.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changelogSection, insertSection, isVersion } from "./release-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

export function lastTag() {
  try {
    return git("describe", "--tags", "--abbrev=0", "--match", "v*");
  } catch {
    return null;
  }
}

export function writeChangelog(version, { since = lastTag(), all = false, date = new Date().toISOString().slice(0, 10), dryRun = false } = {}) {
  const range = all || !since ? ["HEAD"] : [`${since}..HEAD`];
  const subjects = git("log", "--no-merges", "--format=%s", ...range).split("\n");
  const section = changelogSection(version, date, subjects);
  const file = path.join(root, "CHANGELOG.md");
  const before = existsSync(file) ? readFileSync(file, "utf8") : "";
  const after = insertSection(before, section);
  if (dryRun) process.stdout.write(section);
  else writeFileSync(file, after);
  return section;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
  const version = args[0];
  if (!version || !isVersion(version)) {
    console.error("usage: node scripts/changelog.mjs <version> [--since <ref>] [--all] [--date YYYY-MM-DD] [--dry-run]");
    process.exit(2);
  }
  const s = writeChangelog(version, { since: opt("--since") ?? lastTag(), all: args.includes("--all"), date: opt("--date"), dryRun: args.includes("--dry-run") });
  if (!args.includes("--dry-run")) console.log(`CHANGELOG.md: section ${version} (${s.split("\n").filter((l) => l.startsWith("- ")).length} entries)`);
}
