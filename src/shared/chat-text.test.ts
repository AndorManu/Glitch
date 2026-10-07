import { describe, expect, it } from "vitest";
import { explainError } from "./chat-text";

describe("chat errors", () => {
  it("offers setup for fixable problems", () => {
    expect(explainError({ code: "ollama_unreachable", message: "" }).offerSetup).toBe(true);
    expect(explainError({ code: "model_missing", message: "" }).offerSetup).toBe(true);
    expect(explainError({ code: "ai_error", message: "boom" })).toEqual({ text: "Oops, something went wrong: boom", offerSetup: false });
  });
});
