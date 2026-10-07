import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Two small pages, no framework. See https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    // WebView2 (Windows) is evergreen Chromium; WKWebView on macOS 11+ is Safari 14+.
    target: ["es2020", "chrome105", "safari14"],
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    rollupOptions: {
      input: {
        mascot: resolve(import.meta.dirname, "mascot.html"),
        panel: resolve(import.meta.dirname, "panel.html"),
        bubble: resolve(import.meta.dirname, "bubble.html"),
        note: resolve(import.meta.dirname, "note.html"),
        pawprints: resolve(import.meta.dirname, "pawprints.html"),
      },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
