// Typed wrappers around the Rust commands in src-tauri/src/commands.rs.

import { Channel, invoke } from "@tauri-apps/api/core";

export interface Settings {
  model: string | null;
  movement_enabled: boolean;
  /** Chaos mode (window mischief, cursor play, paw prints, notes). Missing from old builds: on. */
  chaos_enabled?: boolean;
  /** How wild chaos mode is (chaos_enabled false = off). Missing from old builds: gentle. */
  chaos_level?: ChaosLevel;
  /** The one-time Full Virus confirmation was given. */
  chaos_full_confirmed?: boolean;
  /** "Reduce effects": null / missing follows the OS animation setting. */
  reduce_effects?: boolean | null;
  /** Chaos mode may run while the stream overlay is on (default off). */
  chaos_during_stream?: boolean;
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
  /** Sub-level "Desktop control" (pointer, windows, files). Off by default; needs hands_enabled. */
  hands_desktop_enabled?: boolean;
  /** The user allowed notes once; later notes don't ask. */
  notes_trusted?: boolean;
  /** Voice commands (see the voice section at the end of this file). */
  voice?: VoiceSettings;
  /** Games, play and growth + wardrobe (see the play section at the end of this file). */
  play?: PlaySettings;
  /** OBS stream overlay (see the stream section). Missing from old builds: off. */
  stream_overlay?: StreamSettings;
  /** Update checks (see the updates section). */
  auto_update?: UpdateSettings;
  /** "He reacts to what you're doing" (see ./context.ts). Missing from old builds: defaults. */
  context?: import("./context").ContextSettings;
  /** "Update me" features (missing from old builds: defaults). */
  update_me?: UpdateMeSettings;
  /** Panic button and "Start with Windows" (missing from old builds: defaults). */
  safety?: SafetySettings;
}

/** Saved part of the safety switches (see the safety section). */
export interface SafetySettings {
  paused: boolean;
  panic_hotkey: string;
  start_with_windows: boolean;
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

/** What "Undo last Glitch action" would do. */
export type UndoStatus = { label: string | null; count: number };

export type Step =
  | { type: "reply"; text: string; actions: string[] }
  | { type: "confirm"; id: string; title: string; detail: string; actions: string[]; allow?: string; deny?: string; auto?: string };

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
export type CaptureTarget = "screen" | "window" | "cursor" | "app";

/**
 * Sent as "agent-progress" while Glitch works on a message (see Progress in
 * crates/glitch-core/src/agent.rs): new model rounds, tool steps, the
 * "looking at your screen" moment, and the reply text as it streams in.
 */
export type AgentProgress =
  | { kind: "thinking" }
  | { kind: "step"; id: number; tool: string; label: string }
  | { kind: "step_done"; id: number; ok: boolean }
  /** `app`: with target "app", which app ("Spotify"). */
  | { kind: "looking"; active: boolean; target: CaptureTarget; app?: string }
  | { kind: "text"; delta: string }
  /** An app task's plan (2 to 6 short steps). */
  | { kind: "plan"; steps: string[] };

/** Sent as "reminder" when a timer Glitch set rings. */
export interface Reminder {
  message: string;
  /** A passing remark (a context nudge, not a timer): the bubble hides by itself if nobody answers. */
  ambient?: boolean;
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
  confirmAction: (id: string, approved: boolean, auto = false) => invoke<Step>("confirm_action", { id, approved, auto }),
  /** "Undo last Glitch action": what it would do (label null: nothing to undo). */
  undoStatus: () => invoke<UndoStatus>("undo_status"),
  undoLast: () => invoke<string>("undo_last_action"),
  resetChat: () => invoke<void>("reset_chat"),
  /** The chat is open: load the model and keep it loaded (call again every few minutes). */
  warmModel: () => invoke<void>("warm_model"),
  /** The chat closed: back to the short keep-alive. */
  coolModel: () => invoke<void>("cool_model"),
  getSettings: () => invoke<Settings>("get_settings"),
  updateSettings: (patch: Partial<Pick<Settings, "model" | "movement_enabled" | "chaos_enabled" | "chaos_level" | "chaos_full_confirmed" | "reduce_effects" | "chaos_during_stream" | "onboarding_done" | "memory_enabled" | "screen_enabled" | "hands_enabled" | "hands_desktop_enabled">> & { hands_model?: string }) =>
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
  /** Listen for "Hey Glitch" (the mic stays open while armed). Off by default. */
  wake_word: boolean;
  /** Read-aloud voice: the system's, or Glitch's own (downloaded on request). */
  read_aloud_voice: "system" | "glitch";
}

/** The wake word: the setting, and whether the mic is open for it right now. */
export interface WakeStatus {
  enabled: boolean;
  armed: boolean;
  /** Why it isn't armed although enabled. */
  problem: "needs_model" | "voice_off" | "unavailable" | "mic_denied" | "mic_missing" | "mic_busy" | "mic_failed" | null;
  message: string | null;
}

/** Glitch's own read-aloud voice (Piper). */
export interface TtsStatus {
  /** There is a build for this system (Windows x64). */
  supported: boolean;
  installed: boolean;
  size_mb: number;
  /** [done, total] bytes while downloading. */
  download: [number, number] | null;
  playing: boolean;
}

export interface TtsDownloadEvent {
  state: "running" | "done" | "failed" | "cancelled";
  done: number;
  total: number;
  error: string | null;
  code: string | null;
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
  wake: WakeStatus;
  read_aloud_voice: "system" | "glitch";
  tts: TtsStatus;
}

export type VoiceEvent =
  | { phase: "listening"; level: number; hands_free: boolean }
  | { phase: "transcribing" }
  | { phase: "heard"; text: string }
  | { phase: "idle"; reason: "cancelled" | "nothing_heard" | "wake_only" }
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
  wake_word?: boolean;
  read_aloud_voice?: "system" | "glitch";
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
  /** The system voice started/stopped reading aloud (the wake word ignores the mic meanwhile). */
  speaking: (on: boolean) => invoke<void>("voice_speaking", { on }),
  /** A message was sent: get Glitch's voice ready (no-op if it isn't used). */
  ttsPrepare: () => invoke<void>("voice_tts_prepare"),
  /** Read aloud with Glitch's voice; rejects if it can't (use the system voice then). */
  ttsSpeak: (text: string) => invoke<void>("voice_tts_speak", { text }),
  ttsStop: () => invoke<void>("voice_tts_stop"),
  /** Resolves when finished; progress as "tts-download" events. */
  ttsDownload: () => invoke<void>("voice_tts_download"),
  ttsCancelDownload: () => invoke<void>("voice_tts_cancel_download"),
  ttsDelete: () => invoke<void>("voice_tts_delete"),
};

// ------------------------------------------------------------------ safety
// The panic button and "Start with Windows" (src-tauri/src/pause.rs,
// autostart.rs). "pause-changed" (boolean) is sent whenever the panic button flips.

export interface SafetyStatus {
  paused: boolean;
  hotkey: { combo: string; registered: boolean; error: string | null };
  default_hotkey: string;
  start_with_windows: boolean;
  autostart_supported: boolean;
  /** What the Windows registry says right now (the saved setting is the wish). */
  autostart_active: boolean;
  autostart_error: string | null;
}

export const safetyApi = {
  status: () => invoke<SafetyStatus>("safety_status"),
  setPaused: (paused: boolean) => invoke<SafetyStatus>("safety_set_paused", { paused }),
  /** Rejects with a UiError whose message says why (too easy to hit by accident, taken...). */
  setHotkey: (combo: string) => invoke<SafetyStatus>("safety_set_hotkey", { combo }),
  setAutostart: (enabled: boolean) => invoke<SafetyStatus>("safety_set_autostart", { enabled }),
};

// ------------------------------------------------------------------ chaos
// Chaos mode (src-tauri/src/chaos.rs). Everything that touches other apps'
// windows or the cursor is checked again in Rust: chaos + movement on, chat
// closed, user not busy, rate limits, travel limits, on-screen clamping.

export type ChaosRefusal = "disabled" | "cooling_down" | "user_active" | "fullscreen" | "not_found" | "ineligible" | "in_use" | "busy" | "unsaved_work";

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

// ------------------------------------------------------- chaos mode 2
// "Old virus style" chaos (src-tauri/src/chaos2.rs, crates/glitch-core/src/chaos2.rs):
// the hook, cursor classics, screen effects, swarm, popups, the minimise prank.
// Rust re-checks level, safety gate, cooldowns and the global rate limit on every call.

export type ChaosLevel = "off" | "gentle" | "mischief" | "full_virus";

export type Fx = "hook" | "orbit" | "jitter" | "hops" | "trail" | "matrix" | "scanlines" | "melt" | "bugs" | "swarm" | "popup" | "yoink" | "dance";

export type Blocked =
  | "level"
  | "paused"
  | "chat"
  | "voice"
  | "hands"
  | "quiet"
  | "focus"
  | "stream"
  | "screen_share"
  | "user_busy"
  | "user_active"
  | "reduce_effects"
  | "rate_limit"
  | "cooling_down"
  | "unsafe";

export interface Chaos2Status {
  level: ChaosLevel;
  label: string;
  reduce_effects: boolean;
  /** Acts that could start right now. */
  ready: Fx[];
  blocked: Blocked | null;
  idle_ms: number;
  /** [min, max] ms to the next act. */
  gap_ms: [number, number] | null;
}

export type HookStyle = "pull" | "circle" | "figure8" | "bounce";
export type CursorAct = { kind: "hook"; style: HookStyle } | { kind: "orbit" } | { kind: "jitter" } | { kind: "hops" };
export type AbortReason = "stopped" | "esc" | "button" | "user_input" | "user_moved" | "lost";
export type DanceKind = "wobble" | "edge_slide" | "quake" | "run_away";
export type FxKind = "trail" | "matrix" | "scanlines" | "melt" | "bugs" | "swarm";
export type PopupKind = "ram" | "raccoons" | "adopted";

export interface CursorOutcome {
  aborted: AbortReason | null;
  travel: number;
  ms: number;
}

export interface FxStarted {
  ms: number;
  tops: { id: number; x0: number; x1: number; y: number }[];
}

export const chaos2Api = {
  status: () => invoke<Chaos2Status>("chaos2_status"),
  /** Hook / orbit / jitter / hop the cursor. Resolves when it ends (or the user takes the mouse back). Rejects with a Blocked. */
  cursorAct: (act: CursorAct, rodX: number, rodY: number) => invoke<CursorOutcome>("chaos2_cursor_act", { act, rodX, rodY }),
  fxStart: (kind: FxKind) => invoke<FxStarted>("chaos2_fx_start", { kind }),
  fxSquash: (x: number, y: number) => invoke<void>("chaos2_fx_squash", { x, y }),
  fxIdle: () => invoke<void>("chaos2_fx_idle"),
  /** The effects overlay is loaded and listening. */
  fxReady: () => invoke<void>("chaos2_fx_ready"),
  popup: (kind: PopupKind) => invoke<void>("chaos2_popup", { kind }),
  popupClose: () => invoke<void>("chaos2_popup_close"),
  dance: (id: number, kind: DanceKind) => invoke<{ aborted: AbortReason | null; ms: number }>("chaos2_dance", { id, kind }),
  yoink: () => invoke<{ id: number; frame: ScreenRect; deadline_ms: number }>("chaos2_yoink"),
  yoinkedCount: () => invoke<number>("chaos2_yoinked_count"),
  abort: () => invoke<void>("chaos2_abort"),
  /** Settings: stop everything now (and put minimised windows back). */
  stop: () => invoke<void>("chaos2_stop"),
  /** Settings: one harmless sample (a popup and a little cursor trail). */
  test: () => invoke<void>("chaos2_test"),
};

// ------------------------------------------------------------------- play
// Games, play and growth (src-tauri/src/play.rs, crates/glitch-core/src/play.rs
// and belly.rs). "pet-changed" (PetView) fires when his mood/XP/wardrobe
// changes, "pet-levelup" (LevelUp) on a new level, "belly-changed" when the
// eaten-files list changes.

export interface PlaySettings {
  fetch: boolean;
  hide_seek: boolean;
  /** Off by default. */
  feeding: boolean;
  mood: boolean;
  growth: boolean;
  levels: boolean;
  /** Ask before each meal (false = "don't ask again"). */
  feed_confirm: boolean;
  belly_dir: string | null;
  hat: string | null;
  eye: string;
  seasonal: boolean;
}

export const PLAY_DEFAULTS: PlaySettings = {
  fetch: true,
  hide_seek: true,
  feeding: false,
  mood: true,
  growth: true,
  levels: true,
  feed_confirm: true,
  belly_dir: null,
  hat: null,
  eye: "magenta",
  seasonal: true,
};

export type PetMood = "bored" | "content" | "happy";

export interface UnlockInfo {
  id: string;
  kind: "hat" | "eye";
  /** 0 = seasonal only. */
  level: number;
  unlocked: boolean;
}

export interface PetView {
  energy: number;
  mood: PetMood;
  mood_on: boolean;
  level: number;
  xp: number;
  level_xp: number;
  next_level_xp: number | null;
  /** 0-1: thrown around a lot yesterday. */
  suspicion: number;
  chubby: boolean;
  /** What he wears now. */
  hat: string | null;
  eye: string;
  season_hat: string | null;
  levels_on: boolean;
  unlocks: UnlockInfo[];
}

export interface LevelUp {
  level: number;
  unlocked: string[];
}

export type PetEventKind = "fetch" | "found" | "gave_up" | "pet" | "thrown";

export interface EatenFile {
  id: number;
  name: string;
  original: string;
  stored: string;
  size: number;
  eaten: string;
}

export interface FeedResult {
  eaten: string[];
  refused: string[];
  declined: boolean;
}

export type PlayPatch = Partial<Omit<PlaySettings, "belly_dir" | "hat">> & { hat?: string };

export const playApi = {
  pet: () => invoke<PetView>("pet_state"),
  event: (kind: PetEventKind) => invoke<PetView>("pet_event", { kind }),
  /** hat "" = no hat. */
  updateSettings: (patch: PlayPatch) => invoke<Settings>("update_play_settings", { patch }),
  /** Bring up the invisible play overlay the fetch ball is drawn on. */
  ballOpen: () => invoke<boolean>("ball_open"),
  /** The ball's picture for the overlay; centre/radius in physical px (where the mouse can grab it). */
  ballFrame: (frame: { x: number; y: number; r: number; pic: unknown }) => invoke<void>("ball_frame", { frame }),
  /** The ball pops away and the overlay goes. */
  ballClose: () => invoke<void>("ball_close"),
  /** Once a day: hello by name + a question about a project (null = the usual greeting). */
  greeting: () => invoke<string | null>("growth_greeting"),
  belly: () => invoke<{ dir: string | null; items: EatenFile[] }>("belly_list"),
  restore: (id: number) => invoke<string>("belly_restore", { id }),
  chooseBelly: () => invoke<string | null>("belly_choose_folder"),
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
