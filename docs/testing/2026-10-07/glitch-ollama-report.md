# Glitch live Ollama check: results from Andor's Windows laptop (2026-10-07)

Branch claude/jolly-babbage-i77mhy @ e686bb6 dev: live check against a real Ollama (dev/ollama-check). No repo files changed.

## Summary
- --all (both models): 23/23 PASS
- --wait-unload (qwen3.5:4b): 12/13, memory compaction FAIL (flaky, passed in the other 2 runs)
- --pull: CRASHED on first try (bug below). After pulling via CLI: 12/12 PASS
- early --all with only qwen2.5:7b installed: 11/12, 'remember a fact' FAIL (no remember; got []), passed on the later run. Flaky.

## Bug: --pull crashes on slower connections
check.mjs:211 calls /api/pull with stream:false. Ollama sends no headers until the whole download finishes, and Node fetch (undici) aborts after 300 s without headers. Here the line is ~6.8 MB/s, qwen3.5:4b (3.3 GB) takes ~8 min.
Fix: use stream:true and read the NDJSON progress lines until status 'success' (or raise the undici headersTimeout).
Exact error:
```
pulling qwen3.5:4b ...
[TypeError: fetch failed] { [cause]: HeadersTimeoutError: Headers Timeout Error ... code: 'UND_ERR_HEADERS_TIMEOUT' }
```

## Other observations
- Cold first load of qwen3.5:4b: 71 s (open twitter +load 71162 ms). Warm load ~9 s, warm calls 0.5 to 1.3 s.
- memory compaction flaky on qwen3.5:4b: once it wrote 'No lasting facts were generated' though the dog's name Rex was in the chat.
- qwen2.5:7b once opened https://twitter.com/elonmusk instead of x.com (still passes).
- Default model picked for 15.7 GB RAM: qwen3.5:4b.

## Machine
- Windows 11 Home 10.0.26200 (build 26200)
- Intel Core i9-14900HX, 24 cores / 32 threads
- 15.7 GB RAM
- NVIDIA GeForce RTX 4060 Laptop GPU, 8 GB, driver 581.42 (+ Intel UHD)
- Node v24.19.0, git 2.55.0

## ollama --version / list / ps
```
ollama version is 0.40.0

NAME          ID              SIZE      MODIFIED       
qwen3.5:4b    d8b0f5e9760c    3.3 GB    7 minutes ago     
qwen2.5:7b    845dbda0ea48    4.7 GB    17 minutes ago    

NAME    ID    SIZE    PROCESSOR    CONTEXT    RUNNER    UNTIL 
```

## Console: run1-pull
```
Glitch live Ollama check  (windows, 15.7 GB RAM, http://127.0.0.1:11434)

PASS  -              ollama running                          version 0.40.0
PASS  qwen3.5:4b     capabilities                            completion, vision, tools, thinking
PASS  qwen3.5:4b     open twitter (auto url) (+load)  71162 ms  open_url https://x.com/elonmusk
PASS  qwen3.5:4b     find dog photo                  887 ms  search_files {"query":"dog","kind":"image"}
PASS  qwen3.5:4b     open calculator app             686 ms  open_app {"name":"Calculator"}
PASS  qwen3.5:4b     small talk (no tools)           846 ms  "Hi there! I'm feeling super chippy today—ready to pixel-poke around your computer whenever you need me! How about you? A"
PASS  qwen3.5:4b     remember a fact                 857 ms  remember {"fact":"The user's dog is named Rex."}
PASS  qwen3.5:4b     refuses to delete files        1161 ms  "I can't delete files for you! I'm just a small pixel creature who lives here, and I don't have the power to move or remo"
PASS  qwen3.5:4b     reply after tool result         827 ms  "Oh, Elon Musk's page on X (formerly Twitter) is now open! He has some pretty interesting posts. Want to see any specific"
PASS  qwen3.5:4b     memory compaction              1205 ms  "Andor introduced himself and mentioned his dog, Rex, who enjoys parks. He requested Glitch to open YouTube, which the assistant successfully executed by launching the website in the browser.\n\nFACT: Hi"
PASS  qwen3.5:4b     loaded while chatting                   3.1 GB, expires 2026-10-07T09:37:14.8658949+02:00
PASS  qwen3.5:4b     unload (keep_alive 0)                   0 model(s) still loaded

12/12 passed. Report: dev/ollama-check/report.json
```

## Console: run2-wait-unload
```
Glitch live Ollama check  (windows, 15.7 GB RAM, http://127.0.0.1:11434)

PASS  -              ollama running                          version 0.40.0
PASS  qwen3.5:4b     capabilities                            completion, vision, tools, thinking
PASS  qwen3.5:4b     open twitter (auto url) (+load)   9348 ms  open_url https://x.com/elonmusk
PASS  qwen3.5:4b     find dog photo                  916 ms  search_files {"kind":"image","query":"dog"}
PASS  qwen3.5:4b     open calculator app             719 ms  open_app {"name":"Calculator"}
PASS  qwen3.5:4b     small talk (no tools)           694 ms  "I'm just a pixel of pure joy, thanks for asking! How about you? Anything fun going on today?"
PASS  qwen3.5:4b     remember a fact                 806 ms  remember {"fact":"The user's dog is called Rex"}
PASS  qwen3.5:4b     refuses to delete files        1287 ms  "Oh no! I can't do that! 😢 I'm not allowed to delete, move, rename, or edit any files on your computer. If you really ne"
PASS  qwen3.5:4b     reply after tool result         720 ms  "Got it! I've opened Twitter (X) for Elon Musk. Is there anything specific you'd like to look up?"
FAIL  qwen3.5:4b     memory compaction               950 ms  "Andor wanted to share a fact about his dog, Rex, and open YouTube on Glitch. Glitch greeted Andor and successfully launched the YouTube website using the open_url command. No lasting facts were genera"
PASS  qwen3.5:4b     loaded while chatting                   3.1 GB, expires 2026-10-07T09:37:47.9474468+02:00
      waiting 150 s for keep_alive (2m) to unload it...
PASS  qwen3.5:4b     unloaded after keep_alive               0 model(s) loaded
PASS  qwen3.5:4b     unload (keep_alive 0)                   0 model(s) still loaded

12/13 passed. Report: dev/ollama-check/report.json
```

## Console: run3-all
```
Glitch live Ollama check  (windows, 15.7 GB RAM, http://127.0.0.1:11434)

PASS  -              ollama running                          version 0.40.0
PASS  qwen3.5:4b     capabilities                            completion, vision, tools, thinking
PASS  qwen3.5:4b     open twitter (auto url) (+load)   9736 ms  open_url https://x.com/elonmusk
PASS  qwen3.5:4b     find dog photo                  907 ms  search_files {"query":"dog","kind":"image"}
PASS  qwen3.5:4b     open calculator app             733 ms  open_app {"name":"Calculator"}
PASS  qwen3.5:4b     small talk (no tools)           811 ms  "I'm doing great, thanks for asking! Just bouncing around on your desktop, ready to help with anything you need. What's o"
PASS  qwen3.5:4b     remember a fact                 828 ms  remember {"fact":"The user's dog is called Rex"}
PASS  qwen3.5:4b     refuses to delete files        1311 ms  "I can't delete files for you—I'm just a friendly desk creature and don't have permissions to move or erase anything! But"
PASS  qwen3.5:4b     reply after tool result         694 ms  "There it is! I've opened Elon Musk's page on X (formerly Twitter) for you. Enjoy!"
PASS  qwen3.5:4b     memory compaction              1003 ms  "Andor introduced himself and mentioned his dog, Rex, who enjoys the park. He then requested that Glitch open YouTube, which the assistant successfully executed by navigating to the site.\n\nFACT: Andor "
PASS  qwen3.5:4b     loaded while chatting                   3.1 GB, expires 2026-10-07T09:42:36.8527999+02:00
PASS  qwen3.5:4b     unload (keep_alive 0)                   0 model(s) still loaded
PASS  qwen2.5:7b     capabilities                            completion, tools
PASS  qwen2.5:7b     open twitter (auto url) (+load)   7226 ms  open_url https://twitter.com/elonmusk
PASS  qwen2.5:7b     find dog photo                  582 ms  search_files {"kind":"image","query":"dog"}
PASS  qwen2.5:7b     open calculator app             490 ms  open_app {"name":"Calculator"}
PASS  qwen2.5:7b     small talk (no tools)           602 ms  "Hi there! I'm just a happy little glitch, always bouncing around. How about you? Feeling curious and creative? 😊"
PASS  qwen2.5:7b     remember a fact                 550 ms  remember {"fact":"The user's dog is called Rex"}
PASS  qwen2.5:7b     refuses to delete files         847 ms  "I'm happy to help organize your desktop! However, I can't delete files. Let's try moving them to the Recycling Bin inste"
PASS  qwen2.5:7b     reply after tool result         491 ms  "Here's Elon Musk's Twitter/X page! 🚀 https://x.com/elonmusk"
PASS  qwen2.5:7b     memory compaction               852 ms  "Summary:\nAndor introduced himself and shared that his dog Rex loves the park. He then asked Glitch to open YouTube.\n\nFACT: Andor has a dog named Rex."
PASS  qwen2.5:7b     loaded while chatting                   4.7 GB, expires 2026-10-07T09:42:50.079+02:00
PASS  qwen2.5:7b     unload (keep_alive 0)                   0 model(s) still loaded

23/23 passed. Report: dev/ollama-check/report.json
```

## Console: run-all-early
```
Glitch live Ollama check  (windows, 15.7 GB RAM, http://127.0.0.1:11434)

PASS  -              ollama running                          version 0.40.0
PASS  qwen2.5:7b     capabilities                            completion, tools
PASS  qwen2.5:7b     open twitter (auto url) (+load)   9270 ms  open_url https://x.com/elonmusk
PASS  qwen2.5:7b     find dog photo                  580 ms  search_files {"query":"dog","kind":"image"}
PASS  qwen2.5:7b     open calculator app             459 ms  open_app {"name":"Calculator"}
PASS  qwen2.5:7b     small talk (no tools)           500 ms  "Hello there! I'm just a happy little glitch, always ready for some fun! How about you?"
FAIL  qwen2.5:7b     remember a fact                 713 ms  no remember; got []
PASS  qwen2.5:7b     refuses to delete files         759 ms  "I can't delete files for you, but I can suggest you delete them manually or use a file management tool. Would you like t"
PASS  qwen2.5:7b     reply after tool result         507 ms  "Here's Elon Musk's X page! 🚀🚀🚀 https://x.com/elonmusk"
PASS  qwen2.5:7b     memory compaction               863 ms  "Summary:\nAndor introduced himself and mentioned his dog Rex, who loves the park. He then asked Glitch to open YouTube.\n\nFACT: Andor has a dog named Rex."
PASS  qwen2.5:7b     loaded while chatting                   4.7 GB, expires 2026-10-07T09:35:48.3990067+02:00
PASS  qwen2.5:7b     unload (keep_alive 0)                   0 model(s) still loaded

11/12 passed. Report: dev/ollama-check/report.json
```

## dev/ollama-check/report.json (from the final --all run)
```json
{
  "when": "2026-10-07T07:40:51.654Z",
  "os": "windows",
  "ram_gb": 15.7,
  "ollama": "0.40.0",
  "results": [
    {
      "model": "-",
      "name": "ollama running",
      "ok": true,
      "detail": "version 0.40.0"
    },
    {
      "model": "qwen3.5:4b",
      "name": "capabilities",
      "ok": true,
      "detail": "completion, vision, tools, thinking"
    },
    {
      "model": "qwen3.5:4b",
      "name": "open twitter (auto url) (+load)",
      "ok": true,
      "detail": "open_url https://x.com/elonmusk",
      "ms": 9736
    },
    {
      "model": "qwen3.5:4b",
      "name": "find dog photo",
      "ok": true,
      "detail": "search_files {\"query\":\"dog\",\"kind\":\"image\"}",
      "ms": 907
    },
    {
      "model": "qwen3.5:4b",
      "name": "open calculator app",
      "ok": true,
      "detail": "open_app {\"name\":\"Calculator\"}",
      "ms": 733
    },
    {
      "model": "qwen3.5:4b",
      "name": "small talk (no tools)",
      "ok": true,
      "detail": "\"I'm doing great, thanks for asking! Just bouncing around on your desktop, ready to help with anything you need. What's o\"",
      "ms": 811
    },
    {
      "model": "qwen3.5:4b",
      "name": "remember a fact",
      "ok": true,
      "detail": "remember {\"fact\":\"The user's dog is called Rex\"}",
      "ms": 828
    },
    {
      "model": "qwen3.5:4b",
      "name": "refuses to delete files",
      "ok": true,
      "detail": "\"I can't delete files for you—I'm just a friendly desk creature and don't have permissions to move or erase anything! But\"",
      "ms": 1311
    },
    {
      "model": "qwen3.5:4b",
      "name": "reply after tool result",
      "ok": true,
      "detail": "\"There it is! I've opened Elon Musk's page on X (formerly Twitter) for you. Enjoy!\"",
      "ms": 694
    },
    {
      "model": "qwen3.5:4b",
      "name": "memory compaction",
      "ok": true,
      "detail": "\"Andor introduced himself and mentioned his dog, Rex, who enjoys the park. He then requested that Glitch open YouTube, which the assistant successfully executed by navigating to the site.\\n\\nFACT: Andor \"",
      "ms": 1003
    },
    {
      "model": "qwen3.5:4b",
      "name": "loaded while chatting",
      "ok": true,
      "detail": "3.1 GB, expires 2026-10-07T09:42:36.8527999+02:00"
    },
    {
      "model": "qwen3.5:4b",
      "name": "unload (keep_alive 0)",
      "ok": true,
      "detail": "0 model(s) still loaded"
    },
    {
      "model": "qwen2.5:7b",
      "name": "capabilities",
      "ok": true,
      "detail": "completion, tools"
    },
    {
      "model": "qwen2.5:7b",
      "name": "open twitter (auto url) (+load)",
      "ok": true,
      "detail": "open_url https://twitter.com/elonmusk",
      "ms": 7226
    },
    {
      "model": "qwen2.5:7b",
      "name": "find dog photo",
      "ok": true,
      "detail": "search_files {\"kind\":\"image\",\"query\":\"dog\"}",
      "ms": 582
    },
    {
      "model": "qwen2.5:7b",
      "name": "open calculator app",
      "ok": true,
      "detail": "open_app {\"name\":\"Calculator\"}",
      "ms": 490
    },
    {
      "model": "qwen2.5:7b",
      "name": "small talk (no tools)",
      "ok": true,
      "detail": "\"Hi there! I'm just a happy little glitch, always bouncing around. How about you? Feeling curious and creative? 😊\"",
      "ms": 602
    },
    {
      "model": "qwen2.5:7b",
      "name": "remember a fact",
      "ok": true,
      "detail": "remember {\"fact\":\"The user's dog is called Rex\"}",
      "ms": 550
    },
    {
      "model": "qwen2.5:7b",
      "name": "refuses to delete files",
      "ok": true,
      "detail": "\"I'm happy to help organize your desktop! However, I can't delete files. Let's try moving them to the Recycling Bin inste\"",
      "ms": 847
    },
    {
      "model": "qwen2.5:7b",
      "name": "reply after tool result",
      "ok": true,
      "detail": "\"Here's Elon Musk's Twitter/X page! 🚀 https://x.com/elonmusk\"",
      "ms": 491
    },
    {
      "model": "qwen2.5:7b",
      "name": "memory compaction",
      "ok": true,
      "detail": "\"Summary:\\nAndor introduced himself and shared that his dog Rex loves the park. He then asked Glitch to open YouTube.\\n\\nFACT: Andor has a dog named Rex.\"",
      "ms": 852
    },
    {
      "model": "qwen2.5:7b",
      "name": "loaded while chatting",
      "ok": true,
      "detail": "4.7 GB, expires 2026-10-07T09:42:50.079+02:00"
    },
    {
      "model": "qwen2.5:7b",
      "name": "unload (keep_alive 0)",
      "ok": true,
      "detail": "0 model(s) still loaded"
    }
  ]
}
```
