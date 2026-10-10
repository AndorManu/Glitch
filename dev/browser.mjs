// Shared bits for the dev screenshot/check scripts.
//
// Browser: PW_CHROMIUM=<path> uses that Chromium binary; otherwise Edge on
// Windows (it's what WebView2 is built on, so the closest to the real app),
// else Playwright's bundled Chromium.
// Dev server: GLITCH_DEV_URL (default http://localhost:1420).
import { chromium } from "playwright";

export const BASE = (process.env.GLITCH_DEV_URL ?? "http://localhost:1420").replace(/\/$/, "");

export function launch() {
  if (process.env.PW_CHROMIUM) return chromium.launch({ executablePath: process.env.PW_CHROMIUM });
  if (process.platform === "win32") return chromium.launch({ channel: "msedge" });
  return chromium.launch();
}
