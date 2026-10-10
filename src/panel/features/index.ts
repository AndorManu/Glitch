// The Settings "Features" section: one card per feature, each with its own
// on/off switch. Add a feature by writing src/panel/features/<feature>.ts
// and listing it here.

import type { Settings } from "../../shared/ipc";
import { contextFeature } from "./context";
import { voiceExtra } from "./voice-extra";
import { playFeature } from "./play";
import { streamFeature } from "./stream";
import { updatesFeature } from "./updates";
import { handsFeature } from "./hands";
import { safetyFeature } from "./safety";
import { chaosFeature } from "./chaos";
import { updateMeFeature } from "./update-me";

export interface Feature {
  id: string;
  /** Draw the feature's controls from the current settings. */
  render(s: Settings): HTMLElement;
}

export const FEATURES: readonly Feature[] = [safetyFeature, chaosFeature, contextFeature, handsFeature, playFeature, updateMeFeature, voiceExtra, streamFeature, updatesFeature];
