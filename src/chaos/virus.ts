// Glitch's fake popup (chaos mode 2). Always unmistakably his: pixel frame, his
// face, magenta palette, "Glitch is only playing" in the footer, a visible
// Close button, Esc closes. Rust opens it without taking the keyboard focus and
// also watches Esc, so it closes either way. It does nothing but show text.

import { chaos2Api } from "../shared/ipc";
import { drawAvatar } from "../panel/avatar";
import { closeLabel, FOOTER, POPUP_KINDS, POPUP_LIFE_MS, type PopupKind, stageAt } from "./virus-lines";

const raw = location.hash.slice(1);
const kind: PopupKind = (POPUP_KINDS as readonly string[]).includes(raw) ? (raw as PopupKind) : "adopted";

const $ = (id: string) => document.getElementById(id)!;
const title = $("title");
const body = $("body");
const bar = $("bar");
const fill = $("fill");
const meter = $("meter");
const minis = $("minis");
const closeBtn = $("close") as HTMLButtonElement;

$("footer").textContent = FOOTER;
closeBtn.textContent = closeLabel(kind);
void drawAvatar($("face") as HTMLCanvasElement, 72);

const close = (): void => void chaos2Api.popupClose().catch(() => window.close());
closeBtn.addEventListener("click", close);
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") close();
});
window.addEventListener("contextmenu", (e) => e.preventDefault());

const t0 = performance.now();
let shownMinis = 0;
let last = "";

function paint(): void {
  const ms = performance.now() - t0;
  const s = stageAt(kind, ms);
  const key = `${s.title}|${s.body}|${s.meter}|${s.raccoons}|${(s.progress ?? -1).toFixed(2)}`;
  if (key !== last) {
    last = key;
    title.textContent = s.title;
    body.textContent = s.body;
    bar.hidden = s.progress === null;
    fill.style.width = `${Math.round((s.progress ?? 0) * 100)}%`;
    bar.setAttribute("aria-valuenow", String(Math.round((s.progress ?? 0) * 100)));
    meter.textContent = s.meter;
    while (shownMinis < s.raccoons) {
      const c = document.createElement("canvas");
      c.width = c.height = 28;
      void drawAvatar(c, 28);
      minis.appendChild(c);
      shownMinis++;
    }
  }
  if (ms > POPUP_LIFE_MS) return close();
  // 10 repaints a second is plenty for a progress bar.
  window.setTimeout(paint, 100);
}
paint();
