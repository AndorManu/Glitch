// What Glitch writes on the sticky notes he drags onto the screen (chaos
// mode). Offline, in his voice: lowercase, a bit broken, never mean, never
// about the user's files or private stuff (he doesn't look at any).

export const NOTE_LINES: readonly string[] = [
  "i licked your RAM. tasted like 4 gigs",
  "your tabs are my nest now",
  "beep. i am a very serious program",
  "do not look behind this note",
  "i found a pixel. it's mine now",
  "reminder: drink water. i drink cache",
  "this note is load-bearing. do not close",
  "i pressed nothing. probably",
  "hello from inside the screen",
  "i am 3% raccoon, 97% glitch",
  "your desktop smells like snacks",
  "i defragmented my tail",
  "status: chaotic. mood: crunchy",
  "trash panda. emphasis on panda",
  "i ate a semicolon;",
  "rebooting cuteness... done",
  "brb chewing on a cable",
  "you're doing great. i'm doing glitches",
  "error 404: snack not found",
  "this window was too tidy",
  "i put a bug in your bug",
  "certified desktop gremlin",
  "the cursor started it",
  "i can see my house from this taskbar",
  "pls pet. no touchy tail",
  "i speedran your screen",
  "stealing nothing. just vibes",
  "warning: may contain raccoon",
  "my other note is a sandwich",
  "i heard the fans. they cheer for me",
  "today's forecast: 80% glitch",
  "i hid a byte. good luck",
  "loading personality.exe ... 99%",
  "your wallpaper is my lawn",
  "do raccoons dream of electric trash",
  "i bit the internet. it bit back",
  "sorry about the footprints",
  "nap.dll has stopped responding",
  "i am the captain of this monitor",
  "you have 1 new raccoon",
  "high score: 9001 windows nudged",
  "i'm not lost. i'm exploring",
  "zzz... wait, i'm awake",
  "free hugs (pixelated)",
  "i reorganized the void",
  "beware of the glitch. he's adorable",
  "who moved my window? oh. me",
  "i licked the clock. it's later now",
];

/** The note page shows line `n` (any integer; wraps around). */
export function noteLine(n: number): string {
  const i = ((Math.floor(n) % NOTE_LINES.length) + NOTE_LINES.length) % NOTE_LINES.length;
  return NOTE_LINES[Number.isFinite(i) ? i : 0];
}

/** A random line, not the one shown last. */
export function pickLine(rand: () => number, last = -1): number {
  if (NOTE_LINES.length < 2) return 0;
  let i = Math.floor(rand() * NOTE_LINES.length) % NOTE_LINES.length;
  if (i === last) i = (i + 1) % NOTE_LINES.length;
  return i;
}
