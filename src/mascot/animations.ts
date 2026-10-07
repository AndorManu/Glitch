// Which frames make up each animation, and a timer that plays them without
// ever using requestAnimationFrame (rAF would wake the CPU 60+ times/second).

export type AnimationName = "idle" | "walk" | "think" | "happy" | "sleep";

export interface Animation {
  frames: string[];
  fps: number;
  /** Play once then return to idle (otherwise loop). */
  once?: boolean;
}

function hold(frame: string, count: number): string[] {
  return Array<string>(count).fill(frame);
}

/** Hard cap so no animation can ever burn CPU, whatever its config says. */
export const MAX_FPS = 12;

export const ANIMATIONS: Record<AnimationName, Animation> = {
  // 6 s loop at 4 fps: mostly still, one quick blink, one antenna sway.
  // Repeated frames are held, so this is only ~0.7 repaints per second.
  idle: { frames: [...hold("idle0", 10), "blink", ...hold("idle0", 8), "idle1", "idle1", ...hold("idle0", 3)], fps: 4 },
  walk: { frames: ["walk0", "walk1"], fps: 6 },
  think: { frames: ["think0", "think1"], fps: 3 },
  happy: { frames: ["wave", "happy", "wave", "happy"], fps: 3, once: true },
  sleep: { frames: ["sleep0", "sleep1"], fps: 0.5 },
};

/** Delay between frames in ms, respecting MAX_FPS. */
export function frameDelay(anim: Animation): number {
  const fps = Math.min(Math.max(anim.fps, 0.1), MAX_FPS);
  return Math.round(1000 / fps);
}

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const realClock: Clock = {
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id as number),
};

/**
 * Plays an animation by calling `draw(frameName)` on a timer.
 * Exactly one timer is pending at any time; single-frame animations schedule
 * no timer at all; repeated frames are held (one timer, no redraw).
 */
export class Animator {
  private current: AnimationName = "idle";
  private index = 0;
  private timer: unknown = null;
  private lastDrawn: string | null = null;

  constructor(
    private readonly draw: (frame: string) => void,
    private readonly animations: Record<AnimationName, Animation> = ANIMATIONS,
    private readonly clock: Clock = realClock,
  ) {}

  get animation(): AnimationName {
    return this.current;
  }

  play(name: AnimationName): void {
    if (name === this.current && this.timer !== null) return;
    this.current = name;
    this.index = 0;
    this.lastDrawn = null; // always draw the first frame of a new animation
    this.tick();
  }

  stop(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private tick = (): void => {
    this.stop();
    const anim = this.animations[this.current];
    if (this.index >= anim.frames.length) {
      if (anim.once) {
        this.play("idle");
        return;
      }
      this.index = 0;
    }
    const frame = anim.frames[this.index];
    // Repaints are the expensive part: skip them when nothing changes.
    if (frame !== this.lastDrawn) {
      this.draw(frame);
      this.lastDrawn = frame;
    }
    // Hold repeated frames with one longer timer instead of several wakeups.
    let hold = 1;
    while (anim.frames[this.index + hold] === frame) hold += 1;
    this.index += hold;
    if (anim.frames.length > 1 || anim.once) {
      this.timer = this.clock.setTimeout(this.tick, frameDelay(anim) * hold);
    }
  };
}
