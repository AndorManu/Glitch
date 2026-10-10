/** What the little tag under the ring says for each kind of pointer action. Unit-tested. */
const LABELS: Record<string, string> = {
  click: "Click here",
  right: "Right-click here",
  double: "Double-click here",
  move: "Moving here",
  pickup: "Picking this up",
  drop: "Dropping it here",
  scroll_down: "Scrolling down",
  scroll_up: "Scrolling up",
};

export function pointerLabel(kind: string): string {
  return LABELS[kind] ?? "Here";
}

export const POINTER_KINDS = Object.keys(LABELS);
