import { describe, expect, it } from "vitest";
import type { ClaudeCodeStatus } from "../../shared/ipc";
import { FEATURES } from "./index";
import { accessText, claudeLine, digestLine, parseList } from "./update-me";

const claude: ClaudeCodeStatus = {
  path: "C:\\Users\\me\\.claude\\settings.json",
  file_exists: true,
  connected: false,
  outdated: false,
  problem: null,
  preview: "{}",
  command: "\"C:/Glitch/glitch.exe\" --glitch-claude-hook",
};

describe("Update me card", () => {
  it("is registered as a feature", () => {
    expect(FEATURES.map((f) => f.id)).toContain("update-me");
  });

  it("explains notification access", () => {
    expect(accessText("allowed", "windows").ok).toBe(true);
    expect(accessText("denied", "windows").text).toContain("Privacy & security");
    expect(accessText("allowed", "macos")).toEqual({ text: expect.stringContaining("Only works on Windows"), ok: false });
  });

  it("describes the Claude Code hook", () => {
    expect(claudeLine(claude, null)).toBe("Not connected.");
    expect(claudeLine({ ...claude, connected: true }, null)).toContain("Connected");
    expect(claudeLine({ ...claude, connected: true, outdated: true }, null)).toContain("older copy");
    expect(claudeLine({ ...claude, problem: "not valid JSON" }, null)).toBe("not valid JSON");
    expect(claudeLine(null, "unsafe path")).toBe("unsafe path");
  });

  it("digest and list helpers", () => {
    expect(digestLine([])).toBe("");
    expect(digestLine([{ app: "WhatsApp", count: 3 }, { app: "Teams", count: 1 }])).toBe("3 WhatsApp, 1 Teams waiting. Click Glitch to hear them.");
    expect(parseList(" Tinder, Work Slack ,,Tinder\nBank ")).toEqual(["Tinder", "Work Slack", "Bank"]);
  });

  it("no em or en dashes in what the card says", () => {
    const texts = [accessText("denied", "windows").text, accessText("unspecified", "windows").text, claudeLine(claude, null)];
    for (const t of texts) expect(t).not.toMatch(/[\u2013\u2014]/);
  });
});
