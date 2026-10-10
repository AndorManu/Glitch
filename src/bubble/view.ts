// Draws the bubble: Glitch's speech (or thought cloud) above a compose pill.
// All decisions live in state.ts; this file only turns state into DOM.

import { askPermission, lookingText, plainText, PLACEHOLDER, THINKING } from "../shared/chat-text";
import type { BubbleLayout, UpdateIcon } from "../shared/ipc";
import { allowAccepted, CONFIRM_CHOICES, defaultChoice } from "./choices";
import { h, svg } from "./dom";
import {
  CLOUD,
  CLOUD_W,
  ICON_CHECK,
  ICON_CLOSE,
  ICON_FAIL,
  ICON_GEAR,
  ICON_MIC,
  ICON_SEND,
  TAIL,
  TAIL_TIP,
  TRAIL,
  TRAIL_W,
} from "./shapes";
import { canSend, type BubbleState, type Speech, type Work } from "./state";
import { actionChip, breakChunks, centerOn, narrowestFit, tailWithin } from "./text";
import { Typewriter } from "./typewriter";
import { micActive, micHint, setupText, type MicState } from "./voice";

export interface ViewHandlers {
  send(text: string): void;
  answer(approved: boolean): void;
  hide(): void;
  openSettings(): void;
  openSetup(): void;
  /** The current speech has been fully revealed on screen. */
  seen(): void;
  /** Glitch starts "saying" a reply or question of `chars` characters (he moves his mouth). */
  talk?(chars: number, opened: boolean): void;
  /** Mic button pressed / released (pointer or keyboard). */
  micDown(): void;
  micUp(): void;
  /** Voice setup offer buttons. */
  voiceDownload(): void;
  voiceDismiss(): void;
  voiceCancelDownload(): void;
  openMicSettings(): void;
  /** A button on an "Update me" speech (Done, Snooze, Tell me...). */
  choose?(id: string, choice: string): void;
}

/** The little round badge in front of an update. */
const UPDATE_GLYPHS: Record<UpdateIcon, string> = {
  reminder: "⏰",
  claude: "✦",
  event: "✓",
  digest: "✉",
  briefing: "☀",
};

/** Transparent gap kept around the shapes for their shadow and focus ring. */
const SIDE = 6;
/** Outline width: tails are positioned inside the border. */
const BORDER = 2;
/** How close a tail may get to a shape's rounded ends. */
const PILL_TAIL_INSET = 26;
const BALLOON_TAIL_INSET = 22;
const MAX_LINES = 4;

type SpeechShown = {
  kind: "speech";
  rev: number;
  el: HTMLElement;
  balloon: HTMLElement;
  tail: SVGSVGElement;
  choices: HTMLButtonElement[];
  /** An Allow / Nope card. */
  confirm: boolean;
  /** Voice setup offer: progress bar, status line, and its button rows. */
  setup?: { bar: HTMLElement; fill: HTMLElement; note: HTMLElement; pct: HTMLElement; offer: HTMLElement; running: HTMLElement };
};
/** While busy: the thought cloud (no text yet) or the reply streaming in. Both carry the step list. */
type CloudShown = { kind: "cloud"; el: HTMLElement; work: HTMLElement };
type LiveShown = { kind: "live"; el: HTMLElement; balloon: HTMLElement; tail: SVGSVGElement; work: HTMLElement; say: HTMLElement; scroll: HTMLElement };
type Shown = CloudShown | LiveShown | SpeechShown;

export class BubbleView {
  readonly root: HTMLElement;
  readonly input: HTMLTextAreaElement;
  private readonly slot: HTMLElement;
  private readonly pill: HTMLElement;
  private readonly pillTail: SVGSVGElement;
  private readonly sendButton: HTMLButtonElement;
  private readonly micButton: HTMLButtonElement;
  private readonly voiceStrip: HTMLElement;
  private readonly voiceHint: HTMLElement;
  private mic: MicState | null = null;
  private placeholder = PLACEHOLDER;
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

    // Push-to-talk. Hidden until the voice side says it's usable.
    this.micButton = h("button", { type: "button", class: "icon mic", hidden: true, "aria-label": "Talk to Glitch" });
    this.micButton.append(svg(ICON_MIC), h("span", { class: "mic-ring", "aria-hidden": "true" }));
    this.bindMic(this.micButton);
    // Shown over the text box while listening: a level meter and a hint.
    const bars = h("span", { class: "bars", "aria-hidden": "true" });
    for (let i = 0; i < 5; i++) bars.append(h("i"));
    this.voiceHint = h("span", { class: "voice-hint" });
    this.voiceStrip = h("div", { class: "voice-strip", "aria-live": "polite" }, bars, this.voiceHint);

    this.pill = h("form", { class: "pill", "aria-label": "Chat with Glitch" }, gear, this.input, this.voiceStrip, this.micButton, this.sendButton, close);
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
    this.micButton.disabled = state.busy && !(this.mic && micActive(this.mic));
    this.root.setAttribute("aria-busy", String(state.busy));

    if (state.busy) {
      if (state.work.text) {
        if (this.shown?.kind !== "live") this.replace(this.buildLive());
        const live = this.shown as LiveShown;
        const text = plainText(state.work.text);
        if (live.say.textContent !== text) {
          live.say.textContent = text;
          live.scroll.scrollTop = live.scroll.scrollHeight;
        }
      } else if (this.shown?.kind !== "cloud") {
        const work = this.buildWork();
        this.replace({ kind: "cloud", el: this.buildCloud(work), work });
      }
      const shown = this.shown as CloudShown | LiveShown;
      renderWork(shown.work, state.work);
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
    // A confirmation card focuses "Nope", so a stray Enter can't approve.
    const i = s?.kind === "speech" ? defaultChoice(s.confirm ? "confirm" : "other", s.choices.length) : null;
    const button = s?.kind === "speech" && i !== null ? s.choices[i] : undefined;
    if (button && !button.disabled && !this.input.value) button.focus();
    else this.input.focus();
  }

  clearInput(): void {
    this.input.value = "";
    this.fitInput();
  }

  /** Put text in the message box (a transcript that couldn't be sent yet). */
  setInput(text: string): void {
    this.input.value = text;
    this.fitInput();
    if (this.state) this.sendButton.disabled = !canSend(this.state, text);
  }

  /** While Glitch thinks about a spoken message, show what he heard in the empty box. */
  setEcho(text: string | null): void {
    this.placeholder = text ? `“${text}”` : PLACEHOLDER;
    this.input.placeholder = this.placeholder;
    this.pill.classList.toggle("echo", !!text);
  }

  // ------------------------------------------------------------- voice

  /** Mic button + listening strip. `hotkeyTitle`: the button's tooltip. */
  renderMic(mic: MicState, title: string): void {
    const prev = this.mic;
    this.mic = mic;
    const b = this.micButton;
    b.hidden = mic.phase === "hidden";
    b.title = title;
    const active = micActive(mic);
    b.disabled = !active && !!this.state?.busy;
    b.setAttribute("aria-pressed", String(mic.phase === "starting" || mic.phase === "listening"));
    this.pill.classList.toggle("listening", mic.phase === "starting" || mic.phase === "listening");
    this.pill.classList.toggle("transcribing", mic.phase === "transcribing");
    this.voiceStrip.style.setProperty("--level", mic.level.toFixed(2));
    b.style.setProperty("--level", mic.level.toFixed(2));
    const hint = micHint(mic);
    if (this.voiceHint.textContent !== hint) this.voiceHint.textContent = hint;
    if (!prev || micActive(prev) !== active) {
      this.input.readOnly = active;
      this.input.setAttribute("aria-hidden", String(active));
    }
  }

  private bindMic(b: HTMLButtonElement): void {
    let down = false;
    const press = () => {
      if (down || b.disabled) return;
      down = true;
      this.on.micDown();
    };
    const release = () => {
      if (!down) return;
      down = false;
      this.on.micUp();
    };
    b.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); // keep the text box focused, no text selection
      b.setPointerCapture?.(e.pointerId);
      press();
    });
    b.addEventListener("pointerup", release);
    b.addEventListener("pointercancel", release);
    b.addEventListener("lostpointercapture", release);
    b.addEventListener("contextmenu", (e) => e.preventDefault());
    // Keyboard: Space/Enter work like the mouse (hold or tap).
    b.addEventListener("keydown", (e) => {
      if ((e.key === " " || e.key === "Enter") && !e.repeat) {
        e.preventDefault();
        press();
      }
    });
    b.addEventListener("keyup", (e) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        release();
      }
    });
    b.addEventListener("blur", release);
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
    const typer = new Typewriter(typed, text, () => this.on.seen(), shown.balloon.querySelector<HTMLElement>(".scroll"));
    this.typer = typer;
    snugWidth(shown.balloon);
    const scroll = shown.balloon.querySelector<HTMLElement>(".scroll");
    if (scroll) this.markOverflow(scroll);
    // Text that already streamed in is shown at once, not typed again.
    if (speech.kind === "reply" && speech.instant) typer.finish();
    else if (this.live) queueMicrotask(() => typer.start());
    if (this.live && (speech.kind === "reply" || speech.kind === "confirm" || speech.kind === "update") && text.trim()) {
      // He opened a site or an app for you: he points at it first, then says it.
      const opened = speech.kind === "reply" && speech.actions.some((a) => a.startsWith("Opened"));
      this.on.talk?.(text.length, opened);
    }
  }

  private buildCloud(work: HTMLElement): HTMLElement {
    const dots = h("div", { class: "dots" }, h("i"), h("i"), h("i"));
    const cloud = h("div", { class: "cloud" }, h("div", { class: "glitchy" }, svg(CLOUD, "cloud-shape"), dots));
    const trail = h("div", { class: "trail" });
    trail.append(svg(TRAIL));
    return h("div", { class: "thought" }, h("span", { class: "sr" }, THINKING), work, cloud, trail);
  }

  /** The step list and the "looking at your screen" badge (filled by renderWork). */
  private buildWork(): HTMLElement {
    return h("div", { class: "work", "aria-live": "polite" });
  }

  /** The reply as it streams in: a speech balloon without typing. */
  private buildLive(): LiveShown {
    const work = this.buildWork();
    const say = h("p", { class: "say" });
    const scroll = h("div", { class: "scroll" }, say);
    const tail = svg(TAIL, "tail");
    const balloon = h("div", { class: "balloon reply live" }, work, scroll, tail);
    const el = h("div", { class: "speech" }, balloon);
    return { kind: "live", el, balloon, tail, work, say, scroll };
  }

  private buildSpeech(speech: Speech, rev: number): { shown: SpeechShown; typed: HTMLElement; text: string } {
    const balloon = h("div", { class: `balloon ${speech.kind}${speech.kind === "notice" ? ` ${speech.tone}` : ""}` });
    const main =
      speech.kind === "confirm" ? askPermission(speech.title) : speech.kind === "voice_setup" ? setupText(speech.sizeMb) : speech.text;

    // Screen readers get the whole text at once; the eyes get it typed.
    const say = h("p", { class: "say" });
    const typed = h("span", { "aria-hidden": "true" });
    say.append(h("span", { class: "sr" }, main), typed);
    const scroll = h("div", { class: "scroll" }, say);
    if (speech.kind === "error" || (speech.kind === "notice" && speech.tone === "error")) {
      scroll.prepend(h("span", { class: "glyph", "aria-hidden": "true" }, "!"));
    }
    if (speech.kind === "voice_setup") scroll.prepend(h("span", { class: "glyph mic-glyph", "aria-hidden": "true" }, svg(ICON_MIC)));
    if (speech.kind === "update") scroll.prepend(h("span", { class: `glyph update-glyph ${speech.icon}`, "aria-hidden": "true" }, UPDATE_GLYPHS[speech.icon]));
    if (main) balloon.append(scroll);

    if (speech.kind === "confirm" && speech.detail) {
      const detail = h("p", { class: "detail", title: speech.detail });
      for (const part of breakChunks(speech.detail)) detail.append(part, h("wbr"));
      balloon.append(detail);
    }

    const actions = speech.kind === "reply" || speech.kind === "confirm" ? speech.actions : [];
    if (actions.length) balloon.append(this.buildChips(actions));

    const choices: HTMLButtonElement[] = [];
    if (speech.kind === "confirm") {
      const shownAt = performance.now();
      const allow = h(
        "button",
        { type: "button", class: "choice yes", onclick: () => allowAccepted(shownAt, performance.now()) && this.on.answer(true) },
        CONFIRM_CHOICES[0],
      );
      const nope = h("button", { type: "button", class: "choice no", onclick: () => this.on.answer(false) }, CONFIRM_CHOICES[1]);
      choices.push(allow, nope);
      const row = h("div", { class: "choices", role: "group", "aria-label": "Allow this?" }, allow, nope);
      // Typing while a button is focused goes to the message box instead.
      row.addEventListener("keydown", (e) => {
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== " ") this.input.focus();
      });
      balloon.append(row);
    }
    if (speech.kind === "update" && speech.choices.length) {
      speech.choices.forEach((c, i) => {
        const b = h("button", { type: "button", class: `choice ${i === 0 ? "yes" : "no"}`, onclick: () => this.on.choose?.(speech.id, c.id) }, c.label);
        choices.push(b);
      });
      balloon.append(h("div", { class: "choices", role: "group" }, ...choices));
    }
    if (speech.kind === "error" && speech.offerSetup) {
      balloon.append(h("div", { class: "choices" }, h("button", { type: "button", class: "choice yes", onclick: () => this.on.openSetup() }, "Fix it")));
    }
    if (speech.kind === "notice" && speech.action === "mic-settings") {
      balloon.append(
        h("div", { class: "choices" }, h("button", { type: "button", class: "choice yes", onclick: () => this.on.openMicSettings() }, "Open settings")),
      );
    }
    let setup: SpeechShown["setup"];
    if (speech.kind === "voice_setup") {
      const fill = h("i");
      const bar = h("div", { class: "vbar", role: "progressbar", "aria-label": "Download progress", "aria-valuemin": 0, "aria-valuemax": 100 }, fill);
      const note = h("p", { class: "note", role: "alert" });
      const download = h("button", { type: "button", class: "choice yes", onclick: () => this.on.voiceDownload() }, "Download");
      const later = h("button", { type: "button", class: "choice no", onclick: () => this.on.voiceDismiss() }, "Not now");
      const offer = h("div", { class: "choices" }, download, later);
      const pct = h("span", { class: "pct", role: "status" });
      const running = h(
        "div",
        { class: "choices running" },
        pct,
        h("button", { type: "button", class: "choice no", onclick: () => this.on.voiceCancelDownload() }, "Cancel"),
      );
      choices.push(download);
      setup = { bar, fill, note, pct, offer, running };
      balloon.append(bar, note, offer, running);
    }

    const tail = svg(TAIL, "tail");
    balloon.append(tail);
    balloon.addEventListener("click", () => this.typer?.finish());
    const el = h("div", { class: "speech" }, balloon);

    scroll.addEventListener("scroll", () => this.markOverflow(scroll), { passive: true });

    const shown: SpeechShown = { kind: "speech", rev, el, balloon, tail, choices, confirm: speech.kind === "confirm", setup };
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
    if (speech.kind === "voice_setup" && s.setup) {
      const { bar, fill, note, pct: pctEl, offer, running } = s.setup;
      const downloading = speech.progress !== null;
      bar.hidden = !downloading;
      running.hidden = !downloading;
      offer.hidden = downloading;
      const pct = Math.round(speech.progress ?? 0);
      fill.style.width = `${pct}%`;
      bar.setAttribute("aria-valuenow", String(pct));
      const progressText = `Downloading… ${pct}%`;
      if (pctEl.textContent !== progressText) pctEl.textContent = progressText;
      const text = speech.failed ?? "";
      if (note.textContent !== text) note.textContent = text;
      note.hidden = !text;
      const label = speech.failed ? "Try again" : "Download";
      if (offer.firstElementChild && offer.firstElementChild.textContent !== label) offer.firstElementChild.textContent = label;
      return;
    }
    if (speech.kind === "update") {
      for (const b of s.choices) b.disabled = speech.answered;
      return;
    }
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
    if (s?.kind === "speech" || s?.kind === "live") {
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
  // offsetWidth is rounded: the natural width may be a fraction wider, so
  // allow one extra pixel and let narrowestFit test it.
  const best = narrowestFit(lo, full + 1, (w) => {
    balloon.style.width = `${w}px`;
    return balloon.offsetHeight <= height;
  });
  balloon.style.width = best === null ? "" : `${best}px`;
}

const STEP_ICON: Record<"running" | "done" | "failed", string> = { running: "", done: "\u2713", failed: "\u00D7" };

/** Draw the live step list ("1. Looking at your screen ✓") and the looking badge. */
function renderWork(el: HTMLElement, work: Work): void {
  const key = JSON.stringify([work.steps, work.looking]);
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  const parts: HTMLElement[] = [];
  if (work.looking) parts.push(h("div", { class: "looking", role: "status" }, lookingText(work.looking)));
  // While the badge shows, the screenshot step it stands for isn't listed twice.
  const steps = work.steps.filter((st) => !(work.looking && st.tool === "look_at_screen" && st.state === "running"));
  if (steps.length) {
    const list = h("ol", { class: "steps", "aria-label": "What I'm doing" });
    for (const st of steps) {
      list.append(h("li", { class: `step ${st.state}` }, h("span", { class: "icon", "aria-hidden": "true" }, STEP_ICON[st.state]), h("span", { class: "label" }, st.label)));
    }
    parts.push(list);
  }
  el.replaceChildren(...parts);
  el.hidden = parts.length === 0;
}
