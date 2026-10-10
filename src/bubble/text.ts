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

const URL_RE = /\bhttps?:\/\/[^\s<>"“”]+/gi;
const URL_SEPARATORS = "/?&=+#";

/**
 * Where links in a reply may wrap: after the separators inside each URL
 * (not in "https://"), so a long link breaks at "/" or "&" instead of
 * mid-word. Returns grapheme indices to break after. Unit-tested.
 */
export function urlBreaks(chars: string[]): Set<number> {
  const out = new Set<number>();
  const text = chars.join("");
  if (!/https?:\/\//i.test(text)) return out;
  // Character offset where each grapheme ends.
  const ends: number[] = [];
  let at = 0;
  for (const c of chars) ends.push((at += c.length));
  for (const m of text.matchAll(URL_RE)) {
    // Keep "https://" with the host name.
    const start = (m.index ?? 0) + m[0].indexOf("//") + 2;
    const end = (m.index ?? 0) + m[0].length;
    for (let i = 0; i < chars.length; i++) {
      const offset = ends[i] - chars[i].length;
      if (offset < start || ends[i] >= end) continue;
      if (URL_SEPARATORS.includes(chars[i]) && !URL_SEPARATORS.includes(chars[i + 1] ?? "")) out.add(i);
    }
  }
  return out;
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

/**
 * Smallest whole width in [lo, hi] for which `fits(width)` holds, assuming
 * everything wider fits too. `hi` itself is always tested (never trusted),
 * so a rounded-down measurement can't squeeze text onto an extra line.
 * Returns null when not even `hi` fits.
 */
export function narrowestFit(lo: number, hi: number, fits: (width: number) => boolean): number | null {
  lo = Math.ceil(lo);
  hi = Math.ceil(hi);
  if (!fits(hi)) return null;
  // Invariant: hi fits; everything below lo is assumed not to.
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) hi = mid;
    else lo = mid + 1;
  }
  return hi;
}
