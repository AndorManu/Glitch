import { api, asUiError, type Step, type UiError } from "../shared/ipc";
import { h } from "./dom";

/** Friendly text for errors the user can fix. Unit-tested. */
export function explainError(e: UiError): { text: string; offerSetup: boolean } {
  switch (e.code) {
    case "ollama_unreachable":
      return { text: "I can't reach Ollama, my brain app. Is it running?", offerSetup: true };
    case "model_missing":
      return { text: "My brain (the AI model) isn't downloaded yet.", offerSetup: true };
    case "no_model":
      return { text: "I need a brain first! Let's pick one.", offerSetup: true };
    case "stale_confirmation":
      return { text: "That request expired, so I didn't do it. Just ask me again.", offerSetup: false };
    default:
      return { text: `Oops, something went wrong: ${e.message}`, offerSetup: false };
  }
}

export const WELCOME =
  "Hi, I'm Glitch! Ask me anything, or try “open YouTube”, “open the Calculator app” or “find a photo of a dog”.";

export class ChatView {
  private readonly log: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly send: HTMLButtonElement;
  private busy = false;

  constructor(
    root: HTMLElement,
    private readonly openSetup: () => void,
  ) {
    this.log = h("div", { class: "log", role: "log", "aria-live": "polite" });
    this.input = h("textarea", { rows: 2, placeholder: "Say something to Glitch…", "aria-label": "Message" });
    this.send = h("button", { class: "primary", onclick: () => void this.submit() }, "Send");
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.submit();
      }
    });
    root.append(this.log, h("div", { class: "composer" }, this.input, this.send));
    this.reset();
  }

  focus(): void {
    this.input.focus();
  }

  reset(): void {
    this.log.replaceChildren();
    this.bubble("glitch", WELCOME);
  }

  private scroll(): void {
    this.log.scrollTop = this.log.scrollHeight;
  }

  private bubble(who: "user" | "glitch", text: string): HTMLElement {
    const el = h("div", { class: `bubble ${who}` }, text);
    this.log.append(el);
    this.scroll();
    return el;
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.send.disabled = busy;
    this.log.querySelector(".typing")?.remove();
    if (busy) {
      this.log.append(h("div", { class: "bubble glitch typing" }, "Glitch is thinking…"));
      this.scroll();
    }
  }

  private async submit(): Promise<void> {
    const text = this.input.value.trim();
    if (!text || this.busy) return;
    this.input.value = "";
    // A pending confirmation is cancelled by a new message (Rust side too).
    this.log.querySelectorAll<HTMLButtonElement>(".confirm button").forEach((b) => (b.disabled = true));
    this.bubble("user", text);
    await this.run(() => api.sendMessage(text));
  }

  private async run(call: () => Promise<Step>): Promise<void> {
    this.setBusy(true);
    try {
      this.show(await call());
    } catch (e) {
      this.showError(asUiError(e));
    } finally {
      this.setBusy(false);
      this.focus();
    }
  }

  private actions(actions: string[]): void {
    for (const a of actions) this.log.append(h("div", { class: "action" }, `✓ ${a}`));
  }

  private show(step: Step): void {
    this.actions(step.actions);
    if (step.type === "reply") {
      this.bubble("glitch", step.text);
      return;
    }
    const answer = (approved: boolean) => {
      allow.disabled = deny.disabled = true;
      card.append(h("div", { class: "muted small" }, approved ? "Allowed" : "Not allowed"));
      void this.run(() => api.confirmAction(step.id, approved));
    };
    const allow = h("button", { class: "primary", onclick: () => answer(true) }, "Allow");
    const deny = h("button", { onclick: () => answer(false) }, "Don't allow");
    const card = h(
      "div",
      { class: "confirm" },
      h("div", { class: "title" }, `Glitch wants to: ${step.title}`),
      h("div", { class: "detail" }, step.detail),
      h("div", { class: "row" }, allow, deny),
    );
    this.log.append(card);
    this.scroll();
    allow.focus();
  }

  private showError(e: UiError): void {
    const { text, offerSetup } = explainError(e);
    const el = this.bubble("glitch", text);
    el.classList.add("error");
    if (offerSetup) el.append(h("div", {}, h("button", { onclick: () => this.openSetup() }, "Open setup")));
  }
}
