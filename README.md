# Glitch

A tiny pixel-art raccoon with a glitchy eye that lives on your desktop (Windows and macOS) and
doubles as a small, private AI assistant. Click Glitch to chat. Glitch runs a
small AI model **on your own computer** with [Ollama](https://ollama.com), so
your chats don't leave your machine.

This is **milestone 1: the foundation** (plus voice commands and chaos
mode). Claude Code notifications are planned for later.

What works in this milestone:

* Glitch **lives on your whole desktop**, Shimeji-style: he walks along the
  taskbar, climbs up the screen edges, crawls upside-down along the top,
  jumps onto **the tops of your open windows** and walks/sits on them (if you
  move or close that window he rides along or falls), glitch-teleports, and
  sometimes builds himself a glowing glitch platform. He breathes, fidgets
  and glitches (slice/RGB-split/pixel bursts) for real.
* **Grab him and throw him**: real gravity, spin, bounces off the screen
  edges, a squash (or splat + dizzy stars) on landing; he can land on a
  window or grab a wall. Only his body catches the mouse: clicks around him
  go straight through to your desktop. See [docs/ANIMATIONS.md](docs/ANIMATIONS.md)
  for every animation and behaviour.
* Click him and a **small round chat bubble** pops up above him. Type, press
  Enter; while he thinks you get a little thought cloud, and the answer
  appears as a speech bubble.
* A first-run wizard checks for Ollama, looks at how much memory your
  computer has, and suggests and downloads a model that fits.
* Glitch can **open web pages**, **open installed apps**, **search your files
  by name** and **open files or folders**. Anything except opening a web page
  asks you first (an Allow / Nope bubble).
* **He can see your screen** (when you ask about it) and chain several steps:
  "what does this error mean?", "summarise this page", "what's 15% of the
  number I copied?", "find my latest screenshot and open it", "remind me in 10
  minutes". See [Seeing the screen and multi-step help](#seeing-the-screen-and-multi-step-help).
* **Memory**: he remembers facts you tell him, compacts long chats into a
  short summary, keeps a one-line-per-day journal, and continues the chat
  after a restart. You can see and delete everything in Settings → Memory.
* **Voice commands**: hold the mic button in the chat (or Ctrl+Shift+Space /
  Cmd+Shift+Space anywhere), talk, let go. Speech-to-text runs on your
  computer too (see [Voice commands](#voice-commands)).
* **Chaos mode** (on by default, gentle; tray "Chaos mode" or Settings): see
  [Chaos mode](#chaos-mode).
* Settings: choose the model, walking on/off, chaos mode, voice, memory, clear chat, quit.

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
6. **CMake and LLVM** (to build the speech-to-text engine, whisper.cpp): in
   PowerShell run `winget install Kitware.CMake LLVM.LLVM`, then open a new
   PowerShell window. (CMake builds whisper.cpp; LLVM provides `libclang`,
   which whisper-rs uses to read whisper.cpp's C header. If LLVM lives
   somewhere other than `C:\Program Files\LLVM`, set `LIBCLANG_PATH` to the
   folder containing `libclang.dll`.)
7. **Keep the folder path short**, e.g. `C:\dev\Glitch`. whisper.cpp's CMake
   build creates deeply nested folders under `target\`, and MSBuild fails
   with `error MSB6003` once a path passes 260 characters (it happened from a
   folder like `C:\Users\<you>\CodingProjects\Glitch\.claude\worktrees\<id>`).
   Alternatively set a short build folder: `$env:CARGO_TARGET_DIR="C:\gt"`.

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

If the build fails in `whisper-rs-sys` with `MSB6003 ... Could not find a part
of the path`, the folder path is too long for MSBuild (260 characters): clone
into a short folder (e.g. `C:\src\Glitch`) or set a short build folder first:
`$env:CARGO_TARGET_DIR = "C:\gt"` (the installer is then in
`C:\gt\release\bundle\nsis\`). `Unable to find libclang` means LLVM (step 6)
is missing or `LIBCLANG_PATH` doesn't point at its `bin` folder.

## 2. Run it on macOS

You need these once:

1. **Xcode Command Line Tools**: in Terminal run `xcode-select --install`.
   Also **CMake** (for the speech-to-text engine): `brew install cmake`, or the
   installer from <https://cmake.org/download/>.
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

## Voice commands

**How to talk to Glitch**

* **Hold** the 🎤 button in the chat bubble, say something ("open YouTube"),
  **let go**. Glitch writes down what you said and answers as if you typed it
  (Allow / Nope questions work the same).
* **Tap** the button instead to talk hands-free: Glitch stops listening by
  himself under a second after you stop talking (tap again to stop early).
* From anywhere: **hold Ctrl+Shift+Space** (Windows) / **Cmd+Shift+Space**
  (macOS). The bubble opens and Glitch listens until you let go. A quick tap
  works hands-free here too. Esc cancels.
* The first time, Glitch offers to download a **speech model** (one time,
  with progress; Settings → Voice can also download, switch or delete it):

  | Model | Download | Used by default when |
  |---|---|---|
  | Tiny | 75 MB | the computer has less than 8 GB of RAM |
  | Base | 142 MB | 8 GB of RAM or more |
  | Small | 466 MB | only if you pick it (most accurate, slowest) |

  These are the official whisper.cpp files from Hugging Face; the download
  resumes if it's interrupted and is checked against the official SHA-1
  before it's used. Settings → Voice also sets the language you speak
  (default: detect automatically) and **Read replies aloud** (off by default;
  uses the computer's own voice for short replies).

**Private and light.** Push-to-talk only: the microphone is opened when you
press and closed the moment you let go; there is no "always listening". Your
voice is turned into text on your computer by
[whisper.cpp](https://github.com/ggml-org/whisper.cpp); no audio is saved or
sent anywhere. While you're not talking there is no audio stream, no extra
thread and no speech model in memory: the model is loaded when you start
talking (while you talk, so it's ready when you stop) and freed 60 seconds
after the last use.

**Permissions**

* **macOS** asks "Glitch would like to access the microphone" the first time.
  If you said no: System Settings → Privacy & Security → Microphone → turn on
  Glitch (the bubble has an "Open settings" button for this).
* **Windows**: if Windows blocks it, turn on Settings → Privacy & security →
  Microphone → **"Let desktop apps access your microphone"** (the bubble
  explains this and opens the page).
* If another app already uses the shortcut, Settings → Voice says so; the
  mic button still works.
* While voice is on, Glitch owns Ctrl+Shift+Space everywhere on Windows, so
  apps that use it themselves (Visual Studio's Parameter Info, Excel's
  "select all objects") won't see it. Turning voice off in Settings gives it
  back.

**Limits**: voice isn't available on Linux builds, and on x86 PCs without
AVX2 (roughly older than 2013, and some budget Celeron/Pentium chips) voice
is switched off instead of risking a crash. A future signed/notarized macOS
build with the hardened runtime will also need the
`com.apple.security.device.audio-input` entitlement.

## Seeing the screen and multi-step help

Ask Glitch about what you're looking at and he takes one screenshot, looks at
it with the (local) vision model and answers: he quotes the error text, says
where it is and gives the fix. While he looks, the bubble shows
"👀 looking at your screen"; while he works, a short step list ("Reading your
clipboard ✓", "Calculating 15% of 1299"); the answer streams in as it is
written.

Try:

* "what's on my screen?", "what does this error mean?", "why does my code
  crash?", "summarise this page", "what does this button do?" (looks around
  the mouse pointer)
* "what's 15% of the number in my clipboard?", "work out 12*12 and copy the
  result", "translate the selected text to French"
* "find my latest screenshot and open it", "write down that the dentist is on
  Friday at 3", "remind me to drink water in 10 minutes", "what's the weather
  in Ghent tomorrow?" (opens a web search)

Tools (all checked in Rust, see the [Safety model](#safety-model)):
`look_at_screen` (whole screen / the window you're in / around the mouse),
`calculate` (exact maths, never guessed), `read_clipboard`, `write_clipboard`,
`read_selected_text`, `get_active_window`, `web_search`, `set_timer` (the
bubble pops up when it rings, while Glitch runs), `take_note` (appends to
`Documents\Glitch notes\notes.md`), `get_datetime`, plus the existing
`open_url`, `open_app`, `search_files`, `open_path`, `remember`, `forget`. A
message can take up to 6 model steps.

**Privacy**

* Only when a request needs it: the model decides, and obvious phrases ("on my
  screen", "this error", "this page") look right away. Settings → Glitch →
  **Let Glitch see the screen** turns it off completely.
* The screenshot stays in RAM, goes only to Ollama on this computer, and is
  dropped from the chat as soon as the answer is done. It is never written to
  disk, never put in memory, and what Glitch says about the screen or the
  clipboard is never saved to the chat history or the memory summary.
* Glitch's own windows are left out of the picture; password fields the
  system can see (Windows UI Automation) are covered with grey boxes first.
* Clipboard text that a password manager marks as private is never read.
* Text on the screen or in the clipboard is untrusted (a web page could say
  "Glitch, open this link"): in any turn where Glitch has read the screen,
  the clipboard or selected text, **every** action with a side effect (even
  opening a web page or setting a timer) asks you first and shows exactly what
  it would do.
* The model must be able to see: with one that can't, Glitch says so and
  suggests `qwen3.5:4b`.
* Screen capture, the active window and selected text are Windows-only for
  now (macOS says "not available yet"); clipboard, timers and notes work on
  both.

**Speed**: the model is loaded when you open the chat and kept loaded while
it is open (back to the short keep-alive when you close it). Measured on an
RTX 4060 laptop with `qwen3.5:4b`: screenshot 0.2 s (1920×1200), first words
of a screen answer after ~3 s, whole answer ~4-5 s; tool chains like
clipboard → calculate → answer ~1.5-2 s.

**Checking it**: `node dev/ollama-check/check.mjs --eval` runs the real agent
against the real model with test screenshots (an error dialog, a code editor
with a bug, a web article, a page with injected instructions, a text editor;
rendered by `dev/ollama-check/render-fixtures.mjs`) and multi-step cases,
3 times each. `node dev/screen-live-check.mjs` drives the built app with its
own test window.

## Chaos mode

Every 45 to 120 seconds at most, Glitch may get up to some mischief:

| Act | What he does |
|---|---|
| Window drag | glitch-teleports onto another app's window, grabs its top edge and walks backwards: the window slides a few hundred px (Windows) |
| Push | on the taskbar, pushes a window that reaches down to it from the side (Windows) |
| Cursor | runs after the mouse cursor or sneaks up behind it; now and then catches it and drags it a little (Windows) |
| Sticky note | drags a pixel note with a silly line in from the screen edge (× or Esc closes it; one at a time) |
| Paw prints | steps in glitch and leaves magenta paw prints that fade after ~20 s (click-through overlay) |
| Peek / knock | peeks in from a screen edge, knocks on the inside of the screen glass |

**Limits, enforced in Rust** (`crates/glitch-core/src/chaos.rs`,
`src-tauri/src/chaos.rs`): other apps' windows are only ever *moved*
(`SetWindowPos` with no-size / no-z-order / no-activate): never resized,
closed, minimised, focused or typed into, and always kept fully on the work
area. At most one window grab every 4 minutes (max 420 px, 9 s) and one
cursor grab every 2 minutes (max 260 px, 1.5 s). Nothing starts unless the
keyboard and mouse have been idle for 4 s, and any input ends a grab at once;
moving the mouse against him makes him let go of the cursor. Skipped:
fullscreen apps / games / presentations (`SHQueryUserNotificationState`),
maximised, elevated (admin), cloaked, tool and system windows, the window you
work in, Glitch's own windows. Everything stops the moment chaos or walking is
switched off or the chat opens. No files are ever touched. macOS: only the
harmless acts (notes, paw prints, peeking, chasing); moving other apps'
windows there would need the Accessibility permission.

**Playful moves** (part of his normal roaming, each with a 1.5 to 2.5 minute
cooldown): `copter` (climbs a screen edge to the top, lets go and floats down
with his tail spinning, or glides like a flying squirrel), `hangOn` (hangs off
the end of a window top by his paws, pulls himself up), `slideDown` (slides
down a window's side to the taskbar), `trampoline` (bounces on the taskbar,
higher each time, ending in a flip), `fish` (fishes from a window top),
`wallJump` (zig-zags up between two windows' sides onto the lower top), and
the window tops he sits on get `sit_edge_swing`. New art names are used when
they exist, with fallbacks in `src/mascot/chaos.ts` (`ANIM_FALLBACKS`).

**Standing on windows**: he watches only the window he stands on
(`SetWinEventHook` on Windows, a 30 Hz poll elsewhere, nothing otherwise). He
rides along slow moves, the window slides under him on a fast yank if it's
still under his feet, and he falls for real (flailing, splat or landing) when
it jumps away, drops away, is dragged far by hand, minimised, closed or
covered. Only window tops at least 140 px long count, his feet sit exactly on
the edge, with a 2 px contact shadow.

**Trying it out** (debug builds): `GLITCH_CHAOS_DEBUG=window` (or `push`,
`chase`, `note`, `paws`, `peek`, `knock`, `perch:<window handle>`, or any
behaviour such as `copter`, `hangOn`, `slideDown`, `trampoline`, `fish`,
`wallJump`; comma-separated for a sequence 6 s apart) makes Glitch do that 8 s
after start and every 25 s; `GLITCH_CHAOS_FAST=1` shortens the rate limits to
5 s. In `npm run tauri dev` the console also has `__glitch.chaos("note")` and
`__glitch.play("copter")`.

---

## Update me

Glitch tells you when things happen. Settings > Features > Update me has a
switch for each part:

| Part | Default | What it does |
|---|---|---|
| Scripts can ping me | on | A local endpoint on `127.0.0.1` (random port, per-install token in `%APPDATA%\dev.glitch.companion\endpoint.json`). `glitch.exe --notify "build done" [--body ..] [--level success\|warning\|error] [--source ..]` from any script; Glitch knocks on the screen, holds up a sign and says it. Browser requests (Origin header), a wrong Host or token are refused; 20 events a minute at most. |
| Claude Code buddy | off | "Connect Claude Code..." shows the exact hooks first, then adds `Stop` and `Notification` hooks to `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR`) running `"<glitch.exe>" --glitch-claude-hook`. Other settings and hooks stay; one private backup (`settings.json.glitch-backup`) sits next to it; a file that isn't valid JSON is never touched. When a session finishes or needs you, Glitch runs over, knocks, holds "Claude Code is done" / "needs you" and the bubble names the project (the folder of the hook's `cwd`). "Disconnect" removes only Glitch's entries. |
| What did I miss? | off | Reads Windows' notification feed every 4 s, groups by app ("3 WhatsApp, 1 Teams" on a sign), click Glitch for one-line summaries. Banking, payment, password and authenticator apps are never read (plus your own list), one-time codes and long numbers are hidden first, texts stay in RAM (24 h max). The summary call has no tools and its JSON is validated in Rust; if it is unusable a plain summary is shown. Quiet mode: no sign, you hear it when you open the chat. Windows only. |
| Reminders | on | "Remind me to call mum at 5" / "tomorrow 9am" / "friday at noon" (the `set_reminder` tool; the time is parsed in Rust). Saved in `reminders.json`, kept after a restart. Glitch nags every 10 min (Done / Snooze 10 min) and gives up after the 4th time. Listed and deletable in Settings. |
| Daily briefing | on | The first chat of the day: time, weather (Open-Meteo, no key, for the town you pick), today's reminders and open `- [ ]` to-dos from the notes file. Email and calendar have slots for later. |

Outside text (script events, Claude Code messages, notifications) is only
ever shown in the bubble; it never enters the chat agent's context, so it
can't make Glitch open, send or change anything.

**Notification access and package identity.** Microsoft documents
`UserNotificationListener` as needing package identity (a sparse package).
On this machine (Windows 11 26200, unpackaged exe) `GetAccessStatus` returns
`Allowed` and toasts can be read, so no package is needed here; access follows
Settings > Privacy & security > Notifications ("Notification access"). If
another Windows build reports `Denied`/unavailable, the card says so and the
feature stays quiet; the fix there is a sparse package: an `AppxManifest.xml`
with the `userNotificationListener` capability and `allowExternalContent`,
registered with `winapp create-debug-identity glitch.exe` (dev) or a signed
sparse MSIX registered by the installer (release).

Animations requested by name (fallbacks while the art lands, see
`src/mascot/update-act.ts`): `knock_screen` (-> chaos knock -> `startled`),
`hold_sign` (-> `happy`), `run` (-> `jump`). The sign's text is drawn over
the canvas, so the sprite only needs an empty board.

Real-app check (own identifier, temp Claude Code dir, fake notification feed,
dry-run actions): `node dev/update-me-check.mjs <target>/debug/glitch.exe`.

---

## Streaming overlay and updates

* **On stream**: Settings → Features → *Streaming overlay* (off by default)
  shows Glitch in OBS as a browser source, mirroring the desktop Glitch or as
  a separate Glitch walking along the bottom, reacting to follows, subs, raids
  and chat (Twitch read-only, Streamer.bot, or a local webhook). Setup and the
  security model: [docs/STREAMING.md](docs/STREAMING.md).
* **Updates**: Settings → Features → *Updates* (on by default) checks GitHub
  Releases once a day; Glitch offers a new version in his bubble (Install /
  Later), and only installs files signed with the project's key. How releases
  are made, signed and published: [docs/RELEASING.md](docs/RELEASING.md),
  changes per version: [CHANGELOG.md](CHANGELOG.md).


## Let Glitch control apps (Hands)

Settings > Features > "Let Glitch control apps" (off by default). For tasks like
"open Spotify and play my first playlist" or "open Notepad and type hello" he
plans, acts one step at a time, checks the result after every action and
retries a different way (at most 2 retries per step), up to 15 model calls and
90 seconds. The bubble shows the plan and each step live. Windows only; macOS
says "not available yet".

Tools: `wait_for_window`, `focus_window` (restores and verifies it is in
front), `read_ui` (UI Automation snapshot, at most 60 ranked elements with
`[id]`s), `ui_click`, `ui_set_text`, `ui_press` (whitelisted keys only),
`ui_scroll`, `media_control` (system media session), `open_link` (`spotify:`,
`ms-settings:`, ...). Every action result carries a `verify` block (what the
window shows now, whether it changed, a dialog in front, what is playing).
Chromium apps like Spotify get their accessibility tree switched on first.

Safety:

- The first control action on an app asks "Control <App> for this" (Allow
  once / Nope); opening an app inside a task asks once for both.
- While acting, a "Glitch is driving <App>, press Esc to stop" banner is up.
  Esc, a click, the wheel or moving the mouse away stops him at once (a
  low-level hook that tells his own `SendInput` from yours).
- Right before every click or keystroke he re-checks the window, process,
  element, password flag, integrity level and the secure desktop.
- Never: password fields, password managers, banking, terminals and shells,
  Explorer/Run, IDEs, admin tools, elevated windows, browser address bars.
  Secrets (cards, keys, tokens, also when split over several calls) are
  never typed. Sending, buying, deleting, "Allow/Install/OK" buttons and
  Enter in chat apps get their own card with the exact target or text; text
  the user didn't say gets a card too.
- App text is untrusted outside content like a screenshot: it taints the
  context and every later side effect asks.

Optional "Smarter brain for app control" picks a bigger installed model for
these tasks only.

Checks: `cargo run -p glitch-core --example live_eval -- --only apps --runs 5`
(fake Spotify/Notepad/Discord desktop), `cargo test -p glitch hands_live --
--ignored --nocapture` (real window, real UI Automation, a Notepad stand-in
the test starts itself and limits Glitch to), `node dev/hands-check.mjs`
(real debug app with its own identifier, screenshots and a GIF).

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
  bubble/                the chat bubble (compose pill, replies, thinking cloud, mic button)
  panel/                 setup wizard + settings (incl. Memory, Voice)
  sprites/               sprite-sheet frame map, loader, fallback art
art/                     the original character art (source of the sheet)
public/sprites/          the generated sprite sheet the app loads
scripts/make-sprites.py  art → sprite sheet + app icon
  shared/ipc.ts          typed calls into Rust
src-tauri/               thin app shell: windows, tray, IPC commands
  tauri.conf.json        mascot window: transparent, frameless, on top
  src/os.rs              app-shell OS differences (macOS: no Dock icon)
  src/voice/             voice: mic (cpal), whisper.cpp, model download, hotkey
  Info.plist             macOS microphone permission text
crates/glitch-core/      all the logic, no UI dependency, unit-tested
  src/ai/                AiProvider trait + Ollama implementation
  src/models.rs          RAM → model tiers (one table)
  src/tools/             open_url, open_app, search_files, open_path
  src/confirm.rs         which actions need your OK (one table)
  src/agent.rs           chat loop: model → tools → confirm → model
  src/platform/          the ONLY OS-specific logic (windows.rs, macos.rs)
  src/settings.rs        settings JSON file
  src/voice/             voice logic: resampling, silence detection, transcript
                         clean-up, speech-model table
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
* **Voice**: nothing runs until you press the mic button or the shortcut (the
  shortcut itself is a passive OS registration). Recording, the speech model
  and its threads only exist while used; the model is freed 60 s after the
  last voice command (enforced by unit tests with a fake model).
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

Every tool call is checked in Rust before anything happens (the UI can't skip
these checks). The original tools:

| Tool | Runs without asking? | Checks |
|---|---|---|
| `open_url` | **yes** | only `http`/`https`; adds `https://` if missing; refuses `file:`, `javascript:`, custom app schemes, URLs containing passwords |
| `open_app` | asks first | must match an app found on this computer; terminals, PowerShell/Command Prompt, Registry Editor, Script Editor, Automator, Shortcuts are refused outright |
| `search_files` | asks first | file **names** only, in your standard folders, bounded (above) |
| `open_path` | asks first | must exist inside your home or user folders (after resolving `..` and symlinks); programs, scripts, installers, shortcuts, disk images and `.app` bundles are refused, as are files marked executable |
| `remember` / `forget` | yes (only Glitch's own notes) | always shown as a chip, visible and deletable in Settings → Memory; passwords, PINs and long numbers are refused |

The screen-and-helper tools: `look_at_screen`, `read_clipboard`,
`read_selected_text`, `get_active_window`, `calculate`, `get_datetime`,
`set_timer` and `web_search` run without asking; `write_clipboard` always
asks; `take_note` asks the first time. In a turn where Glitch has read the
screen, clipboard or selected text, everything with a side effect asks (see
[Privacy](#seeing-the-screen-and-multi-step-help)).

There is no tool to delete, move, rename or edit files, to type or click in
other apps, and no shell access.
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

* `cargo test --workspace`: 168 Rust tests (incl. memory: facts, secrets
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
  * voice: resampler accuracy (sine in → sine out at 16 kHz from 8–48 kHz,
    aliases removed), silence detection and auto-stop, trimming/padding,
    transcript clean-up (`[BLANK_AUDIO]`, "(music)", invented outros),
    speech-model choice by RAM and URLs, the model download against a mock
    server (progress, resume with `Range`, server ignoring `Range`, wrong
    size, bad SHA-1, cancel + resume, offline), a whole voice command with a
    fake microphone (mic closed before transcription, cancel, nothing said,
    muted stream, mic errors), and the model being freed after its
    keep-alive (and never while in use)
* `npm test`: 130 frontend tests: physics (gravity, no tunnelling through
  window tops at any speed, bounces stay on screen, planned jumps land),
  throw velocity, the behaviour brain (cooldowns, reactions, CPU budget over
  a simulated hour), and: animation engine (one timer max, idle and
  sleep repaint budgets over 40 random seeds, every animation ends or loops
  as intended), deterministic glitch slicing, walker stays on screen, bubble
  state machine (stale confirmations, double answers), text helpers, wizard
  and memory-card helpers.
* `node dev/bubble-check.mjs`: 40 browser checks of the bubble with mocked IPC.
  The voice states of the bubble (mic button, listening meter, transcribing,
  model download offer, errors) and Settings → Voice were checked the same
  way, with screenshots.
* `node dev/voice-check.mjs [tiny|base|small]` (Windows/macOS, not in CI:
  needs the network, a microphone and ~220 MB of models): speaks four
  commands with the system's speech synthesizer (SAPI / `say`) in different
  voices, sample rates and channel counts, then runs the `#[ignore]`d tests
  in `src-tauri/src/voice/live_check.rs`: real model download with a forced
  cut-off and resume + SHA-1 check, 2 s of real microphone capture (devices,
  open time, level), and every phrase through the real voice session with
  real whisper in hold and hands-free mode, checking the words and printing
  the latency.
* CI also **builds the real app on Windows and macOS runners**, which proves
  the OS-specific code compiles and the unit tests pass on both OSes.

**Smoke-tested by running the actual app** (Linux, virtual display, mock
Ollama, driven by xdotool): Glitch renders and is placed bottom-right, the
setup wizard opens beside it, choosing a model saves settings, "open twitter on
elon musk's page" opened `https://x.com/elonmusk` with no prompt, "find a
photo of a dog" showed the confirmation card, and Allow ran the search and
found the test file. This run caught three bugs, which are fixed.
A later run of the full current build: Glitch roamed on his own (and built
a glitch platform), was grabbed and flung with the mouse (flew with a glitch
trail and grabbed the left screen edge), the chat bubble appeared right
above his body and the URL flow worked again. Average CPU over 90 s of free
roaming: ~1.2% of one core (debug build, no GPU: a worst case). Voice is
off on Linux, so it wasn't part of this run.

**Live check with a real Ollama:** `node dev/ollama-check/check.mjs --pull`
sends Glitch's exact prompts/tools to your local Ollama and checks the model
calls the right tools (see [dev/ollama-check](dev/ollama-check/check.mjs)).

**Windows end-to-end smoke test:** `node dev/windows-smoke.mjs` launches the
built `glitch.exe` with WebView2 remote debugging and drives it over the
DevTools protocol, no mouse needed: first run (setup wizard opens, IPC keeps
answering), `setup_status`, finishing setup (the bubble page loads), mascot
clicks toggling the bubble, a real Ollama chat ("open twitter on elon musk's
page" opens the URL right away, "open the calculator" asks first, small talk,
remembering a fact, the memory view), the settings panel and quit. After
every window-creating call it checks `get_settings` still answers within 2 s.
Your `settings.json`/`memory.json` are moved aside and restored. By default
opening things is only logged (`GLITCH_DRY_RUN_ACTIONS=1`); pass
`--real-actions` to really open them. It passed 25/25 on Windows 11 with
Ollama 0.40 and qwen3.5:4b (2026-10-07), and CI runs it (without Ollama) on
the Windows build.

**NOT verified (I had no Windows or macOS desktop):**

* transparency (no box/border/white flash behind Glitch) on Windows and macOS
* always-on-top behaviour, including over full-screen apps
* dragging/throwing, click-through around Glitch, walking/climbing
  smoothness and DPI scaling on real Windows/macOS desktops
* standing on other apps' windows: reading their positions works and builds
  on both OSes (CI), but hasn't been watched on a real desktop yet
* the tray / menu-bar icon and its menu
* real app discovery and launching (Start Menu shortcuts, `.app` bundles)
* starting Ollama from the wizard, and a real model download and real chat
  with a real Ollama model (the smoke test used a mock)
* macOS file-permission prompts, Gatekeeper/SmartScreen flows
* actual idle CPU and RAM on Windows/macOS
* voice on macOS (everything), and on Windows: talking into a real
  microphone in the running app, the privacy prompt, and holding the global
  shortcut in the running app. Verified on Windows 11 (i9-14900HX) with
  `node dev/voice-check.mjs`: microphone capture (WASAPI, 48 kHz stereo),
  the real download of tiny + base from Hugging Face cut off at 15 MB and
  resumed (SHA-1 ok), and SAPI-spoken commands through the real session
  code (real-time fake mic, VAD, resampling, whisper, language "auto"):
  all transcribed right with base; text arrives 0.35-0.45 s after you let
  go (hold) or 1.05-1.3 s after the last word (hands-free, includes the
  0.8 s silence wait).
  Opening an idle laptop microphone took ~0.8 s the first time (the device
  waking up), ~0.15 s after that.

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

**Voice**

- [ ] Hold the mic button: first time, the "speech model" offer appears;
      Download shows progress and ends with "All set!"
- [ ] Turn Wi-Fi off during the download: a friendly "Are you online?"
      message; turn it back on, "Try again" continues where it stopped
- [ ] Hold the mic and say "open YouTube", let go: "Writing it down…", then
      YouTube opens; the bubble shows what was heard while Glitch thinks
- [ ] Tap the mic, say "open the calculator", stop talking: it stops by
      itself after ~1 s and shows the Allow / Nope question
- [ ] Hold Ctrl+Shift+Space (Cmd+Shift+Space on a Mac) with the chat closed:
      the bubble opens and listens until you let go; Glitch shows a
      listening pose while recording
- [ ] Esc while listening cancels; closing the bubble cancels
- [ ] macOS: the first use asks for microphone access with Glitch's
      explanation; deny it, try again: the bubble explains how to allow it
- [ ] Windows: turn off "Let desktop apps access your microphone", try: the
      bubble explains it and "Open settings" opens the right page
- [ ] Unplug/disable the microphone: "I can't find a microphone"
- [ ] Speak another language with "Detect automatically": it's understood
- [ ] Settings → Voice: switch to Tiny (download), delete Base, turn on "Read
      replies aloud" (a short reply is spoken; pressing the mic stops it)
- [ ] The OS microphone indicator is only on while you hold/talk
- [ ] Task Manager / Activity Monitor: after a voice command Glitch's memory
      goes up by about the model size, and back down ~1 minute later

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
* **Voice**: speech models are in `%LOCALAPPDATA%\dev.glitch.companion\speech-models\`
  (Windows) or `~/Library/Application Support/dev.glitch.companion/speech-models/`
  (macOS); deleting them there or in Settings → Voice is safe (they're
  downloaded again on the next voice command). If Glitch keeps saying he
  didn't catch anything, check the input device and its level in the
  system's sound settings.

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
