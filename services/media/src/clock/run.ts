// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Recorder runs on the broadcast clock (R4, ADR 0012 decision 4 as updated for A2). The recorder
 * reads SRT with `-copyts`, so a sample's fMP4 time is on the source timeline and its exact PDT is
 * `W0 + time`. ffmpeg's own PDT is its process clock at muxer start plus summed durations, so one
 * offset per run converts it: `offset = W0 + firstSampleTime − rawPDT(first segment)`.
 *
 * Each run persists a sidecar `<runId>.clock.json` next to its playlist, so crash recovery can
 * stamp the run without the network (the broadcast may have ended).
 */
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFragment, parseInit } from "./boxes.ts";
import { pdtTrack, PTS_WRAP_SECONDS } from "./w0.ts";

export const runSidecar = (runId: string) => `${runId}.clock.json`;

export interface RunSidecar {
  runId: string;
  /** W0 used for this run (epoch ms), null until known. */
  w0Ms: number | null;
  /** Milliseconds to add to the run's raw segment times, null until the first segment is anchored. */
  offsetMs: number | null;
}

const WRAP_MS = PTS_WRAP_SECONDS * 1000;

/**
 * The run offset, folded into ±half the PTS wrap: W0 may have been read in the other
 * representation of a timeline that wrapped between the run's start and the fetch; a true offset
 * is seconds, never hours.
 */
export function runOffsetMs(w0Ms: number, firstSampleSeconds: number, rawPdtMs: number): number {
  const raw = w0Ms + firstSampleSeconds * 1000 - rawPdtMs;
  return raw - Math.round(raw / WRAP_MS) * WRAP_MS;
}

/** Read at most this much of a segment: its `moof` comes first and is a few KiB. */
const SEGMENT_HEAD_BYTES = 256 * 1024;

/**
 * First presentation time (seconds, on the source timeline) of a recorder segment, on the track
 * whose PDT ffmpeg writes (video when present).
 */
export async function firstSampleSeconds(initPath: string, segmentPath: string): Promise<number> {
  const init = await Bun.file(initPath).bytes();
  const head = await Bun.file(segmentPath).slice(0, SEGMENT_HEAD_BYTES).bytes();
  const track = pdtTrack(parseInit(init));
  if (!track) throw new Error("recorder init has no audio or video track");
  const frag = parseFragment(head, { truncated: true }).find((f) => f.trackId === track.trackId);
  if (!frag) throw new Error("recorder segment has no fragment for the PDT track");
  return (frag.baseDecodeTime + frag.firstCompositionOffset) / track.timescale;
}

export async function readSidecar(dir: string, runId: string): Promise<RunSidecar | null> {
  try {
    const raw = (await Bun.file(join(dir, runSidecar(runId))).json()) as Partial<RunSidecar>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return { runId, w0Ms: num(raw.w0Ms), offsetMs: num(raw.offsetMs) };
  } catch {
    return null;
  }
}

/** Atomic: a crash never leaves a half-written sidecar. */
export async function writeSidecar(dir: string, sidecar: RunSidecar): Promise<void> {
  const path = join(dir, runSidecar(sidecar.runId));
  await writeFile(`${path}.tmp`, JSON.stringify(sidecar));
  await rename(`${path}.tmp`, path);
}
