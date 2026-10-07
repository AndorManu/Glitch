// The panel window: setup wizard and settings. (Chat lives in the bubble.)

import { listen } from "@tauri-apps/api/event";
import { api, asUiError, type PanelView, type Settings, type SetupStatus, type VoiceDownloadEvent } from "../shared/ipc";
import { drawAvatar } from "./avatar";
import { h } from "./dom";
import { renderMemory } from "./memory";
import { formatGb, layout, ollamaSummary, prettyModelName, SetupView, sameModel } from "./setup";
import { loading, toggleSwitch } from "./ui";
import { onVoiceDownload, renderVoice } from "./voice";

type View = PanelView;

const views: Record<View, HTMLElement> = {
  setup: document.getElementById("setup")!,
  settings: document.getElementById("settings")!,
};
const subtitles: Record<View, string> = {
  setup: "Let’s get me ready",
  settings: "Settings",
};
const settingsButton = document.getElementById("settings-button") as HTMLButtonElement;
const subtitle = document.getElementById("subtitle")!;
let current: View = "setup";

function showView(v: View): void {
  current = v;
  for (const [name, el] of Object.entries(views)) el.hidden = name !== v;
  settingsButton.hidden = v === "settings";
  subtitle.textContent = subtitles[v];
  if (v === "setup") void setup.refresh();
  if (v === "settings") void renderSettings();
}

const setup = new SetupView(views.setup, {
  done: () => void api.finishSetup(),
});

settingsButton.addEventListener("click", () => showView("settings"));

function card(title: string, ...children: (Node | null)[]): HTMLElement {
  return h("section", { class: "card" }, h("h3", { class: "card-title" }, title), ...children);
}

async function renderSettings(): Promise<void> {
  const root = views.settings;
  layout(root, [loading("Loading…")]);
  let status: SetupStatus;
  try {
    status = await api.setupStatus();
  } catch (e) {
    layout(
      root,
      [h("div", { class: "callout error", role: "alert" }, h("b", {}, "Couldn’t load the settings."), h("span", {}, asUiError(e).message))],
      [h("button", { class: "primary", type: "button", onclick: () => void renderSettings() }, "Try again")],
    );
    return;
  }
  const s = status.settings;

  const select = h("select", { "aria-label": "Brain (AI model)" });
  const names = status.installed.map((m) => m.name);
  if (s.model && !names.some((n) => sameModel(n, s.model!))) names.unshift(s.model);
  for (const n of names) {
    const info = status.installed.find((m) => m.name === n);
    const label = info
      ? `${prettyModelName(n)} (${formatGb(info.size_gb)})${info.supports_tools === false ? " – chat only" : ""}`
      : `${prettyModelName(n)} (not downloaded)`;
    select.append(h("option", { value: n, selected: !!s.model && sameModel(n, s.model) }, label));
  }
  const toolWarning = h(
    "p",
    { class: "callout warn", hidden: true },
    "This brain can chat, but it can’t open apps or websites for you.",
  );
  const updateWarning = () => {
    toolWarning.hidden = status.installed.find((m) => m.name === select.value)?.supports_tools !== false;
  };
  updateWarning();
  select.addEventListener("change", async () => {
    updateWarning();
    await api.updateSettings({ model: select.value });
  });

  const ollama = ollamaSummary(status);
  const memoryBody = h("div", { class: "memory" });
  void renderMemory(memoryBody);
  const voiceBody = h("div", { class: "voice" });
  void renderVoice(voiceBody);

  layout(
    root,
    [
      card(
        "Brain",
        names.length
          ? h("label", { class: "select" }, select)
          : h("p", { class: "hint" }, "No brains downloaded yet."),
        toolWarning,
        h("button", { class: "link", type: "button", onclick: () => showView("setup") }, "Download another brain…"),
      ),
      card(
        "Glitch",
        toggleSwitch("Let Glitch walk around", "Off: Glitch stays where you put it.", s.movement_enabled, (on) =>
          void api.updateSettings({ movement_enabled: on }),
        ),
        h(
          "div",
          { class: "row" },
          h("button", { class: "secondary small", type: "button", onclick: async () => { await api.resetChat(); await api.showBubble(); } }, "Clear chat"),
          h("button", { class: "secondary small", type: "button", onclick: () => showView("setup") }, "Run setup again"),
        ),
      ),
      card("Voice", voiceBody),
      card("Memory", memoryBody),
      h("p", { class: `info ${ollama.state}` }, h("span", { class: "dot", "aria-hidden": "true" }), h("span", {}, ollama.text)),
    ],
    [
      s.onboarding_done
        ? h("button", { class: "primary", type: "button", onclick: () => void api.showBubble() }, "Back to chat")
        : null,
      h("span", { class: "spacer" }),
      h("button", { class: "danger", type: "button", onclick: () => void api.quit() }, "Quit Glitch"),
    ],
  );
}

async function main(): Promise<void> {
  void drawAvatar(document.getElementById("avatar") as HTMLCanvasElement, 48);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") void api.hidePanel();
  });
  await listen<PanelView>("panel-view", (e) => showView(e.payload));
  await listen<Settings>("settings-changed", () => {
    if (current === "settings") void renderSettings();
  });
  await listen<VoiceDownloadEvent>("voice-download", (e) => onVoiceDownload(e.payload));
  await listen("memory-changed", () => {
    const body = views.settings.querySelector<HTMLElement>(".memory");
    if (current === "settings" && body) void renderMemory(body);
  });
  // Coming back from the browser/installer: re-check setup automatically.
  window.addEventListener("focus", () => {
    if (current === "setup") setup.refreshIfWaiting();
  });
  showView(await api.panelView().catch((): View => "setup"));
}

void main();
