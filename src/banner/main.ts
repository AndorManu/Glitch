// "Glitch is driving <App>, press Esc to stop": shown while Glitch acts in
// another app (src-tauri/src/hands.rs). The app name comes in the URL hash.
// The window never takes focus or clicks; Esc is caught by Rust's input hook.

import { bannerText } from "./text";

const el = document.getElementById("text")!;
const app = (() => {
  try {
    return decodeURIComponent(location.hash.slice(1));
  } catch {
    return "";
  }
})();
const { before, key, after } = bannerText(app);
const kbd = document.createElement("kbd");
kbd.textContent = key;
el.replaceChildren(before, kbd, after);
