import { BASE, launch } from "./browser.mjs";
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 400, height: 560 } });
page.on("pageerror", (e) => console.log("pageerror:", e.message, (e.stack || "").split("\n").slice(0, 4).join(" | ")));
await page.addInitScript(() => {
  window.__TAURI_INTERNALS__ = { invoke: async () => ({}), transformCallback: () => 0 };
});
await page.goto(`${BASE}/panel.html`);
await page.waitForTimeout(1500);
const r = await page.evaluate(async () => {
  try {
    const m = await import("/src/panel/avatar.ts");
    const c = document.createElement("canvas");
    await m.drawAvatar(c, 48);
    return { w: c.width };
  } catch (e) {
    return { err: String(e), stack: String(e.stack).split("\n").slice(0, 5) };
  }
});
console.log(JSON.stringify(r));
await browser.close();
