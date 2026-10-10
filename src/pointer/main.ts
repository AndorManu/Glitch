// The pointer overlay (src-tauri/src/hands_desktop/overlay.rs): a ring, a
// ghost cursor and a little paw at the spot Glitch is about to click. Rust
// moves the window and calls these three functions; the window never takes
// focus or clicks.

import { pointerLabel } from "./labels";

const stage = document.getElementById("stage")!;
const label = document.getElementById("label")!;

declare global {
  interface Window {
    __ping: (kind: string) => void;
    __pop: () => void;
    __hide: () => void;
  }
}

window.__ping = (kind) => {
  label.textContent = pointerLabel(kind);
  stage.classList.remove("pop");
  stage.classList.add("on");
};
window.__pop = () => {
  stage.classList.remove("pop");
  void stage.getBoundingClientRect(); // restart the animation
  stage.classList.add("pop");
};
window.__hide = () => stage.classList.remove("on", "pop");
