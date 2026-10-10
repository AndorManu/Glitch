// Typed wrappers around the Rust commands in src-tauri/src/commands.rs.

import { Channel, invoke } from "@tauri-apps/api/core";

export interface Settings {
  model: string | null;
  movement_enabled: boolean;
  /** Chaos mode (window mischief, cursor play, paw prints, notes). Missing from old builds: on. */
  chaos_enabled?: boolean;
  onboarding_done: boolean;
  ollama_url: string;
  keep_alive: string;
  memory_enabled: boolean;
  /** "Let Glitch see the screen" (look_at_screen). Missing from old builds: on. */
  screen_enabled?: boolean;
  /** Feature "Let Glitch control apps" (click, type, play in other apps). Off by default. */
  hands_enabled?: boolean;
  /** "Smarter brain for app control": a bigger model only for app tasks (null: the normal brain). */
  hands_model?: string | null;
  /** The user allowed notes once; later notes don't ask. */
  notes_trusted?: boolean;
  /** Voice commands (see the voice section at the end of this file). */
  voice?: VoiceSettings;
  /** OBS stream overlay (see the stream section). Missing from old builds: off. */
  stream_overlay?: StreamSettings;
  /** Update checks (see the updates section). */
  auto_update?: UpdateSettings;
  /** "He reacts to what you're doing" (see ./context.ts). Missing from old builds: defaults. */
  context?: import("./context").ContextSettings;
  /** "Update me" features (missing from old builds: defaults). */
  update_me?: UpdateMeSettings;
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
  | { type: "confirm"; id: string; title: string; detail: string; actions: string[]; allow?: string; deny?: string };

export interface UiError {
  code: string;
  message: string;
}

export interface PullProgress {
  status: string;
  completed: number | null;
  total: number | null;
}

/** "looking": Glitch is taking a screenshot right now (mapped by the mascot's animator). */
export type Mood = "thinking" | "happy" | "asking" | "idle" | "listening" | "talking" | "looking";

/** What `look_at_screen` captured. */
export type CaptureTarget = "screen" | "window" | "cursor";

/**
 * Sent as "agent-progress" while Glitch works on a message (see Progress in
 * crates/glitch-core/src/agent.rs): new model rounds, tool steps, the
 * "looking at your screen" moment, and the reply text as it streams in.
 */
export type AgentProgress =
  | { kind: "thinking" }
  | { kind: "step"; id: number; tool: string; label: string }
  | { kind: "step_done"; id: number; ok: boolean }
  | { kind: "looking"; active: boolean; target: CaptureTarget }
  | { kind: "text"; delta: string }
  /** An app task's plan (2 to 6 short steps). */
  | { kind: "plan"; steps: string[] };

/** Sent as "reminder" when a timer Glitch set rings. */
export interface Reminder {
  message: string;
}

export type PanelView = "setup" | "settings";

/** Physical-pixel rectangle (screen coordinates, y grows downwards). */
export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A surface Glitch can stand on: the visible part of the top edge of another
 * app's window. Physical px; `y` is where his feet go. Already excludes
 * Glitch's own windows, minimised/hidden windows, parts covered by windows in
 * front, and edges with less than ~120 CSS px of room above them.
 */
export interface Ledge {
  /** Stable while the window exists (use it to notice moved/closed windows). */
  id: number;
  x: number;
  y: number;
  w: number;
}

export interface WorldSnapshot {
  /** Work area of the monitor Glitch is on (excludes taskbar / menu bar). */
  area: ScreenRect;
  /** Physical px per CSS px of the mascot window. */
  scale: number;
  /** Window tops to stand on (empty on Linux or if unavailable). */
  ledges: Ledge[];
  /** Whole frames of the windows those ledges belong to (missing from older builds / fakes). */
  frames?: WindowFrame[];
}

/** Another app's window frame, physical px (`id` matches its ledges). */
export interface WindowFrame {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Sent as "ledge-event" while Glitch stands on another app's window. */
export interface LedgeEvent {
  id: number;
  /** move: it is now at `frame`; grab: the user took hold of it; gone: closed/hidden/minimised; front: another window came to the front. */
  kind: "move" | "grab" | "gone" | "front";
  frame: ScreenRect | null;
}

export interface LedgeWatchInfo {
  /** true: "ledge-event" events arrive; false: poll ledgeFrame. */
  events: boolean;
  frame: ScreenRect | null;
}

/** Window-local CSS px. */
export interface LocalRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

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

/**
 * Window-to-window event (no Rust involved): the panel's "Clear chat"
 * finished, so the bubble drops what it was showing.
 */
export const CHAT_CLEARED_EVENT = "chat-cleared";

/**
 * Window-to-window event (no Rust involved): the bubble started showing a
 * reply of N characters; the mascot moves his mouth for a while (payload: N).
 */
export const MASCOT_TALK_EVENT = "mascot-talk";

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
  /** The chat is open: load the model and keep it loaded (call again every few minutes). */
  warmModel: () => invoke<void>("warm_model"),
  /** The chat closed: back to the short keep-alive. */
  coolModel: () => invoke<void>("cool_model"),
  getSettings: () => invoke<Settings>("get_settings"),
  updateSettings: (patch: Partial<Pick<Settings, "model" | "movement_enabled" | "chaos_enabled" | "onboarding_done" | "memory_enabled" | "screen_enabled" | "hands_enabled">> & { hands_model?: string }) =>
    invoke<Settings>("update_settings", { patch }),
  /** Click on Glitch: toggles the chat bubble (or opens setup on first run). */
  mascotClicked: () => invoke<void>("mascot_clicked"),
  showBubble: () => invoke<void>("show_bubble"),
  hideBubble: () => invoke<void>("hide_bubble"),
  /** Call when a close animation starts (before `hideBubble`): a click on
   *  Glitch meanwhile reopens the bubble, and "bubble-shown" fires. */
  bubbleClosing: () => invoke<void>("bubble_closing"),
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
  /** Screen edges + other windows' tops, for walking/climbing/jumping. Cheap (a few ms); poll every ~1.5 s at most. */
  world: () => invoke<WorldSnapshot>("world_snapshot"),
  /**
   * The part of the mascot window that should catch the mouse (Glitch's body),
   * in window-local CSS px. Everything else clicks through to what's below.
   * `null` = the whole window catches the mouse (use while dragging).
   * Rust emits "mascot-hover" (boolean) when the cursor enters/leaves it.
   */
  setHitbox: (rect: LocalRect | null) => invoke<void>("set_hitbox", { rect }),
  /** Watch the window Glitch stands on (null: stop). Events arrive as "ledge-event". */
  ledgeWatch: (id: number | null) => invoke<LedgeWatchInfo>("ledge_watch", { id }),
  /** Where that window is now (null: gone). For platforms without events. */
  ledgeFrame: (id: number) => invoke<ScreenRect | null>("ledge_frame", { id }),
};

// ------------------------------------------------------------------ voice
// Push-to-talk voice commands (src-tauri/src/voice/). Everything that
// happens during a voice command arrives as "voice" events (VoiceEvent);
// model downloads report as "voice-download" events (VoiceDownloadEvent).

export interface VoiceSettings {
  enabled: boolean;
  /** "tiny" | "base" | "small"; null = picked by RAM. */
  model: string | null;
  /** "auto" or a language code. */
  language: string;
  speak_replies: boolean;
}

export interface SpeechModel {
  id: string;
  label: string;
  blurb: string;
  file: string;
  size_bytes: number;
  size_mb: number;
  downloaded: boolean;
}

export interface VoiceStatus {
  /** false on Linux, or on a CPU too old for the speech model. */
  available: boolean;
  unavailable_reason: "platform" | "cpu" | null;
  os: "windows" | "macos" | "linux";
  enabled: boolean;
  phase: "idle" | "listening" | "transcribing";
  hotkey: { label: string; registered: boolean; error: string | null };
  /** Model in use (explicit choice or RAM pick) and the RAM pick. */
  model: string;
  recommended: string;
  model_auto: boolean;
  models: SpeechModel[];
  language: string;
  languages: { code: string; label: string }[];
  speak_replies: boolean;
  download: { model: string; done: number; total: number } | null;
  /** The bubble should offer the model download (the hotkey opened it). */
  offer_pending: boolean;
}

export type VoiceEvent =
  | { phase: "listening"; level: number; hands_free: boolean }
  | { phase: "transcribing" }
  | { phase: "heard"; text: string }
  | { phase: "idle"; reason: "cancelled" | "nothing_heard" }
  | { phase: "error"; code: string; message: string }
  | { phase: "needs_model"; model: Omit<SpeechModel, "size_mb" | "downloaded"> };

export interface VoiceDownloadEvent {
  model: string;
  state: "running" | "done" | "failed" | "cancelled";
  done: number;
  total: number;
  error: UiError | null;
}

export interface VoicePatch {
  enabled?: boolean;
  /** A model id, or "auto". */
  model?: string;
  language?: string;
  speak_replies?: boolean;
}

export const voiceApi = {
  status: () => invoke<VoiceStatus>("voice_status"),
  updateSettings: (patch: VoicePatch) => invoke<Settings>("update_voice_settings", { patch }),
  /** "hold": until stop(); "hands_free": until the user goes quiet. */
  start: (mode: "hold" | "hands_free" = "hold") => invoke<void>("voice_start", { mode }),
  stop: () => invoke<void>("voice_stop"),
  /** The mic was only tapped: keep listening until the user is quiet. */
  handsFree: () => invoke<void>("voice_hands_free"),
  cancel: () => invoke<void>("voice_cancel"),
  offerSeen: () => invoke<void>("voice_offer_seen"),
  /** Default: the model in use. Resolves when finished. */
  downloadModel: (model?: string) => invoke<void>("voice_download_model", { model }),
  cancelDownload: () => invoke<void>("voice_cancel_download"),
  deleteModel: (model: string) => invoke<void>("voice_delete_model", { model }),
  openMicSettings: () => invoke<void>("voice_open_mic_settings"),
};

// ------------------------------------------------------------------ chaos
// Chaos mode (src-tauri/src/chaos.rs). Everything that touches other apps'
// windows or the cursor is checked again in Rust: chaos + movement on, chat
// closed, user not busy, rate limits, travel limits, on-screen clamping.

export type ChaosRefusal = "disabled" | "cooling_down" | "user_active" | "fullscreen" | "not_found" | "ineligible" | "in_use" | "busy";

export interface ChaosStatus {
  /** Other apps' windows / the cursor can be touched on this OS (Windows). */
  available: boolean;
  enabled: boolean;
  /** Why not right now (null = go ahead). */
  blocked: ChaosRefusal | null;
  /** ms since the last keyboard/mouse input (0 if unknown). */
  idle_ms: number;
  window_ready: boolean;
  cursor_ready: boolean;
}

export interface ChaosWindow {
  /** Same id as the window's ledges. */
  id: number;
  /** Visible frame, physical px. */
  frame: ScreenRect;
}

/** Physical screen px; `angle` in degrees. */
export interface PawStamp {
  x: number;
  y: number;
  angle: number;
  left: boolean;
}

export const chaosApi = {
  status: () => invoke<ChaosStatus>("chaos_status"),
  /** Windows Glitch may drag right now (empty when not allowed). */
  windows: () => invoke<ChaosWindow[]>("chaos_windows"),
  /** Start a grab: resolves to the frame, rejects with a ChaosRefusal. */
  grabWindow: (id: number) => invoke<ScreenRect>("chaos_grab_window", { id }),
  /** Move it by (dx, dy) from where it was grabbed: the applied offset, or null = let go. */
  dragWindow: (dx: number, dy: number) => invoke<[number, number] | null>("chaos_drag_window", { dx, dy }),
  releaseWindow: () => invoke<void>("chaos_release_window"),
  grabCursor: () => invoke<[number, number] | null>("chaos_grab_cursor"),
  /** false = let go (the user pulled, time up). */
  dragCursor: (x: number, y: number) => invoke<boolean>("chaos_drag_cursor", { x, y }),
  releaseCursor: () => invoke<void>("chaos_release_cursor"),
  paws: (paws: PawStamp[]) => invoke<void>("chaos_paws", { paws }),
  pawsIdle: () => invoke<void>("chaos_paws_idle"),
  /** Open the sticky note with line `line` at (x, y) physical px: its size in physical px. */
  noteOpen: (line: number, x: number, y: number) => invoke<{ w: number; h: number } | null>("chaos_note_open", { line, x, y }),
  noteMove: (x: number, y: number) => invoke<boolean>("chaos_note_move", { x, y }),
  noteClose: () => invoke<void>("chaos_note_close"),
  noteIsOpen: () => invoke<boolean>("chaos_note_open_now"),
};

// ------------------------------------------------------------------ stream
// The OBS stream overlay (src-tauri/src/stream/). "stream-status" events
// carry StreamStatus whenever the server or a connection changes.

export interface StreamSettings {
  enabled: boolean;
  port: number;
  /** Secrets: never shown, copied with streamApi.copy. */
  view_token: string;
  write_token: string;
  mode: "mirror" | "walk";
  size: number;
  position: "left" | "center" | "right";
  react: boolean;
  show_chat: boolean;
  mirror_chat: boolean;
  streamerbot: boolean;
  streamerbot_url: string;
  twitch_channel: string;
}

export interface SourceStatus {
  state: "off" | "connecting" | "connected" | "error";
  detail: string;
}

export interface StreamStatus {
  enabled: boolean;
  running: boolean;
  error: string | null;
  /** OBS browser-source URL (read-only token). Empty while off. */
  url: string;
  /** Where bots POST events (the write token goes in a header). */
  webhook: string;
  viewers: number;
  streamerbot: SourceStatus;
  twitch: SourceStatus;
  /** The overlay settings, tokens blanked. */
  settings: StreamSettings;
}

export type StreamPatch = Partial<Omit<StreamSettings, "view_token" | "write_token">>;
export type StreamEventKind = "follow" | "sub" | "raid" | "chat";

export const streamApi = {
  status: () => invoke<StreamStatus>("stream_status"),
  update: (patch: StreamPatch) => invoke<Settings>("update_stream_settings", { patch }),
  /** New view and write tokens: the old OBS URL and bot token stop working. */
  newToken: () => invoke<StreamStatus>("stream_new_token"),
  test: (kind: StreamEventKind) => invoke<void>("stream_test_event", { kind }),
  copy: (what: "url" | "write_token") => invoke<void>("stream_copy", { what }),
};

// ----------------------------------------------------------------- updates
// Auto-update (src-tauri/src/autoupdate.rs). "update-status" events carry
// UpdateStatus; "update-available" (UpdateAvailable) asks the bubble to offer it.

export interface UpdateSettings {
  auto_check: boolean;
  snoozed_version: string | null;
  snoozed_at: number;
}

export interface UpdateAvailable {
  version: string;
  notes: string;
}

export interface UpdateStatus {
  current: string;
  auto_check: boolean;
  checking: boolean;
  available: UpdateAvailable | null;
  /** Offer it in the bubble now (not snoozed with "Later"). */
  offer: boolean;
  installing: boolean;
  /** Download percent while installing (null: size unknown). */
  progress: number | null;
  /** Unix seconds (0 = never). */
  last_check: number;
  error: string | null;
}

export const updateApi = {
  status: () => invoke<UpdateStatus>("update_status"),
  check: () => invoke<UpdateStatus>("update_check"),
  setAuto: (on: boolean) => invoke<UpdateStatus>("update_set_auto", { on }),
  later: () => invoke<void>("update_later"),
  /** Downloads, verifies the signature, installs and restarts Glitch. */
  install: () => invoke<void>("update_install"),
};

// -------------------------------------------------------------- update me
// "Update me" (src-tauri/src/update_me.rs): the local event endpoint, the
// Claude Code buddy, the notification digest, saved reminders and the daily
// briefing. The mascot gets "mascot-update" (UpdateAct), the bubble gets
// "glitch-update" (UpdateSpeech). Outside text is only ever shown.

export interface UpdateLocation {
  name: string;
  latitude: number;
  longitude: number;
}

export interface UpdateMeSettings {
  endpoint_enabled: boolean;
  claude_code_enabled: boolean;
  notifications_enabled: boolean;
  notifications_quiet: boolean;
  notifications_blocklist: string[];
  reminders_enabled: boolean;
  briefing_enabled: boolean;
  location: UpdateLocation | null;
}

export interface ClaudeCodeStatus {
  path: string;
  file_exists: boolean;
  connected: boolean;
  outdated: boolean;
  problem: string | null;
  /** Exactly what "Connect" adds (pretty JSON). */
  preview: string;
  command: string;
}

export interface DigestGroup {
  app: string;
  count: number;
}

export interface ReminderView {
  id: number;
  text: string;
  /** "today 17:00", "tomorrow 09:00", "Fri 9 Oct 12:00" */
  when: string;
}

export type NotificationAccess = "allowed" | "denied" | "unspecified" | "unavailable";

export interface UpdateMeStatus {
  os: "windows" | "macos" | "linux";
  settings: UpdateMeSettings;
  endpoint_port: number | null;
  endpoint_file: string;
  claude: ClaudeCodeStatus | null;
  claude_error: string | null;
  notifications_access: NotificationAccess;
  digest: DigestGroup[];
  reminders: ReminderView[];
}

export type UpdateMePatch = Partial<Omit<UpdateMeSettings, "location">> & { location?: UpdateLocation; clear_location?: boolean };

export interface UpdateChoice {
  id: string;
  label: string;
}

export type UpdateIcon = "reminder" | "claude" | "event" | "digest" | "briefing";

/** Something Glitch tells the user by himself ("glitch-update"). */
export interface UpdateSpeech {
  id: string;
  text: string;
  icon: UpdateIcon;
  choices: UpdateChoice[];
}

/** The mascot's little act for an update ("mascot-update"). */
export interface UpdateAct {
  /** "run", "knock_screen", "hold_sign" (mapped to animations with fallbacks). */
  steps: string[];
  sign: string | null;
  sign_ms: number;
}

export const updateMeApi = {
  status: () => invoke<UpdateMeStatus>("update_me_status"),
  set: (patch: UpdateMePatch) => invoke<UpdateMeStatus>("update_me_set", { patch }),
  claudeConnect: () => invoke<UpdateMeStatus>("claude_connect"),
  claudeDisconnect: () => invoke<UpdateMeStatus>("claude_disconnect"),
  deleteReminder: (id: number) => invoke<UpdateMeStatus>("reminder_delete", { id }),
  /** An update the bubble may have missed while closed. */
  pending: () => invoke<UpdateSpeech | null>("update_pending"),
  seen: (id: string) => invoke<void>("update_seen", { id }),
  choose: (id: string, choice: string) => invoke<UpdateSpeech | null>("update_choose", { id, choice }),
  /** The daily briefing, once per day (null otherwise). */
  briefing: () => invoke<string | null>("briefing_today"),
  searchLocation: (query: string) => invoke<UpdateLocation[]>("location_search", { query }),
  /** Sends a test event through the real endpoint. */
  test: () => invoke<void>("update_me_test"),
};
