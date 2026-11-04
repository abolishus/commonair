// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure parts of the `relay-dvr` W3 steps (`index.ts`): receipt sums per session, the caption
 * cache rule, the caption fixture the relay-vtt step plants, and where a URL points.
 */
import { CAPTIONS_KEYS, encodeCue, type LiveTrack } from "@commonair/captions";

/** One `relay_receipts.payload` (`ReceiptPayload`): its per-session entries. */
interface ReceiptPayloadLike {
  entries?: { sessionId?: unknown; segments?: unknown; bytes?: unknown }[];
}

/** Segments and bytes the receipts credit one session with (malformed entries count nothing). */
export function receiptTotals(payloads: readonly unknown[], sessionId: string): { segments: number; bytes: number } {
  let segments = 0;
  let bytes = 0;
  for (const p of payloads) {
    const entries = (p as ReceiptPayloadLike | null)?.entries;
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      if (e?.sessionId !== sessionId) continue;
      if (typeof e.segments === "number" && Number.isFinite(e.segments)) segments += e.segments;
      if (typeof e.bytes === "number" && Number.isFinite(e.bytes)) bytes += e.bytes;
    }
  }
  return { segments, bytes };
}

/** One `relay_receipts` row as the dvr-relay step reads it: the payload and its `period_end` (epoch ms). */
export interface ReceiptRow {
  payload: unknown;
  endMs: number;
}

/**
 * What one relay's receipts credit a session with, and the instant they account through: the
 * newest `period_end` of all that relay's receipts (the ledger is cut at that instant, so every
 * fetch the relay finished before it is in one of these rows). 0 when there is no receipt.
 */
export function receiptCoverage(
  rows: readonly ReceiptRow[],
  sessionId: string,
): { segments: number; bytes: number; throughMs: number } {
  const throughMs = rows.reduce((m, r) => (Number.isFinite(r.endMs) && r.endMs > m ? r.endMs : m), 0);
  return {
    ...receiptTotals(
      rows.map((r) => r.payload),
      sessionId,
    ),
    throughMs,
  };
}

/**
 * The relay counts a segment just after writing its last byte; the viewer notes it once read. A
 * fetch the viewer finished this close before a cut may still land in the next period.
 */
export const RECEIPT_EDGE_SLACK_MS = 500;

/** How many of the viewer's segment fetches (finish times, epoch ms) a cut at `throughMs` must cover. */
export function fetchedThrough(doneAt: readonly number[], throughMs: number): number {
  const cut = throughMs - RECEIPT_EDGE_SLACK_MS;
  return doneAt.filter((t) => t <= cut).length;
}

/** Decision (y): a relay's `.vtt` is cached briefly, never pinned. */
export function vttCacheControlOk(header: string | null): boolean {
  if (header === null) return false;
  const parts = header
    .toLowerCase()
    .split(",")
    .map((p) => p.trim());
  return parts.includes("max-age=30") && !parts.includes("immutable");
}

/** Whether `url` is served by the relay at `relayUrl` (same origin). */
export function servedBy(url: string | null | undefined, relayUrl: string): boolean {
  if (!url) return false;
  try {
    return new URL(url).origin === new URL(relayUrl).origin;
  } catch {
    return false;
  }
}

/** The DVR prefix a purge for this VOD carries. */
export const dvrPurgePrefix = (vodId: string) => `dvr/${vodId}/`;

export const FIXTURE_CUE_TEXT = "relay caption check";

/**
 * A live caption track as media keeps it in Valkey (`@commonair/captions` `CAPTIONS_KEYS`), with
 * one cue per 3 s segment over the last `seconds`. The relay shard runs no whisper sidecar
 * (batch 6 decision (c)), so the relay-vtt step plants this for its own broadcast: the origin's
 * caption route and the relay only read these keys.
 */
export function captionFixture(
  broadcastId: string,
  nowMs: number,
  seconds = 30,
): { liveKey: string; cuesKey: string; track: string; cues: [number, string][] } {
  const anchorMs = nowMs - seconds * 1000;
  const track: LiveTrack = { language: "en", w0Ms: anchorMs, anchorMs, throughMs: nowMs };
  const cues: [number, string][] = [];
  for (let i = 0, s = anchorMs; s + 2000 <= nowMs; i++, s += 3000)
    cues.push([s, encodeCue(i, { startMs: s, endMs: s + 2000, text: `${FIXTURE_CUE_TEXT} ${i}` })]);
  return {
    liveKey: CAPTIONS_KEYS.live(broadcastId),
    cuesKey: CAPTIONS_KEYS.cues(broadcastId, "en"),
    track: JSON.stringify(track),
    cues,
  };
}
