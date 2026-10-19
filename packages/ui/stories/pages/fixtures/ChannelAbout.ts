// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data from the ChannelAbout board (synthesist_ana, offline). */
import type { MediaCardData } from "@commonair/ui/blocks/media";

export const channel = {
  name: "synthesist_ana",
  accent: "pink" as const,
  meta: "806 followers · Music · Last live 2 days ago",
};

export const tabs = [
  { id: "home", label: "Home", href: "#channel/synthesist_ana", current: true },
  { id: "about", label: "About", href: "#channel/synthesist_ana/about" },
  { id: "schedule", label: "Schedule", href: "#channel/synthesist_ana/schedule" },
  { id: "videos", label: "Videos", href: "#channel/synthesist_ana/videos" },
  { id: "clips", label: "Clips", href: "#channel/synthesist_ana/clips" },
];

export const offline = {
  next: "Next stream: tomorrow, 19:00 UTC",
  show: "Patch-from-zero Thursdays · Music",
};

export const vods: MediaCardData[] = [
  { id: "v1", title: "Patch from zero: FM bells on a 4-op", accent: "pink", duration: "2:58:12", ago: "2 days ago", views: "1.1K views" },
  { id: "v2", title: "Listener tracks review #14", accent: "pink", duration: "1:47:30", ago: "5 days ago", views: "640 views" },
  { id: "v3", title: "Patch from zero: West-coast plucks", accent: "pink", duration: "3:05:44", ago: "1 week ago", views: "1.4K views" },
];

export const clips: MediaCardData[] = [
  { id: "c1", title: "The accidental drone that ate the stream", accent: "pink", kind: "Clip", duration: "0:38", clippedBy: "clipped by ohmslaw · 6.1K views" },
  { id: "c2", title: "Explaining wavefolding with a slinky", accent: "pink", kind: "Clip", duration: "1:02", clippedBy: "clipped by nightcap · 3.3K views" },
  { id: "c3", title: "Chat finally gets the filter joke", accent: "pink", kind: "Clip", duration: "0:21", clippedBy: "clipped by Fernsby · 980 views" },
];

export const schedule = [
  { id: "s1", day: "Thu", date: "Oct 19", title: "Patch-from-zero Thursdays", time: "19:00 – 22:00", next: true },
  { id: "s2", day: "Sat", date: "Oct 21", title: "Listener tracks review", time: "16:00 – 18:00", next: false },
  { id: "s3", day: "Tue", date: "Oct 24", title: "Sound design Q&A", time: "19:00 – 21:00", next: false },
];

export const about = {
  text: "Sound designer teaching synthesis from first principles. Every Thursday we build a patch from a blank rack.",
  links: ["Website", "Fediverse", "Bandcamp"],
};

export const rules = ["Be kind, especially to beginners.", "No self-promo without asking.", "English or Spanish please."];

export const supporters =
  "Monthly subscriptions fund the stream. 71% goes to the creator; the split is set by member vote.";
