import { describe, expect, it } from "vitest";
import { bannerText } from "./text";

describe("driving banner", () => {
  it("names the app and the key", () => {
    const t = bannerText("Spotify");
    expect(`${t.before}${t.key}${t.after}`).toBe("Glitch is driving Spotify, press Esc to stop");
    expect(bannerText("  ").before).toContain("an app");
    expect(bannerText("x".repeat(100)).before.length).toBeLessThan(70);
  });
});
