// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-media's direct inserts, as the app role: the backdated broadcasts (kind `live`, ended),
 * their stream hours, health and egress samples, and `broadcast_id` on seed-social's chat lines
 * inside each broadcast (so a broadcast's chat is its own, as live chat would be). All four tables
 * are plain; `stream_hours`' trigger only refuses rehearsals. No `events` rows: demo history must
 * not fan out. Inserts are chunked (`CHUNK` rows) and check the abort signal between chunks.
 */
import { type DbHandle, schema, uuidv7 } from "@commonair/db";
import type { HistoryPlan } from "./plan.ts";

export const CHUNK = 1_000;
const PROGRESS_MS = 10_000;

export interface WriteOptions {
  signal?: AbortSignal;
  progress?: (line: string) => void;
}

async function insertChunks<T>(
  label: string,
  rows: readonly T[],
  insert: (chunk: T[]) => Promise<unknown>,
  o: WriteOptions,
): Promise<number> {
  let last = Date.now();
  for (let i = 0; i < rows.length; i += CHUNK) {
    o.signal?.throwIfAborted();
    await insert(rows.slice(i, i + CHUNK));
    if (o.progress && Date.now() - last > PROGRESS_MS) {
      o.progress(`${label}: ${Math.min(rows.length, i + CHUNK)}/${rows.length}`);
      last = Date.now();
    }
  }
  return rows.length;
}

export interface HistoryWritten {
  /** Broadcast id per plan index. */
  broadcastIds: string[];
  rows: Record<string, number>;
}

export async function writeHistory(h: DbHandle, plan: HistoryPlan, o: WriteOptions = {}): Promise<HistoryWritten> {
  const { db } = h;
  const ids = plan.broadcasts.map((b) => uuidv7(b.start.getTime()));
  const id = (i: number) => {
    const v = ids[i];
    if (!v) throw new Error(`seed-media: no broadcast at plan index ${i}`);
    return v;
  };
  const rows: Record<string, number> = {};
  rows.broadcasts = await insertChunks(
    "broadcasts",
    plan.broadcasts,
    (chunk) =>
      db.insert(schema.broadcasts).values(
        chunk.map((b) => ({
          id: id(b.index),
          channelId: b.channelId,
          kind: "live" as const,
          ingestProtocol: b.ingestProtocol,
          path: `live/${b.slug}`,
          title: b.title,
          categoryId: b.categoryId,
          startedAt: b.start,
          endedAt: b.end,
          peakVerifiedViewers: b.peakVerifiedViewers,
          verifiedViewerSeconds: b.verifiedViewerSeconds,
          excludedViewerSeconds: b.excludedViewerSeconds,
          createdAt: b.start,
        })),
      ),
    o,
  );
  rows.stream_hours = await insertChunks(
    "stream_hours",
    plan.streamHours,
    (chunk) =>
      db.insert(schema.streamHours).values(
        chunk.map((s) => ({
          broadcastId: id(s.broadcast),
          channelId: s.channelId,
          hourStart: s.hourStart,
          liveSeconds: s.liveSeconds,
          verifiedOtherViewers: s.verifiedOtherViewers,
          eligible: s.eligible,
        })),
      ),
    o,
  );
  rows.broadcast_health_samples = await insertChunks(
    "broadcast_health_samples",
    plan.health,
    (chunk) =>
      db.insert(schema.broadcastHealthSamples).values(
        chunk.map((s) => ({
          broadcastId: id(s.broadcast),
          at: s.at,
          bitrateKbps: s.bitrateKbps,
          fps: s.fps,
          width: s.width,
          height: s.height,
          videoCodec: s.videoCodec,
          audioCodec: s.audioCodec,
          keyframeIntervalMs: s.keyframeIntervalMs,
          droppedFrames: s.droppedFrames,
          warnings: s.warnings,
        })),
      ),
    o,
  );
  rows.egress_samples = await insertChunks(
    "egress_samples",
    plan.egress,
    (chunk) =>
      db.insert(schema.egressSamples).values(
        chunk.map((s) => ({
          broadcastId: id(s.broadcast),
          bucketStart: s.bucketStart,
          source: s.source,
          bytes: s.bytes,
          requests: s.requests,
        })),
      ),
    o,
  );
  return { broadcastIds: ids, rows };
}

/**
 * seed-social's request: set `broadcast_id` on the backdated chat lines inside each broadcast's
 * window (scoped by channel and window, lines not yet linked). Returns the lines linked.
 */
export async function linkChat(
  h: DbHandle,
  plan: HistoryPlan,
  broadcastIds: readonly string[],
  o: WriteOptions = {},
): Promise<number> {
  let linked = 0;
  for (let i = 0; i < plan.broadcasts.length; i += CHUNK) {
    o.signal?.throwIfAborted();
    const chunk = plan.broadcasts.slice(i, i + CHUNK).map((b) => ({
      id: broadcastIds[b.index],
      channel_id: b.channelId,
      s: b.start.toISOString(),
      e: b.end.toISOString(),
    }));
    const res = await h.sql`
      update chat_messages m
         set broadcast_id = v.id
        from jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) as v(id uuid, channel_id uuid, s timestamptz, e timestamptz)
       where m.channel_id = v.channel_id
         and m.created_at >= v.s
         and m.created_at <= v.e
         and m.broadcast_id is null`;
    linked += res.count;
  }
  return linked;
}
