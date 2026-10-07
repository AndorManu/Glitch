// Words Glitch uses in the chat UI that don't depend on the model.
import type { UiError } from "./ipc";

/** Friendly text for errors the user can fix. Unit-tested. */
export function explainError(e: UiError): { text: string; offerSetup: boolean } {
  switch (e.code) {
    case "ollama_unreachable":
      return { text: "I can't reach Ollama, my brain app. Is it running?", offerSetup: true };
    case "ai_timeout":
      return { text: "My brain is taking ages. It may still be waking up. Try again in a moment, or pick a smaller brain in Settings.", offerSetup: false };
    case "too_long":
      return { text: "That's a lot of text! Could you make it shorter?", offerSetup: false };
    case "model_missing":
      return { text: "My brain (the AI model) isn't downloaded yet.", offerSetup: true };
    case "no_model":
      return { text: "I need a brain first! Let's pick one.", offerSetup: true };
    case "stale_confirmation":
      return { text: "That request expired, so I didn't do it. Just ask me again.", offerSetup: false };
    default:
      return { text: `Oops, something went wrong: ${e.message}`, offerSetup: false };
  }
}

export const WELCOME =
  "Hi, I'm Glitch! Ask me anything, or try “what's on my screen?”, “what does this error mean?”, “what's 15% of what I copied?” or “remind me to stretch in 20 minutes”.";

/** The badge while Glitch takes a screenshot. */
export function lookingText(target: "screen" | "window" | "cursor"): string {
  return target === "cursor" ? "👀 looking under your mouse" : target === "window" ? "👀 looking at your window" : "👀 looking at your screen";
}

/**
 * The speech bubble shows plain text: drop the markdown small models add
 * anyway and a "Glitch:" speaker label. Same rules as `plain_text` in
 * crates/glitch-core/src/agent.rs (used here for text while it streams in,
 * so the final reply matches what was already shown). Unit-tested.
 */
export function plainText(text: string): string {
  let t = text.trim();
  for (const label of ["**Glitch:**", "Glitch:", "**Glitch**:"]) {
    if (t.slice(0, label.length).toLowerCase() === label.toLowerCase()) t = t.slice(label.length).trimStart();
  }
  return t
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("```"))
    .map((l) => {
      const line = l.replaceAll("**", "").replaceAll("`", "");
      const trimmed = line.trimStart();
      if (trimmed.startsWith("* ")) return `- ${trimmed.slice(2)}`;
      if (trimmed.startsWith("#")) return trimmed.replace(/^#+/, "").trimStart();
      return line;
    })
    .join("\n")
    .trim();
}

/** Said after "Clear chat" in Settings. */
export const CLEARED = "Fresh start! What's on your mind?";

/** Placeholder of the little compose pill. */
export const PLACEHOLDER = "Say something to Glitch…";

/** Screen-reader text while the thought cloud is up. */
export const THINKING = "Glitch is thinking…";

/** Shown when the model answered with nothing at all. */
export const EMPTY_REPLY = "Hmm… I'm not sure what to say to that.";

/**
 * Turn a confirmation title from Rust ("Open the app “Spotify”") into Glitch
 * asking for permission ("Can I open the app “Spotify”?"). Unit-tested.
 */
export function askPermission(title: string): string {
  const t = title.trim().replace(/[.?!…]+$/, "");
  if (!t) return "Can I go ahead?";
  // Keep words like "URL" or "Spotify" intact: only lower a capital that
  // starts an ordinary word.
  const lowered = /^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t;
  return `Can I ${lowered}?`;
}
