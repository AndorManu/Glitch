// The Settings "Features" section: one card per feature, each with its own
// on/off switch. Add a feature by writing src/panel/features/<feature>.ts
// and listing it here.

import type { Settings } from "../../shared/ipc";
import { contextFeature } from "./context";
import { voiceExtra } from "./voice-extra";

export interface Feature {
  id: string;
  /** Draw the feature's controls from the current settings. */
  render(s: Settings): HTMLElement;
}

export const FEATURES: readonly Feature[] = [contextFeature, voiceExtra];
