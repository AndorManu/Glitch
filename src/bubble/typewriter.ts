// Types Glitch's words into an element, fast. Click/typing skips it.
// Layout never jumps: the not-yet-typed rest is already there, just
// invisible, so the bubble has its final size from the first frame.

import { graphemes, revealedAt } from "./text";

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export class Typewriter {
  private readonly chars: string[];
  private readonly shown = document.createElement("span");
  private readonly caret = document.createElement("span");
  private readonly rest = document.createElement("span");
  private frame = 0;
  private started = false;
  private done = false;

  constructor(
    target: HTMLElement,
    text: string,
    private readonly onDone: () => void,
  ) {
    this.chars = graphemes(text);
    this.caret.className = "caret";
    this.rest.className = "rest";
    this.rest.textContent = text;
    target.append(this.shown, this.caret, this.rest);
  }

  /** Start typing (no-op if already started or finished). */
  start(): void {
    if (this.started || this.done) return;
    this.started = true;
    if (this.chars.length === 0 || reducedMotion()) {
      this.finish();
      return;
    }
    let t0 = -1;
    let last = -1;
    const tick = (now: number) => {
      if (t0 < 0) t0 = now;
      const n = revealedAt(now - t0, this.chars.length);
      if (n !== last) {
        last = n;
        this.shown.textContent = this.chars.slice(0, n).join("");
        this.rest.textContent = this.chars.slice(n).join("");
      }
      if (n >= this.chars.length) this.finish();
      else this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  /** Show everything now. */
  finish(): void {
    if (this.done) return;
    this.done = true;
    cancelAnimationFrame(this.frame);
    this.shown.textContent = this.chars.join("");
    this.rest.textContent = "";
    this.caret.remove();
    this.onDone();
  }

  /** Stop without reporting (the speech was replaced). */
  cancel(): void {
    this.done = true;
    cancelAnimationFrame(this.frame);
  }
}
