// "He reacts to what you're doing": typed wrappers around src-tauri/src/context.rs.
// Rust polls what the user is doing every few seconds and sends "context"
// events (a Reaction) and "focus" events (a ContextStatus).

import { invoke } from "@tauri-apps/api/core";
import type { Settings } from "./ipc";

/** The `context` block of the settings (crates/glitch-core/src/context.rs). */
export interface ContextSettings {
  enabled: boolean;
  music: boolean;
  coding: boolean;
  quiet_fullscreen: boolean;
  video: boolean;
  late_night: boolean;
  /** "HH:MM" local time. */
  night_start: string;
  night_end: string;
  morning: boolean;
  battery: boolean;
  cpu: boolean;
  focus: boolean;
  /** Suggest a focus session after a long coding stretch (off by default). */
  focus_suggest: boolean;
  focus_minutes: number;
  break_minutes: number;
}

export const CONTEXT_DEFAULTS: ContextSettings = {
  enabled: true,
  music: true,
  coding: true,
  quiet_fullscreen: true,
  video: true,
  late_night: true,
  night_start: "00:30",
  night_end: "05:00",
  morning: true,
  battery: true,
  cpu: true,
  focus: true,
  focus_suggest: false,
  focus_minutes: 25,
  break_minutes: 5,
};

/** Sent as "context". */
export type Reaction =
  | { kind: "dance"; bpm: number }
  | { kind: "glasses_type" }
  | { kind: "watch_tv"; window: number }
  | { kind: "late_night"; say: boolean }
  | { kind: "morning" }
  | { kind: "battery_low"; percent: number }
  | { kind: "cpu_hot" }
  | { kind: "quiet"; on: boolean }
  | { kind: "suggest_focus" };

export type FocusPhase = { phase: "off" } | { phase: "focus"; minutes: number } | { phase: "break"; minutes: number };

/** Sent as "focus" (and returned by `status`). */
export interface ContextStatus {
  enabled: boolean;
  quiet: boolean;
  focus: FocusPhase;
  remaining_ms: number | null;
}

export const contextApi = {
  status: () => invoke<ContextStatus>("context_status"),
  /** `minutes` undefined: the default length; 0: stop. Resolves to the minutes started. */
  focus: (minutes?: number) => invoke<number>("focus_start", { minutes }),
  update: (patch: ContextSettings) => invoke<Settings>("update_context_settings", { patch }),
  /** Debug builds: make a reaction happen now ("dance", "glasses", "watch", "focus"...). */
  debug: (what: string) => invoke<boolean>("context_debug", { what }),
};
