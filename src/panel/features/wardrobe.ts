// Settings → Wardrobe: his level and XP, the hats and glitch-eye colours
// he has unlocked (locked ones show the level they come at), and the
// seasonal hats switch. Only with "Levels & wardrobe" on.

import { listen } from "@tauri-apps/api/event";
import { asUiError, playApi, type PetView, type PlayPatch, type Settings } from "../../shared/ipc";
import { HAT_CELL, HAT_SPRITES } from "../../mascot/hats-data";
import { EYE_COLOURS } from "../../mascot/accessories";
import { clear, h } from "../dom";
import { progressBar, toggleSwitch } from "../ui";
import { playSettingsOf } from "./play";

export const HAT_LABELS: Record<string, string> = {
  party: "Party hat",
  wizard: "Wizard hat",
  cap: "Cap",
  pumpkin: "Pumpkin (Halloween)",
  santa: "Santa hat (December)",
  crown: "Crown",
  cowboy: "Cowboy hat",
  headphones: "Headphones",
};

/** "Level 3 · 40 / 160 XP to level 4". */
export function levelLine(v: Pick<PetView, "level" | "xp" | "level_xp" | "next_level_xp">): { text: string; percent: number } {
  if (v.next_level_xp === null) return { text: `Level ${v.level} · ${v.xp} XP (top level!)`, percent: 100 };
  const span = v.next_level_xp - v.level_xp;
  const got = v.xp - v.level_xp;
  return { text: `Level ${v.level} · ${got} / ${span} XP to level ${v.level + 1}`, percent: Math.max(0, Math.min(100, Math.floor((got / span) * 100))) };
}

let hatsImg: Promise<HTMLImageElement | null> | null = null;
function hats(): Promise<HTMLImageElement | null> {
  hatsImg ??= new Promise((done) => {
    const img = new Image();
    img.onload = () => done(img);
    img.onerror = () => done(null);
    img.src = "/sprites/hats.png";
  });
  return hatsImg;
}

function hatPreview(id: string): HTMLCanvasElement {
  const c = h("canvas", { width: HAT_CELL.w, height: HAT_CELL.h, class: "hat-preview", "aria-hidden": "true" });
  const spec = HAT_SPRITES[id];
  if (spec) {
    void hats().then((img) => {
      if (!img) return;
      const ctx = c.getContext("2d")!;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, spec.cell * HAT_CELL.w, 0, HAT_CELL.w, HAT_CELL.h, 0, 0, HAT_CELL.w, HAT_CELL.h);
    });
  }
  return c;
}

let redraw: (() => void) | null = null;
let listening = false;

export function renderWardrobe(s: Settings): HTMLElement {
  const cfg = playSettingsOf(s);
  const root = h("div", { class: "wardrobe" });
  const note = h("p", { class: "callout warn", role: "status", hidden: true });
  let view: PetView | null = null;
  const save = async (patch: PlayPatch): Promise<void> => {
    note.hidden = true;
    try {
      Object.assign(cfg, playSettingsOf(await playApi.updateSettings(patch)));
    } catch (e) {
      note.textContent = asUiError(e).message;
      note.hidden = false;
    }
    void load();
  };
  const draw = (): void => {
    if (!cfg.levels) {
      clear(root, h("p", { class: "hint" }, "Turn on “Levels & wardrobe” in Features to dress him up."));
      return;
    }
    if (!view) return clear(root, h("p", { class: "hint" }, "Loading…"));
    const v = view;
    const line = levelLine(v);
    const bar = progressBar();
    bar.el.setAttribute("aria-label", "XP to the next level");
    bar.set(line.percent);
    const unlocked = (id: string) => v.unlocks.some((u) => u.id === id && u.unlocked);
    const levelOf = (id: string) => v.unlocks.find((u) => u.id === id)?.level ?? 0;
    const hatChoice = (id: string | null) => {
      const ok = id === null || unlocked(id);
      const label = id === null ? "No hat" : HAT_LABELS[id] ?? id;
      const lock = id === null || ok ? "" : levelOf(id) ? `Level ${levelOf(id)}` : "In season";
      const input = h("input", { type: "radio", name: "hat", value: id ?? "", checked: (cfg.hat ?? null) === id, disabled: !ok });
      input.addEventListener("change", () => void save({ hat: id ?? "" }));
      return h(
        "label",
        { class: `wardrobe-item${ok ? "" : " locked"}`, title: lock ? `${label}: unlocks at ${lock.toLowerCase()}` : label },
        input,
        id ? hatPreview(id) : h("span", { class: "hat-none", "aria-hidden": "true" }, "∅"),
        h("span", { class: "wardrobe-name" }, label),
        lock ? h("span", { class: "badge plain" }, lock) : null,
      );
    };
    const eyeChoice = (id: string) => {
      const ok = unlocked(id);
      const input = h("input", { type: "radio", name: "eye", value: id, checked: cfg.eye === id, disabled: !ok });
      input.addEventListener("change", () => void save({ eye: id }));
      return h(
        "label",
        { class: `wardrobe-item eye${ok ? "" : " locked"}` },
        input,
        h("span", { class: "eye-swatch", style: `background:${EYE_COLOURS[id]}`, "aria-hidden": "true" }),
        h("span", { class: "wardrobe-name" }, id.charAt(0).toUpperCase() + id.slice(1)),
        ok ? null : h("span", { class: "badge plain" }, `Level ${levelOf(id)}`),
      );
    };
    const hatIds = ["cap", "party", "headphones", "cowboy", "wizard", "crown", "pumpkin", "santa"];
    clear(
      root,
      h("p", { class: "wardrobe-level" }, line.text),
      bar.el,
      v.mood_on ? h("p", { class: "hint" }, `Energy ${Math.round(v.energy)} / 100 · ${v.mood === "happy" ? "happy" : v.mood === "bored" ? "a bit bored, play with him!" : "content"}${v.chubby ? " · full belly" : ""}`) : null,
      h("fieldset", { class: "wardrobe-group" }, h("legend", {}, "Hat"), hatChoice(null), ...hatIds.map(hatChoice)),
      h("fieldset", { class: "wardrobe-group" }, h("legend", {}, "Glitch eye"), ...["magenta", "cyan", "green", "gold"].map(eyeChoice)),
      toggleSwitch("Seasonal hats", "A pumpkin around Halloween, a Santa hat in December (when he wears no other hat).", cfg.seasonal, (on) => void save({ seasonal: on })),
      note,
    );
  };
  const load = async (): Promise<void> => {
    try {
      view = await playApi.pet();
    } catch {
      view = null;
    }
    draw();
  };
  redraw = () => void load();
  if (!listening) {
    listening = true;
    void listen("pet-changed", () => redraw?.()).catch(() => {});
  }
  draw();
  void load();
  return root;
}
