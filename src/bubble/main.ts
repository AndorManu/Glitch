// The chat bubble window: a little speech bubble that pops up above Glitch.
//
// Idle cost: nothing runs while nobody is chatting. The only animations are
// the entrance (once per show), the typewriter (about a second per reply)
// and the thought cloud (only while the model is working, paused when the
// window is hidden).

import { listen } from "@tauri-apps/api/event";
import {
  api,
  asUiError,
  CHAT_CLEARED_EVENT,
  voiceApi,
  type BubbleLayout,
  type Settings,
  type VoiceDownloadEvent,
  type VoiceEvent,
  type VoiceStatus,
} from "../shared/ipc";
import { canSend, dismissSpeech, initialState, transition, type BubbleEvent, type Request } from "./state";
import { BubbleView } from "./view";
import {
  explainDownloadError,
  initialMic,
  micActive,
  micTitle,
  micTransition,
  readyText,
  speakable,
  type MicEvent,
  type Os,
  type VoiceSay,
} from "./voice";

const root = document.getElementById("root")!;
let state = initialState();

const view = new BubbleView(root, {
  send: (text) => dispatch({ type: "send", text }),
  answer: (approved) => dispatch({ type: "answer", approved }),
  hide: () => hide(),
  openSettings: () => void api.showPanel("settings").catch(() => {}),
  openSetup: () => void api.showPanel("setup").catch(() => {}),
  seen: () => dispatch({ type: "seen" }),
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
});

function dispatch(e: BubbleEvent): void {
  const prev = state;
  const t = transition(state, e);
  state = t.state;
  if (state !== prev) view.render(state);
  if (t.request) {
    if (t.request.kind === "send") view.clearInput();
    stopSpeaking();
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

// Reading replies aloud (optional, off by default): the system's own voice
// via the webview, short replies only, silenced by any new input.
function speakReply(text: string): void {
  const synth = "speechSynthesis" in window ? window.speechSynthesis : null;
  const words = speakable(text);
  if (!speakReplies || !synth || !words || !visible) return;
  try {
    synth.cancel();
    synth.speak(new SpeechSynthesisUtterance(words));
  } catch {
    // No voices installed: stay quiet.
  }
}

function stopSpeaking(): void {
  try {
    if ("speechSynthesis" in window && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel();
  } catch {
    // ignore
  }
}

void listen<VoiceEvent>("voice", (e) => micDispatch({ type: "voice", event: e.payload }));
void listen<VoiceDownloadEvent>("voice-download", (e) => onDownload(e.payload));
void listen<Settings>("settings-changed", () => refreshVoice());

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
  }
  view.focus();
}

function onHidden(): void {
  if (!visible) return;
  visible = false;
  hiddenAt = Date.now();
  // Closing the chat stops listening and talking.
  micDispatch({ type: "cancel" });
  stopSpeaking();
  view.leave();
}

function hide(): void {
  if (hideTimer) return;
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
