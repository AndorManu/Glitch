// Inline SVG icons and bubble shapes (CSP forbids external assets anyway).
// Colours come from CSS (currentColor / classes), so dark mode just works.

const icon = (body: string, size = 16) =>
  `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICON_SEND = icon(`<path d="M8 13.2V3.4M3.6 7.6 8 3.2l4.4 4.4" stroke-width="2.3"/>`);

/** Microphone: capsule, cradle, stand. */
export const ICON_MIC = icon(
  `<rect x="5.6" y="1.6" width="4.8" height="8" rx="2.4" stroke-width="2"/><path d="M3.2 7.6a4.8 4.8 0 0 0 9.6 0M8 12.4v2" stroke-width="2"/>`,
);

export const ICON_GEAR = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

export const ICON_CLOSE = icon(`<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke-width="2.4"/>`, 10);

export const ICON_CHECK = icon(`<path d="M3.2 8.6 6.6 12 12.8 4.6" stroke-width="2.4"/>`, 11);

export const ICON_FAIL = icon(`<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke-width="2.4"/>`, 10);

/**
 * Speech tail: its top 2px sit on the shape's bottom border and erase it,
 * the two curved edges carry the outline down to the tip.
 * TAIL_W x TAIL_H, tip leaning slightly left like a comic balloon.
 */
export const TAIL_W = 22;
/** x of the tail's tip inside its box. */
export const TAIL_TIP = 8.4;
export const TAIL_H = 13;
export const TAIL = `<svg viewBox="0 0 22 13" width="22" height="13" overflow="visible">
  <path class="fill" d="M1.2 -0.5 V1 C6.4 2.6 9 6.4 8.4 11.6 C11.8 7.6 15.6 2.8 20.8 1 V-0.5 Z"/>
  <path class="line" d="M1.2 1 C6.4 2.6 9 6.4 8.4 11.6 C11.8 7.6 15.6 2.8 20.8 1" fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
</svg>`;

/** The puffy thought cloud: outline pass (thick stroke) under a fill pass. */
export const CLOUD_W = 92;
export const CLOUD_H = 52;
const puffs = `<rect x="11" y="19" width="70" height="25" rx="12.5"/>
  <circle cx="23" cy="25" r="12"/>
  <circle cx="39" cy="16.5" r="13"/>
  <circle cx="57" cy="16" r="12"/>
  <circle cx="71" cy="25" r="11"/>
  <circle cx="33" cy="38" r="9.5"/>
  <circle cx="51" cy="39.5" r="9.5"/>
  <circle cx="66" cy="36.5" r="8.5"/>`;
export const CLOUD = `<svg viewBox="0 0 92 52" width="92" height="52">
  <g class="line" stroke-width="4" stroke-linejoin="round">${puffs}</g>
  <g class="fill">${puffs}</g>
  <path class="shine" d="M27 17.5a9 9 0 0 1 8-6" fill="none" stroke-width="2.2" stroke-linecap="round"/>
</svg>`;

/** The little circles trailing from the cloud down to the pill. */
export const TRAIL_W = 26;
export const TRAIL_H = 20;
export const TRAIL = `<svg viewBox="0 0 26 20" width="26" height="20" overflow="visible">
  <circle class="puff puff-big" cx="16" cy="5.5" r="4.6" stroke-width="2"/>
  <circle class="puff puff-small" cx="9" cy="15" r="3" stroke-width="2"/>
</svg>`;
