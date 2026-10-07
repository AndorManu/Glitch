import { describe, expect, it } from "vitest";
import { BEHAVIOURS } from "../mascot/brain";
import { isAnimationName } from "../mascot/animations";
import { clipFor, LineQueue, parseConfig, placeX, readMs, STREAM_BEHAVIOURS, STREAMER_FRAMES } from "./queue";

describe("overlay line queue", () => {
  it("keeps alerts over chat when full", () => {
    const q = new LineQueue(3);
    q.push({ text: "c1", speaker: "a", alert: false });
    q.push({ text: "follow", speaker: null, alert: true });
    q.push({ text: "c2", speaker: "b", alert: false });
    expect(q.push({ text: "raid", speaker: null, alert: true })).toBe(true);
    expect(q.length).toBe(3);
    expect(q.next()?.text).toBe("follow"); // c1, the oldest chat line, made room
    expect(q.next()?.text).toBe("c2");
    expect(q.next()?.text).toBe("raid");
    expect(q.next()).toBeUndefined();
  });

  it("drops new chat when every slot is an alert", () => {
    const q = new LineQueue(2);
    q.push({ text: "a", speaker: null, alert: true });
    q.push({ text: "b", speaker: null, alert: true });
    expect(q.push({ text: "chat", speaker: "x", alert: false })).toBe(false);
    expect(q.push({ text: "c", speaker: null, alert: true })).toBe(true);
    expect(q.next()?.text).toBe("b");
  });

  it("reads long enough, never forever", () => {
    expect(readMs("hi")).toBe(3000);
    expect(readMs("x".repeat(80))).toBe(2200 + 80 * 55);
    expect(readMs("x".repeat(1000))).toBe(9000);
  });
});

describe("overlay reactions", () => {
  it("alerts have clips inside the sheet, chat has none", () => {
    for (const k of ["follow", "sub", "raid"] as const) {
      const c = clipFor(k)!;
      expect(c.frames.length).toBeGreaterThan(3);
      expect(c.frames.every((f) => f >= 0 && f < STREAMER_FRAMES)).toBe(true);
    }
    expect(clipFor("chat")).toBeNull();
  });

  it("the actions the server sends are real animations", () => {
    // src-tauri reaction(): wave / celebrate / dance / talk.
    for (const a of ["wave", "celebrate", "dance", "talk"]) expect(isAnimationName(a)).toBe(true);
  });

  it("the walking Glitch's behaviours exist", () => {
    for (const b of STREAM_BEHAVIOURS) expect(Object.prototype.hasOwnProperty.call(BEHAVIOURS, b)).toBe(true);
  });
});

describe("overlay layout and config", () => {
  it("places left, centre, right", () => {
    expect(placeX("left", 1920, 160)).toBe(24);
    expect(placeX("center", 1920, 160)).toBe(880);
    expect(placeX("right", 1920, 160)).toBe(1920 - 160 - 24);
    expect(placeX("right", 100, 160)).toBe(0);
  });

  it("parses config defensively", () => {
    expect(parseConfig({ mode: "walk", size: 2, position: "left", show_chat: false })).toEqual({ mode: "walk", size: 2, position: "left", show_chat: false });
    expect(parseConfig(null)).toEqual({ mode: "mirror", size: 1, position: "right", show_chat: true });
    expect(parseConfig({ mode: "x", size: 99, position: "<script>" }).size).toBe(3);
    expect(parseConfig({ size: Number.NaN }).size).toBe(1);
  });
});
