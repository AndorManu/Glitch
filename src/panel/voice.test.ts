import { describe, expect, it } from "vitest";
import { hotkeyText, speechModelLabel, unavailableText } from "./voice";

const base = { id: "base", label: "Base", blurb: "", file: "ggml-base.bin", size_bytes: 147951465, size_mb: 142, downloaded: false };

describe("settings → voice helpers", () => {
  it("labels speech models", () => {
    expect(speechModelLabel(base)).toBe("Base · 142 MB");
    expect(speechModelLabel({ ...base, downloaded: true })).toBe("Base · 142 MB ✓");
  });

  it("explains the shortcut, or that it's taken", () => {
    const ok = hotkeyText({ os: "windows", hotkey: { label: "Ctrl+Shift+Space", registered: true, error: null } });
    expect(ok.warn).toBe(false);
    expect(ok.text).toMatch(/hold Ctrl\+Shift\+Space anywhere/);
    const mac = hotkeyText({ os: "macos", hotkey: { label: "Cmd+Shift+Space", registered: true, error: null } });
    expect(mac.text).toMatch(/Cmd\+Shift\+Space anywhere on your Mac/);
    const taken = hotkeyText({ os: "windows", hotkey: { label: "Ctrl+Shift+Space", registered: false, error: "in use" } });
    expect(taken.warn).toBe(true);
    expect(taken.text).toMatch(/another app/);
  });

  it("says why voice is off", () => {
    expect(unavailableText("cpu")).toMatch(/processor/);
    expect(unavailableText("platform")).toMatch(/isn't available/);
  });
});
