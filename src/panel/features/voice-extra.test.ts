import { describe, expect, it } from "vitest";
import type { TtsStatus, WakeStatus } from "../../shared/ipc";
import { useGlitchVoice } from "../../bubble/voice";
import { FEATURES } from "./index";
import { ttsPercent, ttsText, wakeText } from "./voice-extra";

const wake = (w: Partial<WakeStatus>): WakeStatus => ({ enabled: false, armed: false, problem: null, message: null, ...w });
const tts = (t: Partial<TtsStatus>): TtsStatus => ({ supported: true, installed: false, size_mb: 82, download: null, playing: false, ...t });

describe("features → Hey Glitch & his voice", () => {
  it("is registered once in the features list", () => {
    expect(FEATURES.filter((f) => f.id === "voice-extra")).toHaveLength(1);
    expect(new Set(FEATURES.map((f) => f.id)).size).toBe(FEATURES.length);
  });

  it("says plainly whether the microphone is open", () => {
    expect(wakeText(wake({})).text).toMatch(/only opens while you hold/);
    const armed = wakeText(wake({ enabled: true, armed: true }));
    expect(armed.tone).toBe("ok");
    expect(armed.text).toMatch(/Listening for “Hey Glitch” right now/);
    expect(wakeText(wake({ enabled: true, problem: "needs_model" }))).toEqual({ text: expect.stringMatching(/speech model/), tone: "warn" });
    expect(wakeText(wake({ enabled: true, problem: "voice_off" })).text).toMatch(/Talk to Glitch/);
    expect(wakeText(wake({ enabled: true, problem: "mic_denied" })).text).toMatch(/not allowed/);
    expect(wakeText(wake({ enabled: true, problem: "mic_failed", message: "device gone" })).text).toBe("The microphone didn't start (device gone).");
  });

  it("download progress", () => {
    expect(ttsPercent(null)).toBeNull();
    expect(ttsPercent([0, 0])).toBeNull();
    expect(ttsPercent([50, 200])).toBe(25);
    expect(ttsPercent([300, 200])).toBe(100);
  });

  it("describes the voice state", () => {
    expect(ttsText(tts({ supported: false }), "glitch")).toMatch(/system voice/);
    expect(ttsText(tts({}), "system")).toMatch(/one-time 82 MB download/);
    expect(ttsText(tts({ download: [1, 2] }), "glitch")).toMatch(/Downloading/);
    expect(ttsText(tts({ installed: true }), "glitch")).toMatch(/his own voice/);
    expect(ttsText(tts({ installed: true }), "system")).toMatch(/Pick it above/);
  });

  it("falls back to the system voice unless his is chosen and downloaded", () => {
    expect(useGlitchVoice("glitch", true)).toBe(true);
    expect(useGlitchVoice("glitch", false)).toBe(false);
    expect(useGlitchVoice("system", true)).toBe(false);
  });
});
