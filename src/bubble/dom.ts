// A tiny element helper (the bubble's stand-in for a UI framework).

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | boolean | number | EventListener | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = String(v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Parse a trusted, hard-coded SVG string (icons and shapes below only). */
export function svg(markup: string, cls?: string): SVGSVGElement {
  const tpl = document.createElement("template");
  tpl.innerHTML = markup.trim();
  const el = tpl.content.firstElementChild as SVGSVGElement;
  if (el.namespaceURI !== SVG_NS) throw new Error("not an svg");
  el.setAttribute("aria-hidden", "true");
  el.setAttribute("focusable", "false");
  if (cls) el.setAttribute("class", cls);
  return el;
}
