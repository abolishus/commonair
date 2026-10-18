// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RENDITIONS } from "@commonair/contracts/enums";

export type Rendition = (typeof RENDITIONS)[number];
export type LadderRendition = Exclude<Rendition, "source">;

export interface VideoRung {
  name: Exclude<LadderRendition, "audio">;
  height: number;
  videoKbps: number;
  audioKbps: number;
}
export interface AudioRung {
  name: "audio";
  audioKbps: number;
}
export type Rung = VideoRung | AudioRung;

/** Highest first. Bitrates follow common platform guidance for 30/60 fps H.264. */
export const VIDEO_RUNGS: readonly VideoRung[] = [
  { name: "1080p", height: 1080, videoKbps: 6000, audioKbps: 160 },
  { name: "720p", height: 720, videoKbps: 3000, audioKbps: 128 },
  { name: "480p", height: 480, videoKbps: 1200, audioKbps: 96 },
];
export const AUDIO_RUNG: AudioRung = { name: "audio", audioKbps: 96 };

export interface SourceShape {
  /** Source video height in pixels; null when the source has no video track. */
  height: number | null;
  hasAudio: boolean;
}

/**
 * Rungs worth producing for a source: no upscaling (rungs taller than the source are skipped),
 * an audio-only rung whenever there is audio. A source shorter than the lowest rung still gets
 * that rung at its own height so low-bandwidth viewers have something besides the source.
 */
export function selectRungs(source: SourceShape): Rung[] {
  const rungs: Rung[] = [];
  if (source.height !== null && source.height > 0) {
    const h = source.height;
    const fitting = VIDEO_RUNGS.filter((r) => r.height <= h);
    if (fitting.length > 0) rungs.push(...fitting);
    else {
      const lowest = VIDEO_RUNGS[VIDEO_RUNGS.length - 1];
      // Even height: H.264 4:2:0 needs it.
      if (lowest) rungs.push({ ...lowest, height: h - (h % 2) });
    }
  }
  if (source.hasAudio) rungs.push(AUDIO_RUNG);
  return rungs;
}

/** Renditions advertised to players while the ladder runs (source always first). */
export function advertisedRenditions(rungs: readonly Rung[]): Rendition[] {
  return ["source", ...rungs.map((r) => r.name)];
}
