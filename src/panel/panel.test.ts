import { describe, expect, it } from "vitest";
import { memorySummary } from "./memory";
import type { SetupStatus } from "../shared/ipc";
import { GLITCH } from "../sprites/glitch";
import { checkGrid } from "../sprites/load";
import { squareCrop } from "./avatar";
import { chooseLabel, formatGb, modelOptions, ollamaSummary, prettyModelName, progressText, sameModel } from "./setup";

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
    settings: { model, movement_enabled: true, onboarding_done: false, ollama_url: "", keep_alive: "2m", memory_enabled: true },
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

describe("panel display helpers", () => {
  it("prettifies model tags", () => {
    expect(prettyModelName("qwen3.5:4b")).toBe("Qwen 3.5 · 4B");
    expect(prettyModelName("llama3.2:latest")).toBe("Llama 3.2");
    expect(prettyModelName("gemma3n:e2b")).toBe("Gemma 3n");
    expect(prettyModelName("mistral")).toBe("Mistral");
    expect(prettyModelName("phi3:3.8b-mini-q4")).toBe("Phi 3 · 3.8B");
    expect(prettyModelName("deepseek-r1:8b")).toBe("Deepseek-r1 · 8B");
  });

  it("formats sizes and the choose button", () => {
    expect(formatGb(3.4)).toBe("3.4 GB");
    expect(formatGb(2.04)).toBe("2 GB");
    expect(chooseLabel({ installed: true, sizeGb: 2 })).toBe("Use this brain");
    expect(chooseLabel({ installed: false, sizeGb: 3.4 })).toBe("Download & continue (≈3.4 GB)");
  });

  it("summarises Ollama and memory in one line", () => {
    expect(ollamaSummary(status([]))).toEqual({ state: "running", text: "Ollama 0.12.0 is running · 7.8 GB of memory" });
    const stopped = status([]);
    stopped.ollama = { ...stopped.ollama, state: "stopped", version: null };
    expect(ollamaSummary(stopped).text).toBe("Ollama is installed but not running · 7.8 GB of memory");
  });

  it("crops a square portrait out of a wide frame", () => {
    expect(squareCrop(16, 16)).toEqual({ x: 0, y: 0, w: 16, h: 16 });
    expect(squareCrop(276, 180)).toEqual({ x: 48, y: 0, w: 180, h: 180 });
    // focus near the right edge is clamped inside the frame
    expect(squareCrop(276, 180, 1)).toEqual({ x: 96, y: 0, w: 180, h: 180 });
    expect(squareCrop(276, 180, 0.62, 1.2)).toEqual({ x: 96, y: 0, w: 150, h: 150 });
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

describe("memory card", () => {
  const base = { enabled: true, facts: [], summary: "", journal: [] };
  it("summarises what Glitch remembers", () => {
    expect(memorySummary(base)).toBe("Nothing remembered yet.");
    expect(memorySummary({ ...base, enabled: false })).toMatch(/off/);
    expect(
      memorySummary({ ...base, facts: [{ id: 1, text: "Likes cats", added: "2026-10-07" }], journal: [{ date: "d", text: "t" }] }),
    ).toBe("Remembers 1 thing · 1 earlier day");
  });
});
