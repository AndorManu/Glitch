// What Glitch says when the chat opens. The full intro only on the very first
// start; after that a short, varied hello (or nothing, just the input pill),
// never one of the last few he used. Pure and unit-tested; the store is
// localStorage in the bubble page.

import { WELCOME } from "./chat-text";

export interface GreetingStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = "glitch.greeting";
/** How many recent greetings can't come back. */
const MEMORY = 6;
/** Chance of saying nothing at all (just the pill). */
const QUIET = 0.3;

const ANY = [
  "Yo. What are we breaking today?",
  "Back again? I missed you. A little.",
  "Hey hey. Need something?",
  "*crunches a pixel* Oh, hi!",
  "What's up?",
  "I was totally not napping. What do you need?",
  "Ready when you are.",
  "Hiya! Point me at a problem.",
  "Sup. I'm all ears. Literally, look at them.",
  "Ask away, I'm feeling smart today.",
  "Oh! A human. Hello!",
  "Talk to me.",
];
const MORNING = ["Morning! Coffee first, or chaos first?", "Good morning! What's the plan?", "Rise and glitch."];
const AFTERNOON = ["Afternoon! How's it going?", "Afternoon slump? I can help.", "Hey, what's next on the list?"];
const EVENING = ["Evening! Still at it?", "Hey night owl-in-training.", "Evening. Wrapping up, or just starting?"];
const NIGHT = ["It's late… what are we doing up?", "Midnight raccoon hours. What's up?", "Psst. Still awake?"];

function timePool(hour: number): string[] {
  if (hour >= 5 && hour < 12) return MORNING;
  if (hour >= 12 && hour < 18) return AFTERNOON;
  if (hour >= 18 && hour < 23) return EVENING;
  return NIGHT;
}

interface Memory {
  introduced: boolean;
  recent: string[];
}

function load(store: GreetingStore | null): Memory {
  try {
    const raw = store?.getItem(KEY);
    if (raw) {
      const m = JSON.parse(raw) as Partial<Memory>;
      return { introduced: m.introduced === true, recent: Array.isArray(m.recent) ? m.recent.filter((r) => typeof r === "string") : [] };
    }
  } catch {
    // Unreadable or blocked storage: behave like a first start, once.
  }
  return { introduced: false, recent: [] };
}

function save(store: GreetingStore | null, m: Memory): void {
  try {
    store?.setItem(KEY, JSON.stringify(m));
  } catch {
    // Not fatal: worst case he introduces himself again next time.
  }
}

/**
 * The greeting for this start: the full intro the first time, then a varied
 * short hello or `null` (stay quiet, just show the pill).
 */
export function pickGreeting(store: GreetingStore | null, now: Date = new Date(), rand: () => number = Math.random): string | null {
  const m = load(store);
  if (!m.introduced) {
    save(store, { introduced: true, recent: [] });
    return WELCOME;
  }
  if (rand() < QUIET) return null;
  const pool = [...ANY, ...timePool(now.getHours()), ...timePool(now.getHours())].filter((g) => !m.recent.includes(g));
  const choice = pool.length ? pool[Math.floor(rand() * pool.length)] : ANY[Math.floor(rand() * ANY.length)];
  save(store, { introduced: true, recent: [choice, ...m.recent].slice(0, MEMORY) });
  return choice;
}

export function browserStore(): GreetingStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
