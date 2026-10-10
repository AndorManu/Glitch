#!/usr/bin/env node
// Wake word + character voice check on a real machine (Windows, SAPI voices).
//
//   node dev/wake-check.mjs              # tiny + base
//   node dev/wake-check.mjs base         # one model
//
// 1. Synthesizes test audio to <temp>/glitch-wake:
//    - pos_*.wav: "Hey Glitch, open YouTube" variants (3 voices x 3 speeds,
//      with and without a pause after the name)
//    - neg_*.wav: 5+ minutes of speech that must NOT wake him (including
//      near misses: "a glitch in the system", "Hey Mitch", German "gleich",
//      "glitchy", "Hi Glitch"), plus 2 minutes of music-like noise
// 2. Runs the #[ignore]d tests in src-tauri/src/voice/wake_check.rs:
//    - live_wake_wavs: every file through the real pipeline (utterance
//      gate -> whisper wake check -> command transcript), printing true
//      positives, false wakes, CPU per second of audio and latency
//    - live_wake_mic_idle: the armed listener on the real microphone for
//      60 s (keep the room quiet), printing CPU use
//    - live_tts: Piper's time to first audio, cold and on standby (needs
//      the voice in <temp>/glitch-tts, see the test)
//
// Speech models are shared with dev/voice-check.mjs (<temp>/glitch-voice/models).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.platform !== "win32") {
  console.error("this check uses Windows' SAPI voices");
  process.exit(1);
}

const models = process.argv[2] ?? "tiny,base";
const dir = join(tmpdir(), "glitch-wake");
mkdirSync(dir, { recursive: true });

const VOICES = ["David", "Zira", "Hazel"];
const RATES = [-2, 0, 3];

// [name, text before the pause, text after it (or "")]
const POSITIVES = [
  ["oneshot", "Hey Glitch, open YouTube.", ""],
  ["pause", "Hey Glitch.", "Open YouTube."],
  ["long", "Hey Glitch, open YouTube and search for lo-fi music.", ""],
  ["okay", "Okay Glitch, open YouTube.", ""],
  ["please", "Hey Glitch, could you open YouTube for me?", ""],
  ["play", "Hey Glitch, play some music on YouTube.", ""],
  ["ohhey", "Oh, hey Glitch! Open YouTube please.", ""],
  ["slowpause", "Hey, Glitch.", "Can you open YouTube?"],
];

// Ordinary talk (a podcast, a video, a phone call next to the computer).
const NEGATIVE_TEXT = [
  "Welcome back to the show. Today we are talking about how small companies can use cloud computing without spending a fortune. Our guest has been building software for more than fifteen years.",
  "There was a glitch in the system last night, and the payment page went down for about an hour. Nobody lost any money, but the support team had a long evening.",
  "Hey Mitch, can you grab the charger from the kitchen? I think I left it next to the coffee machine.",
  "If you switch the light off in the hallway, the motion sensor will turn it back on after a few seconds anyway.",
  "The pitch was great, but the investors wanted to see more numbers before they made a decision.",
  "Okay, so let's get started. First, open the settings menu and scroll down to the privacy section.",
  "Hey, what's up? Long time no see. How was the trip to Portugal?",
  "That game is so glitchy, my character fell through the floor three times in the first level.",
  "Ich komme gleich, ich muss nur noch kurz die E-Mail fertig schreiben.",
  "Hi Glitch is what my little brother calls the raccoon on my screen, but he never asks it anything.",
  "The weather tomorrow will be cloudy with a chance of rain in the afternoon. Temperatures will stay around fourteen degrees.",
  "To make the sauce, melt the butter in a pan, add the flour, and stir for one minute before you pour in the milk.",
  "He glitched out in the middle of the presentation and had to restart his laptop.",
  "Rich people often say that time is more valuable than money, and maybe they are right.",
  "Hey Siri, what's the time? Okay Google, set a timer. Alexa, play some jazz. None of these should wake anything here.",
  "The match ended in a draw after ninety minutes, and the fans were not very happy with the referee.",
  "Please remember to bring your ID card and a printed copy of the ticket to the airport.",
  "In this tutorial, we will open YouTube, search for a video, and add it to a playlist. Let's go.",
  "My grandmother grew up on a farm, and she still wakes up at five every morning to feed the chickens.",
  "The new update fixes a few bugs, improves battery life, and adds a dark mode to the calendar app.",
  "Can you believe it? The train was late again, and I missed the first half of the meeting.",
  "A glitch, a bug, a hiccup: call it what you want, the server was down for everyone in Europe.",
  "Today's episode is sponsored by a company that makes very comfortable office chairs.",
  "Hey there, glitchy little computer, please don't crash before I save this file.",
  "When you are learning a new language, the most important thing is to practice a little every day.",
  "The museum is open from nine to six, and on Sundays the entrance is free for students.",
  "So the plan is simple: we finish the report today, send it tomorrow, and celebrate on Friday.",
  "Hey, glitches happen. Don't worry about it, just try again in a minute.",
  "Gleich geht es weiter mit den Nachrichten und dem Wetter für morgen.",
  "Thank you for watching, and don't forget to like and subscribe for more videos like this one.",
];

function ps(script) {
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "inherit" });
}

const esc = (t) => t.replace(/'/g, "''");

/** One SAPI file: `parts` are spoken with a ~1 s pause between them. */
function synth(file, parts, voice, rate, hz) {
  const speak = parts
    .filter(Boolean)
    .map((p, i) => `${i ? "$pb.AppendBreak([TimeSpan]::FromMilliseconds(1000)); " : ""}$pb.AppendText('${esc(p)}');`)
    .join(" ");
  ps(`
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Name -like '*${voice}*' } | Select-Object -First 1
if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }
$s.Rate = ${rate}
$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(${hz}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile('${file}', $f)
$pb = New-Object System.Speech.Synthesis.PromptBuilder
${speak}
$s.Speak($pb)
$s.Dispose()`);
}

let n = 0;
for (const [name, a, b] of POSITIVES) {
  for (const voice of VOICES) {
    for (const rate of RATES) {
      const f = join(dir, `pos_${name}_${voice}_${rate}.wav`);
      if (!existsSync(f)) synth(f, [a, b], voice, rate, [16000, 22050, 44100][n % 3]);
      n++;
    }
  }
}
NEGATIVE_TEXT.forEach((t, i) => {
  const f = join(dir, `neg_speech_${String(i).padStart(2, "0")}.wav`);
  if (!existsSync(f)) synth(f, [t], VOICES[i % 3], [0, -1, 2][i % 3], 22050);
});

// Music-like noise: chords with harmonics, a bass line, hi-hat and kick-ish
// noise bursts (90 s), then pink-ish noise (30 s). Deterministic.
function writeWav(file, samples, rate) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(s * 32767))), 44 + i * 2));
  writeFileSync(file, buf);
}
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
const musicFile = join(dir, "neg_music.wav");
if (!existsSync(musicFile)) {
  const rate = 22050;
  const out = new Float32Array(rate * 90);
  const chords = [[220, 277.2, 329.6], [196, 246.9, 293.7], [174.6, 220, 261.6], [196, 246.9, 329.6]];
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const beat = t * 2; // 120 bpm
    const chord = chords[Math.floor(t / 2) % chords.length];
    let s = 0;
    for (const f of chord) for (let h = 1; h <= 4; h++) s += (0.08 / h) * Math.sin(2 * Math.PI * f * h * t);
    s += 0.15 * Math.sin(2 * Math.PI * (chord[0] / 2) * t) * (1 - (beat % 1));
    const ph = beat % 0.5;
    if (ph < 0.03) s += 0.25 * rnd() * (1 - ph / 0.03); // hi-hat
    if (beat % 1 < 0.08) s += 0.4 * Math.sin(2 * Math.PI * 60 * t) * (1 - (beat % 1) / 0.08); // kick
    out[i] = s * 0.6;
  }
  writeWav(musicFile, out, rate);
}
const noiseFile = join(dir, "neg_noise.wav");
if (!existsSync(noiseFile)) {
  const rate = 16000;
  const out = new Float32Array(rate * 30);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < out.length; i++) {
    const w = rnd();
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    // Swells in and out like a fan or traffic.
    out[i] = (b0 + b1 + b2 + w * 0.1848) * 0.05 * (0.6 + 0.4 * Math.sin((2 * Math.PI * i) / (rate * 7)));
  }
  writeWav(noiseFile, out, rate);
}
console.log(`test audio in ${dir}`);

const env = {
  ...process.env,
  GLITCH_WAKE_WAVS: dir,
  GLITCH_VOICE_MODELS: join(tmpdir(), "glitch-voice", "models"),
  GLITCH_WAKE_MODELS: models,
  GLITCH_TTS_DIR: join(tmpdir(), "glitch-tts"),
};
const r = spawnSync(
  "cargo",
  ["test", "-p", "glitch", "--release", "wake_check::", "--", "--ignored", "--nocapture", "--test-threads=1"],
  { stdio: "inherit", env, shell: true },
);
process.exit(r.status ?? 1);
