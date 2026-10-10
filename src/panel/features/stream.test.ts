import { describe, expect, it } from "vitest";
import type { StreamStatus, UpdateStatus } from "../../shared/ipc";
import { serverLine, sourceLine } from "./stream";
import { updateLine } from "./updates";

const off = { state: "off" as const, detail: "" };
const settings = {
  enabled: true, port: 7799, view_token: "", write_token: "", mode: "mirror" as const, size: 1, position: "right" as const,
  react: true, show_chat: true, mirror_chat: false, streamerbot: false, streamerbot_url: "ws://127.0.0.1:8080/", twitch_channel: "",
};
const base: StreamStatus = { enabled: true, running: true, error: null, url: "u", webhook: "w", viewers: 0, streamerbot: off, twitch: off, settings };

describe("stream overlay card", () => {
  it("says where the server runs and how many pages watch", () => {
    expect(serverLine(base, 7799)).toEqual({ text: "Running on 127.0.0.1:7799, this computer only. 0 overlay pages connected.", tone: "ok" });
    expect(serverLine({ ...base, viewers: 1 }, 7799).text).toContain("1 overlay page connected");
    expect(serverLine({ ...base, running: false, error: "Port 7799 is already in use" }, 7799)).toEqual({ text: "Port 7799 is already in use", tone: "error" });
    expect(serverLine({ ...base, running: false }, 7799).tone).toBe("muted");
  });

  it("describes connections", () => {
    expect(sourceLine("Twitch", off).text).toBe("");
    expect(sourceLine("Twitch", { state: "connected", detail: "Reading #x (read-only)" })).toEqual({ text: "Twitch: connected. Reading #x (read-only)", tone: "ok" });
    expect(sourceLine("Streamer.bot", { state: "error", detail: "Streamer.bot isn't running" }).tone).toBe("error");
  });
});

describe("updates card", () => {
  const st: UpdateStatus = { current: "0.1.0", auto_check: true, checking: false, available: null, offer: false, installing: false, progress: null, last_check: 0, error: null };
  it("covers every state", () => {
    expect(updateLine(st, 1000).text).toBe("You have Glitch 0.1.0.");
    expect(updateLine({ ...st, last_check: 1000 - 7200 }, 1000).text).toBe("You have the latest Glitch (0.1.0). Checked 2 h ago.");
    expect(updateLine({ ...st, checking: true }, 0).text).toBe("Checking…");
    expect(updateLine({ ...st, available: { version: "0.2.0", notes: "" } }, 0)).toEqual({ text: "Glitch 0.2.0 is out (you have 0.1.0).", tone: "ok" });
    expect(updateLine({ ...st, installing: true, progress: 40 }, 0).text).toBe("Downloading the update… 40%");
    expect(updateLine({ ...st, error: "offline" }, 0).tone).toBe("error");
  });

  it("never uses long dashes (house style)", () => {
    for (const l of [updateLine(st, 0), serverLine(base, 1), sourceLine("x", { state: "error", detail: "" })]) {
      expect(l.text).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`));
    }
  });
});
