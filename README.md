# Glitch

A tiny pixel-art raccoon with a glitchy eye that lives on your desktop (Windows and macOS) and
doubles as a small, private AI assistant. Click Glitch to chat. Glitch runs a
small AI model **on your own computer** with [Ollama](https://ollama.com), so
your chats don't leave your machine.

This is **milestone 1: the foundation**. Voice, "chaos mode" and Claude Code
notifications are planned for later and are not in this build.

What works in this milestone:

* Glitch sits on top of your other windows and is properly alive: he
  breathes, fidgets, hops, glitches (slice/RGB-split/pixel bursts every so
  often), walks with a multi-frame bobbing run, dangles when you pick him up
  and lands with a squash, and curls up asleep after 10 quiet minutes. See
  [docs/ANIMATIONS.md](docs/ANIMATIONS.md) for every animation, including
  ready-made actions for later features (grabbing the cursor, dragging a
  window on a rope, teleporting).
* Click him and a **small round chat bubble** pops up above him. Type, press
  Enter; while he thinks you get a little thought cloud, and the answer
  appears as a speech bubble.
* A first-run wizard checks for Ollama, looks at how much memory your
  computer has, and suggests and downloads a model that fits.
* Glitch can **open web pages**, **open installed apps**, **search your files
  by name** and **open files or folders**. Anything except opening a web page
  asks you first (an Allow / Nope bubble).
* **Memory**: he remembers facts you tell him, compacts long chats into a
  short summary, keeps a one-line-per-day journal, and continues the chat
  after a restart. You can see and delete everything in Settings → Memory.
* Settings: choose the model, walking on/off, memory, clear chat, quit.

---

## 1. Run it on Windows

You need these once (all free):

1. **Microsoft C++ Build Tools**: download from
   <https://visualstudio.microsoft.com/visual-cpp-build-tools/>, run it, tick
   **"Desktop development with C++"**, install.
2. **WebView2**: already part of Windows 10 (recent updates) and Windows 11.
3. **Rust**: download and run `rustup-init.exe` from <https://rustup.rs>,
   accept the defaults.
4. **Node.js 22 LTS**: <https://nodejs.org> (the "LTS" installer).
5. **Git**: <https://git-scm.com/download/win>.

Then, in a new **PowerShell** window:

```powershell
git clone https://github.com/AndorManu/Glitch.git
cd Glitch
git checkout claude/jolly-babbage-i77mhy
npm install
npm run tauri dev
```

The first build takes several minutes (Rust compiles everything once); later
starts take seconds. Glitch appears in the bottom-right corner of your screen,
and on first run the setup panel opens next to it.

To build a normal installer instead: `npm run tauri build`. The installer ends
up in `target\release\bundle\nsis\` (named like `Glitch_0.1.0_x64-setup.exe`).

## 2. Run it on macOS

You need these once:

1. **Xcode Command Line Tools**: in Terminal run `xcode-select --install`.
2. **Rust**: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
   (accept the defaults, then open a new Terminal window).
3. **Node.js 22 LTS**: <https://nodejs.org> or `brew install node@22`.

Then in Terminal:

```bash
git clone https://github.com/AndorManu/Glitch.git
cd Glitch
git checkout claude/jolly-babbage-i77mhy
npm install
npm run tauri dev
```

Glitch appears in the bottom-right corner, and a small Glitch icon appears in
the **menu bar** (there is no Dock icon on purpose). Use that icon to quit.

To build a normal app: `npm run tauri build`; the app is at
`target/release/bundle/macos/Glitch.app`.

## 3. Or use a ready-made test build

Every push builds Glitch on GitHub's Windows and macOS machines (see
**Actions → CI → the latest run → Artifacts**): `glitch-windows` contains the
installer, `glitch-macos` a zipped universal `Glitch.app` (Apple Silicon and
Intel). These builds are **not code-signed**, so:

* **Windows**: SmartScreen says "Windows protected your PC" → **More info →
  Run anyway**.
* **macOS**: the first open is blocked → open **System Settings → Privacy &
  Security**, scroll down, click **Open Anyway** next to Glitch.

## 4. First run

1. If Ollama is missing, the panel shows a **Download Ollama** button (opens
   ollama.com). Install it, come back, click **I've installed it**. If Ollama
   is installed but not running, click **Start Ollama**.
2. Glitch shows how much memory your computer has and suggests a model. Click
   **Download … and continue** (a few GB; progress is shown).
3. Chat! Try:
   * "open twitter on elon musk's page": opens `https://x.com/elonmusk` straight away
   * "open the calculator": asks first, then opens the Calculator app
   * "find a photo of a dog": asks first, searches file *names* in Desktop,
     Documents, Downloads, Pictures, Music and Videos, then can open the
     result (asks again)

---

## Why Tauri (and not Electron)

| | **Tauri 2** (chosen) | Electron |
|---|---|---|
| What ships | Your code + the OS's own web view (WebView2 on Windows, WKWebView on macOS) | Your code + a full copy of Chromium + Node.js |
| Installer size | a few MB | ~80–150 MB |
| Memory | Lower. On macOS WKWebView is light. On Windows, WebView2 is itself Chromium-based and multi-process, so the saving is real but smaller than on macOS | Highest: browser, GPU and one renderer process per window, every app ships its own |
| Backend | Rust: fast, no garbage collector, idles at ~0 CPU | Node.js main process |
| Transparent, frameless, always-on-top window | Supported on both (`transparent`, `decorations: false`, `alwaysOnTop`) | Supported on both, widely used for desktop pets |
| Transparency reliability | Windows: WebView2 transparency works on Windows 10/11. macOS: needs a private macOS API, which Tauri ≥ 2.12.1 turns on automatically | Mature on both; Electron has had longer to iron out edge cases |

Priority #1 for Glitch is "never weigh the computer down", so the smaller
footprint and the Rust backend decided it. The price: Tauri's transparency has
had fewer years of real-world use than Electron's, which is why it is first
on the manual checklist below.

**Known platform limitations:**

* **macOS, private API**: transparent windows rely on a private macOS API.
  Apple doesn't allow private APIs in the Mac App Store, so Glitch must be
  distributed directly (download/DMG), not through the App Store.
* **macOS, file permissions**: the first time Glitch searches Desktop,
  Documents or Downloads, macOS asks "Glitch would like to access files in
  your … folder". Glitch can only search folders you allow.
* **macOS, full-screen apps**: Glitch is set to show on all Spaces, but it
  may not float over another app's *full-screen* Space. Untested.
* **Windows, tray icon** may be hidden behind the **^** arrow in the taskbar
  until you drag it out.
* **Both**: the mascot window is a 160×110 rectangle. Clicks on its transparent
  corners still go to Glitch rather than to the window underneath.
* **Unsigned builds** trigger SmartScreen / Gatekeeper warnings (see above).
  Code signing is a release task for a later milestone.
* **Linux** isn't a target. It builds and mostly runs (used for CI and the
  smoke test), but app discovery isn't implemented there.

## How it is built

```
src/                     frontend (TypeScript, no framework)
  mascot/                mascot window: animator, walker, click/drag
  mascot/                animations, glitch effects, props, walking, input
  bubble/                the chat bubble (compose pill, replies, thinking cloud)
  panel/                 setup wizard + settings (incl. Memory)
  sprites/               sprite-sheet frame map, loader, fallback art
art/                     the original character art (source of the sheet)
public/sprites/          the generated sprite sheet the app loads
scripts/make-sprites.py  art → sprite sheet + app icon
  shared/ipc.ts          typed calls into Rust
src-tauri/               thin app shell: windows, tray, IPC commands
  tauri.conf.json        mascot window: transparent, frameless, on top
  src/os.rs              app-shell OS differences (macOS: no Dock icon)
crates/glitch-core/      all the logic, no UI dependency, unit-tested
  src/ai/                AiProvider trait + Ollama implementation
  src/models.rs          RAM → model tiers (one table)
  src/tools/             open_url, open_app, search_files, open_path
  src/confirm.rs         which actions need your OK (one table)
  src/agent.rs           chat loop: model → tools → confirm → model
  src/platform/          the ONLY OS-specific logic (windows.rs, macos.rs)
  src/settings.rs        settings JSON file
docs/PLAN.md             the plan this milestone followed
docs/ANIMATIONS.md       every animation + the art wishlist
dev/                     screenshot scripts and the animation gallery (dev only)
```

**Swappable AI backend.** Everything talks to the `AiProvider` trait
(`crates/glitch-core/src/ai/mod.rs`). Ollama is the only implementation. An
API-key provider would be a new file implementing `chat()`.

**What differs per OS** is all in `crates/glitch-core/src/platform/`:

| | Windows | macOS |
|---|---|---|
| Installed apps | Start Menu `.lnk` shortcuts (per-user + all users) | `.app` bundles in /Applications, /System/Applications (+ Utilities), ~/Applications |
| Ollama location | `%LOCALAPPDATA%\Programs\Ollama\ollama app.exe`, or `ollama.exe` on PATH | `/Applications/Ollama.app`, `~/Applications/Ollama.app`, or the `ollama` CLI (Homebrew) |
| Opening things | `ShellExecuteW` (via the `open` crate) | `/usr/bin/open` (via the `open` crate) |
| User folders | Known Folder IDs (OneDrive-redirected folders work) | ~/Desktop, ~/Documents, ~/Downloads, ~/Pictures, ~/Music, ~/Movies |

## Staying lightweight

* **No AI in memory until you chat.** Glitch only loads the model when you
  send a message, with Ollama's `keep_alive: "2m"`, so Ollama unloads it
  2 minutes after your last message. Switching models or quitting Glitch
  unloads the model immediately. The context window is capped
  (`num_ctx: 4096`) and the chat history is trimmed, which keeps the model's
  memory use down.
* **Small models only.** Picked from total RAM (`crates/glitch-core/src/models.rs`).
  Every pick is a small model that supports tool calling in the Ollama library:

  | Total RAM | Suggested | Download | Alternatives |
  |---|---|---|---|
  | under 6 GB | `qwen3.5:0.8b` | ~1.0 GB | `qwen3:0.6b` |
  | 6–12 GB (8 GB PCs) | `qwen3.5:2b` | ~2.7 GB | `qwen3:1.7b`, `llama3.2:3b`, `qwen3.5:0.8b` |
  | 12–24 GB (16 GB PCs) | `qwen3.5:4b` | ~3.4 GB | `qwen3:4b`, `llama3.2:3b`, `qwen3.5:2b` |
  | 24 GB or more | `qwen3.5:9b` | ~6.6 GB | `qwen3:8b`, `qwen3.5:4b` |

  Sizes are approximate. The wizard shows the real download progress. For
  thinking-capable models Glitch sends `think: false` so replies come quickly.
* **Animation has no frame loop.** No `requestAnimationFrame`: frames are
  drawn on timers capped at 20 fps, unchanged frames are not redrawn, and
  repeated frames share one timer. Idle Glitch (including his random glitch
  bursts) averages under one repaint per second, a sleeping Glitch about one
  every 2.4 s; this is enforced by unit tests. Walking redraws and moves the
  window 15 times per second, only for a few seconds every 25–75 s, and
  never while the chat is open. The bubble's thought-cloud animation only
  exists while Glitch is thinking.
* **The chat bubble and the settings panel are only created when first
  opened**, then hidden (not destroyed), so the conversation is kept.
* **Memory compaction** runs right after a reply, while the model is still
  loaded anyway, so it never wakes the model up by itself.
* **File search is bounded**: max depth 8, 200,000 entries, 4 seconds, 15
  results; it skips hidden folders, `node_modules`, `AppData`, `Library` etc.

Measured in this project's Linux test environment (no GPU, software
rendering, debug build, which is a worst case): about **0.5% of one CPU core**
idle and about **1.1%** averaged with walking turned on. On Windows/macOS with
GPU compositing and a release build it should be lower, **but that hasn't
been measured yet**. See the checklist.

## Safety model

The AI can **only** call four tools, and every call is checked in Rust before
anything happens (the UI can't skip these checks):

| Tool | Runs without asking? | Checks |
|---|---|---|
| `open_url` | **yes** | only `http`/`https`; adds `https://` if missing; refuses `file:`, `javascript:`, custom app schemes, URLs containing passwords |
| `open_app` | asks first | must match an app found on this computer; terminals, PowerShell/Command Prompt, Registry Editor, Script Editor, Automator, Shortcuts are refused outright |
| `search_files` | asks first | file **names** only, in your standard folders, bounded (above) |
| `open_path` | asks first | must exist inside your home or user folders (after resolving `..` and symlinks); programs, scripts, installers, shortcuts, disk images and `.app` bundles are refused, as are files marked executable |
| `remember` / `forget` | yes (only Glitch's own notes) | always shown as a chip, visible and deletable in Settings → Memory; passwords, PINs and long numbers are refused |

There is no tool to delete, move, rename or edit files and no shell access.
A confirmation is a one-time ID held in Rust: a stale or replayed "Allow"
does nothing, and typing a new message cancels any pending request. The rule
"only URLs run without asking" is one table in `crates/glitch-core/src/confirm.rs`.

## The character art

Glitch is the raccoon in `art/glitch-raccoon-source.webp` (16 poses).
`scripts/make-sprites.py` finds each pose by the empty space around it, puts
them all on one same-size canvas (feet on a shared baseline so Glitch doesn't
jump between poses) and writes:

* `public/sprites/glitch.png`: the 4×4 sprite sheet the app loads (frames
  276×180, twice the on-screen size so it's sharp on high-DPI screens)
* `src-tauri/icons/source.png`: the app icon source (front pose)

Which pose plays when is set in `src/sprites/raccoon.ts`:

The animations themselves (keyframes with squash/stretch, hops, glitch
effects and small code-drawn props like a cursor and a mini browser window)
are in `src/mascot/animations.ts`; [docs/ANIMATIONS.md](docs/ANIMATIONS.md)
lists every one, what triggers it, and **which new poses would improve it
most**, ready to paste into an image generator. Preview them all with
`npm run dev` and open http://localhost:1420/dev/gallery.html.

**To change the art:** replace the source image (same rough 4×4 layout,
transparent background), then run

```bash
pip install pillow numpy
python3 scripts/make-sprites.py
npx tauri icon src-tauri/icons/source.png
```

and adjust the pose numbers in `src/sprites/raccoon.ts` if the order
changed. Any art works through the `SpriteSet` interface
(`src/sprites/types.ts`). If the sheet ever fails to load, Glitch falls back
to a tiny code-drawn creature (`src/sprites/glitch.ts`), so the app still works.

---

## Tests and what was verified

**Automated (runs in CI on every push):**

* `cargo test --workspace`: 101 Rust tests (incl. memory: facts, secrets
  refused, compaction with a scripted model, journal roll-over, restart)
  * Ollama client against a mock HTTP server using the documented API
    responses: request body (`stream:false`, `keep_alive`, `num_ctx`,
    `tools`, `think:false` only for thinking models), tool-call parsing,
    tool results with `tool_name`, 404 → "model missing", error bodies, pull
    progress streaming and mid-stream errors, unload (`keep_alive: 0`),
    capability caching, unreachable server
  * RAM tiers (including how the OS under-reports RAM), settings file
  * every tool's validation (URL schemes, app matching and block list, file
    search limits, path escapes via `..`/symlinks, executables)
  * confirmation gate (one-time IDs, stale/replayed approvals) and the agent
    loop with a scripted fake model (auto URL, approve, decline, invalid
    calls, loop cap, history trimming)
  * panel placement next to Glitch (multi-monitor, screen edges)
* `npm test`: 63 frontend tests: animation engine (one timer max, idle and
  sleep repaint budgets over 40 random seeds, every animation ends or loops
  as intended), deterministic glitch slicing, walker stays on screen, bubble
  state machine (stale confirmations, double answers), text helpers, wizard
  and memory-card helpers.
* `node dev/bubble-check.mjs`: 40 browser checks of the bubble with mocked IPC.
* CI also **builds the real app on Windows and macOS runners**, which proves
  the OS-specific code compiles and the unit tests pass on both OSes.

**Smoke-tested by running the actual app** (Linux, virtual display, mock
Ollama, driven by xdotool): Glitch renders and is placed bottom-right, the
setup wizard opens beside it, choosing a model saves settings, "open twitter on
elon musk's page" opened `https://x.com/elonmusk` with no prompt, "find a
photo of a dog" showed the confirmation card, and Allow ran the search and
found the test file. This run caught three bugs, which are fixed.

**NOT verified (I had no Windows or macOS desktop):**

* transparency (no box/border/white flash behind Glitch) on Windows and macOS
* always-on-top behaviour, including over full-screen apps
* dragging, click-vs-drag detection, walking smoothness, DPI scaling
* the tray / menu-bar icon and its menu
* real app discovery and launching (Start Menu shortcuts, `.app` bundles)
* starting Ollama from the wizard, and a real model download and real chat
  with a real Ollama model (the smoke test used a mock)
* macOS file-permission prompts, Gatekeeper/SmartScreen flows
* actual idle CPU and RAM on Windows/macOS

## Manual test checklist

Do this on **each** OS. Before you start, quit any running Ollama so you can
test the wizard from scratch.

**Appearance and behaviour**

- [ ] Glitch appears bottom-right with **no** box, border, shadow or white
      flash around it (fully transparent background)
- [ ] Glitch stays on top when you click other windows
- [ ] No white/grey fringe around the raccoon's outline
- [ ] It shifts its tail now and then; within ~1–2 minutes it walks a short way
      and stays fully on screen (also on a second monitor)
- [ ] Dragging Glitch moves it and he dangles; letting go plays a fall + landing
- [ ] A simple click (no drag) opens the chat bubble right above him; clicking
      again (or Esc, or ×) closes it; dragging him moves the bubble along
- [ ] Looks crisp (not blurry) on a high-DPI / Retina screen
- [ ] No taskbar button (Windows) / no Dock icon (macOS); tray / menu-bar icon
      is present, and its menu works (Chat, Let Glitch wander, Quit)
- [ ] Settings → turn off "walk around": it stops walking (tray tick updates too)
- [ ] Leave it alone for 10 minutes: it curls up asleep (Zzz); hover wakes it
- [ ] While it's thinking it shows the "?" pose and the bubble shows a thought
      cloud; after a reply it waves or laughs
- [ ] Every so often (8–25 s) he glitches briefly (sliced/RGB-split flicker)
- [ ] Near the top of the screen the bubble appears below him (tail up)

**Setup wizard**

- [ ] With Ollama not installed: the "Download Ollama" button opens the right page
- [ ] With Ollama installed but not running: "Start Ollama" starts it and the
      wizard moves on
- [ ] Memory size shown matches your computer; suggested model is sensible
- [ ] Downloading shows progress and then opens the chat

**Chat and tools**

- [ ] "hi" gets a reply (first reply may take a while: model loading)
- [ ] "open twitter on elon musk's page" opens x.com/elonmusk in your default
      browser **without** asking
- [ ] "open the calculator" (or Spotify, etc.) shows an Allow / Nope bubble;
      Allow opens it, Nope doesn't
- [ ] "open a terminal" / "open powershell" is refused
- [ ] Put a file named `dog.jpg` in Pictures. "find a photo of a dog" asks,
      then lists it; asking to open it asks again, then opens it
      (macOS: the folder-access prompt appears once; allow it)
- [ ] Typing a new message while an Allow card is waiting disables the card
- [ ] Stop Ollama mid-session and send a message: a friendly error with
      "Fix it" appears

**Memory**

- [ ] "Remember that my dog is called Rex" shows a "Remembered" chip and the
      fact appears in Settings → Memory; × deletes it
- [ ] "Remember my password is 1234" is refused
- [ ] Chat for a while (15+ messages): Settings → Memory → "What we talked
      about" shows a summary
- [ ] Quit and restart Glitch: he still knows the fact and the last chat

**Lightweight**

- [ ] Idle CPU of Glitch (Task Manager → Details: `glitch.exe` +
      `msedgewebview2.exe` children / Activity Monitor: Glitch + its web-content
      helper processes) stays near 0%
- [ ] Note Glitch's memory use with the chat closed and open
- [ ] After chatting, wait ~2 minutes: `ollama ps` (in a terminal) shows no
      loaded model; quitting Glitch frees it immediately

## Troubleshooting

* **"I can't reach Ollama"**: make sure the Ollama app is running (llama icon
  in the tray / menu bar), or open the panel → Settings → Run setup again.
* **Replies are slow**: pick a smaller model in Settings. The first reply after
  a pause is always slower (the model is loading).
* **Settings and memory files**: `settings.json` and `memory.json` in
  `%APPDATA%\dev.glitch.companion\` (Windows) or
  `~/Library/Application Support/dev.glitch.companion/` (macOS).
  Delete `settings.json` to start the wizard again; delete `memory.json` (or
  use Settings → Memory → Forget everything) to wipe his memory.

## Next milestone (suggested)

1. **Hands-on polish from the checklist above**: fix whatever transparency,
   DPI or always-on-top issues show up on real machines; measure real idle
   CPU/RAM and set a budget.
2. **Streaming replies** (show words as they arrive) and a way to stop a reply.
3. **Use the unused poses**: glitch/laugh reactions, being dragged, peeking at
   a window for notifications; and draw a blink frame.
4. **Signed builds and auto-update** so ordinary users can install with no
   warnings.
5. **Faster file search** through Spotlight (`mdfind`) on macOS and Windows
   Search, and click-through on the transparent pixels.
6. Then the planned features: voice, chaos mode, Claude Code notifications,
   plus an API-key provider behind the existing `AiProvider` trait.
