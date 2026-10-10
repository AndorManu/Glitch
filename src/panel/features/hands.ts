// "Let Glitch control apps" (crates/glitch-core/src/hands): multi-step
// tasks in other apps ("open Spotify and play my first playlist"), off by
// default, plus an optional bigger brain used only for those tasks.

import { api, type InstalledModel, type Settings } from "../../shared/ipc";
import { h } from "../dom";
import { prettyModelName } from "../setup";
import { toggleSwitch } from "../ui";
import type { Feature } from "./index";

export const HANDS_HINT =
  "For things like “open Spotify and play my first playlist”. He asks before he controls an app, shows a banner while he works, and stops the moment you press Esc or touch your mouse. Never password fields, banking, password managers or terminals.";

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

  const save = (patch: { hands_enabled?: boolean; hands_model?: string }): void => {
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
  draw();
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
