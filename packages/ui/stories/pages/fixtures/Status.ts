// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data from the Status board (90-day uptime, incidents). */
import type { StatusTone } from "@commonair/ui";
import type { TimelineUpdate, UptimeDay } from "@commonair/ui/blocks/data";

export const summary = {
  title: "Partial degradation: chat in EU",
  text: "Some viewers see chat messages arrive late. Video is unaffected. Updated 6 min ago.",
};

const start = Date.UTC(2026, 6, 21);
const dateLabel = (i: number): string =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(start + i * 86_400_000),
  );

function days(id: string, outage: number[], degraded: number[], today?: UptimeDay["status"]): UptimeDay[] {
  return Array.from({ length: 90 }, (_, i) => ({
    id: `${id}-${i}`,
    date: dateLabel(i),
    status: i === 89 && today ? today : outage.includes(i) ? "outage" : degraded.includes(i) ? "degraded" : "ok",
  }));
}

export const components: {
  id: string;
  name: string;
  description: string;
  uptime: string;
  state: string;
  tone: StatusTone;
  days: UptimeDay[];
}[] = [
  {
    id: "web",
    name: "Website & API",
    description: "Pages, sign-in, REST",
    uptime: "99.97%",
    state: "Operational",
    tone: "success",
    days: days("web", [], [31]),
  },
  {
    id: "ingest",
    name: "Ingest",
    description: "RTMP, WHIP, SRT",
    uptime: "99.95%",
    state: "Operational",
    tone: "success",
    days: days("ingest", [31], []),
  },
  {
    id: "video",
    name: "Video delivery",
    description: "Origin + edge",
    uptime: "99.92%",
    state: "Operational",
    tone: "success",
    days: days("video", [31], [32]),
  },
  {
    id: "relays",
    name: "Community relays",
    description: "142 online",
    uptime: "—",
    state: "Operational",
    tone: "success",
    days: days("relays", [], []),
  },
  {
    id: "chat",
    name: "Chat",
    description: "WebSocket + IRC gateway",
    uptime: "99.88%",
    state: "Degraded",
    tone: "warning",
    days: days("chat", [], [12, 58], "degraded"),
  },
  {
    id: "payments",
    name: "Payments",
    description: "Subscriptions, tips, payouts",
    uptime: "100%",
    state: "Operational",
    tone: "success",
    days: days("payments", [], []),
  },
  {
    id: "webhooks",
    name: "Webhooks & events",
    description: "Developer deliveries",
    uptime: "99.90%",
    state: "Operational",
    tone: "success",
    days: days("webhooks", [], [44]),
  },
  {
    id: "email",
    name: "Email",
    description: "Verification, notifications",
    uptime: "99.99%",
    state: "Operational",
    tone: "success",
    days: days("email", [], []),
  },
];

export const statusLabels: Record<UptimeDay["status"], string> = {
  ok: "Operational",
  degraded: "Degraded",
  outage: "Outage",
  none: "No data",
};

export const incidents: {
  id: string;
  status: string;
  tone: StatusTone;
  title: string;
  date: string;
  updates?: TimelineUpdate[];
  note?: string;
}[] = [
  {
    id: "chat-eu",
    status: "Monitoring",
    tone: "warning",
    title: "Chat delivery delays in EU",
    date: "Oct 18",
    updates: [
      {
        id: "u3",
        status: "Monitoring",
        time: "19:12 UTC",
        text: "A Valkey replica was failed over. Delays are falling; we are watching for 30 minutes.",
        tone: "warning",
      },
      {
        id: "u2",
        status: "Identified",
        time: "18:54 UTC",
        text: "Fan-out lag on one chat node in the EU region.",
        tone: "info",
      },
      {
        id: "u1",
        status: "Investigating",
        time: "18:41 UTC",
        text: "Reports of chat arriving 10–20 seconds late.",
        tone: "neutral",
      },
    ],
  },
  {
    id: "origin",
    status: "Resolved",
    tone: "success",
    title: "Origin outage, all regions (46 min)",
    date: "Aug 22",
    note: "Storage quota exhausted on the origin cache. Relays kept 31% of viewers watching.",
  },
];
