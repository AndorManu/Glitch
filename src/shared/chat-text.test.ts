import { describe, expect, it } from "vitest";
import { askPermission, explainError, lookingText, plainText } from "./chat-text";

describe("chat errors", () => {
  it("offers setup for fixable problems", () => {
    expect(explainError({ code: "ollama_unreachable", message: "" }).offerSetup).toBe(true);
    expect(explainError({ code: "model_missing", message: "" }).offerSetup).toBe(true);
    expect(explainError({ code: "ai_error", message: "boom" })).toEqual({ text: "Oops, something went wrong: boom", offerSetup: false });
  });
});

describe("askPermission", () => {
  it("turns a confirmation title into a question", () => {
    expect(askPermission("Open the app “Spotify”")).toBe("Can I open the app “Spotify”?");
    expect(askPermission("Open a web page")).toBe("Can I open a web page?");
    expect(askPermission("Search your files for “dog” (photos).")).toBe("Can I search your files for “dog” (photos)?");
  });

  it("keeps acronyms and handles empty titles", () => {
    expect(askPermission("URL check")).toBe("Can I URL check?");
    expect(askPermission("  ")).toBe("Can I go ahead?");
  });
});

describe("plain text (same rules as agent.rs plain_text)", () => {
  it("drops markdown and the speaker label", () => {
    expect(plainText("Glitch: Hi!")).toBe("Hi!");
    expect(plainText("**Glitch:** Use `prices[i]` **now**")).toBe("Use prices[i] now");
    expect(plainText("## Fix\n* one\n* two")).toBe("Fix\n- one\n- two");
    expect(plainText("2 * 3 = 6")).toBe("2 * 3 = 6");
    expect(plainText("Change it:\n```python\ntotal += prices[i]\n```")).toBe("Change it:\ntotal += prices[i]");
  });
  it("says where Glitch is looking", () => {
    expect(lookingText("screen")).toContain("looking at your screen");
    expect(lookingText("cursor")).toContain("mouse");
  });
});
