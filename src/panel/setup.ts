// First-run wizard: 1) make sure Ollama is installed and running,
// 2) pick + download a model that fits this computer, 3) done.
// Pure helpers at the top are unit-tested (setup.test.ts).

import { api, asUiError, type InstalledModel, type PullProgress, type SetupStatus } from "../shared/ipc";
import { clear, h } from "./dom";

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

// --------------------------------------------------------------- the view

export interface SetupCallbacks {
  /** Called when a model is ready and saved; switch to the chat. */
  done(model: string): void;
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
    clear(this.root, h("p", { class: "muted" }, "Checking your computer…"));
    try {
      this.status = await api.setupStatus();
    } catch (e) {
      clear(this.root, h("p", { class: "error" }, `Something went wrong: ${asUiError(e).message}`));
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
      {},
      "To think, I use a free app called ",
      h("b", {}, "Ollama"),
      ". It runs the AI right here on your computer, so your chats stay private.",
    );
    if (s.ollama.state === "missing") {
      clear(
        this.root,
        h("h2", {}, "Step 1 of 2: get Ollama"),
        intro,
        h(
          "ol",
          {},
          h("li", {}, "Click the button to open the Ollama download page."),
          h("li", {}, s.os === "macos" ? "Open the downloaded file and drag Ollama into Applications, then open it once." : "Run the downloaded installer (no admin rights needed)."),
          h("li", {}, "Come back here and click “I’ve installed it”."),
        ),
        h("div", { class: "row" },
          h("button", { class: "primary", onclick: () => void api.openOllamaDownload() }, "Download Ollama"),
          h("button", { onclick: () => void this.refresh() }, "I’ve installed it"),
        ),
      );
      return;
    }
    const status = h("p", { class: "muted" });
    const start = h("button", { class: "primary" }, "Start Ollama");
    start.addEventListener("click", async () => {
      start.disabled = true;
      status.textContent = "Starting Ollama…";
      try {
        await api.startOllama();
      } catch (e) {
        status.textContent = `Couldn't start it: ${asUiError(e).message}. Try opening Ollama from your ${s.os === "macos" ? "Applications folder" : "Start menu"}.`;
        start.disabled = false;
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
      status.textContent = "Ollama is taking a while. Wait a moment, then click “Check again”.";
      start.disabled = false;
    });
    clear(
      this.root,
      h("h2", {}, "Step 1 of 2: start Ollama"),
      h("p", {}, "Ollama is installed but not running."),
      h("div", { class: "row" }, start, h("button", { onclick: () => void this.refresh() }, "Check again")),
      status,
    );
  }

  private renderModels(s: SetupStatus): void {
    const rec = s.recommendation;
    const options = modelOptions(s);
    let selected = options.find((o) => s.settings.model && sameModel(o.name, s.settings.model)) ?? options[0];

    const list = h("div", { class: "options" });
    for (const o of options) {
      const input = h("input", { type: "radio", name: "model", value: o.name, checked: o === selected });
      input.addEventListener("change", () => {
        selected = o;
        updateButton();
      });
      list.append(
        h(
          "label",
          { class: "option" },
          input,
          h("span", { class: "name" }, o.name),
          o.recommended ? h("span", { class: "tag good" }, "recommended") : null,
          o.installed ? h("span", { class: "tag" }, "downloaded") : h("span", { class: "muted" }, ` ≈${o.sizeGb} GB`),
        ),
      );
    }

    const go = h("button", { class: "primary" });
    const bar = h("progress", { max: 100, value: 0, hidden: true });
    const status = h("p", { class: "muted" });
    const updateButton = () => {
      go.textContent = selected.installed ? "Use this brain" : `Download (≈${selected.sizeGb} GB) and continue`;
    };
    updateButton();

    go.addEventListener("click", async () => {
      const choice = selected;
      this.busy = true;
      go.disabled = true;
      list.querySelectorAll("input").forEach((i) => (i.disabled = true));
      try {
        if (!choice.installed) {
          bar.hidden = false;
          await api.pullModel(choice.name, (p) => {
            const t = progressText(p);
            status.textContent = t.label;
            if (t.percent !== null) bar.value = t.percent;
          });
        }
        await api.updateSettings({ model: choice.name, onboarding_done: true });
        this.cb.done(choice.name);
      } catch (e) {
        const err = asUiError(e);
        status.textContent =
          err.code === "ollama_unreachable"
            ? "Lost contact with Ollama. Is it still running?"
            : `Download failed: ${err.message}. Check your internet connection and try again.`;
        go.disabled = false;
        list.querySelectorAll("input").forEach((i) => (i.disabled = false));
      } finally {
        this.busy = false;
      }
    });

    clear(
      this.root,
      h("h2", {}, "Step 2 of 2: choose my brain"),
      h(
        "p",
        {},
        `Your computer has ${rec.total_ram_gb} GB of memory, so I suggest `,
        h("b", {}, rec.primary.name),
        ". Smaller brains are faster and lighter; bigger ones are a bit smarter.",
      ),
      rec.note ? h("p", { class: "note" }, rec.note) : null,
      list,
      h("div", { class: "row" }, go),
      bar,
      status,
      h("p", { class: "muted small" }, "The brain is only loaded while we chat and is unloaded from memory shortly after."),
    );
  }
}
