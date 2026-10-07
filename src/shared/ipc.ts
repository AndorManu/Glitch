// Typed wrappers around the Rust commands in src-tauri/src/commands.rs.

import { Channel, invoke } from "@tauri-apps/api/core";

export interface Settings {
  model: string | null;
  movement_enabled: boolean;
  onboarding_done: boolean;
  ollama_url: string;
  keep_alive: string;
  memory_enabled: boolean;
}

export interface MemoryFact {
  id: number;
  text: string;
  /** "YYYY-MM-DD" */
  added: string;
}

export interface MemoryView {
  enabled: boolean;
  facts: MemoryFact[];
  /** Rolling summary of today's earlier chat. */
  summary: string;
  /** One line per earlier day. */
  journal: { date: string; text: string }[];
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

export type PanelView = "setup" | "settings";

/** Also sent as the "bubble-layout" event whenever the bubble moves. */
export interface BubbleLayout {
  /** true: bubble is below Glitch, tail points up. */
  tail_up: boolean;
  /** Tail position from the bubble's left edge, CSS px. */
  tail_x: number;
}

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
  updateSettings: (patch: Partial<Pick<Settings, "model" | "movement_enabled" | "onboarding_done" | "memory_enabled">>) =>
    invoke<Settings>("update_settings", { patch }),
  /** Click on Glitch: toggles the chat bubble (or opens setup on first run). */
  mascotClicked: () => invoke<void>("mascot_clicked"),
  showBubble: () => invoke<void>("show_bubble"),
  hideBubble: () => invoke<void>("hide_bubble"),
  /** Report the bubble's content height in CSS px; returns where the tail goes. */
  resizeBubble: (height: number) => invoke<BubbleLayout | null>("resize_bubble", { height }),
  /** Open the panel on "setup" or "settings" (default: by setup state). */
  showPanel: (view?: PanelView) => invoke<void>("show_panel", { view }),
  /** Which view the panel should show (asked by the panel page on load). */
  panelView: () => invoke<PanelView>("panel_view"),
  hidePanel: () => invoke<void>("hide_panel"),
  /** Setup done: hide the panel and open the chat bubble. */
  finishSetup: () => invoke<void>("finish_setup"),
  /** What Glitch remembers (event "memory-changed" fires when it changes). */
  getMemory: () => invoke<MemoryView>("get_memory"),
  forgetMemory: (id: number) => invoke<boolean>("forget_memory", { id }),
  /** Forget everything, including the saved chat. */
  clearMemory: () => invoke<void>("clear_memory"),
  quit: () => invoke<void>("quit"),
};
