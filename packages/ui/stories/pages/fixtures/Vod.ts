// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data from the Vod board (past broadcast). */
export const video = {
  title: "Patch from zero: FM bells on a 4-op",
  channel: "synthesist_ana",
  accent: "pink" as const,
  meta: "Streamed Oct 16 · 1,104 views · Music",
  chapter: "Chapter 3 · Building the modulator",
  position: 4360,
  duration: 10692,
  positionLabel: "1:12:40",
  durationLabel: "2:58:12",
};

export const chapters = [
  { id: "c1", time: "0:00:00", title: "Intro and what we’re building", playing: false },
  { id: "c2", time: "0:21:30", title: "Carrier and ratio basics", playing: false },
  { id: "c3", time: "0:49:55", title: "Building the modulator", playing: true },
  { id: "c4", time: "1:57:40", title: "Listener patches", playing: false },
];

export const replay = [
  ["1:10:02", "nightcap", 10, "ratio 3.5 sounds like a church bell"],
  ["1:10:15", "ohmslaw", 8, "the inharmonics!!"],
  ["1:10:41", "synthesist_ana", 11, "exactly, non-integer ratios = clangorous"],
  ["1:11:03", "Fernsby", 11, "saving this VOD forever"],
  ["1:11:20", "tapehead99", 9, "what is the feedback knob doing"],
  ["1:11:28", "voltagecontrol", 4, "op4 feeding into itself, gets saw-ish"],
  ["1:11:50", "quietfox", 2, "my ears are happy"],
  ["1:12:05", "kettlebell_kai", 3, "can you share the patch file?"],
  ["1:12:19", "synthesist_ana", 11, "it’s in the description after stream"],
  ["1:12:33", "nightcap", 10, "ty!"],
  ["1:12:38", "ohmslaw", 8, "add a slow LFO on the index"],
  ["1:12:40", "Fernsby", 11, "ooooh"],
].map(([timestamp, author, colorIndex, body], index) => ({
  id: `r${index}`,
  timestamp: String(timestamp),
  author: String(author),
  colorIndex: Number(colorIndex),
  body: String(body),
}));
