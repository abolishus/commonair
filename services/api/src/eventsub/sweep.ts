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

export async function sweepOrphans(db: Executor, store: SessionStore, now: Date, graceMs: number): Promise<number> {
  const before = new Date(now.getTime() - graceMs);
  let deleted = 0;
  const seen = new Set<string>();
  for (let i = 0; i < MAX_BATCHES; i++) {
    const ids = (await staleSessionIds(db, before, BATCH + seen.size)).filter((id) => !seen.has(id));
    if (ids.length === 0) break;
    for (const id of ids) seen.add(id);
    const live = await store.existing(ids);
    const orphans = ids.filter((id) => !live.has(id));
    deleted += await deleteSessionsBefore(db, orphans, before);
    if (ids.length < BATCH) break;
  }
  return deleted;
}
