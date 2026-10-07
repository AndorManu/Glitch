// Typed wrappers around the Rust commands in src-tauri/src/commands.rs.

import { Channel, invoke } from "@tauri-apps/api/core";

export interface Settings {
  model: string | null;
  movement_enabled: boolean;
  onboarding_done: boolean;
  ollama_url: string;
  keep_alive: string;
}

export interface ModelChoice {
  name: string;
  download_gb: number;
}

export interface Recommendation {
  tier: string;
  total_ram_gb: number;
  primary: ModelChoice;
  alternatives: ModelChoice[];
  note: string | null;
}

export interface InstalledModel {
  name: string;
  size_gb: number;
  supports_tools: boolean | null;
}

export interface SetupStatus {
  os: "windows" | "macos" | "linux";
  ollama: { state: "running" | "stopped" | "missing"; version: string | null; download_url: string };
  recommendation: Recommendation;
  installed: InstalledModel[];
  settings: Settings;
}

export type Step =
  | { type: "reply"; text: string; actions: string[] }
  | { type: "confirm"; id: string; title: string; detail: string; actions: string[] };

export interface UiError {
  code: string;
  message: string;
}

export interface PullProgress {
  status: string;
  completed: number | null;
  total: number | null;
}

export type Mood = "thinking" | "happy" | "asking" | "idle";

/** Errors from `invoke` are our UiError objects (or a plain string from Tauri itself). */
export function asUiError(e: unknown): UiError {
  if (e && typeof e === "object" && "code" in e && "message" in e) return e as UiError;
  return { code: "unknown", message: String(e) };
}

export const api = {
  setupStatus: () => invoke<SetupStatus>("setup_status"),
  startOllama: () => invoke<void>("start_ollama"),
  openOllamaDownload: () => invoke<void>("open_ollama_download"),
  pullModel: (name: string, onProgress: (p: PullProgress) => void) => {
    const channel = new Channel<PullProgress>();
    channel.onmessage = onProgress;
    return invoke<void>("pull_model", { name, onProgress: channel });
  },
  sendMessage: (text: string) => invoke<Step>("send_message", { text }),
  confirmAction: (id: string, approved: boolean) => invoke<Step>("confirm_action", { id, approved }),
  resetChat: () => invoke<void>("reset_chat"),
  getSettings: () => invoke<Settings>("get_settings"),
  updateSettings: (patch: Partial<Pick<Settings, "model" | "movement_enabled" | "onboarding_done">>) =>
    invoke<Settings>("update_settings", { patch }),
  togglePanel: () => invoke<void>("toggle_panel"),
  hidePanel: () => invoke<void>("hide_panel"),
  quit: () => invoke<void>("quit"),
};
