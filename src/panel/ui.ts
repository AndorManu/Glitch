// Small building blocks shared by the setup wizard and the settings view.

import { h } from "./dom";

/** "1 Ollama — 2 Brain" step indicator. `current` is 1 or 2. */
export function stepper(current: 1 | 2): HTMLElement {
  const step = (n: 1 | 2, label: string) =>
    h(
      "li",
      { class: n < current ? "step done" : n === current ? "step current" : "step", "aria-current": n === current ? "step" : undefined },
      h("span", { class: "step-num", "aria-hidden": "true" }, n < current ? "✓" : String(n)),
      h("span", { class: "step-label" }, label),
    );
  return h(
    "ol",
    { class: "stepper", "aria-label": `Step ${current} of 2` },
    step(1, "Get Ollama"),
    h("li", { class: "step-line", "aria-hidden": "true" }),
    step(2, "Pick a brain"),
  );
}

export function badge(text: string, kind: "accent" | "ok" | "plain" = "plain"): HTMLElement {
  return h("span", { class: `badge ${kind}` }, text);
}

export function spinner(): HTMLElement {
  return h("span", { class: "spinner", "aria-hidden": "true" });
}

/** A "please wait" line with a spinner. */
export function loading(text: string): HTMLElement {
  return h("p", { class: "loading", role: "status" }, spinner(), h("span", {}, text));
}

export interface ProgressBar {
  el: HTMLElement;
  /** A number 0–100, or null for "busy, amount unknown". */
  set(percent: number | null): void;
}

export function progressBar(): ProgressBar {
  const fill = h("div", { class: "bar-fill" });
  const el = h(
    "div",
    { class: "bar indeterminate", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-label": "Download progress" },
    fill,
  );
  return {
    el,
    set(percent) {
      el.classList.toggle("indeterminate", percent === null);
      if (percent === null) {
        el.removeAttribute("aria-valuenow");
        fill.style.width = "";
      } else {
        el.setAttribute("aria-valuenow", String(percent));
        fill.style.width = `${percent}%`;
      }
    },
  };
}

/** An on/off switch: a real checkbox styled as a switch, with a label and optional hint. */
export function toggleSwitch(label: string, hint: string, checked: boolean, onChange: (on: boolean) => void): HTMLElement {
  const input = h("input", { type: "checkbox", role: "switch", checked });
  input.addEventListener("change", () => onChange(input.checked));
  return h(
    "label",
    { class: "switch-row" },
    h("span", { class: "switch-text" }, h("span", { class: "switch-label" }, label), hint ? h("span", { class: "hint" }, hint) : null),
    input,
    h("span", { class: "switch", "aria-hidden": "true" }),
  );
}
