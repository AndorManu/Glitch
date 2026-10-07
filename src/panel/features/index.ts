// Settings → Features: one card per optional feature, each in its own file.
// To add one: write src/panel/features/<feature>.ts exporting a Feature and
// add it to FEATURES below. Each card owns its switches and redraws itself.

import { updateMeFeature } from "./update-me";

export interface Feature {
  id: string;
  title: string;
  /** Fill `root` (the card body). Called on every settings redraw. */
  render(root: HTMLElement): Promise<void>;
}

export const FEATURES: Feature[] = [updateMeFeature];
