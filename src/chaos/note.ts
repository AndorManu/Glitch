// The sticky note Glitch drags onto the screen. Shows line #n from the URL
// hash; × (or Esc) closes it for good.

import { chaosApi } from "../shared/ipc";
import { noteLine } from "./lines";

const text = document.getElementById("text")!;
text.textContent = noteLine(Number(location.hash.slice(1)) || 0);

const close = () => void chaosApi.noteClose().catch(() => window.close());
document.getElementById("close")!.addEventListener("click", close);
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") close();
});
window.addEventListener("contextmenu", (e) => e.preventDefault());
