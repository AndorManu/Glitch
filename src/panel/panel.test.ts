import { describe, expect, it } from "vitest";
import type { SetupStatus } from "../shared/ipc";
import { GLITCH } from "../sprites/glitch";
import { checkGrid } from "../sprites/load";
import { explainError } from "./chat";
import { modelOptions, progressText, sameModel } from "./setup";

function status(installed: SetupStatus["installed"], model: string | null = null): SetupStatus {
  return {
    os: "windows",
    ollama: { state: "running", version: "0.12.0", download_url: "https://ollama.com/download/windows" },
    recommendation: {
      tier: "8 GB class",
      total_ram_gb: 7.8,
      primary: { name: "qwen3.5:2b", download_gb: 2.7 },
      alternatives: [{ name: "llama3.2:3b", download_gb: 2.0 }],
      note: null,
    },
    installed,
    settings: { model, movement_enabled: true, onboarding_done: false, ollama_url: "", keep_alive: "2m" },
  };
}

describe("setup wizard helpers", () => {
  it("matches model names with implicit :latest", () => {
    expect(sameModel("llama3.2", "llama3.2:latest")).toBe(true);
    expect(sameModel("qwen3.5:2b", "qwen3.5:4b")).toBe(false);
  });

  it("lists recommended first and marks downloaded ones", () => {
    const opts = modelOptions(
      status([
        { name: "llama3.2:3b", size_gb: 2.0, supports_tools: true },
        { name: "mistral:latest", size_gb: 4.1, supports_tools: true },
        { name: "nomic-embed-text:latest", size_gb: 0.3, supports_tools: false },
      ]),
    );
    expect(opts.map((o) => o.name)).toEqual(["qwen3.5:2b", "llama3.2:3b", "mistral:latest"]);
    expect(opts[0]).toMatchObject({ recommended: true, installed: false });
    expect(opts[1]).toMatchObject({ installed: true });
  });

  it("turns pull progress into friendly text", () => {
    expect(progressText({ status: "pulling manifest", completed: null, total: null }).label).toBe("Getting ready…");
    expect(progressText({ status: "pulling abc", completed: 50, total: 200 })).toEqual({ label: "Downloading… 25%", percent: 25 });
    expect(progressText({ status: "success", completed: null, total: null }).label).toBe("Done!");
    expect(progressText({ status: "something new", completed: null, total: null }).label).toBe("something new");
  });
});

describe("chat errors", () => {
  it("offers setup for fixable problems", () => {
    expect(explainError({ code: "ollama_unreachable", message: "" }).offerSetup).toBe(true);
    expect(explainError({ code: "model_missing", message: "" }).offerSetup).toBe(true);
    expect(explainError({ code: "ai_error", message: "boom" })).toEqual({ text: "Oops, something went wrong: boom", offerSetup: false });
  });
});

describe("sprite art", () => {
  it("every frame is a well-formed 16x16 grid using palette colours", () => {
    expect(checkGrid(GLITCH)).toEqual({ width: 16, height: 16 });
  });
  it("checkGrid reports typos clearly", () => {
    expect(() => checkGrid({ kind: "grid", palette: {}, frames: { a: ["..", "."] } })).toThrow(/row 1 has 1 pixels/);
    expect(() => checkGrid({ kind: "grid", palette: {}, frames: { a: [".x"] } })).toThrow(/unknown colour "x"/);
  });
});
