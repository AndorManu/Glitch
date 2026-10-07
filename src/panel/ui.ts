// Small building blocks shared by the setup wizard and the settings view.

import type { Settings } from "../shared/ipc";
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

/**
 * The settings the settings page draws itself (memory and voice cards keep
 * themselves up to date). Two equal keys: no need to redraw. Unit-tested.
 */
export function settingsKey(s: Pick<Settings, "model" | "movement_enabled" | "onboarding_done">): string {
  return JSON.stringify([s.model ?? null, !!s.movement_enabled, !!s.onboarding_done]);
}

/**
 * A secondary button that runs `run`, showing `busyLabel` and staying
 * disabled until it settles (so slow commands can't be double-clicked).
 */
export function busyButton(label: string, busyLabel: string, run: () => Promise<unknown>): HTMLButtonElement {
  const b = h("button", { class: "secondary small", type: "button" }, label);
  b.addEventListener("click", async () => {
    if (b.disabled) return;
    b.disabled = true;
    b.setAttribute("aria-busy", "true");
    b.textContent = busyLabel;
    try {
      await run();
    } catch {
      // The command reports its own errors; the button just recovers.
    } finally {
      b.disabled = false;
      b.removeAttribute("aria-busy");
      b.textContent = label;
    }
  });
  return b;
}

/** Play the view's entrance (once per switch, not on every redraw). */
export function enterView(el: HTMLElement): void {
  el.classList.remove("entering");
  void el.offsetWidth; // restart the animation
  el.classList.add("entering");
  el.addEventListener("animationend", (e) => e.target === el && el.classList.remove("entering"), { once: true });
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
