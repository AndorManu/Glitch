// First-run wizard: 1) make sure Ollama is installed and running,
// 2) pick + download a model that fits this computer, 3) done.
// Pure helpers at the top are unit-tested (panel.test.ts).

import { api, asUiError, type InstalledModel, type PullProgress, type SetupStatus } from "../shared/ipc";
import { clear, h, type Child } from "./dom";
import { badge, loading, progressBar, spinner, stepper } from "./ui";

export interface ModelOption {
  name: string;
  sizeGb: number;
  recommended: boolean;
  installed: boolean;
  supportsTools: boolean | null;
}

/** "qwen3.5:2b" and "qwen3.5:2b" match; "llama3.2" matches "llama3.2:latest". */
export function sameModel(a: string, b: string): boolean {
  const norm = (s: string) => (s.includes(":") ? s : `${s}:latest`).toLowerCase();
  return norm(a) === norm(b);
}

/** Recommended first, then the other suggestions, then installed models that can use tools. */
export function modelOptions(status: SetupStatus): ModelOption[] {
  const rec = status.recommendation;
  const findInstalled = (name: string): InstalledModel | undefined =>
    status.installed.find((m) => sameModel(m.name, name));
  const out: ModelOption[] = [rec.primary, ...rec.alternatives].map((m, i) => {
    const inst = findInstalled(m.name);
    return {
      name: m.name,
      sizeGb: inst?.size_gb ?? m.download_gb,
      recommended: i === 0,
      installed: !!inst,
      supportsTools: inst?.supports_tools ?? true,
    };
  });
  for (const m of status.installed) {
    if (m.supports_tools === false || out.some((o) => sameModel(o.name, m.name))) continue;
    out.push({ name: m.name, sizeGb: m.size_gb, recommended: false, installed: true, supportsTools: m.supports_tools });
  }
  return out;
}

/** Human text for a pull progress line, e.g. "Downloading… 42%". */
export function progressText(p: PullProgress): { label: string; percent: number | null } {
  if (p.total && p.completed !== null && p.status.startsWith("pulling") && p.status !== "pulling manifest") {
    const percent = Math.min(100, Math.floor((p.completed / p.total) * 100));
    return { label: `Downloading… ${percent}%`, percent };
  }
  const labels: Record<string, string> = {
    "pulling manifest": "Getting ready…",
    "verifying sha256 digest": "Checking the download…",
    "writing manifest": "Almost done…",
    "removing any unused layers": "Tidying up…",
    success: "Done!",
  };
  return { label: labels[p.status] ?? p.status, percent: null };
}

/**
 * A friendlier display name for an Ollama model tag:
 * "qwen3.5:4b" → "Qwen 3.5 · 4B", "llama3.2:latest" → "Llama 3.2", "mistral" → "Mistral".
 */
export function prettyModelName(name: string): string {
  const [base, tag = ""] = name.split(":");
  const m = /^([a-z]+)(\d[\d.]*)([a-z]*)$/i.exec(base);
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const family = m ? `${cap(m[1])} ${m[2]}${m[3]}` : cap(base);
  const size = /^(\d+(?:\.\d+)?)([bm])\b/i.exec(tag);
  return size ? `${family} · ${size[1]}${size[2].toUpperCase()}` : family;
}

/** "3.4" → "3.4 GB", rounded to one decimal. */
export function formatGb(gb: number): string {
  return `${Math.round(gb * 10) / 10} GB`;
}

/** The main button under the model list. */
export function chooseLabel(o: Pick<ModelOption, "installed" | "sizeGb">): string {
  return o.installed ? "Use this brain" : `Download & continue (≈${formatGb(o.sizeGb)})`;
}

/** One line about Ollama and this computer, for the bottom of the settings. */
export function ollamaSummary(status: SetupStatus): { state: SetupStatus["ollama"]["state"]; text: string } {
  const o = status.ollama;
  const head =
    o.state === "running"
      ? `Ollama${o.version ? ` ${o.version}` : ""} is running`
      : o.state === "stopped"
        ? "Ollama is installed but not running"
        : "Ollama is not installed";
  return { state: o.state, text: `${head} · ${status.recommendation.total_ram_gb} GB of memory` };
}

// --------------------------------------------------------------- the view

export interface SetupCallbacks {
  /** Called when a model is ready and saved; switch to the chat. */
  done(model: string): void;
}

/** A view is a scrolling body plus an action bar pinned to the bottom. */
export function layout(root: HTMLElement, body: Child[], foot: Child[] = []): void {
  const hasFoot = foot.some(Boolean);
  clear(root, h("div", { class: "scroll" }, ...body), hasFoot ? h("div", { class: "foot" }, ...foot) : null);
}

export class SetupView {
  private status: SetupStatus | null = null;
  private busy = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly cb: SetupCallbacks,
  ) {}

  async refresh(): Promise<void> {
    if (this.busy) return;
    layout(this.root, [loading("Checking your computer…")]);
    try {
      this.status = await api.setupStatus();
    } catch (e) {
      layout(
        this.root,
        [
          h(
            "div",
            { class: "callout error", role: "alert" },
            h("b", {}, "Hmm, something went wrong."),
            h("span", {}, asUiError(e).message),
          ),
        ],
        [h("button", { class: "primary", type: "button", onclick: () => void this.refresh() }, "Try again")],
      );
      return;
    }
    this.render();
  }

  /** Re-check only while waiting for Ollama (don't reset a model choice in progress). */
  refreshIfWaiting(): void {
    if (!this.status || this.status.ollama.state !== "running") void this.refresh();
  }

  private render(): void {
    const s = this.status!;
    if (s.ollama.state !== "running") return this.renderOllama(s);
    this.renderModels(s);
  }

  private renderOllama(s: SetupStatus): void {
    const intro = h(
      "p",
      { class: "lead" },
      "I think with a free app called ",
      h("b", {}, "Ollama"),
      ". It runs right here on your computer, so our chats stay private.",
    );
    if (s.ollama.state === "missing") {
      layout(
        this.root,
        [
          stepper(1),
          h("h2", {}, "Install Ollama"),
          intro,
          h(
            "ol",
            { class: "howto" },
            h("li", {}, "Click ", h("b", {}, "Download Ollama"), " to open its download page."),
            h(
              "li",
              {},
              s.os === "macos"
                ? "Open the downloaded file, drag Ollama into Applications, then open it once."
                : "Run the installer you downloaded (no admin rights needed).",
            ),
            h("li", {}, "Come back here and click ", h("b", {}, "I’ve installed it"), "."),
          ),
        ],
        [
          h("button", { class: "primary grow", type: "button", onclick: () => void api.openOllamaDownload() }, "Download Ollama"),
          h("button", { class: "secondary grow", type: "button", onclick: () => void this.refresh() }, "I’ve installed it"),
        ],
      );
      return;
    }
    const status = h("p", { class: "status", role: "status" });
    const setStatus = (text: string, kind: "busy" | "error" | "" = "") => {
      status.className = `status ${kind}`;
      clear(status, kind === "busy" ? spinner() : null, text ? h("span", {}, text) : null);
    };
    const start = h("button", { class: "primary grow", type: "button" }, "Start Ollama");
    const check = h("button", { class: "secondary grow", type: "button", onclick: () => void this.refresh() }, "Check again");
    start.addEventListener("click", async () => {
      start.disabled = check.disabled = true;
      setStatus("Starting Ollama…", "busy");
      try {
        await api.startOllama();
      } catch (e) {
        setStatus(
          `Couldn't start it: ${asUiError(e).message}. Try opening Ollama from your ${s.os === "macos" ? "Applications folder" : "Start menu"}.`,
          "error",
        );
        start.disabled = check.disabled = false;
        return;
      }
      // Ollama takes a few seconds to come up.
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const st = await api.setupStatus().catch(() => null);
        if (st?.ollama.state === "running") {
          this.status = st;
          return this.render();
        }
      }
      setStatus("Ollama is taking a while. Wait a moment, then click “Check again”.");
      start.disabled = check.disabled = false;
    });
    layout(
      this.root,
      [
        stepper(1),
        h("h2", {}, "Wake up Ollama"),
        intro,
        h("p", { class: "callout" }, "Ollama is installed, but it isn’t running right now. I can start it for you."),
        status,
      ],
      [start, check],
    );
  }

  private renderModels(s: SetupStatus): void {
    const rec = s.recommendation;
    const options = modelOptions(s);
    let selected = options.find((o) => s.settings.model && sameModel(o.name, s.settings.model)) ?? options[0];

    const list = h("div", { class: "options", role: "radiogroup", "aria-label": "Brains" });
    const cards: { o: ModelOption; label: HTMLElement; input: HTMLInputElement }[] = [];
    const select = (o: ModelOption) => {
      selected = o;
      for (const c of cards) c.label.classList.toggle("selected", c.o === o);
      updateButton();
    };
    for (const o of options) {
      const input = h("input", { type: "radio", name: "model", value: o.name, checked: o === selected });
      input.addEventListener("change", () => select(o));
      const label = h(
        "label",
        { class: o === selected ? "option selected" : "option" },
        input,
        h("span", { class: "radio", "aria-hidden": "true" }),
        h(
          "span",
          { class: "option-body" },
          h(
            "span",
            { class: "option-top" },
            h("span", { class: "name" }, prettyModelName(o.name)),
            o.recommended ? badge("Best fit", "accent") : null,
            o.installed ? badge("Downloaded", "ok") : null,
          ),
          h("span", { class: "option-sub" }, h("code", {}, o.name), " · ", o.installed ? `${formatGb(o.sizeGb)} on disk` : `≈${formatGb(o.sizeGb)} download`),
        ),
      );
      cards.push({ o, label, input });
      list.append(label);
    }

    const go = h("button", { class: "primary wide", type: "button" });
    const bar = progressBar();
    const progressLabel = h("span", { class: "progress-label" });
    const progress = h("div", { class: "progress", hidden: true }, progressLabel, bar.el);
    const status = h("p", { class: "status error", role: "alert", hidden: true });
    const updateButton = () => {
      go.textContent = chooseLabel(selected);
    };
    updateButton();

    const setBusy = (busy: boolean) => {
      go.disabled = busy;
      list.classList.toggle("locked", busy);
      for (const c of cards) c.input.disabled = busy;
    };

    go.addEventListener("click", async () => {
      const choice = selected;
      this.busy = true;
      setBusy(true);
      if (!choice.installed) go.textContent = "Downloading…";
      status.hidden = true;
      try {
        if (!choice.installed) {
          progress.hidden = false;
          progressLabel.textContent = "Getting ready…";
          bar.set(null);
          await api.pullModel(choice.name, (p) => {
            const t = progressText(p);
            progressLabel.textContent = t.label;
            bar.set(t.percent);
          });
        }
        await api.updateSettings({ model: choice.name, onboarding_done: true });
        this.cb.done(choice.name);
      } catch (e) {
        const err = asUiError(e);
        progress.hidden = true;
        status.hidden = false;
        status.textContent =
          err.code === "ollama_unreachable"
            ? "Lost contact with Ollama. Is it still running?"
            : `Download failed: ${err.message}. Check your internet connection and try again.`;
        setBusy(false);
        updateButton();
      } finally {
        this.busy = false;
      }
    });

    layout(
      this.root,
      [
        stepper(2),
        h("h2", {}, "Pick my brain"),
        h(
          "p",
          { class: "lead" },
          `This computer has ${rec.total_ram_gb} GB of memory, so I suggest `,
          h("b", {}, prettyModelName(rec.primary.name)),
          ". Smaller brains are quicker, bigger ones a bit smarter.",
        ),
        rec.note ? h("p", { class: "callout" }, rec.note) : null,
        list,
        h("p", { class: "hint" }, "I only load my brain while we chat, then free up the memory again."),
      ],
      [h("div", { class: "foot-stack" }, progress, status, go)],
    );
  }
}
