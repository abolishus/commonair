// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Quarantine for content tied to a CSAM hash match. Objects are moved (copy, then delete the
 * original) under `quarantine/<broadcastId>/` in the media bucket: never served (no public
 * route maps there), never deleted by retention, kept for legal preservation. The rows are
 * marked `deleted` with `removedReason = csam_hash_match` so nothing lists or plays them.
 */
import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@commonair/db";
import type { ObjectStorage } from "@commonair/storage";

export const CSAM_REASON = "csam_hash_match";
export const quarantinePrefix = (broadcastId: string) => `quarantine/${broadcastId}/`;

export interface QuarantineDeps {
  db: Database;
  storage: ObjectStorage;
  bucket: string;
}

export async function moveObject(deps: QuarantineDeps, from: string, to: string): Promise<boolean> {
  const res = await deps.storage.get(deps.bucket, from);
  if (!res) return false;
  await deps.storage.put(deps.bucket, to, new Uint8Array(await res.arrayBuffer()), {
    contentType: res.headers.get("content-type") ?? "application/octet-stream",
  });
  await deps.storage.delete(deps.bucket, from);
  return true;
}

async function movePrefix(deps: QuarantineDeps, prefix: string, to: string): Promise<number> {
  const keys: string[] = [];
  for await (const o of deps.storage.list(deps.bucket, prefix)) keys.push(o.key);
  for (const k of keys) await moveObject(deps, k, to + k.slice(prefix.length));
  return keys.length;
}

/** Quarantine one VOD (idempotent). */
export async function quarantineVod(deps: QuarantineDeps, vodId: string, broadcastId: string): Promise<void> {
  await movePrefix(deps, `vods/${vodId}/`, `${quarantinePrefix(broadcastId)}vods/${vodId}/`);
  await deps.db
    .update(schema.vods)
    .set({ status: "deleted", removedReason: CSAM_REASON, thumbnailKey: null })
    .where(eq(schema.vods.id, vodId));
}

/** Quarantine one clip's stored objects (idempotent). */
export async function quarantineClip(deps: QuarantineDeps, clipId: string, broadcastId: string): Promise<void> {
  const [clip] = await deps.db
    .select({ storageKey: schema.clips.storageKey, thumbnailKey: schema.clips.thumbnailKey })
    .from(schema.clips)
    .where(eq(schema.clips.id, clipId));
  for (const key of [clip?.storageKey, clip?.thumbnailKey])
    if (key) await moveObject(deps, key, `${quarantinePrefix(broadcastId)}${key}`);
  await deps.db
    .update(schema.clips)
    .set({ status: "deleted", removedReason: CSAM_REASON, storageKey: null, thumbnailKey: null })
    .where(eq(schema.clips.id, clipId));
}

/** Everything derived from a broadcast: thumbnails, its VODs, its clips. */
export async function quarantineBroadcast(deps: QuarantineDeps, broadcastId: string): Promise<void> {
  await movePrefix(deps, `thumbnails/${broadcastId}/`, `${quarantinePrefix(broadcastId)}thumbnails/`);
  await deps.db.update(schema.broadcasts).set({ thumbnailKey: null }).where(eq(schema.broadcasts.id, broadcastId));
  const vods = await deps.db
    .select({ id: schema.vods.id })
    .from(schema.vods)
    .where(eq(schema.vods.broadcastId, broadcastId));
  for (const v of vods) await quarantineVod(deps, v.id, broadcastId);
  const clips = await deps.db
    .select({ id: schema.clips.id })
    .from(schema.clips)
    .where(eq(schema.clips.broadcastId, broadcastId));
  for (const c of clips) await quarantineClip(deps, c.id, broadcastId);
}

/** True when publishing anything from this broadcast must be refused. */
export async function broadcastTainted(db: Database, broadcastId: string): Promise<boolean> {
  const [hit] = await db
    .select({ id: schema.hashMatchResults.id })
    .from(schema.hashMatchResults)
    .where(
      and(
        eq(schema.hashMatchResults.subjectType, "broadcast"),
        eq(schema.hashMatchResults.subjectId, broadcastId),
        eq(schema.hashMatchResults.matched, true),
      ),
    )
    .limit(1);
  if (hit) return true;
  const [ch] = await db
    .select({ reason: schema.channels.suspendedReason })
    .from(schema.broadcasts)
    .innerJoin(schema.channels, eq(schema.channels.id, schema.broadcasts.channelId))
    .where(eq(schema.broadcasts.id, broadcastId));
  return ch?.reason === CSAM_REASON;
}
