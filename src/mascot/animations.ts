// Which frames make up each animation, and a timer that plays them without
// ever using requestAnimationFrame (rAF would wake the CPU 60+ times/second).

export type AnimationName = "idle" | "walk" | "think" | "happy" | "sleep";

export interface Animation {
  frames: string[];
  fps: number;
  /** Play once then return to idle (otherwise loop). */
  once?: boolean;
}

/** Hard cap so no animation can ever burn CPU, whatever its config says. */
export const MAX_FPS = 12;

export const ANIMATIONS: Record<AnimationName, Animation> = {
  // ~4 s loop: mostly still, one sway, one blink.
  idle: { frames: ["idle0", "idle0", "idle0", "idle1", "idle0", "idle0", "blink", "idle0", "idle0", "idle1", "idle0", "idle0"], fps: 3 },
  walk: { frames: ["walk0", "walk1"], fps: 6 },
  think: { frames: ["think0", "think1"], fps: 3 },
  happy: { frames: ["happy", "happy", "idle0", "happy", "happy", "idle0"], fps: 4, once: true },
  sleep: { frames: ["sleep0", "sleep1"], fps: 1 },
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
 * no timer at all.
 */
export class Animator {
  private current: AnimationName = "idle";
  private index = 0;
  private timer: unknown = null;

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
    this.draw(anim.frames[this.index]);
    this.index += 1;
    if (anim.frames.length > 1 || anim.once) {
      this.timer = this.clock.setTimeout(this.tick, frameDelay(anim));
    }
  };
}
