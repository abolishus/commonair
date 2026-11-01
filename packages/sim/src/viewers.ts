// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Synthetic presence for a rehearsal: who is "in the room" to send the simulated chat. A synthetic
 * viewer is a key and a join/leave time, nothing more. It never sends a playback heartbeat, never
 * becomes a `playback_sessions` row and is never counted as a viewer (batch 6 decision (h)).
 */
import { seededRandom } from "./random.ts";

export interface SimViewer {
  /** Stable, short, never a real username: `v001` … (the chat dry run derives its sender from it). */
  key: string;
  /** Offset from the rehearsal's start. */
  joinAtMs: number;
  /** Offset when the viewer leaves; null = stays to the end. */
  leaveAtMs: number | null;
}

export interface ViewersOptions {
  count: number;
  seed: string;
  /** Spread joins over this many seconds from the start (default 60). */
  joinWindowSeconds?: number;
  /** Rehearsal length; about a third of the viewers leave before it (default the 30-minute cap). */
  durationSeconds?: number;
}

/** Viewers present from the first second (they never leave). */
export const EARLY_VIEWERS = 8;

export const viewerKey = (i: number) => `v${String(i + 1).padStart(3, "0")}`;

export function viewers(opts: ViewersOptions): SimViewer[] {
  const count = Math.max(0, Math.floor(opts.count));
  const rand = seededRandom(`viewers:${opts.seed}`);
  const joinWindowMs = (opts.joinWindowSeconds ?? 60) * 1000;
  const durationMs = (opts.durationSeconds ?? 1800) * 1000;
  const out: SimViewer[] = [];
  for (let i = 0; i < count; i++) {
    // A first handful is there from the start, so the chat never waits for someone to join.
    const early = i < EARLY_VIEWERS;
    const joinAtMs = early ? 0 : Math.floor(rand() * joinWindowMs);
    const leaves = !early && rand() < 1 / 3;
    const leaveAtMs = leaves ? Math.floor(joinAtMs + (durationMs - joinAtMs) * (0.5 + rand() / 2)) : null;
    out.push({ key: viewerKey(i), joinAtMs, leaveAtMs });
  }
  return out;
}

/** The viewers present at `atMs` (joined, not yet left). */
export function presentAt(all: readonly SimViewer[], atMs: number): SimViewer[] {
  return all.filter((v) => v.joinAtMs <= atMs && (v.leaveAtMs === null || v.leaveAtMs > atMs));
}
