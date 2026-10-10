# Glitch desktop app: live test on Windows (2026-10-07)

Build: CI run 37583469169 (branch claude/jolly-babbage-i77mhy, "Panel: polished setup wizard"), NSIS installer, Windows 11 Home 26200, 1920x1200 @ 100%.

## SHOWSTOPPER: chat and the setup wizard never open on Windows (IPC deadlock)

Symptom: Glitch appears, but clicking him does nothing, the first-run setup wizard never shows, he never walks, and once it happened the app went "Not Responding".

Root cause (proven with WebView2 remote debugging, `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9229`):
- mascot page startup works: `get_settings` and `win.show()` answer over IPC.
- First run (`onboarding_done: false`) -> mascot calls `api.showPanel()` -> **sync** command `show_panel` -> `windows::show_panel` -> `create_panel` builds a `WebviewWindow` inside a sync command.
- On Windows that deadlocks (Tauri docs on WebviewWindowBuilder::new: creating windows in a synchronous command or event handler deadlocks on Windows; see wry#583). The panel page stays at `about:blank` and from then on **every** IPC call hangs: `http://ipc.localhost/get_settings` POST and its OPTIONS preflight never get a response. Tested `setup_status`, `get_settings`, `world_snapshot`: all time out.
- A/B proof: with `settings.json` = `{"onboarding_done":true,...}` IPC works after launch. Then one click on Glitch -> sync `mascot_clicked` -> `toggle_bubble` -> creates the bubble window -> same deadlock, bubble page stuck at `about:blank`, IPC dead.
- Mouse events do reach the page (recorded pointerdown/mousedown/mouseup/click on the canvas), so the frontend is fine.

Fix options:
1. Make every command that can create a window `async`: `mascot_clicked`, `show_bubble`, `show_panel` (and anything else that reaches `create_panel` / `create_bubble`).
2. Or pre-create the bubble and panel windows hidden in `setup()`, so commands only show/hide them. Also covers the tray "Chat"/"Settings" menu handlers and the single-instance callback, which are event handlers and can hit the same deadlock.
Option 2 is the most robust. Please add a Windows CI smoke test that launches the built app and invokes `mascot_clicked` / `show_panel`.

## Checklist results
- See-through background, no box: PASS (checked over dark Explorer, in the corner and mid-screen).
- Stays on top: PASS (window has WS_EX_TOPMOST, stayed above Explorer after drag).
- Drag: PASS (native drag moves him smoothly).
- Click: FAIL (deadlock above). Mouse events arrive fine.
- "open twitter" vs "open app asks first": NOT TESTABLE in the app (chat can't open). The model side passes in dev/ollama-check (open_url for the X page, open_app for Calculator, 23/23).

## Smaller notes
- The mascot window is 160x110 on screen (rect 1736,1018 to 1896,1128) though hover.rs says 160x160; canvas 138x90. Check whether the height is being clamped near the taskbar.
- Click-through polls every 100 ms (hover.rs), so a click that lands within ~100 ms of the cursor arriving passes through to the app underneath. Real users won't notice; automated tests must hover first.
- `favicon.ico` request returns 500 from tauri.localhost (harmless console noise).
- Tester note: the app was installed from inside the Claude desktop app's MSIX sandbox, so it lives in the virtualized AppData. The deadlock is a known Windows/WebView2 behaviour, not a sandbox issue, but a re-test from a normal install is worth doing after the fix.
