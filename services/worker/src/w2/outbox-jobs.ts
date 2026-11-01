// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The outbox relay's W2 hook (batch 6 contract step §5): which jobs a relayed batch starts.
 *
 * - `stream.offline` → `broadcast-rollup` (`reason: "offline"`), delayed until
 *   `AUDIENCE_SETTLE_SECONDS` after the broadcast ended, so every session's verdict has settled
 *   (ADR 0014 decision 3). The event names only the channel: the broadcast is the channel's latest
 *   one ended at the event's time. A rehearsal never counts (decision (f); it emits no
 *   `stream.offline` anyway).
 * - `analytics.rollup.ready` → `integrity-attestation` (`rollup` after an offline rollup,
 *   `recheck` after a re-score, `test` from the test hook).
 * - `integrity.sessions.rescored` → `broadcast-rollup` (`reason: "rescore"`) now.
 * - `rehearsal.armed` → the rehearsal driver for that arm.
 *
 * Job ids are deterministic per event, so a re-relayed batch (at-least-once) enqueues nothing new
 * while a later event for the same broadcast (a second re-score) still runs. BullMQ refuses a
 * custom id with a colon unless it has exactly three parts: `analyticsJobId` has three, the
 * rehearsal id none.
 */
import { EVENTS, type EventType } from "@commonair/contracts/events";
import {
  ANALYTICS_JOBS,
  QUEUES,
  REHEARSAL_JOBS,
  analyticsJobId,
  type BroadcastRollupJob,
  type IntegrityAttestationJob,
  type RehearsalDriverJob,
} from "@commonair/contracts/internal";
import { type Executor, schema } from "@commonair/db";
import { AUDIENCE_SETTLE_SECONDS } from "@commonair/integrity";
import { and, desc, eq, isNotNull, lte } from "drizzle-orm";
import type { z } from "zod";
import type { EnqueueOptions } from "../context.ts";
import type { QueueName } from "../env.ts";

const { broadcasts, events } = schema;
type EventRow = typeof events.$inferSelect;

/** A `stream.offline` belongs to a broadcast that ended at most this long before the event. */
const OFFLINE_MATCH_MS = 60_000;

export interface W2Job {
  queue: QueueName;
  name: string;
  data: BroadcastRollupJob | IntegrityAttestationJob | RehearsalDriverJob;
  opts: EnqueueOptions;
}

const ATTESTATION_REASON = {
  offline: "rollup",
  rescore: "recheck",
  test: "test",
} as const satisfies Record<BroadcastRollupJob["reason"], IntegrityAttestationJob["reason"]>;

const payloadOf = <T extends EventType>(type: T, row: EventRow) =>
  EVENTS[type].payload.parse(row.payload) as z.output<(typeof EVENTS)[T]["payload"]>;

/** The live broadcast a `stream.offline` row ended, or null (none, too old, or a rehearsal). */
async function offlineBroadcast(tx: Executor, row: EventRow) {
  if (!row.channelId) return null;
  const [b] = await tx
    .select({ id: broadcasts.id, kind: broadcasts.kind, endedAt: broadcasts.endedAt })
    .from(broadcasts)
    .where(
      and(
        eq(broadcasts.channelId, row.channelId),
        isNotNull(broadcasts.endedAt),
        lte(broadcasts.endedAt, row.occurredAt),
      ),
    )
    .orderBy(desc(broadcasts.endedAt))
    .limit(1);
  if (!b?.endedAt || b.kind !== "live") return null;
  if (row.occurredAt.getTime() - b.endedAt.getTime() > OFFLINE_MATCH_MS) return null;
  return { id: b.id, endedAt: b.endedAt };
}

/**
 * Jobs for the relayed rows (validated already; internal events included). Runs in the relay
 * transaction, so the broadcast lookup sees what the event's own transaction committed.
 */
export async function w2JobsFor(tx: Executor, rows: readonly EventRow[], now: Date): Promise<W2Job[]> {
  const out: W2Job[] = [];
  for (const row of rows) {
    switch (row.type) {
      case "stream.offline": {
        const b = await offlineBroadcast(tx, row);
        if (!b) break;
        const due = b.endedAt.getTime() + AUDIENCE_SETTLE_SECONDS * 1000;
        out.push({
          queue: QUEUES.analytics,
          name: ANALYTICS_JOBS.broadcastRollup,
          data: { broadcastId: b.id, reason: "offline" },
          opts: {
            jobId: analyticsJobId(ANALYTICS_JOBS.broadcastRollup, b.id, "offline"),
            delayMs: Math.max(0, due - now.getTime()),
          },
        });
        break;
      }
      case "analytics.rollup.ready": {
        const p = payloadOf("analytics.rollup.ready", row);
        const reason = ATTESTATION_REASON[p.reason];
        out.push({
          queue: QUEUES.analytics,
          name: ANALYTICS_JOBS.integrityAttestation,
          data: { broadcastId: p.broadcast_id, reason },
          opts: { jobId: analyticsJobId(ANALYTICS_JOBS.integrityAttestation, p.broadcast_id, `${reason}-${row.id}`) },
        });
        break;
      }
      case "integrity.sessions.rescored": {
        const p = payloadOf("integrity.sessions.rescored", row);
        out.push({
          queue: QUEUES.analytics,
          name: ANALYTICS_JOBS.broadcastRollup,
          data: { broadcastId: p.broadcast_id, reason: "rescore" },
          opts: { jobId: analyticsJobId(ANALYTICS_JOBS.broadcastRollup, p.broadcast_id, `rescore-${row.id}`) },
        });
        break;
      }
      case "rehearsal.armed": {
        const p = payloadOf("rehearsal.armed", row);
        out.push({
          queue: QUEUES.rehearsal,
          name: REHEARSAL_JOBS.driver,
          data: { armId: p.arm_id, channelId: p.channel_id },
          opts: { jobId: rehearsalDriverJobId(p.arm_id) },
        });
        break;
      }
    }
  }
  return out;
}

/** One driver per arm (BullMQ forbids a two-part `rehearsal:<armId>` custom id). */
export const rehearsalDriverJobId = (armId: string) => `rehearsal-${armId}`;
