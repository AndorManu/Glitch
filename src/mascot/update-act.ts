// "Update me" on the mascot: when something happened (Claude Code is done,
// a build finished, 3 new WhatsApp messages, a reminder) Rust sends
// "mascot-update" with a few steps; Glitch runs over, knocks on the screen
// and holds up a sign with a short text.
//
// The animations are requested by name. Names the animator doesn't have yet
// fall back to ones it has (ACT_FALLBACKS), so this works before the new art
// lands: knock_screen -> the chaos knock -> startled; hold_sign -> happy.
// The sign's text is drawn here, over the canvas (the sprite only holds an
// empty board).

import type { UpdateAct } from "../shared/ipc";

/** Requested name -> what to try, in order. */
export const ACT_FALLBACKS: Record<string, string[]> = {
  run: ["run", "jump"],
  knock_screen: ["knock_screen", "chaos:knock", "startled"],
  hold_sign: ["hold_sign", "happy"],
};

/** Roughly how long each step takes before the next starts (ms). */
export const STEP_MS: Record<string, number> = { run: 2400, knock_screen: 1500, hold_sign: 0 };

/** Play the first name that works. Returns it (or null). Unit-tested. */
export function playFirst(step: string, play: (name: string) => boolean): string | null {
  for (const name of ACT_FALLBACKS[step] ?? [step]) if (play(name)) return name;
  return null;
}

/** Sign text: short, one or two lines. Unit-tested. */
export function signLines(text: string, perLine = 16): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last !== undefined && (last + " " + w).length <= perLine) lines[lines.length - 1] = `${last} ${w}`;
    else lines.push(w.length > perLine ? `${w.slice(0, perLine - 1)}…` : w);
  }
  if (lines.length > 2) {
    const second = lines[1];
    return [lines[0], second.length >= perLine ? `${second.slice(0, perLine - 1)}…` : `${second}…`];
  }
  return lines;
}

export interface ActHost {
  play(name: string): boolean;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
}

/** Shows the sign's text; returns a function that takes it down. */
export type SignStage = (lines: string[], label: string) => () => void;

/** The real stage: a DOM element over the canvas (styled in mascot.html). */
export function domSignStage(parent: HTMLElement): SignStage {
  return (lines, label) => {
    const el = document.createElement("div");
    el.className = "update-sign";
    el.setAttribute("role", "status");
    el.setAttribute("aria-label", label);
    for (const line of lines) {
      const span = document.createElement("span");
      span.textContent = line;
      el.append(span);
    }
    parent.append(el);
    return () => el.remove();
  };
}

export class UpdateActor {
  private timers: unknown[] = [];
  private takeDown: (() => void) | null = null;

  constructor(
    private readonly host: ActHost,
    private readonly stage: SignStage | null,
  ) {}

  run(act: UpdateAct): void {
    this.stop();
    let at = 0;
    const steps = act.steps.length ? act.steps : ["hold_sign"];
    for (const step of steps) {
      this.later(() => {
        playFirst(step, (n) => this.host.play(n));
        if (step === "hold_sign" && act.sign) this.showSign(act.sign, act.sign_ms || 8000);
      }, at);
      at += STEP_MS[step] ?? 1200;
    }
    // A sign without a hold_sign step still shows (at the end).
    if (act.sign && !steps.includes("hold_sign")) this.later(() => this.showSign(act.sign!, act.sign_ms || 8000), at);
  }

  stop(): void {
    for (const t of this.timers) this.host.clearTimeout(t);
    this.timers = [];
    this.takeDown?.();
    this.takeDown = null;
  }

  private later(fn: () => void, ms: number): void {
    this.timers.push(this.host.setTimeout(fn, ms));
  }

  private showSign(text: string, ms: number): void {
    if (!this.stage) return;
    this.takeDown?.();
    const down = this.stage(signLines(text), text);
    this.takeDown = down;
    this.later(() => {
      if (this.takeDown === down) {
        down();
        this.takeDown = null;
      }
    }, ms);
  }
}
