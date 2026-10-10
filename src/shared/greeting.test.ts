import { describe, expect, it } from "vitest";
import { WELCOME } from "./chat-text";
import { pickGreeting, type GreetingStore } from "./greeting";

function memStore(): GreetingStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe("greeting", () => {
  it("introduces himself only on the very first start", () => {
    const s = memStore();
    expect(pickGreeting(s, new Date(2026, 9, 7, 10), () => 0.9)).toBe(WELCOME);
    for (let i = 0; i < 20; i++) expect(pickGreeting(s, new Date(2026, 9, 7, 10), () => 0.9 - i * 0.03)).not.toBe(WELCOME);
  });

  it("never repeats one of the last few greetings", () => {
    const s = memStore();
    pickGreeting(s);
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 0.7 + 0.3; // never quiet
    const said: string[] = [];
    for (let i = 0; i < 40; i++) said.push(pickGreeting(s, new Date(2026, 9, 7, 15), rand)!);
    for (let i = 1; i < said.length; i++) expect(said.slice(Math.max(0, i - 6), i)).not.toContain(said[i]);
  });

  it("sometimes stays quiet, and survives broken storage", () => {
    const s = memStore();
    pickGreeting(s);
    expect(pickGreeting(s, new Date(), () => 0.1)).toBeNull();
    const broken: GreetingStore = { getItem: () => "{nope", setItem: () => { throw new Error("blocked"); } };
    expect(pickGreeting(broken)).toBe(WELCOME);
    expect(pickGreeting(null)).toBe(WELCOME);
  });
});

import { noDashes, plainText } from "./chat-text";

describe("no dashes", () => {
  it("rewrites em and en dashes the way the Rust side does", () => {
    expect(plainText("It's sunny in space—his Starlink thing!")).toBe("It's sunny in space, his Starlink thing!");
    expect(noDashes("Pick one – the red one.")).toBe("Pick one, the red one.");
    expect(noDashes("Takes 3–5 minutes")).toBe("Takes 3-5 minutes");
    expect(noDashes("Done —.")).toBe("Done.");
    expect(noDashes("— a list item")).toBe("- a list item");
  });
});
