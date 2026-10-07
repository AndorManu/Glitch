import { describe, expect, it } from "vitest";
import { actionChip, baseName, breakChunks, centerOn, graphemes, narrowestFit, urlBreaks, revealedAt, shortUrl, tailWithin, typingDuration, TYPE_MAX_MS } from "./text";

describe("shortUrl", () => {
  it("drops the scheme, www and trailing slash", () => {
    expect(shortUrl("https://x.com/elonmusk")).toBe("x.com/elonmusk");
    expect(shortUrl("https://www.youtube.com/")).toBe("youtube.com");
    expect(shortUrl("http://example.org/a?b=1")).toBe("example.org/a?b=1");
  });
  it("shows only the host for long URLs", () => {
    expect(shortUrl("https://www.google.com/search?q=cute+raccoons+in+the+snow")).toBe("google.com");
  });
  it("leaves non-web strings alone", () => {
    expect(shortUrl("not a url")).toBe("not a url");
    expect(shortUrl("mailto:a@b.c")).toBe("mailto:a@b.c");
  });
});

describe("actionChip", () => {
  it("shortens opened URLs and paths", () => {
    expect(actionChip("Opened https://x.com/elonmusk")).toEqual({ text: "Opened x.com/elonmusk", full: "Opened https://x.com/elonmusk", ok: true });
    expect(actionChip("Opened /home/me/My Docs/cv final.pdf").text).toBe("Opened cv final.pdf");
    expect(actionChip("Opened C:\\Users\\me\\Pictures\\dog.png").text).toBe("Opened dog.png");
  });
  it("keeps other summaries and spots failures", () => {
    expect(actionChip("Opened Spotify")).toEqual({ text: "Opened Spotify", full: "Opened Spotify", ok: true });
    expect(actionChip("Searched files for “dog”: 3 found").text).toBe("Searched files for “dog”: 3 found");
    expect(actionChip("Couldn't open the app").ok).toBe(false);
    expect(actionChip("Couldn’t open it").ok).toBe(false);
  });
});

describe("baseName", () => {
  it("handles both separators and trailing slashes", () => {
    expect(baseName("/a/b/c/")).toBe("c");
    expect(baseName("C:\\x\\y.txt")).toBe("y.txt");
    expect(baseName("plain")).toBe("plain");
  });
});

describe("typewriter", () => {
  it("never splits emoji or accents", () => {
    expect(graphemes("hi 👋🏽!")).toEqual(["h", "i", " ", "👋🏽", "!"]);
    expect(graphemes("")).toEqual([]);
  });
  it("is fast and capped", () => {
    expect(typingDuration(10)).toBe(160);
    expect(typingDuration(10_000)).toBe(TYPE_MAX_MS);
    expect(typingDuration(0)).toBe(0);
  });
  it("reveals monotonically from nothing to everything", () => {
    const n = 120;
    let last = -1;
    for (let t = 0; t <= TYPE_MAX_MS + 50; t += 16) {
      const r = revealedAt(t, n);
      expect(r).toBeGreaterThanOrEqual(last);
      last = r;
    }
    expect(revealedAt(0, n)).toBe(0);
    expect(revealedAt(TYPE_MAX_MS, n)).toBe(n);
    expect(revealedAt(5, 0)).toBe(0);
  });
});

describe("geometry", () => {
  it("centres a shape on the tail, inside the margins", () => {
    expect(centerOn(150, 100, 300, 6)).toBe(100);
    expect(centerOn(20, 100, 300, 6)).toBe(6);
    expect(centerOn(290, 100, 300, 6)).toBe(194);
    expect(centerOn(150, 400, 300, 6)).toBe(-50);
  });
  it("keeps tails off the rounded corners", () => {
    expect(tailWithin(150, 100, 100, 18)).toBe(50);
    expect(tailWithin(20, 6, 288, 18)).toBe(18);
    expect(tailWithin(299, 6, 288, 18)).toBe(270);
    expect(tailWithin(10, 0, 20, 18)).toBe(10);
  });
});

describe("breakChunks", () => {
  it("breaks after separators only", () => {
    expect(breakChunks("/usr/share/spotify.desktop")).toEqual(["/", "usr/", "share/", "spotify.desktop"]);
    expect(breakChunks("C:\\Apps\\x.exe")).toEqual(["C:\\", "Apps\\", "x.exe"]);
    expect(breakChunks("https://a.com/b?c=1")).toEqual(["https://", "a.com/", "b?", "c=", "1"]);
    expect(breakChunks("")).toEqual([]);
  });
});

describe("urlBreaks", () => {
  const breaksIn = (s: string) => {
    const chars = graphemes(s);
    return [...urlBreaks(chars)].map((i) => chars.slice(0, i + 1).join(""));
  };
  it("breaks links after their separators only", () => {
    expect(breaksIn("see https://a.com/b?c=1&d=2 ok")).toEqual([
      "see https://a.com/",
      "see https://a.com/b?",
      "see https://a.com/b?c=",
      "see https://a.com/b?c=1&",
      "see https://a.com/b?c=1&d=",
    ]);
  });
  it("leaves plain text and the end of a link alone", () => {
    expect(breaksIn("a/b and c=d, no links")).toEqual([]);
    expect(breaksIn("https://x.com/")).toEqual([]);
  });
  it("counts graphemes, not UTF-16 units", () => {
    const chars = graphemes("👋 https://a.com/b");
    expect([...urlBreaks(chars)]).toEqual([chars.indexOf("/", 10)]);
  });
});

describe("narrowestFit", () => {
  it("finds the smallest width that fits", () => {
    const tested: number[] = [];
    const fits = (w: number) => (tested.push(w), w >= 137);
    expect(narrowestFit(60, 220, fits)).toBe(137);
    expect(tested.length).toBeLessThan(12);
  });
  it("never trusts the upper bound without testing it", () => {
    // Natural width measured as 79 (rounded) but the text needs 79.4px:
    // 79 must not be returned.
    expect(narrowestFit(60, 80, (w) => w >= 79.4)).toBe(80);
    expect(narrowestFit(60, 79, (w) => w >= 79.4)).toBeNull();
  });
  it("handles fractional and collapsed ranges", () => {
    expect(narrowestFit(50.2, 50.7, () => true)).toBe(51);
    expect(narrowestFit(90, 90, () => true)).toBe(90);
  });
});
