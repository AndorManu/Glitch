#!/usr/bin/env node
// Live voice check on a real machine (Windows: speech from SAPI; macOS: `say`).
//
//   node dev/voice-check.mjs            # tiny + base, all checks
//   node dev/voice-check.mjs base       # one model
//
// 1. Synthesizes spoken commands to WAV files (different voices, sample rates
//    and channel counts, so mono mix-down and resampling are exercised).
// 2. Runs the #[ignore]d live tests in src-tauri/src/voice/live_check.rs:
//    - live_download: downloads the models from Hugging Face, cutting the
//      first try off at 15 MB to prove resume + SHA-1 on the real server
//    - live_mic: lists microphones, records 2 s, reports open time and level
//    - live_wav_pipeline: each WAV through the real session code (real-time
//      fake mic -> VAD -> resample -> whisper), hold and hands-free, checking
//      the words and printing the latency after the speech ended.
//
// Files go to <temp>/glitch-voice (models are kept between runs).

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const models = process.argv[2] ?? "tiny,base";
const dir = join(tmpdir(), "glitch-voice");
const wavs = join(dir, "wavs");
mkdirSync(wavs, { recursive: true });

// name, text, words the transcript must contain, voice hint, rate, channels
const phrases = [
  ["twitter", "open twitter on elon musk's page", "open twitter elon musk's page", "David", 48000, 2],
  ["weather", "what's the weather like", "what's the weather like", "Zira", 44100, 1],
  ["timer", "set a timer for five minutes please", "timer minutes", "David", 16000, 1],
  ["youtube", "Glitch, open YouTube and search for lo-fi music", "open youtube search music", "Zira", 22050, 1],
];

function synthWindows([name, text, , voice, rate, channels]) {
  const ps = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Name -like '*${voice}*' } | Select-Object -First 1
if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }
$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(${rate}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::${channels === 2 ? "Stereo" : "Mono"})
$s.SetOutputToWaveFile('${join(wavs, name + ".wav")}', $f)
$s.Speak('${text.replace(/'/g, "''")}')
$s.Dispose()`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { stdio: "inherit" });
}

function synthMac([name, text, , , rate]) {
  execFileSync("say", ["-o", join(wavs, name + ".wav"), `--data-format=LEI16@${rate}`, text], { stdio: "inherit" });
}

for (const p of phrases) {
  if (process.platform === "win32") synthWindows(p);
  else if (process.platform === "darwin") synthMac(p);
  else {
    console.error("voice is Windows/macOS only");
    process.exit(1);
  }
  writeFileSync(join(wavs, p[0] + ".txt"), p[2]);
}
console.log(`speech files in ${wavs}`);

const env = {
  ...process.env,
  GLITCH_VOICE_WAVS: wavs,
  GLITCH_VOICE_MODELS: join(dir, "models"),
  GLITCH_VOICE_CHECK_MODELS: models,
};
const r = spawnSync(
  "cargo",
  ["test", "-p", "glitch", "--release", "live_", "--", "--ignored", "--nocapture", "--test-threads=1"],
  { stdio: "inherit", env, shell: process.platform === "win32" },
);
process.exit(r.status ?? 1);
