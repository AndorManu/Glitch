import { describe, expect, it } from "vitest";
import { AUTOSTART_HINT, autostartLine, chordFromKey, hotkeyLine, PAUSE_HINT } from "./safety";
import { FEATURES } from "./index";
import type { SafetyStatus } from "../../shared/ipc";

const key = (code: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}) => ({
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

const status = (over: Partial<SafetyStatus> = {}): SafetyStatus => ({
  paused: false,
  hotkey: { combo: "Ctrl+Alt+Shift+G", registered: true, error: null },
  default_hotkey: "Ctrl+Alt+Shift+G",
  start_with_windows: false,
  autostart_supported: true,
  autostart_active: false,
  autostart_error: null,
  ...over,
});

describe("safety feature card", () => {
  it("is registered, and first", () => {
    expect(FEATURES.map((f) => f.id)[0]).toBe("safety");
  });

  it("writes key presses the way the Rust side parses them", () => {
    expect(chordFromKey(key("KeyG", { ctrlKey: true, altKey: true, shiftKey: true }))).toBe("Ctrl+Alt+Shift+G");
    expect(chordFromKey(key("KeyP", { altKey: true, ctrlKey: true }))).toBe("Ctrl+Alt+P");
    expect(chordFromKey(key("Digit5", { ctrlKey: true, altKey: true }))).toBe("Ctrl+Alt+5");
    expect(chordFromKey(key("F12", { ctrlKey: true, altKey: true }))).toBe("Ctrl+Alt+F12");
    expect(chordFromKey(key("F24", { ctrlKey: true, altKey: true }))).toBe("Ctrl+Alt+F24");
    expect(chordFromKey(key("Space", { ctrlKey: true, altKey: true }))).toBe("Ctrl+Alt+Space");
    expect(chordFromKey(key("ArrowUp", { altKey: true, shiftKey: true }))).toBe("Alt+Shift+Up");
    expect(chordFromKey(key("PageDown", { ctrlKey: true, altKey: true }))).toBe("Ctrl+Alt+PageDown");
    expect(chordFromKey(key("KeyH", { metaKey: true, altKey: true }))).toBe("Alt+Super+H");
  });

  it("waits for a real key, and refuses keys that can't be hotkeys", () => {
    for (const code of ["ControlLeft", "AltRight", "ShiftLeft", "MetaLeft", "Escape", "Enter", "Tab", "Backspace", "F25", "F0", "NumpadAdd", "Comma", "KeyGG", ""]) {
      expect(chordFromKey(key(code, { ctrlKey: true, altKey: true })), code).toBeNull();
    }
  });

  it("says whether the hotkey is active", () => {
    expect(hotkeyLine(status().hotkey)).toEqual({ text: "Active: Ctrl+Alt+Shift+G. Works in every app.", tone: "ok" });
    const taken = hotkeyLine({ combo: "Ctrl+Alt+F9", registered: false, error: "another program already uses that shortcut" });
    expect(taken.tone).toBe("error");
    expect(taken.text).toContain("another program already uses that shortcut");
    expect(taken.text).toContain("tray icon still works");
    expect(hotkeyLine({ combo: "Ctrl+Alt+F9", registered: false, error: null }).text).toContain("isn't active.");
  });

  it("explains the startup entry", () => {
    expect(autostartLine(status())).toBeNull();
    expect(autostartLine(status({ start_with_windows: true, autostart_active: true }))).toBeNull();
    expect(autostartLine(status({ start_with_windows: true, autostart_active: false }))?.text).toContain("written again");
    expect(autostartLine(status({ autostart_supported: false }))?.text).toContain("Windows");
    expect(autostartLine(status({ autostart_error: "denied" }))?.tone).toBe("error");
  });

  it("never uses em or en dashes", () => {
    const dashes = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
    for (const t of [PAUSE_HINT, AUTOSTART_HINT, hotkeyLine(status().hotkey).text, autostartLine(status({ autostart_supported: false }))?.text ?? ""]) {
      expect(t).not.toMatch(dashes);
    }
  });
});
