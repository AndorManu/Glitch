// Settings → Features → "Hey Glitch & his voice": the optional wake word
// (always-on microphone, off by default) and Glitch's own read-aloud voice
// (an opt-in download, falls back to the system voice).

import { asUiError, voiceApi, type TtsDownloadEvent, type TtsStatus, type VoiceStatus, type WakeStatus } from "../../shared/ipc";
import { h } from "../dom";
import { progressBar, toggleSwitch, type ProgressBar } from "../ui";
import type { Feature } from "./index";

/** The line under the wake-word switch. Unit-tested. */
export function wakeText(w: WakeStatus): { text: string; tone: "hint" | "ok" | "warn" } {
  if (!w.enabled) return { text: "Off: the microphone only opens while you hold the mic button or the shortcut.", tone: "hint" };
  if (w.armed) return { text: "Listening for “Hey Glitch” right now. The tray icon says so too, and Windows shows its microphone sign.", tone: "ok" };
  switch (w.problem) {
    case "needs_model":
      return { text: "Needs the speech model first: hold the mic button once (or download it under Voice).", tone: "warn" };
    case "voice_off":
      return { text: "Turn on “Talk to Glitch” under Voice first.", tone: "warn" };
    case "unavailable":
      return { text: "Voice isn't available on this computer.", tone: "warn" };
    case "mic_denied":
      return { text: "I'm not allowed to use the microphone. Check your privacy settings.", tone: "warn" };
    case "mic_missing":
      return { text: "I can't find a microphone.", tone: "warn" };
    default:
      return { text: `The microphone didn't start${w.message ? ` (${w.message})` : ""}.`, tone: "warn" };
  }
}

/** Download progress in percent, or null if unknown. Unit-tested. */
export function ttsPercent(d: [number, number] | null): number | null {
  if (!d || d[1] <= 0) return null;
  return Math.min(100, Math.round((d[0] / d[1]) * 100));
}

/** What the voice row says. Unit-tested. */
export function ttsText(t: TtsStatus, voice: "system" | "glitch"): string {
  if (!t.supported) return "Glitch's own voice isn't available on this system yet: replies are read with the system voice.";
  if (t.download) return "Downloading Glitch's voice…";
  if (!t.installed) return `Glitch's own voice is a one-time ${t.size_mb} MB download. It runs only on this computer.`;
  return voice === "glitch" ? "Glitch reads replies in his own voice." : "Glitch's voice is downloaded. Pick it above to use it.";
}

let live: { bar: ProgressBar; text: HTMLElement } | null = null;
let redraw: (() => void) | null = null;

/** Panel main forwards "tts-download" events here. */
export function onTtsDownload(e: TtsDownloadEvent): void {
  if (e.state === "running" && live) {
    const pct = ttsPercent([e.done, e.total]);
    live.bar.set(pct);
    live.text.textContent = pct === null ? "Downloading…" : `Downloading… ${pct}%`;
    return;
  }
  if (e.state !== "running") redraw?.();
}

/** The wake word changed state (armed, mic error...): redraw. */
export function onWakeStatus(): void {
  redraw?.();
}

async function render(root: HTMLElement): Promise<void> {
  redraw = () => void render(root);
  live = null;
  let st: VoiceStatus;
  try {
    st = await voiceApi.status();
  } catch (e) {
    root.replaceChildren(h("p", { class: "hint" }, `Couldn’t load: ${asUiError(e).message}`));
    return;
  }
  if (!st || !st.available) {
    root.replaceChildren(h("p", { class: "hint" }, "Voice isn't available on this system."));
    return;
  }
  const update = (patch: Parameters<typeof voiceApi.updateSettings>[0]) => void voiceApi.updateSettings(patch).then(() => redraw?.(), () => redraw?.());

  // --- Wake word.
  const w = wakeText(st.wake);
  const wakeParts: (Node | null)[] = [
    toggleSwitch(
      "Listen for “Hey Glitch”",
      "Hands-free: say “Hey Glitch, open YouTube”. The microphone stays on while this is on, but the sound never leaves this computer and nothing is saved. Anything he would do on a voice-only request waits for your OK first, since a video could say it too.",
      st.wake.enabled,
      (on) => update({ wake_word: on }),
    ),
    h("p", { class: `${w.tone === "warn" ? "callout warn" : "hint"} wake-status${w.tone === "ok" ? " wake-armed" : ""}`, role: "status" }, w.text),
  ];

  // --- Read-aloud voice.
  const t = st.tts;
  const voiceSelect = h("select", { "aria-label": "Read-aloud voice", disabled: !t.supported });
  voiceSelect.append(
    h("option", { value: "system", selected: st.read_aloud_voice !== "glitch" }, "Your computer’s voice"),
    h("option", { value: "glitch", selected: st.read_aloud_voice === "glitch" }, t.installed ? "Glitch’s own voice" : `Glitch’s own voice (${t.size_mb} MB download)`),
  );
  const text = h("span", { class: "hint" }, ttsText(t, st.read_aloud_voice));
  const startDownload = async (button: HTMLButtonElement | null) => {
    if (button) button.disabled = true;
    try {
      await voiceApi.ttsDownload();
    } catch (e) {
      const err = asUiError(e);
      if (err.code !== "download_cancelled") {
        text.textContent = `Download failed: ${err.message}. It continues where it stopped next time.`;
        text.className = "hint voice-error";
      }
      if (button) button.disabled = false;
    }
  };
  voiceSelect.addEventListener("change", () => {
    const v = voiceSelect.value === "glitch" ? "glitch" : "system";
    update({ read_aloud_voice: v });
    // Choosing his voice is the opt-in for the download.
    if (v === "glitch" && t.supported && !t.installed && !t.download) void startDownload(null);
  });

  let row: HTMLElement;
  if (t.download) {
    const bar = progressBar();
    const pct = ttsPercent(t.download);
    bar.set(pct);
    const label = h("span", { class: "hint" }, pct === null ? "Downloading…" : `Downloading… ${pct}%`);
    live = { bar, text: label };
    row = h(
      "div",
      { class: "voice-model" },
      bar.el,
      h("div", { class: "voice-model-line" }, label, h("button", { class: "secondary small", type: "button", onclick: () => void voiceApi.ttsCancelDownload() }, "Cancel")),
    );
  } else if (t.installed) {
    const del = h("button", { class: "secondary small danger-text", type: "button" }, "Delete");
    del.addEventListener("click", async () => {
      del.disabled = true;
      await voiceApi.ttsDelete().catch(() => {});
      if (st.read_aloud_voice === "glitch") await voiceApi.updateSettings({ read_aloud_voice: "system" }).catch(() => {});
      redraw?.();
    });
    const test = h("button", { class: "secondary small", type: "button" }, "Hear him");
    test.addEventListener("click", () => void voiceApi.ttsSpeak("Hi! I'm Glitch. Want me to open something for you?").catch(() => {}));
    row = h("div", { class: "voice-model-line" }, text, test, del);
  } else if (t.supported) {
    const get = h("button", { class: "secondary small", type: "button" }, `Download (${t.size_mb} MB)`);
    get.addEventListener("click", () => void startDownload(get));
    row = h("div", { class: "voice-model-line stack" }, text, get);
  } else {
    row = h("div", { class: "voice-model-line" }, text);
  }
  const voiceParts = [
    h("div", { class: "voice-field" }, h("span", { class: "voice-label" }, "Read-aloud voice"), h("label", { class: "select" }, voiceSelect)),
    st.speak_replies ? null : h("p", { class: "hint" }, "Turn on “Read replies aloud” under Voice to hear it."),
    row,
  ];
  root.replaceChildren(...[...wakeParts, h("div", { class: "voice-gap" }), ...voiceParts].filter((p): p is Node => p !== null));
}

export const voiceExtra: Feature = {
  id: "voice-extra",
  title: "Hey Glitch & his voice",
  render: (root) => void render(root),
};
