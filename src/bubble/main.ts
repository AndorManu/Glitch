// The chat bubble window: a little speech bubble that pops up above Glitch.
//
// Idle cost: nothing runs while nobody is chatting. The only animations are
// the entrance (once per show), the typewriter (about a second per reply)
// and the thought cloud (only while the model is working, paused when the
// window is hidden).

import { listen } from "@tauri-apps/api/event";
import { api, asUiError, type BubbleLayout } from "../shared/ipc";
import { initialState, transition, type BubbleEvent, type Request } from "./state";
import { BubbleView } from "./view";

const root = document.getElementById("root")!;
let state = initialState();

const view = new BubbleView(root, {
  send: (text) => dispatch({ type: "send", text }),
  answer: (approved) => dispatch({ type: "answer", approved }),
  hide: () => hide(),
  openSettings: () => void api.showPanel("settings").catch(() => {}),
  openSetup: () => void api.showPanel("setup").catch(() => {}),
  seen: () => dispatch({ type: "seen" }),
});

function dispatch(e: BubbleEvent): void {
  const prev = state;
  const t = transition(state, e);
  state = t.state;
  if (state !== prev) view.render(state);
  if (t.request) {
    if (t.request.kind === "send") view.clearInput();
    void perform(t.request);
  }
}

async function perform(r: Request): Promise<void> {
  try {
    const step = r.kind === "send" ? await api.sendMessage(r.text) : await api.confirmAction(r.id, r.approved);
    dispatch({ type: "step", step });
  } catch (e) {
    dispatch({ type: "failed", error: asUiError(e) });
  }
  if (visible) view.focus();
}

// ------------------------------------------------------- show / hide

let visible = false;
let hiddenAt: number | null = null;

function onShown(): void {
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
  view.leave();
}

function hide(): void {
  onHidden();
  void api.hideBubble().catch(() => {});
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !e.isComposing) {
    e.preventDefault();
    hide();
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
void listen("bubble-hidden", () => onHidden());

// --------------------------------------------------------------- go

view.render(state);
if (!document.hidden) onShown();
