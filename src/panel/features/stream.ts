// Settings → Features → Streaming overlay: Glitch as an OBS browser source
// (src-tauri/src/stream/, page in src/overlay/). Off by default.

import { listen } from "@tauri-apps/api/event";
import {
  api,
  asUiError,
  streamApi,
  type Settings,
  type SourceStatus,
  type StreamEventKind,
  type StreamPatch,
  type StreamSettings,
  type StreamStatus,
} from "../../shared/ipc";
import { h } from "../dom";
import { busyButton, toggleSwitch } from "../ui";
import type { Feature } from "./index";

/** One line about a connection. Unit-tested. */
export function sourceLine(name: string, s: SourceStatus): { text: string; tone: "ok" | "muted" | "error" } {
  switch (s.state) {
    case "connected":
      return { text: `${name}: connected. ${s.detail}`.trim(), tone: "ok" };
    case "connecting":
      return { text: `${name}: connecting…`, tone: "muted" };
    case "error":
      return { text: `${name}: ${s.detail || "not connected"}. Trying again soon.`, tone: "error" };
    default:
      return { text: "", tone: "muted" };
  }
}

/** The server line under the switch. Unit-tested. */
export function serverLine(st: StreamStatus, port: number): { text: string; tone: "ok" | "muted" | "error" } {
  if (st.error) return { text: st.error, tone: "error" };
  if (!st.running) return { text: "Starting…", tone: "muted" };
  const pages = st.viewers === 1 ? "1 overlay page connected" : `${st.viewers} overlay pages connected`;
  return { text: `Running on 127.0.0.1:${port}, this computer only. ${pages}.`, tone: "ok" };
}

let current: HTMLElement | null = null;
let listening = false;

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h("label", { class: "voice-field" }, h("span", { class: "voice-label" }, label), control, hint ? h("span", { class: "hint" }, hint) : null);
}

function selectOf(label: string, options: [string, string][], value: string, onChange: (v: string) => void): HTMLElement {
  const sel = h("select", { "aria-label": label });
  for (const [v, text] of options) sel.append(h("option", { value: v, selected: v === value }, text));
  sel.addEventListener("change", () => onChange(sel.value));
  return h("span", { class: "select" }, sel);
}

function textField(label: string, value: string, placeholder: string, onCommit: (v: string) => void): HTMLInputElement {
  const input = h("input", { type: "text", class: "text-input", value, placeholder, "aria-label": label, spellcheck: "false", autocomplete: "off" });
  const commit = () => {
    if (input.value.trim() !== value) onCommit(input.value.trim());
  };
  input.addEventListener("change", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
  });
  return input;
}

function line(l: { text: string; tone: string }): HTMLElement | null {
  return l.text ? h("p", { class: `feature-line ${l.tone}`, role: "status" }, l.text) : null;
}

async function render(root: HTMLElement): Promise<void> {
  current = root;
  if (!listening) {
    listening = true;
    // Live status (connections, pages); settings changes redraw via the settings page.
    void listen<StreamStatus>("stream-status", () => {
      // Not while the user is typing in one of its fields.
      const typing = document.activeElement instanceof HTMLInputElement && document.activeElement.type === "text";
      if (current?.isConnected && !(typing && current.contains(document.activeElement))) void render(current);
    });
  }
  let s: StreamSettings;
  let st: StreamStatus;
  try {
    const all: Settings = await api.getSettings();
    if (!all.stream_overlay) throw new Error("This build has no stream overlay.");
    s = all.stream_overlay;
    st = await streamApi.status();
  } catch (e) {
    root.replaceChildren(h("p", { class: "hint" }, `Couldn’t load the overlay settings: ${asUiError(e).message}`));
    return;
  }
  if (root !== current) return;
  const note = h("p", { class: "feature-line error", role: "alert", hidden: true });
  const update = (patch: StreamPatch) =>
    void streamApi.update(patch).then(
      () => void render(root),
      (e) => {
        note.textContent = asUiError(e).message;
        note.hidden = false;
      },
    );

  const parts: (Node | null)[] = [
    toggleSwitch(
      "Streaming overlay",
      "Show Glitch on your stream as an OBS browser source. Runs only on this computer, nothing goes online.",
      s.enabled,
      (on) => update({ enabled: on }),
    ),
    note,
  ];
  if (!s.enabled) {
    root.replaceChildren(...parts.filter((p): p is Node => p !== null));
    return;
  }

  const copyNote = h("p", { class: "feature-line ok", role: "status", hidden: true });
  const copied = (what: string) => {
    copyNote.textContent = what;
    copyNote.hidden = false;
    window.setTimeout(() => (copyNote.hidden = true), 2500);
  };
  const testButton = (kind: StreamEventKind, label: string) =>
    busyButton(label, "…", () =>
      streamApi.test(kind).catch((e) => {
        note.textContent = asUiError(e).message;
        note.hidden = false;
      }),
    );

  parts.push(
    line(serverLine(st, s.port)),
    h(
      "div",
      { class: "row" },
      h(
        "button",
        {
          class: "primary small",
          type: "button",
          onclick: () =>
            void streamApi.copy("url").then(
              () => copied("Copied. In OBS: Sources, +, Browser, paste it as the URL, size 1920 x 1080."),
              (e) => copied(asUiError(e).message),
            ),
        },
        "Copy OBS URL",
      ),
      h("span", { class: "spacer" }),
    ),
    copyNote,
    h("p", { class: "voice-label feature-sub" }, "Send a test event"),
    h("div", { class: "feature-tests" }, testButton("follow", "Follow"), testButton("sub", "Sub"), testButton("raid", "Raid"), testButton("chat", "Chat")),
    field(
      "On stream",
      selectOf(
        "Overlay mode",
        [
          ["mirror", "Mirror my desktop Glitch"],
          ["walk", "A stream Glitch walking along the bottom"],
        ],
        s.mode,
        (v) => update({ mode: v as StreamSettings["mode"] }),
      ),
    ),
    h(
      "div",
      { class: "feature-pair" },
      field(
        "Size",
        selectOf(
          "Size",
          ["0.75", "1", "1.5", "2", "3"].map((v) => [v, `${v}x`]),
          String(s.size),
          (v) => update({ size: Number(v) }),
        ),
      ),
      field(
        "Position",
        selectOf(
          "Position",
          [
            ["left", "Left"],
            ["center", "Center"],
            ["right", "Right"],
          ],
          s.position,
          (v) => update({ position: v as StreamSettings["position"] }),
        ),
      ),
    ),
    h("div", { class: "voice-gap" }),
    toggleSwitch("React to stream events", "Waves at follows, celebrates subs and raids.", s.react, (on) => update({ react: on })),
    toggleSwitch("Read chat lines in his bubble", "At most one every few seconds.", s.show_chat, (on) => update({ show_chat: on })),
    toggleSwitch(
      "Show my chats with Glitch on stream",
      "Off: what you ask Glitch on your desktop stays private.",
      s.mirror_chat,
      (on) => update({ mirror_chat: on }),
    ),
    h("div", { class: "voice-gap" }),
    field(
      "Twitch chat (read-only)",
      textField("Twitch channel", s.twitch_channel, "your channel name", (v) => update({ twitch_channel: v })),
      "Reads public chat, subs and raids anonymously. Glitch never writes in chat.",
    ),
    line(sourceLine("Twitch", st.twitch)),
    toggleSwitch("Streamer.bot", "Follows, subs, raids and chat from Streamer.bot's WebSocket server.", s.streamerbot, (on) => update({ streamerbot: on })),
    s.streamerbot ? field("Streamer.bot address", textField("Streamer.bot address", s.streamerbot_url, "ws://127.0.0.1:8080/", (v) => update({ streamerbot_url: v }))) : null,
    s.streamerbot ? line(sourceLine("Streamer.bot", st.streamerbot)) : null,
    h(
      "details",
      { class: "feature-more" },
      h("summary", {}, "Other bots and scripts"),
      h(
        "p",
        { class: "hint" },
        "POST JSON like {\"type\":\"follow\",\"user\":\"Ana\"} (type: follow, sub, raid or chat; chat adds \"text\") to ",
        h("code", {}, st.webhook),
        " with the header ",
        h("code", {}, "X-Glitch-Token"),
        " set to the bot token. The OBS URL can't send events.",
      ),
      h(
        "div",
        { class: "feature-tests" },
        h(
          "button",
          { class: "secondary small", type: "button", onclick: () => void streamApi.copy("write_token").then(() => copied("Bot token copied."), (e) => copied(asUiError(e).message)) },
          "Copy bot token",
        ),
        busyButton("New links", "…", async () => {
          await streamApi.newToken();
          copied("New OBS URL and bot token made. Paste the new URL into OBS.");
        }),
      ),
      field("Port", textField("Port", String(s.port), "7799", (v) => update({ port: Number(v) })), "Change it if another program uses 7799."),
    ),
  );
  root.replaceChildren(...parts.filter((p): p is Node => p !== null));
}

/** A titled block in the Features card; fills itself (async) and keeps itself current. */
export function featureBlock(title: string, fill: (body: HTMLElement) => Promise<void>): HTMLElement {
  const body = h("div", { class: "feature-body" });
  void fill(body);
  return h("section", { class: "feature-block" }, h("h4", { class: "feature-title" }, title), body);
}

export const streamFeature: Feature = { id: "stream", render: () => featureBlock("Streaming overlay", render) };
