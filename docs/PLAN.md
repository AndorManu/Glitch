# Glitch – Milestone 1 plan

Goal: a tiny pixel-art desktop companion (Windows + macOS) that you can click to
chat with a **local** Ollama model, and that can call a handful of safe tools.

## Stack decision (short version — full reasoning in the README)

**Tauri 2** (Rust backend + the OS's own webview) with a **vanilla TypeScript**
frontend built by Vite. No UI framework: the UI is two tiny pages.

* Memory: Tauri reuses WebView2 (Windows) / WKWebView (macOS) instead of shipping
  Chromium + Node like Electron. Typical idle footprint is tens of MB instead of
  100–200+ MB, and the installer is a few MB instead of ~100 MB.
* Transparency: both frameworks can do transparent, frameless, always-on-top
  windows on Windows and macOS. Tauri ≥ 2.12.1 enables the macOS transparent
  background API unconditionally (it used to need `macOSPrivateApi`).
  Known caveats are listed in the README.
* Rust backend = all logic that matters (AI client, tools, safety checks)
  lives in a plain Rust library that we can unit-test headlessly in CI.

## Architecture

```
┌──────────── frontend (TypeScript, runs in the OS webview) ────────────┐
│ mascot window: sprite renderer, frame scheduler (capped fps), walker  │
│ panel window : onboarding wizard, chat, confirmation cards, settings │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ Tauri IPC (invoke / channels)
┌───────────────────────────────▼──────────────────────────────────────┐
│ src-tauri (thin shell): windows, tray menu, commands, app state      │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ plain Rust calls
┌───────────────────────────────▼──────────────────────────────────────┐
│ crates/glitch-core  (no Tauri dependency → headless unit tests)      │
│  ai/       AiProvider trait + Ollama implementation                  │
│  models    RAM → recommended model tiers                             │
│  tools/    open_url, open_app, search_files, open_path               │
│  confirm   which tool calls need the user's OK, pending-action store │
│  agent     chat loop: model → tool calls → confirm → run → model     │
│  platform/ the ONLY place with OS differences (Windows/macOS/Linux)  │
│  settings  JSON settings file                                        │
└──────────────────────────────────────────────────────────────────────┘
```

Safety rules are enforced in Rust (glitch-core), never only in the UI:
the model can only call the four tools, every tool except `open_url` needs
a confirmation id that the UI got from the user, URLs must be http(s), and
nothing can delete/move/edit files or run shell commands.

## Project structure

```
Glitch/
├─ Cargo.toml                 workspace (glitch-core + src-tauri)
├─ crates/glitch-core/        testable core library
├─ src-tauri/                 Tauri app shell (config, tray, commands, icons)
├─ src/                       frontend
│  ├─ mascot/                 mascot window (sprite, animation, walker)
│  ├─ panel/                  chat / onboarding / settings window
│  ├─ sprites/                placeholder pixel art (swap for real art here)
│  └─ shared/                 IPC wrappers + types
├─ mascot.html, panel.html    Vite entry pages
├─ docs/PLAN.md               this file
└─ .github/workflows/ci.yml   tests + builds on Windows and macOS runners
```

## Commit plan

1. Plan + structure (this file)
2. Core: AI provider trait + Ollama client (+ mock-server tests)
3. Core: RAM-based model recommendation + settings
4. Core: platform layer + tools + confirmation logic + agent loop (+ tests)
5. Tauri shell: windows, tray, IPC commands
6. Frontend: mascot (sprite, capped animation, walking) + vitest tests
7. Frontend: panel (first-run wizard, chat, confirmations, settings)
8. README (run steps per OS, manual test checklist) + CI for Windows/macOS

## Out of scope for this milestone

Voice, chaos mode, Claude Code notifications, API-key providers (only the
interface exists), real art.
