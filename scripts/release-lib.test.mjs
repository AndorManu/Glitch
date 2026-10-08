// node --test scripts/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  changelogSection,
  compareVersions,
  insertSection,
  isVersion,
  setCargoLockVersions,
  setCargoWorkspaceVersion,
  setJsonVersion,
  setLockVersion,
} from "./release-lib.mjs";

test("versions", () => {
  assert.ok(isVersion("0.2.0") && isVersion("1.0.0-beta.1"));
  assert.ok(!isVersion("v0.2.0") && !isVersion("0.2"));
  assert.ok(compareVersions("0.2.0", "0.1.9") > 0);
  assert.ok(compareVersions("0.2.0-beta", "0.2.0") < 0);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
});

test("edits the real files' formats", () => {
  const conf = readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8");
  assert.equal(JSON.parse(setJsonVersion(conf, "9.8.7")).version, "9.8.7");
  assert.equal(JSON.parse(setJsonVersion(conf, "9.8.7")).app.windows[0].label, "mascot");
  const lock = setLockVersion(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"), "9.8.7");
  assert.equal(JSON.parse(lock).packages[""].version, "9.8.7");
  const cargo = setCargoWorkspaceVersion(readFileSync(new URL("../Cargo.toml", import.meta.url), "utf8"), "9.8.7");
  assert.match(cargo, /\[workspace\.package\]\r?\nversion = "9\.8\.7"/);
  const cl = setCargoLockVersions(readFileSync(new URL("../Cargo.lock", import.meta.url), "utf8"), ["glitch", "glitch-core"], "9.8.7");
  assert.match(cl, /name = "glitch"\r?\nversion = "9\.8\.7"/);
  assert.match(cl, /name = "glitch-core"\r?\nversion = "9\.8\.7"/);
});

test("changelog sections", () => {
  const s = changelogSection("0.2.0", "2026-10-08", [
    "Stream overlay server: 127.0.0.1 HTTP",
    "Voice: faster",
    "Merge branch x",
    "Overlay page (wip before merge)",
    "Bubble: springy open/close",
    "dev: tooling",
    "Something else entirely",
    `Dash ${String.fromCharCode(0x2014)} here`,
  ]);
  assert.match(s, /^## \[0\.2\.0\] - 2026-10-08/);
  assert.match(s, /### Streaming and updates\n\n- Stream overlay server/);
  assert.match(s, /### Voice\n\n- Voice: faster/);
  assert.doesNotMatch(s, /Merge branch|wip/);
  assert.match(s, /### Glitch himself\n\n- Something else entirely/);
  assert.doesNotMatch(s, new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`));
  const doc = insertSection(insertSection("", s), changelogSection("0.3.0", "2026-11-01", ["Voice: x"]));
  assert.ok(doc.indexOf("[0.3.0]") < doc.indexOf("[0.2.0]"));
  // Re-running for the same version replaces its section.
  const again = insertSection(doc, changelogSection("0.3.0", "2026-11-02", ["Voice: y"]));
  assert.equal(again.match(/## \[0\.3\.0\]/g).length, 1);
  assert.match(again, /Voice: y/);
  assert.match(again, /\[0\.2\.0\]/);
});
