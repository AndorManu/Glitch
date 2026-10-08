import { describe, expect, it } from "vitest";
import { BRAIN_HINT, brainChoices, HANDS_HINT } from "./hands";
import { FEATURES } from "./index";

describe("app control feature card", () => {
  it("is registered", () => {
    expect(FEATURES.map((f) => f.id)).toContain("hands");
  });

  it("offers the chat brain first, then tool-capable models", () => {
    const c = brainChoices(
      [
        { name: "qwen3.5:4b", size_gb: 3.3, supports_tools: true },
        { name: "qwen2.5:7b", size_gb: 4.7, supports_tools: null },
        { name: "chatonly:1b", size_gb: 1, supports_tools: false },
      ],
      null,
    );
    expect(c.map((x) => x.value)).toEqual(["", "qwen3.5:4b", "qwen2.5:7b"]);
    expect(brainChoices([], "gone:7b").map((x) => x.value)).toEqual(["", "gone:7b"]);
  });

  it("never uses em or en dashes", () => {
    for (const t of [HANDS_HINT, BRAIN_HINT]) expect(t).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`));
  });
});
