// Settings → Features → Updates: daily check against GitHub Releases
// (src-tauri/src/autoupdate.rs). Installs only on a click; downloads are
// signature-checked against Glitch's key before anything runs.

import { listen } from "@tauri-apps/api/event";
import { asUiError, updateApi, type UpdateStatus } from "../../shared/ipc";
import { h } from "../dom";
import { busyButton, toggleSwitch } from "../ui";
import type { Feature } from "./index";
import { featureBlock } from "./stream";

/** The status line. `now` in unix seconds. Unit-tested. */
export function updateLine(st: UpdateStatus, now: number): { text: string; tone: "ok" | "muted" | "error" } {
  if (st.installing) return { text: st.progress === null ? "Downloading the update…" : `Downloading the update… ${st.progress}%`, tone: "muted" };
  if (st.checking) return { text: "Checking…", tone: "muted" };
  if (st.available) return { text: `Glitch ${st.available.version} is out (you have ${st.current}).`, tone: "ok" };
  if (st.error) return { text: st.error, tone: "error" };
  if (!st.last_check) return { text: `You have Glitch ${st.current}.`, tone: "muted" };
  const mins = Math.max(0, Math.round((now - st.last_check) / 60));
  const when = mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : mins < 60 * 24 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} days ago`;
  return { text: `You have the latest Glitch (${st.current}). Checked ${when}.`, tone: "muted" };
}

let current: HTMLElement | null = null;
let listening = false;

async function render(root: HTMLElement): Promise<void> {
  current = root;
  if (!listening) {
    listening = true;
    void listen<UpdateStatus>("update-status", () => {
      if (current?.isConnected) void render(current);
    });
  }
  let st: UpdateStatus;
  try {
    st = await updateApi.status();
  } catch (e) {
    root.replaceChildren(h("p", { class: "hint" }, `Couldn’t load update settings: ${asUiError(e).message}`));
    return;
  }
  if (root !== current) return;
  const l = updateLine(st, Date.now() / 1000);
  root.replaceChildren(
    toggleSwitch("Check for updates", "Once a day, from Glitch's GitHub page. Nothing installs until you say so.", st.auto_check, (on) => {
      void updateApi.setAuto(on).then(() => render(root));
    }),
    h("p", { class: `feature-line ${l.tone}`, role: "status" }, l.text),
    h(
      "div",
      { class: "row" },
      st.available && !st.installing
        ? busyButton(`Install ${st.available.version}`, "Installing…", () => updateApi.install())
        : busyButton("Check now", "Checking…", () => updateApi.check().catch(() => render(root))),
    ),
  );
}

export const updatesFeature: Feature = { id: "updates", render: () => featureBlock("Updates", render) };
