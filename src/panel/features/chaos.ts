// Settings → Features → Chaos mode: Off / Gentle / Mischief / Full Virus, the
// one-time confirmation for Full Virus, "Reduce effects", a Test button and a
// Stop button. The rules (what each level does, every limit) live in Rust
// (crates/glitch-core/src/chaos2.rs, src-tauri/src/chaos2.rs); this card only
// picks the level and shows what it means.

import { api, asUiError, chaos2Api, type ChaosLevel, type Settings } from "../../shared/ipc";
import { clear, h } from "../dom";
import { toggleSwitch } from "../ui";
import type { Feature } from "./index";

export const LEVELS: readonly { id: ChaosLevel; label: string; blurb: string }[] = [
  { id: "off", label: "Off", blurb: "No mischief at all. Glitch just wanders." },
  {
    id: "gentle",
    label: "Gentle",
    blurb: "Harmless mischief: nudges your windows a little, plays with the cursor, leaves paw prints and notes. One act every minute or two. Never while you type or game.",
  },
  {
    id: "mischief",
    label: "Mischief",
    blurb:
      "Old-virus pranks, all fake: he fishes your cursor with a pixel line, shakes and slides windows, hides one in the taskbar for a few seconds (and always puts it back), shows little pixel popups and screen bugs. About one act every 90 to 180 seconds.",
  },
  {
    id: "full_virus",
    label: "Full Virus",
    blurb:
      "Everything in Mischief, more often (every 30 to 60 seconds), plus cursor hops, matrix rain, a melting screen and a swarm of mini Glitches. Still 100% fake and harmless.",
  },
];

export const CONFIRM_TITLE = "Switch on Full Virus?";
export const CONFIRM_TEXT =
  "Glitch will move your mouse pointer, shake your windows and show little pixel popups. It is all fake and harmless, he never clicks or types, and moving the mouse, pressing a mouse button or Esc stops him at once. Nothing is saved or sent anywhere. Try the Test button first if you like.";
export const SAFETY_LINE =
  "Always stops: moving the mouse, any mouse button, Esc, the panic shortcut or “Stop chaos” in the tray menu. Never near windows with unsaved work, during games, full screen, focus time, voice or app control.";

/** The level shown for these settings (the old switch off = Off). */
export function levelOf(s: Pick<Settings, "chaos_enabled" | "chaos_level">): ChaosLevel {
  if (s.chaos_enabled === false) return "off";
  return s.chaos_level ?? "gentle";
}

/** Does picking this level need the one-time confirmation first? */
export function needsConfirm(level: ChaosLevel, s: Pick<Settings, "chaos_full_confirmed">): boolean {
  return level === "full_virus" && !s.chaos_full_confirmed;
}

async function pick(level: ChaosLevel, s: Settings, confirmed: boolean): Promise<void> {
  await api.updateSettings({ chaos_level: level, ...(confirmed ? { chaos_full_confirmed: true } : {}) });
  s.chaos_level = level;
  s.chaos_enabled = level !== "off";
  if (confirmed) s.chaos_full_confirmed = true;
}

function render(s: Settings): HTMLElement {
  const root = h("div", { class: "chaos-feature" });
  const draw = (confirming = false, note = ""): void => {
    const cur = levelOf(s);
    const info = h("p", { class: "hint", id: "chaos-blurb" }, LEVELS.find((l) => l.id === cur)!.blurb);
    const group = h(
      "div",
      { class: "chaos-levels", role: "radiogroup", "aria-label": "Chaos mode level" },
      ...LEVELS.map((l) => {
        const b = h("button", { type: "button", class: `chaos-level${l.id === cur ? " on" : ""}`, role: "radio", "aria-checked": String(l.id === cur) }, l.label);
        b.addEventListener("click", () => {
          if (l.id === cur) return;
          if (needsConfirm(l.id, s)) return draw(true);
          void pick(l.id, s, false).then(() => draw(), (e) => draw(false, asUiError(e).message));
        });
        return b;
      }),
    );
    const test = h("button", { type: "button", class: "secondary small" }, "Test");
    test.title = "Shows one harmless sample: a pixel popup and a short ghost cursor trail";
    test.addEventListener("click", () => {
      void chaos2Api.test().then(
        () => draw(false, ""),
        (e) => draw(false, `Not now (${String(e).replace(/_/g, " ")}).`),
      );
    });
    const stop = h("button", { type: "button", class: "secondary small" }, "Stop");
    stop.title = "Stops everything chaos mode is doing and puts any window he minimised back";
    stop.addEventListener("click", () => void chaos2Api.stop().catch(() => {}));

    let dialog: HTMLElement | null = null;
    if (confirming) {
      const yes = h("button", { type: "button", class: "primary small" }, "Switch on Full Virus");
      const no = h("button", { type: "button", class: "secondary small" }, "Cancel");
      no.addEventListener("click", () => draw());
      yes.addEventListener("click", () => void pick("full_virus", s, true).then(() => draw(), (e) => draw(false, asUiError(e).message)));
      dialog = h(
        "div",
        { class: "chaos-confirm", role: "alertdialog", "aria-labelledby": "chaos-confirm-title", "aria-describedby": "chaos-confirm-text" },
        h("h4", { id: "chaos-confirm-title", class: "fx-title" }, CONFIRM_TITLE),
        h("p", { id: "chaos-confirm-text" }, CONFIRM_TEXT),
        h("div", { class: "row" }, test.cloneNode(true) as HTMLElement, no, yes),
      );
      (dialog.querySelector("button") as HTMLButtonElement).addEventListener("click", () => void chaos2Api.test().catch(() => {}));
      queueMicrotask(() => no.focus());
      dialog.addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key === "Escape") {
          e.stopPropagation();
          draw();
        }
      });
    }

    clear(
      root,
      h("h4", { class: "fx-title" }, "Chaos mode"),
      group,
      info,
      dialog,
      h("p", { class: "hint" }, SAFETY_LINE),
      toggleSwitch("Reduce effects", "No screen effects (rain, melting screen, scanlines, clones, ghost cursor). Off follows your system animation setting.", s.reduce_effects ?? false, (on) => {
        s.reduce_effects = on;
        void api.updateSettings({ reduce_effects: on }).catch(() => {});
      }),
      toggleSwitch("Also while the stream overlay is on", "Chaos mode pauses while the OBS stream overlay runs, unless you allow it here.", s.chaos_during_stream ?? false, (on) => {
        s.chaos_during_stream = on;
        void api.updateSettings({ chaos_during_stream: on }).catch(() => {});
      }),
      h("div", { class: "row" }, test, stop),
      note ? h("p", { class: "feature-line error", role: "status" }, note) : null,
    );
  };
  draw();
  return root;
}

export const chaosFeature: Feature = { id: "chaos", render };
