// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `watch_room` report subject's evidence (ADR 0017, decision (q)). `subjectInfo` in
 * `routes/safety.ts` calls this inside the report transaction; the report row's `channel_id` is
 * null (room reports go to the platform queue only) and it has no single suspension target.
 *
 * Contract-step stub: W3-watch-rooms copies the room's messages (author ids, body, time) and the
 * member list (ids, joined and left times) into the returned evidence. Until then no room is
 * found, so a `watch_room` report answers 404.
 */
import type { Executor } from "@commonair/db";

export interface WatchRoomEvidence {
  /** Stored as `reports.evidence`; it must survive the room's 30-day retention. */
  evidence: Record<string, unknown>;
}

/** The evidence for a report on `roomId`, or null when there is no such room. */
export async function watchRoomEvidence(_tx: Executor, _roomId: string): Promise<WatchRoomEvidence | null> {
  return null;
}
