// The chat panel window: setup wizard, chat and settings.

import { listen } from "@tauri-apps/api/event";
import { api, asUiError, type Settings, type SetupStatus } from "../shared/ipc";
import { GLITCH } from "../sprites/glitch";
import { loadSprites } from "../sprites/load";
import { ChatView } from "./chat";
import { clear, h } from "./dom";
import { SetupView, sameModel } from "./setup";

type View = "setup" | "chat" | "settings";

const views: Record<View, HTMLElement> = {
  setup: document.getElementById("setup")!,
  chat: document.getElementById("chat")!,
  settings: document.getElementById("settings")!,
};
const settingsButton = document.getElementById("settings-button") as HTMLButtonElement;
let current: View = "chat";

function showView(v: View): void {
  current = v;
  for (const [name, el] of Object.entries(views)) el.hidden = name !== v;
  settingsButton.textContent = v === "settings" ? "Back" : "Settings";
  if (v === "setup") void setup.refresh();
  if (v === "settings") void renderSettings();
  if (v === "chat") chat.focus();
}

const setup = new SetupView(views.setup, {
  done: () => showView("chat"),
});
const chat = new ChatView(views.chat, () => showView("setup"));

settingsButton.addEventListener("click", () => showView(current === "settings" ? "chat" : "settings"));

async function renderSettings(): Promise<void> {
  const root = views.settings;
  clear(root, h("p", { class: "muted" }, "Loading…"));
  let status: SetupStatus;
  try {
    status = await api.setupStatus();
  } catch (e) {
    clear(root, h("p", { class: "error" }, asUiError(e).message));
    return;
  }
  const s = status.settings;

  const select = h("select", { "aria-label": "Model" });
  const names = status.installed.map((m) => m.name);
  if (s.model && !names.some((n) => sameModel(n, s.model!))) names.unshift(s.model);
  for (const n of names) {
    const info = status.installed.find((m) => m.name === n);
    const label = info ? `${n} (${info.size_gb} GB)${info.supports_tools === false ? " – no tools" : ""}` : `${n} (not downloaded)`;
    select.append(h("option", { value: n, selected: !!s.model && sameModel(n, s.model) }, label));
  }
  const toolWarning = h("p", { class: "note", hidden: true }, "This model can chat but can't open things for you.");
  const updateWarning = () => {
    toolWarning.hidden = status.installed.find((m) => m.name === select.value)?.supports_tools !== false;
  };
  updateWarning();
  select.addEventListener("change", async () => {
    updateWarning();
    await api.updateSettings({ model: select.value });
  });

  const move = h("input", { type: "checkbox", checked: s.movement_enabled });
  move.addEventListener("change", () => void api.updateSettings({ movement_enabled: move.checked }));

  const ollamaLine =
    status.ollama.state === "running"
      ? `Ollama ${status.ollama.version ?? ""} is running.`
      : status.ollama.state === "stopped"
        ? "Ollama is installed but not running."
        : "Ollama is not installed.";

  clear(
    root,
    h("h2", {}, "Settings"),
    h("label", { class: "field" }, h("span", {}, "Brain (AI model)"), names.length ? select : h("span", { class: "muted" }, "No models downloaded yet")),
    toolWarning,
    h("button", { onclick: () => showView("setup") }, "Download a different model…"),
    h("label", { class: "toggle" }, move, h("span", {}, "Let Glitch walk around the screen")),
    h("p", { class: "muted small" }, `${ollamaLine} This computer has ${status.recommendation.total_ram_gb} GB of memory.`),
    h(
      "div",
      { class: "row" },
      h("button", { onclick: async () => { await api.resetChat(); chat.reset(); showView("chat"); } }, "Clear chat"),
      h("button", { onclick: () => showView("setup") }, "Run setup again"),
    ),
    h("div", { class: "row" }, h("button", { class: "danger", onclick: () => void api.quit() }, "Quit Glitch")),
  );
}

async function drawAvatar(): Promise<void> {
  const sprites = await loadSprites(GLITCH);
  const c = document.getElementById("avatar") as HTMLCanvasElement;
  const dpr = window.devicePixelRatio || 1;
  c.width = c.height = 32 * dpr;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sprites.frame("idle0"), 0, 0, c.width, c.height);
}

async function main(): Promise<void> {
  void drawAvatar();
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") void api.hidePanel();
  });
  await listen<boolean>("panel-visibility", (e) => {
    if (e.payload && current === "chat") chat.focus();
  });
  await listen<Settings>("settings-changed", () => {
    if (current === "settings") void renderSettings();
  });
  // Coming back from the browser/installer: re-check setup automatically.
  window.addEventListener("focus", () => {
    if (current === "setup") setup.refreshIfWaiting();
  });
  let settings: Settings | null = null;
  try {
    settings = await api.getSettings();
  } catch (e) {
    console.error(e);
  }
  showView(settings?.onboarding_done && settings.model ? "chat" : "setup");
}

void main();
