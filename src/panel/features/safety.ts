// Settings → Features → Safety: the panic button ("Hide Glitch / Pause
// everything", with its global hotkey) and "Start with Windows". The rules
// live in Rust (crates/glitch-core/src/safety.rs, src-tauri/src/pause.rs);
// this card shows them and lets the user change the hotkey.

import { listen } from "@tauri-apps/api/event";
import { asUiError, safetyApi, type SafetyStatus, type Settings } from "../../shared/ipc";
import { clear, h } from "../dom";
import { toggleSwitch } from "../ui";
import type { Feature } from "./index";

export const PAUSE_HINT =
  "Hides Glitch and stops everything at once: no chaos, no app control, no listening, no reactions. Anything he is holding is let go. Stays on, even after a restart, until you switch it off here, from the tray icon or with the shortcut.";

export const AUTOSTART_HINT = "Opens Glitch when you sign in to Windows. Off by default. Turning it off removes the entry again.";

/** The key names the Rust side accepts (crates/glitch-core/src/safety.rs `key_name`). */
const NAMED: Record<string, string> = {
  Space: "Space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Insert: "Insert",
  Delete: "Delete",
};

export interface KeyLike {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/**
 * The shortcut a key press makes, as the Rust side writes it
 * ("Ctrl+Alt+Shift+G"), or null while only modifiers are held or for a key
 * that can't be a hotkey. Unit-tested.
 */
export function chordFromKey(e: KeyLike): string | null {
  let key: string | null = null;
  const letter = /^Key([A-Z])$/.exec(e.code);
  const digit = /^Digit([0-9])$/.exec(e.code);
  const fn = /^F([1-9]|1[0-9]|2[0-4])$/.exec(e.code);
  if (letter) key = letter[1];
  else if (digit) key = digit[1];
  else if (fn) key = `F${fn[1]}`;
  else if (NAMED[e.code]) key = NAMED[e.code];
  if (!key) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Super");
  parts.push(key);
  return parts.join("+");
}

export interface Line {
  text: string;
  tone: "ok" | "muted" | "error";
}

/** The line under the hotkey field. Unit-tested. */
export function hotkeyLine(hk: SafetyStatus["hotkey"]): Line {
  if (hk.registered) return { text: `Active: ${hk.combo}. Works in every app.`, tone: "ok" };
  return { text: `${hk.combo} isn't active${hk.error ? `: ${hk.error}` : ""}. Pick another shortcut; the tray icon still works.`, tone: "error" };
}

/** The line under "Start with Windows". Unit-tested. */
export function autostartLine(s: SafetyStatus): Line | null {
  if (!s.autostart_supported) return { text: "Only available on Windows for now.", tone: "muted" };
  if (s.autostart_error) return { text: `Couldn't read the startup entry: ${s.autostart_error}`, tone: "error" };
  if (s.start_with_windows && !s.autostart_active) return { text: "Switched on, but the startup entry is missing. It is written again the next time Glitch starts.", tone: "muted" };
  return null;
}

let current: HTMLElement | null = null;
let listening = false;

function line(l: Line | null, extra = ""): HTMLElement | null {
  return l ? h("p", { class: `feature-line ${l.tone}${extra}`, role: l.tone === "error" ? "alert" : "status" }, l.text) : null;
}

async function render(root: HTMLElement): Promise<void> {
  current = root;
  if (!listening) {
    listening = true;
    // The tray icon and the hotkey change it too.
    void listen("pause-changed", () => {
      if (current?.isConnected) void render(current);
    });
  }
  let st: SafetyStatus;
  try {
    st = await safetyApi.status();
  } catch (e) {
    root.replaceChildren(h("p", { class: "hint" }, `Couldn’t load the safety settings: ${asUiError(e).message}`));
    return;
  }
  if (root !== current) return;

  const note = h("p", { class: "feature-line error", role: "alert", hidden: true });
  const fail = (e: unknown) => {
    note.textContent = asUiError(e).message;
    note.hidden = false;
  };
  const redraw = () => void render(root);

  // The hotkey field: focus it and press the combination.
  const input = h("input", {
    type: "text",
    class: "text-input",
    readonly: true,
    value: st.hotkey.combo,
    "aria-label": "Panic shortcut. Focus this field and press the new combination.",
    spellcheck: "false",
    autocomplete: "off",
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Tab") return; // keep keyboard navigation working
    e.preventDefault();
    if (e.key === "Escape") return void input.blur();
    const combo = chordFromKey(e);
    if (!combo) {
      if (!["Control", "Alt", "Shift", "Meta"].includes(e.key)) {
        note.textContent = "That key can't be part of the shortcut. Use a letter, a number, F1 to F24 or an arrow key.";
        note.hidden = false;
      }
      return;
    }
    note.hidden = true;
    void safetyApi.setHotkey(combo).then(redraw, (err) => {
      fail(err);
      input.value = st.hotkey.combo;
    });
  });
  const reset = h("button", { class: "secondary small", type: "button" }, "Reset to default");
  reset.addEventListener("click", () => {
    note.hidden = true;
    void safetyApi.setHotkey(st.default_hotkey).then(redraw, fail);
  });
  reset.disabled = st.hotkey.combo === st.default_hotkey && st.hotkey.registered;

  const pauseNow = h("button", { class: st.paused ? "primary small" : "secondary small", type: "button" }, st.paused ? "Show Glitch" : "Hide Glitch now");
  pauseNow.addEventListener("click", () => void safetyApi.setPaused(!st.paused).then(redraw, fail));

  clear(
    root,
    h("p", { class: "voice-label feature-sub" }, "Panic button"),
    h("p", { class: "hint" }, PAUSE_HINT),
    h("div", { class: "row" }, pauseNow, h("span", { class: "spacer" })),
    line(
      st.paused
        ? { text: "Paused: Glitch is hidden and everything is off.", tone: "error" }
        : { text: "Glitch is active.", tone: "muted" },
    ),
    h("label", { class: "voice-field" }, h("span", { class: "voice-label" }, "Panic shortcut"), input),
    h("div", { class: "row" }, reset, h("span", { class: "spacer" })),
    line(hotkeyLine(st.hotkey)),
    note,
    toggleSwitch("Start with Windows", AUTOSTART_HINT, st.start_with_windows, (on) => {
      note.hidden = true;
      void safetyApi.setAutostart(on).then(redraw, (err) => {
        fail(err);
        redraw();
      });
    }),
    line(autostartLine(st)),
  );
  // Not switchable where it isn't implemented.
  if (!st.autostart_supported) root.querySelector<HTMLInputElement>('input[role="switch"]')?.setAttribute("disabled", "");
}

function renderFeature(_s: Settings): HTMLElement {
  const root = h("div", { class: "safety-feature" });
  void render(root);
  return root;
}

export const safetyFeature: Feature = { id: "safety", render: renderFeature };
