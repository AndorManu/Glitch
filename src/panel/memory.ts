// Settings → Memory: see and control what Glitch remembers.

import { api, asUiError, type MemoryView } from "../shared/ipc";
import { h } from "./dom";
import { toggleSwitch } from "./ui";

/** "Remembers 3 things · 5 earlier days". Unit-tested. */
export function memorySummary(m: MemoryView): string {
  if (!m.enabled) return "Memory is off. Glitch forgets everything when a chat ends.";
  const things = m.facts.length === 1 ? "1 thing" : `${m.facts.length} things`;
  const days = m.journal.length === 1 ? "1 earlier day" : `${m.journal.length} earlier days`;
  return m.facts.length || m.journal.length || m.summary ? `Remembers ${things} · ${days}` : "Nothing remembered yet.";
}

/** Fills `root` (a settings card body) and re-renders itself after changes. */
export async function renderMemory(root: HTMLElement): Promise<void> {
  let m: MemoryView;
  try {
    m = await api.getMemory();
  } catch (e) {
    root.replaceChildren(h("p", { class: "hint" }, `Couldn’t load memory: ${asUiError(e).message}`));
    return;
  }
  const rerender = () => void renderMemory(root);

  const toggle = toggleSwitch("Let Glitch remember things", "Kept only on this computer.", m.enabled, (on) =>
    void api.updateSettings({ memory_enabled: on }).then(rerender),
  );

  const list = h("ul", { class: "memory-list" });
  for (const f of m.facts) {
    const forget = h("button", { class: "icon-x", type: "button", title: "Forget this", "aria-label": `Forget: ${f.text}` }, "×");
    forget.addEventListener("click", async () => {
      forget.disabled = true;
      forget.closest("li")?.classList.add("leaving");
      await api.forgetMemory(f.id).catch(() => {});
      rerender();
    });
    list.append(h("li", {}, h("span", {}, f.text), forget));
  }

  const recent = m.journal.slice(-5).reverse();
  const history =
    m.summary || recent.length
      ? h(
          "details",
          { class: "memory-history" },
          h("summary", {}, "What we talked about"),
          m.summary ? h("p", {}, h("b", {}, "Today: "), m.summary) : null,
          ...recent.map((e) => h("p", {}, h("b", {}, `${e.date}: `), e.text)),
        )
      : null;

  // Two clicks to wipe everything, so it can't happen by accident.
  const wipe = h("button", { class: "secondary small danger-text", type: "button", "aria-live": "polite" }, "Forget everything");
  let armed: ReturnType<typeof setTimeout> | null = null;
  const disarm = () => {
    if (armed) clearTimeout(armed);
    armed = null;
    wipe.classList.remove("armed");
    wipe.textContent = "Forget everything";
  };
  wipe.addEventListener("click", async () => {
    if (!armed) {
      wipe.classList.add("armed");
      wipe.textContent = "Sure? Click again";
      armed = setTimeout(disarm, 4000);
      return;
    }
    clearTimeout(armed);
    wipe.disabled = true;
    wipe.textContent = "Forgetting…";
    await api.clearMemory().catch(() => {});
    rerender();
  });
  wipe.addEventListener("blur", () => armed && disarm());

  const parts: (Node | null)[] = [
    toggle,
    h("p", { class: "hint memory-summary" }, memorySummary(m)),
    m.enabled && m.facts.length > 0 ? list : null,
    m.enabled ? history : null,
    m.enabled && (m.facts.length || m.journal.length || m.summary) ? h("div", { class: "row" }, wipe) : null,
  ];
  root.replaceChildren(...parts.filter((p): p is Node => p !== null));
}
