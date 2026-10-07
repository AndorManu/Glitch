// Holding and throwing Glitch: the throw velocity from recent cursor
// samples, and the pendulum he swings on while you carry him around.
// Pure, unit-tested; creature.ts feeds it cursor positions.

import type { Vec } from "./physics";

/**
 * Cursor velocity over the last `windowMs` (least squares, so one jittery
 * sample doesn't decide the throw). Samples are polled at a steady rate, so
 * a cursor that stopped before the release reads as ~0: no accidental throws.
 */
export class VelocityTracker {
  private samples: { t: number; x: number; y: number }[] = [];

  constructor(
    private readonly windowMs = 80,
    private readonly keep = 24,
  ) {}

  add(t: number, p: Vec): void {
    const last = this.samples[this.samples.length - 1];
    if (last && t <= last.t) {
      last.x = p.x;
      last.y = p.y;
      return;
    }
    this.samples.push({ t, x: p.x, y: p.y });
    if (this.samples.length > this.keep) this.samples.shift();
  }

  clear(): void {
    this.samples = [];
  }

  /** Units per second. */
  velocity(now: number): Vec {
    const recent = this.samples.filter((s) => s.t >= now - this.windowMs);
    // The cursor stopped being sampled a while ago: it isn't moving.
    if (recent.length < 2) return { x: 0, y: 0 };
    const n = recent.length;
    const mt = recent.reduce((a, s) => a + s.t, 0) / n;
    const mx = recent.reduce((a, s) => a + s.x, 0) / n;
    const my = recent.reduce((a, s) => a + s.y, 0) / n;
    let stt = 0;
    let stx = 0;
    let sty = 0;
    for (const s of recent) {
      stt += (s.t - mt) ** 2;
      stx += (s.t - mt) * (s.x - mx);
      sty += (s.t - mt) * (s.y - my);
    }
    if (stt <= 0) return { x: 0, y: 0 };
    return { x: (stx / stt) * 1000, y: (sty / stt) * 1000 };
  }
}

/** Clamp a vector's length. */
export function capSpeed(v: Vec, max: number): Vec {
  const s = Math.hypot(v.x, v.y);
  return s <= max ? v : { x: (v.x / s) * max, y: (v.y / s) * max };
}

/**
 * A damped pendulum hanging from the cursor. `phi` = angle of the body
 * centre around the grab point, 0 = straight below, + = swung to the right
 * (radians). Moving the cursor accelerates the pivot, which swings him:
 *   L phi'' = -(g - ay) sin(phi) - ax cos(phi) - c L phi'
 */
export class Pendulum {
  omega = 0;

  constructor(
    public phi: number,
    /** Effective length for the dynamics (same units as g / a). */
    private readonly length: number,
    private readonly g: number,
    private readonly damping = 2.6,
  ) {}

  step(dt: number, accel: Vec): void {
    // Small fixed substeps: stable for any frame time.
    let left = Math.min(dt, 0.1);
    while (left > 1e-9) {
      const h = Math.min(1 / 240, left);
      left -= h;
      const alpha = (-(this.g - accel.y) * Math.sin(this.phi) - accel.x * Math.cos(this.phi)) / this.length - this.damping * this.omega;
      this.omega += alpha * h;
      this.omega = Math.max(-18, Math.min(18, this.omega));
      this.phi += this.omega * h;
    }
    // Keep phi in (-pi, pi].
    if (this.phi > Math.PI) this.phi -= 2 * Math.PI;
    if (this.phi <= -Math.PI) this.phi += 2 * Math.PI;
  }

  /** Velocity of the bob relative to the pivot, for a real distance `r`. */
  tipVelocity(r: number): Vec {
    return { x: r * this.omega * Math.cos(this.phi), y: -r * this.omega * Math.sin(this.phi) };
  }
}
