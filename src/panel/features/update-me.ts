// Settings → Features → "Update me": scripts and builds ping Glitch, the
// Claude Code buddy, the notification digest, saved reminders and the daily
// briefing. Every part has its own switch; the connected / private ones
// (Claude Code, notifications) start off.

import { listen } from "@tauri-apps/api/event";
import {
  asUiError,
  updateMeApi,
  type ClaudeCodeStatus,
  type DigestGroup,
  type NotificationAccess,
  type UpdateLocation,
  type UpdateMePatch,
  type UpdateMeStatus,
} from "../../shared/ipc";
import { h } from "../dom";
import { busyButton, toggleSwitch } from "../ui";
import type { Feature } from "./index";

/** What the notification reader can do right now. Unit-tested. */
export function accessText(access: NotificationAccess, os: UpdateMeStatus["os"]): { text: string; ok: boolean } {
  if (os !== "windows") return { text: "Only works on Windows: macOS doesn't let apps read other apps' notifications.", ok: false };
  switch (access) {
    case "allowed":
      return { text: "Windows lets Glitch read notifications.", ok: true };
    case "denied":
      return { text: "Windows says no. Turn on notification access in Settings > Privacy & security > Notifications.", ok: false };
    case "unspecified":
      return { text: "Waiting for you to answer Windows' question about notification access.", ok: false };
    case "unavailable":
      return { text: "This version of Windows doesn't let Glitch read notifications.", ok: false };
  }
}

/** One line about the Claude Code hook. Unit-tested. */
export function claudeLine(c: ClaudeCodeStatus | null, error: string | null): string {
  if (!c) return error ?? "Claude Code settings not found.";
  if (c.problem) return c.problem;
  if (c.outdated) return "Connected, but to an older copy of Glitch. Connect again to update it.";
  if (c.connected) return "Connected: Claude Code tells Glitch when a session finishes or needs you.";
  return "Not connected.";
}

/** "3 WhatsApp, 1 Teams waiting" or "". Unit-tested. */
export function digestLine(groups: DigestGroup[]): string {
  if (!groups.length) return "";
  return `${groups.map((g) => `${g.count} ${g.app}`).join(", ")} waiting. Click Glitch to hear them.`;
}

/** "WhatsApp, my bank" -> ["WhatsApp", "my bank"]. Unit-tested. */
export function parseList(s: string): string[] {
  return s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter((x, i, all) => x && all.indexOf(x) === i)
    .slice(0, 100);
}

let listening = false;
let current: HTMLElement | null = null;

async function render(root: HTMLElement): Promise<void> {
  current = root;
  if (!listening) {
    listening = true;
    const again = () => current?.isConnected && void render(current);
    void listen("reminders-changed", again).catch(() => {});
    void listen("digest-changed", again).catch(() => {});
  }
  let st: UpdateMeStatus;
  try {
    st = await updateMeApi.status();
  } catch (e) {
    root.replaceChildren(h("p", { class: "hint" }, `Couldn’t load: ${asUiError(e).message}`));
    return;
  }
  const s = st.settings;
  const note = h("p", { class: "status", role: "status" });
  const fail = (e: unknown) => {
    note.className = "status error";
    note.textContent = asUiError(e).message;
  };
  const set = (patch: UpdateMePatch) => updateMeApi.set(patch).then(() => render(root), fail);
  const sw = (label: string, hint: string, on: boolean, key: keyof UpdateMePatch) =>
    toggleSwitch(label, hint, on, (v) => void set({ [key]: v } as UpdateMePatch));

  // -- scripts and builds
  const endpoint = h(
    "div",
    { class: "um-section" },
    sw(
      "Scripts can ping me",
      "Builds, downloads and scripts tell Glitch when they’re done: glitch --notify \"build done\". Only this computer, with a secret token.",
      s.endpoint_enabled,
      "endpoint_enabled",
    ),
    s.endpoint_enabled
      ? h(
          "div",
          { class: "um-line" },
          h("span", { class: "hint" }, st.endpoint_port ? `Listening on 127.0.0.1:${st.endpoint_port}` : "Starting…"),
          busyButton("Send a test", "Sending…", () => updateMeApi.test().catch(fail)),
        )
      : null,
  );

  // -- Claude Code
  const preview = h("div", { class: "um-preview", hidden: true });
  const showPreview = () => {
    if (!st.claude) return;
    preview.replaceChildren(
      h("p", { class: "hint" }, "Glitch will add these hooks to ", h("code", {}, st.claude.path), " (your other settings stay, and a backup is saved next to it):"),
      h("pre", { class: "um-code" }, st.claude.preview),
      h(
        "div",
        { class: "um-line" },
        busyButton("Add them", "Connecting…", () => updateMeApi.claudeConnect().then(() => render(root), fail)),
        h("button", { class: "link", type: "button", onclick: () => (preview.hidden = true) }, "Cancel"),
      ),
    );
    preview.hidden = false;
  };
  const connected = !!st.claude?.connected;
  const claude = h(
    "div",
    { class: "um-section" },
    sw(
      "Claude Code buddy",
      "When a Claude Code session is done or needs you, Glitch runs over, knocks on the screen and says which project.",
      s.claude_code_enabled,
      "claude_code_enabled",
    ),
    h("p", { class: "hint um-state" }, claudeLine(st.claude, st.claude_error)),
    st.claude && !st.claude.problem
      ? h(
          "div",
          { class: "um-line" },
          !connected || st.claude.outdated
            ? h("button", { class: "secondary small", type: "button", onclick: showPreview }, connected ? "Connect again…" : "Connect Claude Code…")
            : null,
          connected ? busyButton("Disconnect", "Removing…", () => updateMeApi.claudeDisconnect().then(() => render(root), fail)) : null,
        )
      : null,
    preview,
  );

  // -- notifications
  const access = accessText(st.notifications_access, st.os);
  const blockInput = h("input", {
    class: "um-input",
    type: "text",
    value: s.notifications_blocklist.join(", "),
    placeholder: "e.g. Tinder, Work Slack",
    "aria-label": "Apps Glitch never reads",
  });
  const notif = h(
    "div",
    { class: "um-section" },
    sw(
      "What did I miss?",
      "Glitch reads Windows’ notifications (WhatsApp, Teams, Discord…) and holds up a sign like “3 WhatsApp, 1 Teams”. Click him for one-line summaries from your local brain. Banking, payment and authenticator apps are never read, and codes are hidden.",
      s.notifications_enabled,
      "notifications_enabled",
    ),
    s.notifications_enabled ? h("p", { class: `hint um-state${access.ok ? "" : " um-warn"}` }, access.text) : null,
    s.notifications_enabled && digestLine(st.digest) ? h("p", { class: "hint um-state" }, digestLine(st.digest)) : null,
    s.notifications_enabled
      ? sw("Quiet mode", "Keep the digest, but no sign and no walking over. You hear it when you open the chat.", s.notifications_quiet, "notifications_quiet")
      : null,
    s.notifications_enabled
      ? h(
          "label",
          { class: "um-field" },
          h("span", { class: "um-label" }, "Never read these apps too"),
          h(
            "span",
            { class: "um-line" },
            blockInput,
            busyButton("Save", "Saving…", () => set({ notifications_blocklist: parseList(blockInput.value) })),
          ),
        )
      : null,
  );

  // -- reminders
  const list = h("ul", { class: "memory-list" });
  for (const r of st.reminders) {
    const del = h("button", { class: "icon-x", type: "button", title: "Delete", "aria-label": `Delete reminder: ${r.text}` }, "×");
    del.addEventListener("click", () => {
      del.disabled = true;
      void updateMeApi.deleteReminder(r.id).then(() => render(root), fail);
    });
    list.append(h("li", {}, h("span", {}, h("b", {}, r.when), ` ${r.text}`), del));
  }
  const reminders = h(
    "div",
    { class: "um-section" },
    sw(
      "Reminders",
      "Say “remind me to call mum at 5”. Saved on this computer, kept after a restart, and Glitch nags until you click Done.",
      s.reminders_enabled,
      "reminders_enabled",
    ),
    s.reminders_enabled && st.reminders.length ? list : null,
  );

  // -- briefing
  const results = h("div", { class: "um-results" });
  const search = h("input", { class: "um-input", type: "search", placeholder: "Your town", "aria-label": "Town for the weather" });
  const pick = (loc: UpdateLocation) => void set({ location: loc });
  const find = async () => {
    results.replaceChildren(h("span", { class: "hint" }, "Looking…"));
    try {
      const found = await updateMeApi.searchLocation(search.value);
      results.replaceChildren(
        ...(found.length
          ? found.map((l) => h("button", { class: "secondary small", type: "button", onclick: () => pick(l) }, l.name))
          : [h("span", { class: "hint" }, "No place found.")]),
      );
    } catch (e) {
      results.replaceChildren(h("span", { class: "hint" }, `Couldn’t search: ${asUiError(e).message}`));
    }
  };
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void find();
    }
  });
  const briefing = h(
    "div",
    { class: "um-section" },
    sw(
      "Daily briefing",
      "The first time you open the chat each day: the time, the weather, today’s reminders and open to-dos from your notes.",
      s.briefing_enabled,
      "briefing_enabled",
    ),
    s.briefing_enabled
      ? s.location
        ? h(
            "div",
            { class: "um-line" },
            h("span", { class: "hint" }, `Weather for ${s.location.name} (Open-Meteo)`),
            h("button", { class: "link", type: "button", onclick: () => void set({ clear_location: true }) }, "Change"),
          )
        : h(
            "div",
            { class: "um-field" },
            h("span", { class: "um-label" }, "Weather for"),
            h("span", { class: "um-line" }, search, h("button", { class: "secondary small", type: "button", onclick: () => void find() }, "Find")),
            results,
          )
      : null,
  );

  root.replaceChildren(endpoint, claude, notif, reminders, briefing, note);
}

export const updateMeFeature: Feature = {
  id: "update-me",
  // The card body fills itself (it has its own status to load) and redraws
  // itself after its own changes.
  render: () => {
    const body = h("div", { class: "feature-update-me" });
    void render(body);
    return h("div", { class: "um-feature" }, h("h4", { class: "um-title" }, "Update me"), body);
  },
};
