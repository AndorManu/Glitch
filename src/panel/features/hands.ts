// "Let Glitch control apps" (crates/glitch-core/src/hands): multi-step
// tasks in other apps ("open Spotify and play my first playlist"), off by
// default, plus an optional bigger brain used only for those tasks.

import { api, type InstalledModel, type Settings, type UndoStatus } from "../../shared/ipc";
import { h } from "../dom";
import { prettyModelName } from "../setup";
import { toggleSwitch } from "../ui";
import type { Feature } from "./index";

export const HANDS_HINT =
  "For things like “open Spotify and play my first playlist”. He asks before he controls an app, shows a banner while he works, and stops the moment you press Esc or touch your mouse. Never password fields, banking, password managers or terminals.";

export const DESKTOP_HINT =
  "Lets him use your whole desktop like you would: look at a window with numbered boxes, move the mouse pointer, click, drag and drop, scroll, move and snap windows, and move or rename files in your own folders.";

/** The explanation card under the Desktop control switch: what he does, what he never does. Unit-tested. */
export const DESKTOP_CARD: { title: string; does: string[]; never: string[] } = {
  title: "What Desktop control does",
  does: [
    "Shows a ring and a little paw where he is about to click, then moves your real pointer there.",
    "Asks before every step the first time (you can pick Auto for one task).",
    "Moving files and windows can be undone with one button.",
    "Stops at once when you press Esc, touch your mouse or keyboard, use the panic hotkey, or pick Stop in the tray.",
  ],
  never: [
    "Close windows, delete or overwrite files, or touch anything outside your own folders.",
    "Touch password fields, banking, password managers, terminals, admin windows or anything with unsaved work.",
    "Send, buy, install, save or change system settings without a card showing the exact action.",
    "Type anything you did not say, or trust text he reads on the screen.",
  ],
};

export const BRAIN_HINT =
  "A bigger brain gets multi-step tasks right more often, but is slower to load. Only used for app tasks.";

/** The "Smarter brain" choices: the chat brain, then installed tool-capable models. Unit-tested. */
export function brainChoices(installed: InstalledModel[], current: string | null | undefined): { value: string; label: string }[] {
  const out = [{ value: "", label: "Same brain as chat" }];
  for (const m of installed) {
    if (m.supports_tools === false) continue;
    out.push({ value: m.name, label: `${prettyModelName(m.name)} (${m.size_gb.toFixed(1)} GB)` });
  }
  if (current && !out.some((o) => o.value === current)) out.push({ value: current, label: `${prettyModelName(current)} (not downloaded)` });
  return out;
}

function render(s: Settings): HTMLElement {
  const root = h("div", { class: "hands-feature" });
  let on = !!s.hands_enabled;
  let model = s.hands_model ?? "";
  let installed: InstalledModel[] = [];
  let desktop = !!s.hands_desktop_enabled;
  let undo: UndoStatus = { label: null, count: 0 };
  let undoMessage = "";

  const save = (patch: { hands_enabled?: boolean; hands_model?: string; hands_desktop_enabled?: boolean }): void => {
    void api.updateSettings(patch).catch(() => {});
  };

  const draw = (): void => {
    const select = h("select", { "aria-label": "Smarter brain for app control" });
    for (const c of brainChoices(installed, model)) select.append(h("option", { value: c.value, selected: c.value === model }, c.label));
    select.addEventListener("change", () => {
      model = select.value;
      save({ hands_model: model });
    });
    const parts: HTMLElement[] = [
      toggleSwitch("Let Glitch control apps", HANDS_HINT, on, (v) => {
        on = v;
        save({ hands_enabled: v });
        draw();
      }),
    ];
    if (on) {
      parts.push(
        toggleSwitch("Desktop control", DESKTOP_HINT, desktop, (v) => {
          desktop = v;
          save({ hands_desktop_enabled: v });
          draw();
        }),
      );
      if (desktop) parts.push(desktopCard());
      parts.push(undoRow());
      parts.push(
        h(
          "div",
          { class: "voice-field" },
          h("span", { class: "voice-label" }, "Smarter brain for app control"),
          h("label", { class: "select" }, select),
          h("span", { class: "hint" }, BRAIN_HINT),
        ),
      );
    }
    root.replaceChildren(...parts);
  };
  const desktopCard = (): HTMLElement =>
    h(
      "div",
      { class: "desktop-card", role: "note", "aria-label": DESKTOP_CARD.title },
      h("strong", {}, DESKTOP_CARD.title),
      h("ul", { class: "does" }, ...DESKTOP_CARD.does.map((t) => h("li", {}, t))),
      h("strong", {}, "What he never does"),
      h("ul", { class: "never" }, ...DESKTOP_CARD.never.map((t) => h("li", {}, t))),
    );

  const undoRow = (): HTMLElement => {
    const button = h("button", { type: "button", class: "secondary small", disabled: !undo.label }, "Undo last Glitch action");
    button.addEventListener("click", () => {
      api.undoLast().then(
        (said) => {
          undoMessage = said;
          refreshUndo();
        },
        (e: { message?: string }) => {
          undoMessage = e?.message ?? "Couldn't undo that.";
          refreshUndo();
        },
      );
    });
    const note = undo.label ? `${undo.label} (${undo.count} to undo)` : "Nothing to undo right now.";
    return h("div", { class: "voice-field undo-field" }, button, h("span", { class: "hint", role: "status" }, undoMessage || note));
  };

  const refreshUndo = (): void => {
    api.undoStatus().then(
      (u) => {
        undo = u;
        draw();
      },
      () => {},
    );
  };

  draw();
  refreshUndo();
  api
    .setupStatus()
    .then((st) => {
      installed = st.installed;
      draw();
    })
    .catch(() => {});
  return root;
}

export const handsFeature: Feature = { id: "hands", render };
