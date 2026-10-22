// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data from the StreamSetup board (ingest, renditions, recording); simulcast is in `../../e6-fixtures.tsx`. */

export const protocols = [
  { value: "rtmp", label: "RTMP" },
  { value: "whip", label: "WHIP (WebRTC)" },
  { value: "srt", label: "SRT" },
];

export const ingest = {
  serverUrl: "rtmp://ingest.example.org/live",
  streamKey: "live_sample_key_not_real_a91f",
  keyHint: "Created Oct 14 · last used never",
  encoder: "x264 or NVENC · 6,000 kbps · keyframe 2 s",
};

export const latencies = [
  { value: "low", label: "Low (~2 s) — best for chat" },
  { value: "normal", label: "Normal (~6 s) — smoother on weak networks" },
];

export interface Rendition {
  id: string;
  name: string;
  resolution: string;
  bitrate: string;
  enabled: boolean;
}

export const renditions: Rendition[] = [
  { id: "source", name: "Source", resolution: "As sent", bitrate: "as sent", enabled: true },
  { id: "720p60", name: "720p60", resolution: "1280 × 720", bitrate: "3,500 kbps", enabled: true },
  { id: "480p", name: "480p", resolution: "854 × 480", bitrate: "1,400 kbps", enabled: true },
  { id: "360p", name: "360p", resolution: "640 × 360", bitrate: "800 kbps", enabled: true },
  { id: "audio", name: "Audio only", resolution: "—", bitrate: "128 kbps", enabled: false },
];

export const recording = [
  {
    id: "vods",
    label: "Save past broadcasts",
    description: "Kept for 60 days, then deleted unless you highlight them.",
    checked: true,
  },
  {
    id: "clips",
    label: "Let viewers create clips",
    description: "Followers only during the first 10 minutes of a stream.",
    checked: true,
  },
];
export const captions = { label: "Live captions (speech to text)", later: "Coming in a later release." };
