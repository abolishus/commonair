// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data from the Analytics board (last 30 days). */
export const ranges = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "custom", label: "Custom" },
];

export const stats: { label: string; value: string; delta?: string; down?: boolean; hint?: string }[] = [
  { label: "Average viewers", value: "286", delta: "+18% vs previous 30 days" },
  { label: "Peak viewers", value: "612", hint: "Oct 12" },
  { label: "Hours watched", value: "9,140", delta: "+22%" },
  { label: "New followers", value: "+804", delta: "+9%" },
  { label: "Hours streamed", value: "48", delta: "−4 h", down: true },
  { label: "Unique chatters", value: "1,322", delta: "+12%" },
];

export const metrics = [
  { value: "avg", label: "Average viewers" },
  { value: "hours", label: "Hours watched" },
  { value: "followers", label: "Followers" },
];

const start = Date.UTC(2026, 8, 18);
const day = (i: number): string =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(start + i * 86_400_000));

/** Average verified viewers per day (days off stream are near zero), Sep 18 – Oct 17. */
export const viewersByDay = Array.from({ length: 30 }, (_, i) => {
  const off = i % 7 === 2 || i % 7 === 5;
  return { day: day(i), viewers: off ? 10 : Math.round(3.5 * Math.min(98, 48 + i * 1.4 + ((i * 17) % 13))) };
});

export const sources = [
  { label: "Following feed", percent: 41 },
  { label: "Directory & spotlight", percent: 27 },
  { label: "Raids & hosts", percent: 14 },
  { label: "Search", percent: 9 },
  { label: "External links & embeds", percent: 9 },
];

export const integrity = {
  share: "2.1%",
  hint: "of sessions excluded (61 of 2,904)",
  reasons: [
    { id: "dc", reason: "Datacenter network", sessions: 38 },
    { id: "headless", reason: "Headless browser", sessions: 14 },
    { id: "concurrency", reason: "Concurrency over limit", sessions: 9 },
  ],
};

export interface StreamRow {
  id: string;
  date: string;
  title: string;
  duration: string;
  avg: string;
  peak: string;
  followers: string;
  messages: string;
}

export const streams: StreamRow[] = [
  { id: "s1", date: "Oct 17", title: "Glaze tests: copper reds, round 4", duration: "3:12", avg: "341", peak: "468", followers: "+37", messages: "1,804" },
  { id: "s2", date: "Oct 15", title: "Throwing big bowls, viewer challenges", duration: "2:48", avg: "322", peak: "512", followers: "+52", messages: "2,130" },
  { id: "s3", date: "Oct 12", title: "Kiln unloading — the moment of truth", duration: "1:55", avg: "398", peak: "612", followers: "+118", messages: "3,402" },
  { id: "s4", date: "Oct 10", title: "Trimming and Q&A", duration: "2:30", avg: "254", peak: "310", followers: "+21", messages: "1,066" },
  { id: "s5", date: "Oct 8", title: "Glaze tests: copper reds, round 3", duration: "3:05", avg: "271", peak: "355", followers: "+30", messages: "1,511" },
];
