// Settings → Features: "Games, play and growth". One switch per feature
// (fetch, hide and seek, feeding, mood, personality growth, levels), the
// belly folder + "ask before eating" and the list of eaten files with
// "Put back". Everything is saved through update_play_settings (the panel
// is the only window allowed to change these, see src-tauri/src/play.rs).

import { listen } from "@tauri-apps/api/event";
import { asUiError, type EatenFile, PLAY_DEFAULTS, playApi, type PlayPatch, type PlaySettings, type Settings } from "../../shared/ipc";
import { clear, h } from "../dom";
import { busyButton, toggleSwitch } from "../ui";
import type { Feature } from "./index";

/** The play block with defaults for anything missing (older builds). */
export function playSettingsOf(s: Pick<Settings, "play">): PlaySettings {
  return { ...PLAY_DEFAULTS, ...(s.play ?? {}) };
}

type BoolKey = "fetch" | "hide_seek" | "feeding" | "mood" | "growth" | "levels";

/** The feature switches, in the order shown. */
export const PLAY_SWITCHES: readonly { key: BoolKey; label: string; hint: string }[] = [
  { key: "fetch", label: "Fetch", hint: "Tray “Play fetch” or say “let's play”: flick the glowing ball, he brings it back." },
  { key: "hide_seek", label: "Hide and seek", hint: "Tray or “hide and seek”: he hides behind an edge. Point at him to find him." },
  { key: "mood", label: "Mood & energy", hint: "Hearts and stars when you pet him (hover). Bored: a bit more mischief. Happy: more dances. Never sad or needy." },
  { key: "growth", label: "Personality growth", hint: "Greets you by name and asks about your projects, at most once a day. Uses his memory (needs Memory on)." },
  { key: "levels", label: "Levels & wardrobe", hint: "Playing and chatting earn XP: hats and eye colours to unlock (Wardrobe below)." },
  { key: "feeding", label: "Feed him files", hint: "Drag a file onto him and he eats it: it is MOVED into his belly folder, never deleted. Off by default." },
];

/** "12 KB", "3.4 MB". */
export function fileSize(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${Math.round(n / (1 << 10))} KB`;
  return `${n} bytes`;
}

// One live card at a time (the settings page redraws itself); events update it.
let redraw: (() => void) | null = null;
let listening = false;
function listenOnce(): void {
  if (listening) return;
  listening = true;
  void listen("belly-changed", () => redraw?.()).catch(() => {});
}

function render(s: Settings): HTMLElement {
  const cfg = playSettingsOf(s);
  const root = h("div", { class: "play-feature" });
  const note = h("p", { class: "callout warn", role: "status", hidden: true });
  const save = async (patch: PlayPatch): Promise<void> => {
    note.hidden = true;
    try {
      Object.assign(cfg, playSettingsOf(await playApi.updateSettings(patch)));
    } catch (e) {
      note.textContent = asUiError(e).message;
      note.hidden = false;
    }
    draw();
  };
  const belly = h("div", { class: "belly" });
  const drawBelly = async (): Promise<void> => {
    if (!cfg.feeding) return clear(belly);
    let list: { dir: string | null; items: EatenFile[] };
    try {
      list = await playApi.belly();
    } catch {
      return clear(belly);
    }
    const status = h("p", { class: "hint", role: "status" });
    const rows = list.items
      .slice()
      .reverse()
      .map((e) =>
        h(
          "li",
          {},
          h("span", {}, h("b", {}, e.name), " ", h("span", { class: "hint" }, `${fileSize(e.size)} · ${e.eaten}`), h("br", {}), h("span", { class: "hint" }, `from ${e.original}`)),
          busyButton("Put back", "Putting back…", async () => {
            try {
              const to = await playApi.restore(e.id);
              status.textContent = `${e.name} is back: ${to}`;
            } catch (err) {
              status.textContent = asUiError(err).message;
            }
            await drawBelly();
          }),
        ),
      );
    clear(
      belly,
      h("p", { class: "hint" }, ...(list.dir ? ["Belly folder: ", h("code", {}, list.dir)] : ["He'll ask for a belly folder the first time you feed him."])),
      h("div", { class: "row" }, busyButton(list.dir ? "Change folder…" : "Choose folder…", "Choosing…", async () => {
        await playApi.chooseBelly();
        await drawBelly();
      })),
      toggleSwitch("Ask before eating", "Off: he eats whatever you drop on him (you ticked “don't ask again”).", cfg.feed_confirm, (on) => void save({ feed_confirm: on })),
      rows.length ? h("ul", { class: "memory-list", "aria-label": "Eaten files" }, ...rows) : h("p", { class: "hint" }, "His belly is empty."),
      status,
    );
  };
  const draw = (): void => {
    clear(
      root,
      ...PLAY_SWITCHES.map((sw) => toggleSwitch(sw.label, sw.hint, cfg[sw.key], (on) => void save({ [sw.key]: on }))),
      belly,
      note,
    );
    void drawBelly();
  };
  redraw = () => void drawBelly();
  listenOnce();
  draw();
  return root;
}

export const playFeature: Feature = { id: "play", render };
