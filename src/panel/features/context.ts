// "He reacts to what you're doing": the switches for each reaction
// (src-tauri/src/context.rs), the late-night window and focus mode.

import { CONTEXT_DEFAULTS, type ContextSettings, contextApi } from "../../shared/context";
import type { Settings } from "../../shared/ipc";
import { h } from "../dom";
import { toggleSwitch } from "../ui";
import type { Feature } from "./index";

/** The settings' context block with defaults for anything missing (old builds). */
export function contextSettings(s: Pick<Settings, "context">): ContextSettings {
  return { ...CONTEXT_DEFAULTS, ...(s.context ?? {}) };
}

type BoolKey = { [K in keyof ContextSettings]: ContextSettings[K] extends boolean ? K : never }[keyof ContextSettings];

/** The per-reaction switches, in the order shown. */
export const REACTION_SWITCHES: readonly { key: BoolKey; label: string; hint: string }[] = [
  { key: "music", label: "Dances to music", hint: "Now and then, while something plays (Spotify, YouTube, any player)." },
  { key: "coding", label: "Codes along", hint: "Tiny glasses and a keyboard when your editor or terminal is in front." },
  { key: "quiet_fullscreen", label: "Quiet during games", hint: "Fullscreen, presentations or a game launcher: he hides in a corner, no mischief, no pop-ups." },
  { key: "video", label: "Watches videos with you", hint: "Sits on top of the window playing a video." },
  { key: "late_night", label: "Late-night nudge", hint: "Yawns, and a gentle “go to sleep” at most once an hour." },
  { key: "morning", label: "Morning stretch", hint: "Once a day." },
  { key: "battery", label: "Battery worries", hint: "Below 15% and not charging, once per drop." },
  { key: "cpu", label: "Feels the heat", hint: "Fans himself when the computer works hard for a while." },
  { key: "focus", label: "Focus mode", hint: "Tray or chat (“focus for 25 minutes”): he guards quietly, then celebrates your break." },
  { key: "focus_suggest", label: "Suggest focus sessions", hint: "After a long coding stretch." },
];

function timeInput(label: string, value: string, onChange: (v: string) => void): HTMLElement {
  const input = h("input", { type: "time", value, "aria-label": label });
  input.addEventListener("change", () => {
    if (/^\d{2}:\d{2}$/.test(input.value)) onChange(input.value);
  });
  return h("label", { class: "voice-field" }, h("span", { class: "voice-label" }, label), input);
}

function render(s: Settings): HTMLElement {
  const cfg = contextSettings(s);
  const root = h("div", { class: "context-feature" });
  const save = async (): Promise<void> => {
    try {
      Object.assign(cfg, contextSettings(await contextApi.update(cfg)));
    } catch {
      // Keep what's shown; the next redraw shows what Rust has.
    }
    draw();
  };
  const set = <K extends keyof ContextSettings>(key: K, value: ContextSettings[K]): void => {
    cfg[key] = value;
    void save();
  };
  const draw = (): void => {
    const details = h(
      "div",
      { class: "context-details", hidden: !cfg.enabled },
      ...REACTION_SWITCHES.filter((r) => r.key !== "focus_suggest" || cfg.focus).map((r) =>
        toggleSwitch(r.label, r.hint, cfg[r.key], (on) => set(r.key, on)),
      ),
      cfg.late_night
        ? h(
            "div",
            { class: "row" },
            timeInput("Late night from", cfg.night_start, (v) => set("night_start", v)),
            timeInput("until", cfg.night_end, (v) => set("night_end", v)),
          )
        : null,
      cfg.focus
        ? h(
            "div",
            { class: "row" },
            h(
              "button",
              { class: "secondary small", type: "button", onclick: () => void contextApi.focus().catch(() => {}) },
              `Focus for ${cfg.focus_minutes} minutes`,
            ),
            h("button", { class: "secondary small", type: "button", onclick: () => void contextApi.focus(0).catch(() => {}) }, "Stop focus"),
          )
        : null,
    );
    root.replaceChildren(
      toggleSwitch(
        "He reacts to what you're doing",
        "Music, coding, games, videos, the time of day. He only peeks at which app is in front and what's playing, on this computer. Nothing is saved.",
        cfg.enabled,
        (on) => set("enabled", on),
      ),
      details,
    );
  };
  draw();
  return root;
}

export const contextFeature: Feature = { id: "context", render };
