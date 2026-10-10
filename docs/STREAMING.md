# Glitch on your stream (OBS overlay)

Settings > Features > **Streaming overlay** (off by default). When on, Glitch
runs a tiny web server on `127.0.0.1` (this computer only, port 7799 by
default) that OBS shows as a browser source.

## Set up in OBS

1. Turn on "Streaming overlay" and press **Copy OBS URL**.
2. OBS: Sources > + > **Browser**. Paste the URL, width 1920, height 1080
   (your canvas size). Leave "Shutdown source when not visible" off.
3. The page is transparent: only Glitch and his speech bubble show.

Modes (switch any time, OBS picks it up without touching the source):

- **Mirror my desktop Glitch**: he stands at the bottom (left, center or
  right) and plays whatever the desktop Glitch does. Walking, climbing and
  flying show as standing, since he stays in one spot.
- **A stream Glitch walking along the bottom**: a separate Glitch strolls,
  runs, looks around and naps along the bottom edge. He never climbs the
  canvas edges.

Size: 0.75x to 3x. "Show my chats with Glitch on stream" is off by default:
what you ask him on your desktop stays private unless you turn it on.

## Reactions

| Event | Glitch |
|---|---|
| follow | waves (streamer headset clip), "Thanks for the follow, Ana!" |
| sub | hype jump, claps, thumbs up, "Ana just subscribed! Thank you!" |
| raid | shocked, hype, "RAID! Ana brought 25 friends! Welcome!" |
| chat | reads the line in his bubble ("Ana: hi Glitch") and talks |

Chat lines: at most one every 4 seconds; alerts: at most 6 per 30 seconds (a
follow-bot wave doesn't queue minutes of waving). Text is cut to 200
characters, control and direction-override characters are removed, and the
page shows it as plain text, never HTML. The **Send a test event** buttons
fire one of each.

In mirror mode the desktop Glitch acts the reaction out too (that's what the
overlay copies).

## Where events come from

**Twitch chat (no account needed).** Type your channel name. Glitch reads
public chat, subs and raids anonymously (`justinfan`, TLS to
irc.chat.twitch.tv:6697). He has no token and never sends a chat message.
Twitch doesn't put follows on chat; use Streamer.bot or the webhook for those.

**Streamer.bot.** Servers/Clients > WebSocket Server: start it (default
`127.0.0.1:8080`, endpoint `/`) and leave **Authentication off** (Glitch
doesn't send a password; it says so if Streamer.bot asks). Turn on
"Streamer.bot" in Glitch. He subscribes to Twitch Follow, Sub, ReSub, GiftSub,
GiftBomb, Raid, ChatMessage and YouTube NewSubscriber, NewSponsor,
MembershipGift, Message. Only `ws://` on this computer is accepted.

**Aitum (Aitum Stream Suite).** Checked 2026-10-08 against its source
(github.com/Aitum/obs-aitum-stream-suite): it is an OBS plugin. Its only local
API is obs-websocket "vendor" requests for scenes, outputs and docks
(`aitum-stream-suite` vendor: switch_scene, start_output...). Its chat and
activity feed are web docks hosted at chat.aitumsuite.tv with no local event
API, so there is nothing local for Glitch to listen to. Use Streamer.bot or
the webhook next to it. (On this PC only the Aitum installer is in Downloads;
it is not installed.)

**Anything else: the webhook.** Bots and scripts can POST JSON:

```powershell
$token = "<press 'Copy bot token' in Glitch>"
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:7799/stream-event `
  -Headers @{ "X-Glitch-Token" = $token } -ContentType "application/json" `
  -Body '{"type":"follow","user":"Ana"}'
```

`type` is follow, sub, raid or chat; `user` the name; `text` the chat line
(or the raid's viewer count). Answers: 202 shown, 429 skipped (reactions off,
chat hidden, or a flood), 400 bad JSON, 401 wrong token, 403 refused.

## Security

- Bound to 127.0.0.1 only; the `Host` header must be `127.0.0.1` or
  `localhost` with the port (blocks DNS-rebinding pages).
- Two secrets. The **view token** in the OBS URL can only read (page, config,
  event stream). The **bot token** only works for `POST /stream-event`, only in
  the `X-Glitch-Token` (or `Authorization: Bearer`) header, only with
  `Content-Type: application/json`, and never from a browser page (any `Origin`
  header is refused). So a leaked OBS URL can't put text on your stream.
- "New links" (under "Other bots and scripts") replaces both tokens.
- No CORS headers. Static files are only the app's own `assets/` and
  `sprites/` (no `..`, no hidden files, no Windows device names).
- At most 32 connections, 8 overlay pages, 8 KB request heads and 16 KB bodies.
- Tokens are redacted from debug output; request targets are never logged.

## Files

- `crates/glitch-core/src/stream/`: events, reactions, throttle, HTTP parsing
  and routing, WebSocket client frames, Streamer.bot and Twitch parsers (unit-tested).
- `src-tauri/src/stream/`: the server, Streamer.bot and Twitch connections,
  settings commands.
- `overlay.html`, `src/overlay/`: the OBS page (no Tauri; plain web page).
- `public/sprites/streamer.png`: the 8-frame reaction clip, built from
  `art/generated/streamer.png` by `scripts/overlay-sprites.py`.
- `dev/overlay-check.mjs`: end-to-end check against the real app.
