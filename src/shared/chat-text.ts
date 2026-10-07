// Words Glitch uses in the chat UI that don't depend on the model.
import type { UiError } from "./ipc";

/** Friendly text for errors the user can fix. Unit-tested. */
export function explainError(e: UiError): { text: string; offerSetup: boolean } {
  switch (e.code) {
    case "ollama_unreachable":
      return { text: "I can't reach Ollama, my brain app. Is it running?", offerSetup: true };
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
  "Hi, I'm Glitch! Ask me anything, or try “open YouTube”, “open the Calculator app” or “find a photo of a dog”.";

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
