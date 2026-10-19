// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data from the Overlays board (alerts & overlays). */
export const overlays = [
  { id: "alerts", label: "Alert box", href: "#overlays/alerts", current: true, badge: { label: "On" } },
  { id: "sub-goal", label: "Sub goal", href: "#overlays/sub-goal", badge: { label: "On" } },
  { id: "tip-goal", label: "Tip goal", href: "#overlays/tip-goal", badge: { label: "Off" } },
  { id: "chat", label: "Chat box", href: "#overlays/chat", badge: { label: "Off" } },
  { id: "recent", label: "Recent events", href: "#overlays/recent", badge: { label: "Off" } },
  { id: "poll", label: "Poll & prediction", href: "#overlays/poll", badge: { label: "On" } },
];

export const previewKinds = [
  { value: "follow", label: "Follow" },
  { value: "tip", label: "Tip" },
  { value: "sub", label: "Sub" },
  { value: "raid", label: "Raid" },
];

export const preview = {
  name: "Fernsby",
  event: "Fernsby tipped",
  cents: 500,
  message: "that glaze!!",
  goal: { label: "Sub goal: new kiln shelves", current: 112, target: 150 },
};

export const sourceUrl = "/overlay/alerts?token=sample-overlay-token-not-real";

export const tipAlert = {
  message: "{name} tipped {amount}",
  minimumCents: 100,
  durations: [
    { value: "4", label: "4 seconds" },
    { value: "6", label: "6 seconds" },
    { value: "10", label: "10 seconds" },
  ],
  sounds: [
    { value: "chime", label: "Soft chime (bundled)" },
    { value: "upload", label: "Upload…" },
  ],
  switches: [
    { id: "show", label: "Show viewer message", checked: true },
    { id: "filter", label: "Run message through chat filters", checked: true },
    { id: "tts", label: "Read message aloud (TTS)", checked: false },
  ],
  layouts: [
    { value: "stacked", label: "Stacked" },
    { value: "side", label: "Side by side" },
  ],
};
