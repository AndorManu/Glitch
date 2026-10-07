// Settings → Features: optional extras, one card each. To add one, write
// a module with a `Feature` and list it in FEATURES.

import { voiceExtra } from "./voice-extra";

export interface Feature {
  /** Stable id (also the card's data-feature attribute). */
  id: string;
  title: string;
  /** Fill the card body; the feature keeps it up to date itself. */
  render(root: HTMLElement): void;
}

export const FEATURES: readonly Feature[] = [voiceExtra];
