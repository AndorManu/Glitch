// What the stream overlay shows next: speech bubbles one at a time, and the
// "streamer" reaction clips (art: public/sprites/streamer.png, 8 frames).
// Pure logic, unit-tested in overlay.test.ts.

export type EventKind = "follow" | "sub" | "raid" | "chat";

/** A "react" event from the server (src-tauri/src/stream/mod.rs handle_event). */
export interface Reaction {
  kind: EventKind;
  /** An animation / behaviour name for the mascot (wave, celebrate, dance, talk). */
  action: string;
  line: string;
  /** Chat lines: who said it. */
  speaker: string | null;
}

export interface Line {
  text: string;
  speaker: string | null;
  /** Alerts (follow/sub/raid) are never dropped for chat. */
  alert: boolean;
}

/** How long a bubble stays up: long enough to read, never forever. */
export function readMs(text: string): number {
  return Math.round(Math.min(9000, Math.max(3000, 2200 + text.length * 55)));
}

/**
 * Bubbles waiting to be shown. At most `max`: when full, the oldest chat
 * line goes first; if they are all alerts, the new chat line is dropped.
 */
export class LineQueue {
  private items: Line[] = [];
  constructor(readonly max = 5) {}

  get length(): number {
    return this.items.length;
  }

  push(l: Line): boolean {
    if (this.items.length >= this.max) {
      const chat = this.items.findIndex((x) => !x.alert);
      if (chat >= 0) this.items.splice(chat, 1);
      else if (!l.alert) return false;
      else this.items.shift();
    }
    this.items.push(l);
    return true;
  }

  next(): Line | undefined {
    return this.items.shift();
  }
}

/** Streamer sheet frames: 0-1 wave, 2 hype jump, 3 clap, 4 laugh, 5 point, 6 shocked, 7 thumbs up. */
export const STREAMER_FRAMES = 8;
export const STREAMER_W = 104;
export const STREAMER_H = 90;
/** CSS px per art px (same as the app's sheet). */
export const STREAMER_SCALE = 1.5;

/** The clip for an alert: frame indices, each held `ms`. Chat lines have none (he just talks). */
export function clipFor(kind: EventKind): { frames: number[]; ms: number } | null {
  switch (kind) {
    case "follow":
      return { frames: [0, 1, 0, 1, 0, 1, 7, 7], ms: 220 };
    case "sub":
      return { frames: [6, 2, 3, 2, 3, 4, 4, 7, 7], ms: 230 };
    case "raid":
      return { frames: [6, 6, 2, 3, 2, 3, 2, 4, 5, 7], ms: 240 };
    default:
      return null;
  }
}

export type Position = "left" | "center" | "right";

/** Left edge (CSS px) of a box `w` wide on a page `pageW` wide. */
export function placeX(pos: Position, pageW: number, w: number, margin = 24): number {
  if (pos === "left") return margin;
  if (pos === "center") return Math.round((pageW - w) / 2);
  return Math.max(0, pageW - w - margin);
}

/** Behaviours the walking stream Glitch may pick: he stays on the floor. */
export const STREAM_BEHAVIOURS = new Set(["stroll", "run", "lookAround", "lookBack", "malfunction", "sleep", "celebrate"]);

export interface OverlayConfig {
  mode: "mirror" | "walk";
  size: number;
  position: Position;
  show_chat: boolean;
}

/** Defensive parse of the "config" event (bad values fall back to defaults). */
export function parseConfig(raw: unknown): OverlayConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const size = typeof o.size === "number" && Number.isFinite(o.size) ? Math.min(3, Math.max(0.5, o.size)) : 1;
  return {
    mode: o.mode === "walk" ? "walk" : "mirror",
    size,
    position: o.position === "left" || o.position === "center" ? o.position : "right",
    show_chat: o.show_chat !== false,
  };
}
