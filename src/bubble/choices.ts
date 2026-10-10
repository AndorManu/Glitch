// Keyboard safety for the Allow / Nope card (review 2026-10-08, L1).
//
// Someone who sends with Enter may press Enter again (a double tap, key
// repeat, or Enter meant for the next message). That must never approve an
// action they haven't read. So the card focuses "Nope", and "Allow" ignores
// activation for a moment after the card appears. Allow stays reachable with
// Tab or the mouse.

/** Order of the buttons on a confirmation card. */
export const CONFIRM_CHOICES = ["Allow", "Nope"] as const;

/** "Allow" does nothing for this long after the card appears. */
export const ALLOW_GRACE_MS = 600;

/** Which button gets keyboard focus when a card with `count` buttons appears. */
export function defaultChoice(kind: "confirm" | "other", count: number): number | null {
  if (count === 0) return null;
  return kind === "confirm" ? CONFIRM_CHOICES.indexOf("Nope") : 0;
}

/** May a click or key on "Allow" count, `now - shownAt` ms after the card appeared? */
export function allowAccepted(shownAt: number, now: number): boolean {
  return now - shownAt >= ALLOW_GRACE_MS;
}
