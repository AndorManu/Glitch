/** The banner's words around the <kbd>Esc</kbd>. Unit-tested. */
export function bannerText(app: string): { before: string; key: string; after: string } {
  const name = app.trim().slice(0, 40);
  return { before: `Glitch is driving ${name || "an app"}, press `, key: "Esc", after: " to stop" };
}
