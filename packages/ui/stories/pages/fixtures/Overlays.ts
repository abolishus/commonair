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
