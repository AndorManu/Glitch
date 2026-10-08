// "Update me" in the bubble: things Glitch says by himself (a reminder,
// Claude Code is done, a script finished, the notification digest, the
// daily briefing) and their buttons. Rust keeps the latest undelivered one,
// so an update that arrived while the bubble was closed is shown on open.

import { listen } from "@tauri-apps/api/event";
import { updateMeApi, type UpdateSpeech } from "../shared/ipc";
import type { BubbleEvent } from "./state";

export interface UpdateHost {
  dispatch(e: BubbleEvent): void;
  /** Glitch is answering something (updates wait until he's done). */
  busy(): boolean;
}

/** The briefing as an update speech (one per day). Unit-tested. */
export function briefingSpeech(text: string, day: string): UpdateSpeech {
  return { id: `brief:${day}`, text, icon: "briefing", choices: [] };
}

export class UpdateMe {
  private held: UpdateSpeech | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly host: UpdateHost) {}

  /** Show it now, or as soon as Glitch is free. Unit-tested. */
  show(s: UpdateSpeech): void {
    if (this.host.busy()) {
      this.held = s;
      this.timer ??= setInterval(() => {
        if (this.host.busy() || !this.held) return;
        const next = this.held;
        this.held = null;
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.show(next);
      }, 800);
      return;
    }
    this.host.dispatch({ type: "update", speech: s });
    void updateMeApi.seen(s.id).catch(() => {});
  }

  /** A button was clicked. */
  async choose(id: string, choice: string): Promise<void> {
    this.host.dispatch({ type: "update_answered", id });
    const next = await updateMeApi.choose(id, choice).catch(() => null);
    if (next) this.show(next);
  }

  /** The bubble opened: anything missed, else the day's briefing. */
  async opened(): Promise<void> {
    const pending = await updateMeApi.pending().catch(() => null);
    if (pending) return this.show(pending);
    const text = await updateMeApi.briefing().catch(() => null);
    if (text) this.show(briefingSpeech(text, new Date().toDateString()));
  }

  listen(): void {
    void listen<UpdateSpeech>("glitch-update", (e) => this.show(e.payload)).catch(() => {});
  }
}
