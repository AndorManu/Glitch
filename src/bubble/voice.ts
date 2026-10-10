// The mic button's state machine: pure, no DOM, unit-tested.
//
// Rust owns the real recording (src-tauri/src/voice/); this mirrors it for
// the UI and turns pointer presses into commands:
//   hold the button  → listen until released ("hold")
//   tap the button   → listen until the user goes quiet ("hands-free");
//                      tap again to stop early
// Rust reports progress as VoiceEvents (listening → transcribing → heard).

import type { VoiceEvent } from "../shared/ipc";

export type MicPhase = "hidden" | "idle" | "starting" | "listening" | "transcribing";

export interface MicState {
  phase: MicPhase;
  /** 0..1 input level while listening (drives the meter). */
  level: number;
  handsFree: boolean;
  /** When the button went down (ms), while it's held. */
  pressedAt: number | null;
}

/** Something to show in the bubble's speech area. */
export type VoiceSay =
  | { kind: "info"; text: string }
  | { kind: "error"; text: string; action: "mic-settings" | null }
  | { kind: "setup"; model: { id: string; label: string; sizeMb: number } };

export type MicEvent =
  | { type: "config"; usable: boolean }
  | { type: "press"; at: number }
  | { type: "release"; at: number }
  | { type: "voice"; event: VoiceEvent }
  /** Esc, the bubble closing, or a stuck start. */
  | { type: "cancel" };

export type MicCommand = "start" | "stop" | "hands_free" | "cancel";

export interface MicTransition {
  state: MicState;
  command: MicCommand | null;
  /** A transcript to send like a typed message. */
  heard: string | null;
  say: VoiceSay | null;
}

/** Released sooner than this after pressing = a tap. Same as the hotkey. */
export const TAP_MS = 350;

export type Os = "windows" | "macos" | "linux";

export function initialMic(): MicState {
  return { phase: "hidden", level: 0, handsFree: false, pressedAt: null };
}

export function micActive(s: MicState): boolean {
  return s.phase === "starting" || s.phase === "listening" || s.phase === "transcribing";
}

const idle = (s: MicState): MicState => ({ ...s, phase: s.phase === "hidden" ? "hidden" : "idle", level: 0, handsFree: false, pressedAt: null });

export function micTransition(s: MicState, e: MicEvent, os: Os): MicTransition {
  const out = (state: MicState, command: MicCommand | null = null, heard: string | null = null, say: VoiceSay | null = null): MicTransition => ({
    state,
    command,
    heard,
    say,
  });
  switch (e.type) {
    case "config":
      if (!e.usable) return out({ ...idle(s), phase: "hidden" }, micActive(s) ? "cancel" : null);
      return out(s.phase === "hidden" ? { ...s, phase: "idle" } : s);
    case "press":
      if (s.phase === "idle") return out({ ...s, phase: "starting", level: 0, handsFree: false, pressedAt: e.at }, "start");
      // Second tap ends a hands-free recording early.
      if (s.phase === "listening" && s.handsFree && s.pressedAt === null) return out({ ...s, pressedAt: null }, "stop");
      return out(s);
    case "release": {
      if (s.pressedAt === null || !(s.phase === "starting" || s.phase === "listening")) return out({ ...s, pressedAt: null });
      const tap = e.at - s.pressedAt < TAP_MS;
      return tap ? out({ ...s, pressedAt: null, handsFree: true }, "hands_free") : out({ ...s, pressedAt: null }, "stop");
    }
    case "cancel":
      return micActive(s) ? out(idle(s), "cancel") : out(s);
    case "voice":
      return fromRust(s, e.event, os, out);
  }
}

function fromRust(
  s: MicState,
  v: VoiceEvent,
  os: Os,
  out: (state: MicState, command?: MicCommand | null, heard?: string | null, say?: VoiceSay | null) => MicTransition,
): MicTransition {
  switch (v.phase) {
    case "listening":
      // Started by the hotkey while the button wasn't touched: show it too.
      return out({ ...s, phase: "listening", level: clamp01(v.level), handsFree: s.handsFree || v.hands_free });
    case "transcribing":
      return out({ ...s, phase: "transcribing", level: 0, pressedAt: null });
    case "heard":
      return out(idle(s), null, v.text);
    case "idle":
      return out(idle(s), null, null, v.reason === "nothing_heard" ? { kind: "info", text: NOTHING_HEARD } : null);
    case "error":
      return out(idle(s), null, null, explainVoiceError(v.code, v.message, os));
    case "needs_model":
      return out(idle(s), null, null, {
        kind: "setup",
        model: { id: v.model.id, label: v.model.label, sizeMb: Math.ceil(v.model.size_bytes / 1048576) },
      });
  }
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

// ------------------------------------------------------------------ words

export const NOTHING_HEARD = "I didn't catch that. Hold the mic button while you talk, or tap it and just start talking.";

export function micHint(s: MicState): string {
  switch (s.phase) {
    // Until the microphone delivers sound: an idle laptop mic can take
    // ~0.8 s to wake up (measured on Windows 11), and words said before
    // that are lost, so don't say "Listening" yet.
    case "starting":
      return "Mic warming up…";
    case "listening":
      return s.handsFree ? "Listening… tap to stop" : "Listening… let go";
    case "transcribing":
      return "Writing it down…";
    default:
      return "";
  }
}

export function micTitle(hotkey: string | null): string {
  const key = hotkey ? ` or ${hotkey}` : "";
  return `Hold to talk${key} · tap for hands-free`;
}

const MIC_SETTINGS: Record<Os, string> = {
  windows: "Settings → Privacy & security → Microphone, and turn on “Let desktop apps access your microphone”",
  macos: "System Settings → Privacy & Security → Microphone, and turn on Glitch",
  linux: "your system's sound settings",
};

/** Friendly words for errors from the voice side. Unit-tested. */
export function explainVoiceError(code: string, message: string, os: Os): VoiceSay {
  const settingsAction = os === "linux" ? null : ("mic-settings" as const);
  switch (code) {
    case "mic_missing":
      return { kind: "error", text: "I can't find a microphone. Plug one in (or switch it on) and try again.", action: null };
    case "mic_denied":
      return { kind: "error", text: `I'm not allowed to use the microphone. Open ${MIC_SETTINGS[os]}.`, action: settingsAction };
    case "mic_silent":
      return os === "macos"
        ? { kind: "error", text: `I only hear silence, so macOS is probably blocking the microphone. Open ${MIC_SETTINGS.macos}.`, action: settingsAction }
        : { kind: "error", text: "I only hear silence. Is your microphone muted?", action: settingsAction };
    case "mic_busy":
      return { kind: "error", text: "Another app is using the microphone right now. Close it and try again.", action: null };
    case "mic_failed":
      return {
        kind: "error",
        text:
          os === "windows"
            ? `The microphone didn't work (${message}). If this keeps happening, check ${MIC_SETTINGS.windows}.`
            : `The microphone didn't work (${message}).`,
        action: os === "windows" ? settingsAction : null,
      };
    case "stt_failed":
      return { kind: "error", text: `I couldn't turn that into words (${message}). Try again, or pick another speech model in Settings.`, action: null };
    case "voice_unsupported":
      return { kind: "error", text: `Voice doesn't work here: ${message}. You can still type!`, action: null };
    default:
      return { kind: "error", text: `Voice hiccup: ${message}`, action: null };
  }
}

/** Download problems, shown in the setup offer. */
export function explainDownloadError(code: string): string {
  switch (code) {
    case "download_offline":
      return "The download didn't work. Are you online? It will continue where it stopped.";
    case "download_corrupt":
      return "The download came out damaged. Please try again.";
    case "download_disk":
      return "I couldn't save the speech model. Is the disk full?";
    case "download_busy":
      return "Another speech model is downloading. Try again in a moment.";
    default:
      return "The download didn't work. Please try again.";
  }
}

export function setupText(sizeMb: number): string {
  return `To hear you, I need a speech model: a one-time ${sizeMb} MB download. It runs only on this computer, so your voice never leaves it.`;
}

export function readyText(hotkey: string | null): string {
  const key = hotkey ? ` (or ${hotkey})` : "";
  return `All set! Hold the mic button${key} and talk to me. Tap it instead to talk hands-free.`;
}

/** Read aloud with Glitch's own voice (else the system voice). Unit-tested. */
export function useGlitchVoice(voice: "system" | "glitch", installed: boolean): boolean {
  return voice === "glitch" && installed;
}

/** The mic button's tooltip while "Hey Glitch" is armed. */
export const ARMED_TITLE = "Listening for “Hey Glitch” (mic on) · or hold to talk";

/**
 * The part of a reply worth reading aloud, or null to stay quiet (too long:
 * nobody wants a lecture from their raccoon). Links aren't read out.
 */
export function speakable(text: string, max = 280): string | null {
  const t = text
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t || t.length > max) return null;
  return t;
}
