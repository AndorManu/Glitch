// The chat bubble window: a little speech bubble that pops up above Glitch.
//
// Idle cost: nothing runs while nobody is chatting. The only animations are
// the entrance (once per show), the typewriter (about a second per reply)
// and the thought cloud (only while the model is working, paused when the
// window is hidden).

import { emit, listen } from "@tauri-apps/api/event";
import {
  api,
  asUiError,
  CHAT_CLEARED_EVENT,
  MASCOT_TALK_EVENT,
  playApi,
  voiceApi,
  type AgentProgress,
  type BubbleLayout,
  type Reminder,
  type Settings,
  type VoiceDownloadEvent,
  type VoiceEvent,
  type VoiceStatus,
  type WakeStatus,
  updateApi,
  type UpdateAvailable,
  type UpdateStatus,
} from "../shared/ipc";
import { browserStore, pickGreeting } from "../shared/greeting";
import { canSend, dismissSpeech, initialState, transition, type BubbleEvent, type Request } from "./state";
import { UpdateMe } from "./update-me";
import { BubbleView } from "./view";
import {
  explainDownloadError,
  initialMic,
  micActive,
  micTitle,
  micTransition,
  readyText,
  speakable,
  useGlitchVoice,
  type MicEvent,
  type Os,
  type VoiceSay,
} from "./voice";

const root = document.getElementById("root")!;
let state = initialState(pickGreeting(browserStore()));

const view = new BubbleView(root, {
  send: (text) => dispatch({ type: "send", text }),
  answer: (approved) => dispatch({ type: "answer", approved }),
  hide: () => hide(),
  openSettings: () => void api.showPanel("settings").catch(() => {}),
  openSetup: () => void api.showPanel("setup").catch(() => {}),
  seen: () => dispatch({ type: "seen" }),
  // The mascot window moves his mouth while the reply appears (see MASCOT_TALK_EVENT).
  talk: (chars, opened) => {
    if (opened) void emit("mascot-action", "point").catch(() => {});
    void emit(MASCOT_TALK_EVENT, chars).catch(() => {});
  },
  micDown: () => micDispatch({ type: "press", at: performance.now() }),
  micUp: () => micDispatch({ type: "release", at: performance.now() }),
  voiceDownload: () => void voiceApi.downloadModel(setupModel()).catch(() => {}),
  voiceDismiss: () => {
    void voiceApi.offerSeen().catch(() => {});
    state = dismissSpeech(state);
    view.render(state);
  },
  voiceCancelDownload: () => void voiceApi.cancelDownload().catch(() => {}),
  openMicSettings: () => void voiceApi.openMicSettings().catch(() => {}),
  updateInstall: () => {
    dispatch({ type: "update_state", installing: true, failed: null });
    // On success Glitch restarts; on failure the status event (or this) says why.
    void updateApi.install().catch((e) => dispatch({ type: "update_state", installing: false, failed: asUiError(e).message }));
  },
  updateLater: () => {
    void updateApi.later().catch(() => {});
    state = dismissSpeech(state);
    view.render(state);
  },
  choose: (id, choice) => void updates.choose(id, choice),
});

// "Update me": reminders, Claude Code, scripts, the digest, the briefing.
const updates = new UpdateMe({ dispatch: (e) => dispatch(e), busy: () => state.busy });
updates.listen();

// A new version of Glitch (src-tauri/src/autoupdate.rs): he offers it here.
void listen<UpdateAvailable>("update-available", (e) => dispatch({ type: "update_offer", version: e.payload.version }));
void listen<UpdateStatus>("update-status", (e) =>
  dispatch({ type: "update_state", installing: e.payload.installing, failed: e.payload.installing ? null : e.payload.error }),
);
// Found before this window existed (or while it was hidden).
void updateApi.status().then(
  (st) => {
    if (st?.offer && st.available) dispatch({ type: "update_offer", version: st.available.version });
  },
  () => {},
);

function dispatch(e: BubbleEvent): void {
  const prev = state;
  const t = transition(state, e);
  state = t.state;
  if (state !== prev) view.render(state);
  // A timer that rang while Glitch was busy speaks up once he's done.
  if (!state.busy && pendingReminders.length) {
    const text = pendingReminders.shift()!;
    queueMicrotask(() => dispatch({ type: "reminder", text }));
  }
  if (t.request) {
    if (t.request.kind === "send") view.clearInput();
    stopSpeaking();
    // His own voice loads while the model thinks (~0.5 s saved).
    if (speakReplies && useGlitchVoice(readAloudVoice, ttsInstalled)) void voiceApi.ttsPrepare().catch(() => {});
    void perform(t.request);
  }
}

/** Bumped by "Clear chat": answers to requests from before it are dropped. */
let epoch = 0;

async function perform(r: Request): Promise<void> {
  const mine = epoch;
  try {
    const step = r.kind === "send" ? await api.sendMessage(r.text) : await api.confirmAction(r.id, r.approved);
    if (mine !== epoch) return;
    dispatch({ type: "step", step });
    if (step.type === "reply") speakReply(step.text);
  } catch (e) {
    if (mine !== epoch) return;
    dispatch({ type: "failed", error: asUiError(e) });
  }
  view.setEcho(null);
  if (visible) view.focus();
}

// Live progress while Glitch works: steps, "looking at your screen", and
// the reply streaming in.
void listen<AgentProgress>("agent-progress", (e) => dispatch({ type: "progress", p: e.payload }));

/** Timers that rang while Glitch was busy (shown right after). */
const pendingReminders: string[] = [];
void listen<Reminder>("reminder", (e) => {
  if (state.busy) pendingReminders.push(e.payload.message);
  else dispatch({ type: "reminder", text: e.payload.message });
  if (e.payload.ambient) armAmbientHide(e.payload.message.length);
});

// A nudge he made up himself (late night, focus suggestion...) must not leave the chat open for good:
// while it is open Glitch stands still. Hide it after a reading time unless you answered or are typing.
const AMBIENT_BASE_MS = 12_000;
let ambientTimer: ReturnType<typeof setTimeout> | null = null;
let touched = false;
for (const ev of ["pointerdown", "keydown", "pointerenter"]) {
  document.addEventListener(ev, () => (touched = true), { capture: true });
}
function armAmbientHide(chars: number): void {
  if (ambientTimer) clearTimeout(ambientTimer);
  touched = false;
  ambientTimer = setTimeout(() => {
    ambientTimer = null;
    if (visible && !touched && !state.busy) hide();
  }, Math.min(30_000, AMBIENT_BASE_MS + chars * 60));
}

// Keep the model loaded while the chat is open, so answers start at once.
const WARM_EVERY_MS = 4 * 60_000;
let warmTimer: ReturnType<typeof setInterval> | null = null;
function keepWarm(on: boolean): void {
  if (warmTimer) clearInterval(warmTimer);
  warmTimer = null;
  if (on) {
    void api.warmModel().catch(() => {});
    warmTimer = setInterval(() => void api.warmModel().catch(() => {}), WARM_EVERY_MS);
  } else {
    void api.coolModel().catch(() => {});
  }
}

void listen(CHAT_CLEARED_EVENT, () => {
  epoch++;
  micDispatch({ type: "cancel" });
  stopSpeaking();
  view.setEcho(null);
  view.clearInput();
  dispatch({ type: "cleared" });
});

// ------------------------------------------------------------- voice
// Push-to-talk. The recording itself happens in Rust; this mirrors its
// state on the mic button and sends the transcript like a typed message.

let mic = initialMic();
let os: Os = "windows";
let hotkey: string | null = null;
let speakReplies = false;
let readAloudVoice: "system" | "glitch" = "system";
let ttsInstalled = false;
/** A voice start that Rust never confirmed (e.g. voice got disabled). */
let startTimer: ReturnType<typeof setTimeout> | null = null;

function micDispatch(e: MicEvent): void {
  if (e.type === "press" && !micActive(mic)) stopSpeaking();
  const t = micTransition(mic, e, os);
  mic = t.state;
  view.renderMic(mic, micTitle(hotkey));
  if (startTimer && mic.phase !== "starting") {
    clearTimeout(startTimer);
    startTimer = null;
  }
  switch (t.command) {
    case "start":
      void voiceApi.start("hold").catch(() => micDispatch({ type: "cancel" }));
      startTimer = setTimeout(() => {
        startTimer = null;
        if (mic.phase === "starting") micDispatch({ type: "cancel" });
      }, 2500);
      break;
    case "stop":
      void voiceApi.stop().catch(() => {});
      break;
    case "hands_free":
      void voiceApi.handsFree().catch(() => {});
      break;
    case "cancel":
      void voiceApi.cancel().catch(() => {});
      break;
  }
  if (t.heard) heard(t.heard);
  if (t.say) say(t.say);
}

/** A transcript: send it exactly like a typed message. */
function heard(text: string): void {
  if (canSend(state, text) && !view.input.value.trim()) {
    view.setEcho(text);
    dispatch({ type: "send", text });
  } else {
    // Busy, or something half-typed: don't lose either, let the user decide.
    view.setInput(view.input.value.trim() ? `${view.input.value.trim()} ${text}` : text);
  }
}

function setupModel(): string | undefined {
  return state.speech?.kind === "voice_setup" ? state.speech.model : undefined;
}

function say(s: VoiceSay): void {
  if (s.kind === "setup") {
    void voiceApi.offerSeen().catch(() => {});
    dispatch({ type: "voice_setup", model: s.model.id, sizeMb: s.model.sizeMb });
  } else {
    dispatch({ type: "notice", text: s.text, tone: s.kind, action: s.kind === "error" ? s.action : null });
  }
}

function onDownload(d: VoiceDownloadEvent): void {
  const percent = d.total > 0 ? Math.min(100, (d.done / d.total) * 100) : null;
  dispatch({
    type: "voice_download",
    state: d.state,
    percent,
    failed: d.error ? explainDownloadError(d.error.code) : null,
    ready: readyText(hotkey),
  });
}

function applyStatus(st: VoiceStatus | null): void {
  if (!st) return micDispatch({ type: "config", usable: false });
  os = st.os;
  hotkey = st.hotkey.registered ? st.hotkey.label : null;
  speakReplies = st.speak_replies;
  readAloudVoice = st.read_aloud_voice ?? "system";
  ttsInstalled = !!st.tts?.installed;
  view.setArmed(!!st.wake?.armed);
  micDispatch({ type: "config", usable: st.available && st.enabled });
  if (st.phase === "listening" && !micActive(mic)) micDispatch({ type: "voice", event: { phase: "listening", level: 0, hands_free: false } });
  if (st.offer_pending) {
    const m = st.models.find((x) => x.id === st.model);
    if (m) say({ kind: "setup", model: { id: m.id, label: m.label, sizeMb: m.size_mb } });
  }
}

function refreshVoice(): void {
  voiceApi.status().then(applyStatus, () => micDispatch({ type: "config", usable: false }));
}

// Reading replies aloud (optional, off by default), short replies only,
// silenced by any new input: Glitch's own voice if it's chosen and
// downloaded (played by Rust, mouth moving), else the system's voice via
// the webview.
function speakReply(text: string): void {
  const words = speakable(text);
  if (!speakReplies || !words || !visible) return;
  if (useGlitchVoice(readAloudVoice, ttsInstalled)) {
    voiceApi.ttsSpeak(words).catch(() => systemSpeak(words));
    return;
  }
  systemSpeak(words);
}

function systemSpeak(words: string): void {
  const synth = "speechSynthesis" in window ? window.speechSynthesis : null;
  if (!synth) return;
  try {
    synth.cancel();
    const u = new SpeechSynthesisUtterance(words);
    // The wake word plugs its ears while he talks (he'd hear himself).
    u.onstart = () => void voiceApi.speaking(true).catch(() => {});
    u.onend = u.onerror = () => void voiceApi.speaking(false).catch(() => {});
    synth.speak(u);
  } catch {
    // No voices installed: stay quiet.
  }
}

function stopSpeaking(): void {
  if (useGlitchVoice(readAloudVoice, ttsInstalled)) void voiceApi.ttsStop().catch(() => {});
  try {
    if ("speechSynthesis" in window && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel();
  } catch {
    // ignore
  }
}

void listen<VoiceEvent>("voice", (e) => micDispatch({ type: "voice", event: e.payload }));
void listen<VoiceDownloadEvent>("voice-download", (e) => onDownload(e.payload));
void listen<Settings>("settings-changed", () => refreshVoice());
// "Hey Glitch" armed / disarmed: the bubble shows it while the mic is open.
void listen<WakeStatus>("wake", (e) => view.setArmed(e.payload.armed));
void listen("tts-download", () => refreshVoice());

// ------------------------------------------------------- show / hide

let visible = false;
let hiddenAt: number | null = null;
/** Esc / ×: the window hides once the close animation has played. */
let hideTimer: ReturnType<typeof setTimeout> | null = null;
const CLOSE_MS = 160;

function onShown(): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (!visible) {
    visible = true;
    const awayMs = hiddenAt === null ? null : Date.now() - hiddenAt;
    hiddenAt = null;
    dispatch({ type: "shown", awayMs });
    view.enter();
    keepWarm(true);
    void onOpened();
  }
  view.focus();
}

/**
 * Personality growth: the first time the chat opens each day he may say
 * hello by name and ask about one of your projects (Rust decides, at most
 * once a day; null = keep the usual greeting). Never over a conversation.
 */
async function personalHello(): Promise<boolean> {
  if (state.busy || (state.speech && state.speech.kind !== "reply")) return false;
  const text = await playApi.greeting().catch(() => null);
  if (!text || state.busy) return false;
  dispatch({ type: "step", step: { type: "reply", text, actions: [] } });
  return true;
}

/**
 * The chat opened: something he missed first, else the day's hello by name,
 * else the briefing (it waits for the next opening when the hello took the
 * slot, so the two never fight over the one speech bubble).
 */
async function onOpened(): Promise<void> {
  if (await updates.showPending()) return;
  if (await personalHello()) return;
  await updates.showBriefing();
}

function onHidden(): void {
  if (!visible) return;
  visible = false;
  hiddenAt = Date.now();
  keepWarm(false);
  // Closing the chat stops listening and talking.
  micDispatch({ type: "cancel" });
  stopSpeaking();
  view.leave();
}

function hide(): void {
  if (hideTimer) return;
  // With a close animation: call bubbleClosing() when it starts and
  // hideBubble() when it ends (Rust ignores the hide if Glitch was clicked
  // meanwhile and the bubble reopened; "bubble-shown" fires then).
  void api.bubbleClosing().catch(() => {});
  onHidden();
  const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  hideTimer = setTimeout(
    () => {
      hideTimer = null;
      void api.hideBubble().catch(() => {});
    },
    calm ? 0 : CLOSE_MS,
  );
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !e.isComposing) {
    e.preventDefault();
    // First Esc stops listening; the next one closes the bubble.
    if (micActive(mic)) micDispatch({ type: "cancel" });
    else hide();
  }
});
document.addEventListener("visibilitychange", () => (document.hidden ? onHidden() : onShown()));

// ------------------------------------------------------ window size

function applyLayout(l: BubbleLayout | null): void {
  if (l) view.setLayout(l);
}

let sentHeight = 0;
new ResizeObserver(() => {
  // offsetHeight ignores the entrance transform.
  const height = root.offsetHeight;
  if (height === sentHeight) return;
  sentHeight = height;
  api.resizeBubble(height).then(applyLayout, () => {});
}).observe(root);

void listen<BubbleLayout>("bubble-layout", (e) => applyLayout(e.payload));
void listen("bubble-shown", () => onShown());
// Rust tells us about hides too (not every webview fires visibilitychange).
// One that beats our close timer (e.g. Glitch clicked mid-close) makes the
// timer moot: drop it, so it can't later hide a bubble reopened meanwhile.
void listen("bubble-hidden", () => {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  onHidden();
});

// --------------------------------------------------------------- go

view.render(state);
view.renderMic(mic, micTitle(hotkey));
refreshVoice();
if (!document.hidden) onShown();
