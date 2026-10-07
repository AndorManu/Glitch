import { describe, expect, it } from "vitest";
import type { VoiceEvent } from "../shared/ipc";
import { initialState, transition, type BubbleState } from "./state";
import {
  explainDownloadError,
  explainVoiceError,
  initialMic,
  micActive,
  micHint,
  micTransition,
  NOTHING_HEARD,
  readyText,
  speakable,
  TAP_MS,
  type MicEvent,
  type MicState,
  type MicTransition,
  type VoiceSay,
} from "./voice";

const words = (v: VoiceSay): string => (v.kind === "setup" ? "" : v.text);

const ready = (): MicState => micTransition(initialMic(), { type: "config", usable: true }, "windows").state;
const voice = (event: VoiceEvent): MicEvent => ({ type: "voice", event });

/** Run events, collecting every command / transcript / message. */
function run(s: MicState, ...events: MicEvent[]): { state: MicState; steps: MicTransition[] } {
  const steps: MicTransition[] = [];
  for (const e of events) {
    const t = micTransition(s, e, "windows");
    steps.push(t);
    s = t.state;
  }
  return { state: s, steps };
}

describe("mic button", () => {
  it("is hidden until voice is usable, and hides again when turned off", () => {
    expect(initialMic().phase).toBe("hidden");
    expect(ready().phase).toBe("idle");
    // Hidden ignores presses.
    expect(micTransition(initialMic(), { type: "press", at: 0 }, "windows").command).toBeNull();
    // Turning voice off mid-recording cancels it.
    const { state } = run(ready(), { type: "press", at: 0 });
    const off = micTransition(state, { type: "config", usable: false }, "windows");
    expect(off.state.phase).toBe("hidden");
    expect(off.command).toBe("cancel");
  });

  it("hold: idle → listening → transcribing → heard", () => {
    const { state, steps } = run(
      ready(),
      { type: "press", at: 1000 },
      voice({ phase: "listening", level: 0, hands_free: false }),
      voice({ phase: "listening", level: 0.7, hands_free: false }),
      { type: "release", at: 3000 },
      voice({ phase: "transcribing" }),
      voice({ phase: "heard", text: "open youtube" }),
    );
    expect(steps.map((t) => t.command)).toEqual(["start", null, null, "stop", null, null]);
    expect(steps.map((t) => t.state.phase)).toEqual(["starting", "listening", "listening", "listening", "transcribing", "idle"]);
    expect(steps[2].state.level).toBe(0.7);
    // Not "Listening" before the microphone actually delivers sound.
    expect(micHint(steps[0].state)).toMatch(/warming up/);
    expect(micHint(steps[1].state)).toMatch(/let go/);
    expect(micHint(steps[2].state)).toMatch(/let go/);
    expect(micHint(steps[4].state)).toMatch(/Writing/);
    expect(steps[5].heard).toBe("open youtube");
    expect(state).toMatchObject({ phase: "idle", level: 0, pressedAt: null, handsFree: false });
  });

  it("tap: hands-free until quiet, a second tap stops early", () => {
    const tapped = run(ready(), { type: "press", at: 0 }, { type: "release", at: TAP_MS - 50 });
    expect(tapped.steps[1].command).toBe("hands_free");
    expect(tapped.state.handsFree).toBe(true);
    const listening = micTransition(tapped.state, voice({ phase: "listening", level: 0.2, hands_free: true }), "windows").state;
    expect(micHint(listening)).toMatch(/tap to stop/);
    const again = run(listening, { type: "press", at: 5000 }, { type: "release", at: 5100 });
    expect(again.steps.map((t) => t.command)).toEqual(["stop", null]);
  });

  it("a hold just over the tap time is a hold", () => {
    const { steps } = run(ready(), { type: "press", at: 0 }, { type: "release", at: TAP_MS + 1 });
    expect(steps[1].command).toBe("stop");
  });

  it("shows recordings started by the hotkey", () => {
    const s = micTransition(ready(), voice({ phase: "listening", level: 0.3, hands_free: false }), "windows").state;
    expect(s.phase).toBe("listening");
    expect(micActive(s)).toBe(true);
    // Releasing the (untouched) button does nothing.
    expect(micTransition(s, { type: "release", at: 10 }, "windows").command).toBeNull();
  });

  it("cancel (Esc / bubble closed) only when active", () => {
    expect(micTransition(ready(), { type: "cancel" }, "windows").command).toBeNull();
    const { state } = run(ready(), { type: "press", at: 0 }, voice({ phase: "transcribing" }));
    const t = micTransition(state, { type: "cancel" }, "windows");
    expect(t.command).toBe("cancel");
    expect(t.state.phase).toBe("idle");
  });

  it("nothing heard and errors become messages, back to idle", () => {
    const quiet = run(ready(), { type: "press", at: 0 }, voice({ phase: "idle", reason: "nothing_heard" }));
    expect(quiet.state.phase).toBe("idle");
    expect(quiet.steps[1].say).toEqual({ kind: "info", text: NOTHING_HEARD });
    const cancelled = run(ready(), { type: "press", at: 0 }, voice({ phase: "idle", reason: "cancelled" }));
    expect(cancelled.steps[1].say).toBeNull();
    const denied = run(ready(), { type: "press", at: 0 }, voice({ phase: "error", code: "mic_denied", message: "x" }));
    expect(denied.state.phase).toBe("idle");
    expect(denied.steps[1].say).toMatchObject({ kind: "error", action: "mic-settings" });
  });

  it("asks for the speech model when it's missing", () => {
    const t = micTransition(
      { ...ready(), phase: "starting", pressedAt: 0 },
      voice({ phase: "needs_model", model: { id: "base", label: "Base", blurb: "", file: "ggml-base.bin", size_bytes: 147_951_465 } }),
      "windows",
    );
    expect(t.state.phase).toBe("idle");
    expect(t.say).toEqual({ kind: "setup", model: { id: "base", label: "Base", sizeMb: 142 } });
  });

  it("clamps silly levels", () => {
    const s = (level: number) => micTransition(ready(), voice({ phase: "listening", level, hands_free: false }), "windows").state.level;
    expect(s(3)).toBe(1);
    expect(s(-1)).toBe(0);
    expect(s(Number.NaN)).toBe(0);
  });
});

describe("voice words", () => {
  it("explains microphone problems per OS", () => {
    expect(words(explainVoiceError("mic_denied", "", "windows"))).toMatch(/Let desktop apps access your microphone/);
    expect(words(explainVoiceError("mic_denied", "", "macos"))).toMatch(/Privacy & Security → Microphone/);
    expect(explainVoiceError("mic_silent", "", "macos")).toMatchObject({ action: "mic-settings" });
    expect(words(explainVoiceError("mic_silent", "", "windows"))).toMatch(/muted/);
    expect(explainVoiceError("mic_missing", "", "macos")).toMatchObject({ action: null });
    expect(words(explainVoiceError("mic_failed", "boom", "windows"))).toMatch(/boom.*desktop apps/);
    expect(explainVoiceError("weird", "boom", "linux")).toMatchObject({ kind: "error", action: null });
    expect(explainDownloadError("download_offline")).toMatch(/online/);
    expect(explainDownloadError("download_corrupt")).toMatch(/damaged/);
  });

  it("mentions the hotkey only if it works", () => {
    expect(readyText("Ctrl+Shift+Space")).toMatch(/\(or Ctrl\+Shift\+Space\)/);
    expect(readyText(null)).not.toMatch(/\(or/);
  });

  it("reads only short replies, without links or markdown", () => {
    expect(speakable("Done! It's open: https://x.com/elonmusk")).toBe("Done! It's open: a link");
    expect(speakable("**Hi** there")).toBe("Hi there");
    expect(speakable("   ")).toBeNull();
    expect(speakable("x".repeat(400))).toBeNull();
  });
});

describe("bubble state: voice speech", () => {
  const setup = (s: BubbleState = initialState()) => transition(s, { type: "voice_setup", model: "base", sizeMb: 142 }).state;
  const dl = (state: "running" | "done" | "failed" | "cancelled", percent: number | null = null, failed: string | null = null) =>
    ({ type: "voice_download", state, percent, failed, ready: "All set!" }) as const;

  it("offer → progress → ready", () => {
    const s0 = setup();
    expect(s0.speech).toEqual({ kind: "voice_setup", model: "base", sizeMb: 142, progress: null, failed: null });
    const s1 = transition(s0, dl("running", 42)).state;
    expect(s1.speech).toMatchObject({ progress: 42 });
    expect(s1.rev).toBe(s0.rev); // updated in place, not re-typed
    const s2 = transition(s1, dl("done")).state;
    expect(s2.speech).toEqual({ kind: "reply", text: "All set!", actions: [] });
    expect(s2.rev).toBe(s1.rev + 1);
  });

  it("failed and cancelled downloads go back to the offer", () => {
    const failed = transition(transition(setup(), dl("running", 10)).state, dl("failed", null, "offline")).state;
    expect(failed.speech).toMatchObject({ kind: "voice_setup", progress: null, failed: "offline" });
    const cancelled = transition(transition(setup(), dl("running", 10)).state, dl("cancelled")).state;
    expect(cancelled.speech).toMatchObject({ kind: "voice_setup", progress: null, failed: null });
  });

  it("download events without an offer on screen change nothing", () => {
    const s = initialState();
    expect(transition(s, dl("running", 50)).state).toBe(s);
    expect(transition(s, dl("done")).state).toBe(s);
  });

  it("voice messages never interrupt thinking", () => {
    const busy = transition(initialState(), { type: "send", text: "hi" }).state;
    expect(transition(busy, { type: "notice", text: "x", tone: "info", action: null }).state).toBe(busy);
    expect(transition(busy, { type: "voice_setup", model: "base", sizeMb: 142 }).state).toBe(busy);
  });

  it("notices show like speech", () => {
    const s = transition(initialState(), { type: "notice", text: "No mic", tone: "error", action: "mic-settings" }).state;
    expect(s.speech).toEqual({ kind: "notice", text: "No mic", tone: "error", action: "mic-settings" });
  });

  it("the download offer doesn't collapse away while hidden", () => {
    const s = { ...setup(), seen: true };
    expect(transition(s, { type: "shown", awayMs: 10 * 60_000 }).state.speech?.kind).toBe("voice_setup");
  });
});
