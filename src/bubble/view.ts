// Draws the bubble: Glitch's speech (or thought cloud) above a compose pill.
// All decisions live in state.ts; this file only turns state into DOM.

import { askPermission, PLACEHOLDER, THINKING } from "../shared/chat-text";
import type { BubbleLayout } from "../shared/ipc";
import { h, svg } from "./dom";
import {
  CLOUD,
  CLOUD_W,
  ICON_CHECK,
  ICON_CLOSE,
  ICON_FAIL,
  ICON_GEAR,
  ICON_SEND,
  TAIL,
  TAIL_TIP,
  TRAIL,
  TRAIL_W,
} from "./shapes";
import { canSend, type BubbleState, type Speech } from "./state";
import { actionChip, breakChunks, centerOn, tailWithin } from "./text";
import { Typewriter } from "./typewriter";

export interface ViewHandlers {
  send(text: string): void;
  answer(approved: boolean): void;
  hide(): void;
  openSettings(): void;
  openSetup(): void;
  /** The current speech has been fully revealed on screen. */
  seen(): void;
}

/** Transparent gap kept around the shapes for their shadow and focus ring. */
const SIDE = 6;
/** Outline width: tails are positioned inside the border. */
const BORDER = 2;
/** How close a tail may get to a shape's rounded ends. */
const PILL_TAIL_INSET = 26;
const BALLOON_TAIL_INSET = 22;
const MAX_LINES = 4;

type SpeechShown = { kind: "speech"; rev: number; el: HTMLElement; balloon: HTMLElement; tail: SVGSVGElement; choices: HTMLButtonElement[] };
type Shown = { kind: "cloud"; el: HTMLElement } | SpeechShown;

export class BubbleView {
  readonly root: HTMLElement;
  readonly input: HTMLTextAreaElement;
  private readonly slot: HTMLElement;
  private readonly pill: HTMLElement;
  private readonly pillTail: SVGSVGElement;
  private readonly sendButton: HTMLButtonElement;
  private layout: BubbleLayout = { tail_up: false, tail_x: 150 };
  private shown: Shown | null = null;
  private typer: Typewriter | null = null;
  private state: BubbleState | null = null;
  /** The window is on screen (typing animations only run then). */
  private live = false;

  constructor(
    root: HTMLElement,
    private readonly on: ViewHandlers,
  ) {
    this.root = root;
    root.classList.add("bubble", "down", "away");
    root.style.setProperty("--tail-x", `${this.layout.tail_x}px`);

    this.slot = h("div", { class: "slot", "aria-live": "polite" });

    this.input = h("textarea", {
      class: "input",
      rows: 1,
      placeholder: PLACEHOLDER,
      "aria-label": "Message to Glitch",
      spellcheck: true,
      autocomplete: "off",
    });
    this.sendButton = h("button", { type: "submit", class: "send", title: "Send (Enter)", "aria-label": "Send" });
    this.sendButton.append(svg(ICON_SEND));
    const gear = h("button", { type: "button", class: "icon gear", title: "Settings", "aria-label": "Settings", onclick: () => this.on.openSettings() });
    gear.append(svg(ICON_GEAR));
    const close = h("button", { type: "button", class: "close", title: "Close (Esc)", "aria-label": "Close", onclick: () => this.on.hide() });
    close.append(svg(ICON_CLOSE));
    this.pillTail = svg(TAIL, "tail");

    this.pill = h("form", { class: "pill", "aria-label": "Chat with Glitch" }, gear, this.input, this.sendButton, close);
    this.pill.append(this.pillTail);
    this.pill.addEventListener("submit", (e) => {
      e.preventDefault();
      this.submit();
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.submit();
      }
    });
    this.input.addEventListener("input", () => {
      this.fitInput();
      this.typer?.finish();
      if (this.state) this.sendButton.disabled = !canSend(this.state, this.input.value);
    });

    root.append(this.slot, this.pill);
  }

  // ------------------------------------------------------------ public

  render(state: BubbleState): void {
    this.state = state;
    this.sendButton.disabled = !canSend(state, this.input.value);
    this.root.setAttribute("aria-busy", String(state.busy));

    if (state.busy) {
      if (this.shown?.kind !== "cloud") this.replace({ kind: "cloud", el: this.buildCloud() });
    } else if (state.speech) {
      const s = this.shown;
      if (s?.kind === "speech" && s.rev === state.rev) this.updateSpeech(s, state.speech);
      else this.showSpeech(state.speech, state.rev);
    } else if (this.shown) {
      this.replace(null);
    }
    this.position();
  }

  setLayout(layout: BubbleLayout): void {
    if (layout.tail_up === this.layout.tail_up && layout.tail_x === this.layout.tail_x) return;
    this.layout = layout;
    this.root.classList.toggle("up", layout.tail_up);
    this.root.classList.toggle("down", !layout.tail_up);
    this.root.style.setProperty("--tail-x", `${layout.tail_x}px`);
    this.position();
  }

  /** Window became visible: play the entrance and any pending typing. */
  enter(): void {
    this.live = true;
    this.root.classList.remove("away");
    this.typer?.start();
  }

  /** Window was hidden. */
  leave(): void {
    this.live = false;
    this.typer?.finish();
    this.root.classList.add("away");
  }

  /** Put the keyboard where it's most useful right now. */
  focus(): void {
    const s = this.shown;
    if (s?.kind === "speech" && s.choices.length && !s.choices[0].disabled && !this.input.value) s.choices[0].focus();
    else this.input.focus();
  }

  clearInput(): void {
    this.input.value = "";
    this.fitInput();
  }

  // ----------------------------------------------------------- compose

  private submit(): void {
    const text = this.input.value;
    if (!this.state || !canSend(this.state, text)) return;
    this.on.send(text);
  }

  /** Grow the textarea with its text, up to MAX_LINES. */
  private fitInput(): void {
    const ta = this.input;
    const cs = getComputedStyle(ta);
    const line = parseFloat(cs.lineHeight) || 20;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const max = line * MAX_LINES + pad;
    ta.style.height = "auto";
    const full = ta.scrollHeight;
    ta.style.height = `${Math.min(full, max)}px`;
    const scrolls = full > max + 1;
    ta.style.overflowY = scrolls ? "auto" : "hidden";
    ta.classList.toggle("scrolls", scrolls);
    this.pill.classList.toggle("multi", full > line + pad + 2);
  }

  // ------------------------------------------------------------ speech

  private replace(next: Shown | null): void {
    this.typer?.cancel();
    this.typer = null;
    this.shown?.el.remove();
    this.shown = next;
    if (next) this.slot.append(next.el);
  }

  private showSpeech(speech: Speech, rev: number): void {
    const { shown, typed, text } = this.buildSpeech(speech, rev);
    this.replace(shown);
    const typer = new Typewriter(typed, text, () => this.on.seen());
    this.typer = typer;
    snugWidth(shown.balloon);
    const scroll = shown.balloon.querySelector<HTMLElement>(".scroll");
    if (scroll) this.markOverflow(scroll);
    if (this.live) queueMicrotask(() => typer.start());
  }

  private buildCloud(): HTMLElement {
    const dots = h("div", { class: "dots" }, h("i"), h("i"), h("i"));
    const cloud = h("div", { class: "cloud" }, h("div", { class: "glitchy" }, svg(CLOUD, "cloud-shape"), dots));
    const trail = h("div", { class: "trail" });
    trail.append(svg(TRAIL));
    return h("div", { class: "thought" }, h("span", { class: "sr" }, THINKING), cloud, trail);
  }

  private buildSpeech(speech: Speech, rev: number): { shown: SpeechShown; typed: HTMLElement; text: string } {
    const balloon = h("div", { class: `balloon ${speech.kind}` });
    const main = speech.kind === "confirm" ? askPermission(speech.title) : speech.text;

    // Screen readers get the whole text at once; the eyes get it typed.
    const say = h("p", { class: "say" });
    const typed = h("span", { "aria-hidden": "true" });
    say.append(h("span", { class: "sr" }, main), typed);
    const scroll = h("div", { class: "scroll" }, say);
    if (speech.kind === "error") scroll.prepend(h("span", { class: "glyph", "aria-hidden": "true" }, "!"));
    if (main) balloon.append(scroll);

    if (speech.kind === "confirm" && speech.detail) {
      const detail = h("p", { class: "detail", title: speech.detail });
      for (const part of breakChunks(speech.detail)) detail.append(part, h("wbr"));
      balloon.append(detail);
    }

    const actions = speech.kind === "error" ? [] : speech.actions;
    if (actions.length) balloon.append(this.buildChips(actions));

    const choices: HTMLButtonElement[] = [];
    if (speech.kind === "confirm") {
      const allow = h("button", { type: "button", class: "choice yes", onclick: () => this.on.answer(true) }, "Allow");
      const nope = h("button", { type: "button", class: "choice no", onclick: () => this.on.answer(false) }, "Nope");
      choices.push(allow, nope);
      const row = h("div", { class: "choices", role: "group", "aria-label": "Allow this?" }, allow, nope);
      // Typing while a button is focused goes to the message box instead.
      row.addEventListener("keydown", (e) => {
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== " ") this.input.focus();
      });
      balloon.append(row);
    }
    if (speech.kind === "error" && speech.offerSetup) {
      balloon.append(h("div", { class: "choices" }, h("button", { type: "button", class: "choice yes", onclick: () => this.on.openSetup() }, "Fix it")));
    }

    const tail = svg(TAIL, "tail");
    balloon.append(tail);
    balloon.addEventListener("click", () => this.typer?.finish());
    const el = h("div", { class: "speech" }, balloon);

    scroll.addEventListener("scroll", () => this.markOverflow(scroll), { passive: true });

    const shown: SpeechShown = { kind: "speech", rev, el, balloon, tail, choices };
    this.updateSpeech(shown, speech);
    return { shown, typed, text: main };
  }

  /** Fade the bottom edge of long replies until scrolled to the end. */
  private markOverflow(scroll: HTMLElement): void {
    scroll.classList.toggle("more", scroll.scrollTop + scroll.clientHeight < scroll.scrollHeight - 4);
  }

  private buildChips(actions: string[]): HTMLElement {
    const list = h("ul", { class: "chips", "aria-label": "What I did" });
    for (const a of actions) {
      const chip = actionChip(a);
      const li = h("li", { class: chip.ok ? "chip" : "chip failed", title: chip.full });
      li.append(svg(chip.ok ? ICON_CHECK : ICON_FAIL), h("span", {}, chip.text));
      list.append(li);
    }
    return list;
  }

  private updateSpeech(s: SpeechShown, speech: Speech): void {
    if (speech.kind !== "confirm") return;
    const done = speech.answer !== null;
    for (const b of s.choices) b.disabled = done;
    s.balloon.classList.toggle("stale", speech.answer === "stale");
  }

  // ---------------------------------------------------------- geometry

  /** Centre the speech on Glitch and point every tail at him. */
  private position(): void {
    const width = document.documentElement.clientWidth || 300;
    const tx = this.layout.tail_x;

    // The little × sits on the pill's corner; move it out of the way when
    // the speech's tail comes down on that side.
    this.root.classList.toggle("close-left", tx > width - 60);

    const pillW = this.pill.offsetWidth;
    if (pillW) this.pillTail.style.left = `${tailWithin(tx, SIDE, pillW, PILL_TAIL_INSET) - TAIL_TIP - BORDER}px`;

    const s = this.shown;
    if (s?.kind === "speech") {
      const w = s.balloon.offsetWidth;
      const left = centerOn(tx, w, width, SIDE);
      s.balloon.style.marginLeft = `${left}px`;
      const t = tailWithin(tx, left, w, BALLOON_TAIL_INSET);
      s.tail.style.left = `${t - TAIL_TIP - BORDER}px`;
      s.balloon.style.setProperty("--tail-x", `${t}px`);
    } else if (s?.kind === "cloud") {
      const left = centerOn(tx + 6, CLOUD_W, width, SIDE);
      const cloud = s.el.querySelector<HTMLElement>(".cloud")!;
      cloud.style.marginLeft = `${left}px`;
      const trail = s.el.querySelector<HTMLElement>(".trail")!;
      trail.style.marginLeft = `${Math.round(tailWithin(tx, SIDE, width - 2 * SIDE, PILL_TAIL_INSET) + SIDE - TRAIL_W / 2)}px`;
    }
  }
}

/**
 * Make a balloon as narrow as it can be without adding lines, so a two-line
 * reply reads as two balanced lines instead of one long and one short.
 * (Like `text-wrap: balance`, which Safari 14 lacks.) Runs once per reply.
 */
function snugWidth(balloon: HTMLElement): void {
  balloon.style.width = "";
  const scroll = balloon.querySelector<HTMLElement>(".scroll");
  // Long text scrolls anyway: keep it wide.
  if (scroll && scroll.scrollHeight > scroll.clientHeight + 1) return;
  const full = balloon.offsetWidth;
  const height = balloon.offsetHeight;
  // Never squeeze chips or buttons (they'd ellipsize instead of wrapping).
  let lo = parseFloat(getComputedStyle(balloon).minWidth) || 0;
  const frame = full - balloon.clientWidth + 26; // border + padding
  balloon.querySelectorAll<HTMLElement>(".chip, .choices").forEach((el) => {
    lo = Math.max(lo, el.scrollWidth + frame);
  });
  if (lo >= full - 4) return;
  let hi = full;
  while (hi - lo > 2) {
    const mid = Math.floor((lo + hi) / 2);
    balloon.style.width = `${mid}px`;
    if (balloon.offsetHeight > height) lo = mid;
    else hi = mid;
  }
  balloon.style.width = `${hi}px`;
}
