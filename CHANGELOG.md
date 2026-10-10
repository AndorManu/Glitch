# Changelog

All notable changes to Glitch. Generated from git history by scripts/changelog.mjs, then tidied by hand.

## [0.1.0] - 2026-10-08

The first release. Glitch is a pixel raccoon who lives on your desktop: he
walks on your windows, chats with a local AI (Ollama, nothing leaves your
computer), listens when you hold the mic key, makes harmless mischief if you
let him, reacts to what you're doing, can star on your stream as an OBS
overlay, and keeps himself up to date.

### Streaming and updates

- Auto-update: tauri-plugin-updater against GitHub Releases, signature-pinned
- Overlay art: the streamer reaction sheet (8 frames, headset) sliced for the stream overlay
- Stream overlay server: 127.0.0.1 HTTP + SSE, Streamer.bot and Twitch readers, separate view/write tokens
- Stream overlay core: events, reactions, HTTP routing, WebSocket client, Streamer.bot and Twitch IRC parsers, settings

### He reacts to what you're doing

- Context: readable focus-done line, reactor in the dev hook
- Mascot reacts to context: reaction plans with art fallbacks, hush for games and focus, hover countdown
- Context sensor: native readings, poller, focus mode (tray, tool), chaos and reminders hush while quiet
- Context reactions core: sensor rules, focus timer, settings, now_playing and focus_mode tools

### Voice

- Voice: hands-free stops 0.8 s after the last word (was 1.2 s)
- Voice: language auto-detect no longer runs the full 30 s encoder
- Voice: model-aware encoder window, honest "mic warming up" hint, docs
- Voice works on Windows: whisper runs, optimized, 0.2-0.6 s per command
- Panel: no settings flash on toggles, cleaner voice card, wipe confirm
- Glitch roams the desktop + voice commands, integrated and smoke-tested

### Chaos mode

- Paw prints: real pixel paws that stamp, trail and glitch away
- Chaos: the sticky note and paw overlay appear without taking keyboard focus
- Chaos mode: push, cursor grab, notes and paw prints verified on Windows; tests and docs
- Chaos mode: Glitch drags other apps' windows, chases the cursor, leaves paw prints, sticky notes

### Chat, memory and skills

- Tune the prompt to 100% on the live eval; dedupe repeated side effects; docs
- Glitch sees the screen in the app: native capture, clipboard, timers, live steps
- Glitch can see the screen and run multi-step tool chains (core)
- Chat: bubble sits on his head, varied greetings instead of the same intro
- He says his replies: the bubble emits mascot-talk (window event) when a reply or question appears, the mascot plays the talk loop for about as long as it takes to read, then returns to his mood
- Bubble: a click during the close animation reopens it; Clear chat reports failures
- Bubble: drop the pending close timer once Rust has hidden the bubble
- Bubble: Clear chat keeps a running speech-model download visible
- Memory that works on small models; streamed model pulls in ollama-check
- Windows: find and open built-in and Store apps (Calculator, Photos, ...)
- Bubble: springy open/close, URL wrapping, Clear chat, AA contrast
- Bubble chat, living glitchy mascot, action animations
- Memory: facts, rolling summary and daily journal that compact themselves
- Plumbing for a bubble chat: bubble window, panel for setup/settings only
- Ollama client: omit tools for models without tool support
- Frontend: animated mascot, setup wizard, chat and settings
- Core: OS abstraction, safe tools, confirmation gate and agent loop
- Core: provider-neutral AI interface and Ollama client

### Settings and setup

- Settings: Features section with the 'He reacts to what you're doing' card
- Wire dizzy, sneeze, typing, point, land, sit, push, grab_tab, peek; pixel-sheet panel portrait
- Panel: redraw settings when saving the model or movement fails
- Panel: "Forgetting..." no longer reset by blur mid-wipe
- Panel: entrance class no longer sticks (replayed on every redraw)
- Panel: polished setup wizard and settings in Glitch's style
- Tauri shell: mascot + panel windows, tray menu, IPC commands
- Core: RAM-based model recommendation and settings file

### Glitch himself

- Glitch never uses em or en dashes
- Mascot: the 'looking' mood (studying a screenshot) plays the curious listen pose
- Smaller edge slide steps; wall poses never on the floor
- Fix the four repeatable pops from the release QA
- cling_cursor without the drawn arrow, held by its grip; annoyed; regenerated fish, wall_jump, sit_idle_look
- Held check in the real app: hangs straight from the scruff (evidence + regression tests)
- Holding feels natural, annoyance reactions, walk v3 matched to the ground speed
- Palette snap, sheet audit and quality lineup
- Playful moves, feet on the edge, contact shadow
- QA fixes: facing-aware turns, edge sitting, air/ledge animations, richer idle, walk cycle follows ground speed
- Standing on a window: ride along smoothly, fall for real when it leaves
- Display sheets at the exact device size; clip families; turns on walls; new air/ledge sheets sliced
- Front-facing frames never mirror; clips aligned to the frames they join; continuity audit
- Transition system: pose families, transition clips between them, drawn turns, walk start/stop, varied idle fidgets
- Sprites: no grey halo on dark desktops
- New walk (glitch eye in every frame, 3 px bob instead of 6, steady x) and the side-view wall crawl for climb, cling and lookBack
- Slicing: drop the neighbour's stray glitch pixels from frames
- Second batch of drawn cycles: think, sleep, wake, dangle, laugh, listen, surprised, spin, teleport, celebrate, sad, angry, scared, dance, eat
- Slicing: remove background halos, keep the run tail inside the canvas; animated GIF previews from the real Animator
- Animation sheet from the generated on-model cycles: walk 8, run 6, idle 8, wave 8, talk 8, jump 8
- Mascot click-through: clickable within 120 ms, cursor read without the event loop
- Fixes from the technical review: Windows deadlock, safety, perf, robustness
- Native world for a free-roaming Glitch: window tops as ledges, click-through
- Use the raccoon character art for Glitch
- Fixes from a real smoke run; cut idle repaints

### Developer tools and docs

- Feature card test: no literal dash characters in source
- docs: visual QA report, first pass (frames, animations, switch matrix, clicks, hold, annoyance, moods, world)
- docs: security review 2026-10-08 (merged code + in-progress worktrees)
- dev: visual QA tooling (frame audit, animation and switch audit, stage scenarios)
- Lint: as_chunks for the screenshot pixel swap
- Lint: cargo fmt, clippy question_mark in chaos_drag_window
- Track the art generation scripts, ignore their logs and review images
- dev/qa-film.mjs: animation QA recorder (fake clock, 50 ms frames, cut detection, strips)
- Gallery shows the animation sheet (?old=1 for the old sheet)
- dev/windows-smoke.mjs: end-to-end test of the real app over WebView2 CDP
- Fix open_path test on Windows: test the paths that are dangerous there
- Dev: screenshot every bubble and panel state, run on Windows
- dev: live check against a real Ollama (dev/ollama-check)
- Dev: add playwright for page screenshots in development
- README: run steps per OS, stack choice, safety model, test checklist
- CI: tests on Linux, real builds on Windows and macOS
- Add milestone 1 plan and project structure
