// Types Glitch's words into an element, fast. Click/typing skips it.
// Layout never jumps: the not-yet-typed rest is already there, just
// invisible, so the bubble has its final size from the first frame.

import { graphemes, revealedAt, urlBreaks } from "./text";

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export class Typewriter {
  private readonly chars: string[];
  /** Links wrap at their separators (see urlBreaks). */
  private readonly breaks: Set<number>;
  private readonly shown = document.createElement("span");
  private readonly caret = document.createElement("span");
  private readonly rest = document.createElement("span");
  private frame = 0;
  private started = false;
  private done = false;

  /**
   * `viewport`: the scroll box the text sits in. Once typing reaches its
   * bottom edge the rest appears at once: nobody watches text being typed
   * out of sight, and the box never scrolls away from the start by itself.
   */
  constructor(
    target: HTMLElement,
    text: string,
    private readonly onDone: () => void,
    private readonly viewport: HTMLElement | null = null,
  ) {
    this.chars = graphemes(text);
    this.breaks = urlBreaks(this.chars);
    this.caret.className = "caret";
    this.rest.className = "rest";
    this.fill(this.rest, 0, this.chars.length);
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
        this.fill(this.shown, 0, n);
        this.fill(this.rest, n, this.chars.length);
      }
      if (n >= this.chars.length || this.pastFold()) this.finish();
      else this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  /** Show everything now. */
  finish(): void {
    if (this.done) return;
    this.done = true;
    cancelAnimationFrame(this.frame);
    this.fill(this.shown, 0, this.chars.length);
    this.rest.textContent = "";
    this.caret.remove();
    this.onDone();
  }

  private pastFold(): boolean {
    const v = this.viewport;
    if (!v || v.scrollHeight <= v.clientHeight) return false;
    return this.caret.getBoundingClientRect().top >= v.getBoundingClientRect().bottom - 4;
  }

  /** chars[from..to) into `el`, with <wbr> where links may wrap. */
  private fill(el: HTMLElement, from: number, to: number): void {
    if (this.breaks.size === 0) {
      el.textContent = this.chars.slice(from, to).join("");
      return;
    }
    const parts: (string | Node)[] = [];
    let run = from;
    for (let i = from; i < to; i++) {
      if (!this.breaks.has(i)) continue;
      parts.push(this.chars.slice(run, i + 1).join(""), document.createElement("wbr"));
      run = i + 1;
    }
    if (run < to) parts.push(this.chars.slice(run, to).join(""));
    el.replaceChildren(...parts);
  }

  /** Stop without reporting (the speech was replaced). */
  cancel(): void {
    this.done = true;
    cancelAnimationFrame(this.frame);
  }
}
