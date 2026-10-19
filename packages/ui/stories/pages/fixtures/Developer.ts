// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data from the Developer board (developer console, glazebot). */
import type { Accent, StatusTone } from "@commonair/ui";

export const apps: { id: string; name: string; kind: string; accent: Accent; current?: boolean }[] = [
  { id: "glazebot", name: "glazebot", kind: "Bot account", accent: "teal", current: true },
  { id: "kiln-overlay", name: "kiln-overlay", kind: "Web app", accent: "amber" },
  { id: "stats-export", name: "stats-export", kind: "Server", accent: "sky" },
];

export const app = {
  name: "glazebot",
  accent: "teal" as Accent,
  meta: "Created Sep 2 · 1 channel authorized",
  clientId: "app_01J9Z3K7Q2W8",
  clientSecret: "sample-client-secret-not-real",
  scopes: ["chat:read", "chat:write", "moderator:manage:timeouts", "channel:read:subscriptions"],
};

export const tabs = [
  { id: "credentials", label: "Credentials", href: "#developer/glazebot/credentials" },
  { id: "events", label: "Events & webhooks", href: "#developer/glazebot/events", current: true },
  { id: "scopes", label: "Scopes", href: "#developer/glazebot/scopes" },
  { id: "logs", label: "Logs", href: "#developer/glazebot/logs" },
];

export interface Subscription {
  id: string;
  event: string;
  transport: string;
  status: string;
  tone: StatusTone;
  success: string;
}

export const subscriptions: Subscription[] = [
  {
    id: "follow",
    event: "channel.follow",
    transport: "https://glaze.example/hook",
    status: "Enabled",
    tone: "success",
    success: "100%",
  },
  {
    id: "subscribe",
    event: "channel.subscribe",
    transport: "https://glaze.example/hook",
    status: "Enabled",
    tone: "success",
    success: "99.2%",
  },
  { id: "tip", event: "channel.tip", transport: "websocket", status: "Enabled", tone: "success", success: "100%" },
  {
    id: "online",
    event: "stream.online",
    transport: "https://glaze.example/hook",
    status: "Failing",
    tone: "warning",
    success: "61%",
  },
];

export interface Delivery {
  id: string;
  time: string;
  event: string;
  code: string;
  latency: string;
  attempt: string;
}

export const deliveries: Delivery[] = [
  ["19:04:12", "channel.tip", "200", "84 ms", "1"],
  ["19:02:55", "channel.subscribe", "200", "91 ms", "1"],
  ["18:58:30", "stream.online", "503", "30 s", "3"],
  ["18:58:00", "stream.online", "503", "30 s", "2"],
  ["18:57:30", "stream.online", "timeout", "30 s", "1"],
  ["18:51:47", "channel.follow", "200", "77 ms", "1"],
].map(([time = "", event = "", code = "", latency = "", attempt = ""], index) => ({
  id: `d${index}`,
  time,
  event,
  code,
  latency,
  attempt,
}));

export const statusFilters = [
  { value: "all", label: "All statuses" },
  { value: "failed", label: "Failed" },
];
