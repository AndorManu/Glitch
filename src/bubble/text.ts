// Pure text and geometry helpers for the chat bubble (unit-tested).

/** Longest "host/path" we show in an action chip before falling back to the host. */
const MAX_URL_CHARS = 26;

/**
 * A URL as people say it: "x.com/elonmusk" instead of
 * "https://www.x.com/elonmusk/". Long ones become just the host.
 * Anything that isn't an http(s) URL comes back unchanged.
 */
export function shortUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return raw;
  const host = u.hostname.replace(/^www\./, "");
  const path = (u.pathname + u.search).replace(/\/+$/, "");
  const full = host + path;
  return full.length <= MAX_URL_CHARS ? full : host;
}

/** Last part of a file path, Windows or Unix. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function looksLikePath(s: string): boolean {
  return /^(\/|~[\\/]|[A-Za-z]:[\\/]|\\\\)/.test(s);
}

export interface ActionChip {
  /** What the chip shows ("Opened x.com"). */
  text: string;
  /** The untouched summary from Rust (tooltip / screen readers). */
  full: string;
  /** false for "Couldn't …" summaries. */
  ok: boolean;
}

/**
 * Action summaries from Rust ("Opened https://x.com/elonmusk",
 * "Opened /home/me/Documents/cv.pdf", "Couldn't open the app") made
 * chip-sized.
 */
export function actionChip(summary: string): ActionChip {
  const full = summary.trim();
  const ok = !/^couldn['’]?t\b|^could not\b|^failed\b/i.test(full);
  const m = /^(\S+)\s+(.+)$/.exec(full);
  let text = full;
  if (m) {
    const [, verb, rest] = m;
    if (/^https?:\/\//i.test(rest)) text = `${verb} ${shortUrl(rest)}`;
    else if (looksLikePath(rest)) text = `${verb} ${baseName(rest)}`;
  }
  return { text, full, ok };
}

// ------------------------------------------------------------ typewriter

/**
 * Split text into user-perceived characters so the typewriter never shows
 * half an emoji. Falls back to code points where Intl.Segmenter is missing.
 */
export function graphemes(text: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  if (Seg) {
    const out: string[] = [];
    for (const s of new Seg(undefined, { granularity: "grapheme" }).segment(text)) out.push(s.segment);
    return out;
  }
  return Array.from(text);
}

/** Typing speed: about 60 characters a second, but never longer than this. */
export const TYPE_MS_PER_CHAR = 16;
export const TYPE_MAX_MS = 1000;

/** How long typing `count` characters takes, in ms. */
export function typingDuration(count: number): number {
  return Math.min(TYPE_MAX_MS, Math.max(0, count) * TYPE_MS_PER_CHAR);
}

/** How many of `count` characters are visible `elapsed` ms after typing began. */
export function revealedAt(elapsed: number, count: number): number {
  const total = typingDuration(count);
  if (count <= 0 || elapsed >= total) return count;
  if (elapsed <= 0) return 0;
  return Math.min(count, Math.ceil((elapsed / total) * count));
}

// -------------------------------------------------------------- geometry

/**
 * Left edge for a shape `size` wide, centred on `anchor` but kept inside
 * [margin, container - margin].
 */
export function centerOn(anchor: number, size: number, container: number, margin: number): number {
  const max = container - margin - size;
  if (max <= margin) return Math.round((container - size) / 2);
  return Math.round(Math.min(max, Math.max(margin, anchor - size / 2)));
}

/**
 * Where a tail goes inside a shape that starts at `left` and is `size`
 * wide: under `anchor`, but at least `inset` away from either edge (so it
 * never sits on a rounded corner).
 */
export function tailWithin(anchor: number, left: number, size: number, inset: number): number {
  const x = anchor - left;
  if (size <= inset * 2) return Math.round(size / 2);
  return Math.round(Math.min(size - inset, Math.max(inset, x)));
}

/**
 * Split a path or URL after its separators so it can wrap at "/" instead
 * of mid-word: "/usr/share/a.desktop" -> ["/", "usr/", "share/", "a.desktop"].
 */
export function breakChunks(s: string): string[] {
  // (No lookbehind: Safari 14 can't parse it.)
  return s.match(/[^\\/?&=]*[\\/?&=]+|[^\\/?&=]+/g) ?? [];
}
