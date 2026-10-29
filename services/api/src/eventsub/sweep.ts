// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Orphan sweep: an instance that crashed (no drain, no close handlers) leaves WebSocket
 * subscription rows whose session no longer exists in Valkey. One API instance at a time (the
 * `KEYS.eventsubSweepLock` leader) deletes those older than the reconnect grace, so a session
 * mid-reconnect is never touched.
 */
import type { Executor } from "@commonair/db";
import { deleteSessionsBefore, staleSessionIds } from "./subscriptions.ts";
import type { SessionStore } from "./sessions.ts";

const BATCH = 500;
/** Bounded work per run; the next run continues. */
const MAX_BATCHES = 20;

export interface SweepResult {
  deleted: number;
  /** Where the next run starts; `null` once the whole table has been walked. */
  cursor: string | null;
}

export async function sweepOrphans(
  db: Executor,
  store: SessionStore,
  now: Date,
  graceMs: number,
  startAfter: string | null = null,
  { batch = BATCH, maxBatches = MAX_BATCHES }: { batch?: number; maxBatches?: number } = {},
): Promise<SweepResult> {
  const before = new Date(now.getTime() - graceMs);
  let deleted = 0;
  // Keyset pagination: each batch starts after the last id of the previous one, so live sessions
  // are read once per pass and orphans past them are still reached, across runs.
  let afterId = startAfter;
  for (let i = 0; i < maxBatches; i++) {
    const ids = await staleSessionIds(db, before, batch, afterId);
    if (ids.length === 0) return { deleted, cursor: null };
    afterId = ids[ids.length - 1] ?? null;
    const live = await store.existing(ids);
    const orphans = ids.filter((id) => !live.has(id));
    deleted += await deleteSessionsBefore(db, orphans, before);
    if (ids.length < batch) return { deleted, cursor: null };
  }
  return { deleted, cursor: afterId };
}
