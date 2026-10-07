// Settings → Voice: push-to-talk on/off, the speech model, language and
// reading replies aloud.

import { asUiError, voiceApi, type VoiceDownloadEvent, type VoiceStatus } from "../shared/ipc";
import { h } from "./dom";
import { progressBar, toggleSwitch, type ProgressBar } from "./ui";

/** "Base · 142 MB ✓" (✓ = downloaded). Unit-tested. */
export function speechModelLabel(m: VoiceStatus["models"][number]): string {
  return `${m.label} · ${m.size_mb} MB${m.downloaded ? " ✓" : ""}`;
}

/** What to say about the shortcut. Unit-tested. */
export function hotkeyText(st: Pick<VoiceStatus, "hotkey" | "os">): { text: string; warn: boolean } {
  const anywhere = st.os === "macos" ? "anywhere on your Mac" : "anywhere";
  if (st.hotkey.registered) return { text: `Or hold ${st.hotkey.label} ${anywhere}: Glitch opens and listens until you let go.`, warn: false };
  return { text: `${st.hotkey.label} is already used by another app, so use the mic button in the chat.`, warn: true };
}

export function unavailableText(reason: VoiceStatus["unavailable_reason"]): string {
  return reason === "cpu"
    ? "This computer's processor is too old for the speech model, so voice is off. Typing works as always."
    : "Voice isn't available on this system yet. Typing works as always.";
}

let live: { model: string; bar: ProgressBar; text: HTMLElement } | null = null;
let rerender: (() => void) | null = null;

/** Panel main forwards "voice-download" events here. */
export function onVoiceDownload(e: VoiceDownloadEvent): void {
  if (e.state === "running" && live && live.model === e.model) {
    const pct = e.total > 0 ? Math.round((e.done / e.total) * 100) : null;
    live.bar.set(pct);
    live.text.textContent = pct === null ? "Downloading…" : `Downloading… ${pct}%`;
    return;
  }
  if (e.state !== "running" || !live) rerender?.();
}

/** Fills `root` (a settings card body) and re-renders itself after changes. */
export async function renderVoice(root: HTMLElement): Promise<void> {
  let st: VoiceStatus;
  try {
    st = await voiceApi.status();
  } catch (e) {
    root.replaceChildren(h("p", { class: "hint" }, `Couldn’t load voice settings: ${asUiError(e).message}`));
    return;
  }
  rerender = () => void renderVoice(root);
  live = null;
  const update = (patch: Parameters<typeof voiceApi.updateSettings>[0]) =>
    void voiceApi.updateSettings(patch).then(rerender ?? undefined, () => rerender?.());

  if (!st.available) {
    root.replaceChildren(h("p", { class: "hint" }, unavailableText(st.unavailable_reason)));
    return;
  }

  const parts: (Node | null)[] = [
    toggleSwitch("Talk to Glitch", "Hold the mic button in the chat while you talk. Nothing listens until you do.", st.enabled, (on) =>
      update({ enabled: on }),
    ),
  ];
  if (!st.enabled) {
    root.replaceChildren(...parts.filter((p): p is Node => p !== null));
    return;
  }
  const hk = hotkeyText(st);
  parts.push(h("p", { class: hk.warn ? "callout warn voice-hotkey" : "hint voice-hotkey" }, hk.text));

  // Speech model.
  const select = h("select", { "aria-label": "Speech model" });
  const rec = st.models.find((m) => m.id === st.recommended);
  select.append(h("option", { value: "auto", selected: st.model_auto }, `Automatic (${rec ? `${rec.label}, ${rec.size_mb} MB` : st.recommended})`));
  for (const m of st.models) {
    select.append(h("option", { value: m.id, selected: !st.model_auto && st.model === m.id }, speechModelLabel(m)));
  }
  select.addEventListener("change", () => update({ model: select.value }));
  const current = st.models.find((m) => m.id === st.model);
  const blurb = current ? h("p", { class: "hint voice-blurb" }, current.blurb) : null;

  // Download / delete row for the model in use.
  let modelRow: HTMLElement | null = null;
  if (current) {
    const downloading = st.download?.model === current.id ? st.download : null;
    if (downloading) {
      const bar = progressBar();
      const pct = downloading.total ? Math.round((downloading.done / downloading.total) * 100) : null;
      bar.set(pct);
      const text = h("span", { class: "hint" }, pct === null ? "Downloading…" : `Downloading… ${pct}%`);
      live = { model: current.id, bar, text };
      modelRow = h(
        "div",
        { class: "voice-model" },
        bar.el,
        h("div", { class: "voice-model-line" }, text, h("button", { class: "secondary small", type: "button", onclick: () => void voiceApi.cancelDownload() }, "Cancel")),
      );
    } else if (current.downloaded) {
      const del = h("button", { class: "secondary small danger-text", type: "button" }, "Delete");
      del.addEventListener("click", async () => {
        del.disabled = true;
        await voiceApi.deleteModel(current.id).catch(() => {});
        rerender?.();
      });
      modelRow = h("div", { class: "voice-model-line" }, h("span", { class: "hint" }, `✓ ${current.label} is downloaded (${current.size_mb} MB).`), del);
    } else {
      const get = h("button", { class: "secondary small", type: "button" }, `Download now (${current.size_mb} MB)`);
      const msg = h("span", { class: "hint" }, "Not downloaded yet. It downloads the first time you talk.");
      get.addEventListener("click", async () => {
        get.disabled = true;
        try {
          await voiceApi.downloadModel(current.id);
        } catch (e) {
          const err = asUiError(e);
          if (err.code !== "download_cancelled") {
            msg.textContent = `Download failed: ${err.message}`;
            msg.className = "hint voice-error";
          }
          get.disabled = false;
        }
      });
      modelRow = h("div", { class: "voice-model-line stack" }, msg, get);
    }
  }
  // Other downloaded models can be deleted too (they take disk space).
  const others = st.models.filter((m) => m.downloaded && m.id !== st.model);
  const otherRows = others.map((m) => {
    const del = h("button", { class: "secondary small danger-text", type: "button" }, "Delete");
    del.addEventListener("click", async () => {
      del.disabled = true;
      await voiceApi.deleteModel(m.id).catch(() => {});
      rerender?.();
    });
    return h("div", { class: "voice-model-line" }, h("span", { class: "hint" }, `${m.label} (${m.size_mb} MB) is also downloaded.`), del);
  });

  // Language.
  const lang = h("select", { "aria-label": "Language you speak" });
  for (const l of st.languages) lang.append(h("option", { value: l.code, selected: l.code === st.language }, l.label));
  lang.addEventListener("change", () => update({ language: lang.value }));

  parts.push(
    h("div", { class: "voice-field" }, h("span", { class: "voice-label" }, "Speech model"), h("label", { class: "select" }, select)),
    blurb,
    modelRow,
    ...otherRows,
    h("div", { class: "voice-field" }, h("span", { class: "voice-label" }, "I speak"), h("label", { class: "select" }, lang)),
    h("div", { class: "voice-gap" }),
    toggleSwitch("Read replies aloud", "Short replies only, with your computer’s own voice.", st.speak_replies, (on) => update({ speak_replies: on })),
  );
  root.replaceChildren(...parts.filter((p): p is Node => p !== null));
}
