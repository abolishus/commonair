// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where a DMCA takedown keeps the objects it hides, and which objects an item covers. The origin
 * serves only `channels/`, `clips/`, `thumbnails/` and `vods/` (services/origin/src/media.ts), so a
 * known media URL stops working once its object moves under `moderation/dmca/`; a restore moves it
 * back to the same key. Objects are moved, never deleted. Keys never reach a log.
 */
import { schema, type Executor } from "@commonair/db";
import type { ObjectStorage } from "@commonair/storage";
import { eq, or } from "drizzle-orm";
import { moveObject, thumbnailPrefix, vodPrefix } from "../moderation/objects.ts";

const { vods, clips } = schema;

/** Private prefix (never publicly routed) holding objects hidden by a DMCA takedown. */
export const DMCA_HIDDEN_PREFIX = "moderation/dmca/";
export const dmcaHiddenKey = (key: string) => `${DMCA_HIDDEN_PREFIX}${key}`;
/** The original key of a hidden object, or null when the key is not under the DMCA prefix. */
export const dmcaOriginalKey = (hidden: string) =>
  hidden.startsWith(DMCA_HIDDEN_PREFIX) ? hidden.slice(DMCA_HIDDEN_PREFIX.length) : null;

export interface ItemSubject {
  subjectType: "vod" | "clip" | "broadcast" | null;
  subjectId: string | null;
}

export interface Covered {
  vods: { id: string; broadcastId: string; storagePrefix: string; thumbnailKey: string | null; status: string }[];
  clips: { id: string; storageKey: string | null; thumbnailKey: string | null; status: string }[];
  /** Live thumbnails of a broadcast item. */
  prefixes: string[];
}

/**
 * The rows an item's material lives in: a VOD and every clip of the same content (its own clips
 * and the live-buffer clips of its broadcast); a clip; a broadcast's VODs, clips and live
 * thumbnails. Deleted rows are included; callers decide what to do with them.
 */
export async function coveredBy(db: Executor, item: ItemSubject): Promise<Covered> {
  const out: Covered = { vods: [], clips: [], prefixes: [] };
  if (!item.subjectId) return out;
  const vodCols = {
    id: vods.id,
    broadcastId: vods.broadcastId,
    storagePrefix: vods.storagePrefix,
    thumbnailKey: vods.thumbnailKey,
    status: vods.status,
  };
  const clipCols = {
    id: clips.id,
    storageKey: clips.storageKey,
    thumbnailKey: clips.thumbnailKey,
    status: clips.status,
  };
  switch (item.subjectType) {
    case "vod": {
      out.vods = await db.select(vodCols).from(vods).where(eq(vods.id, item.subjectId));
      const v = out.vods[0];
      if (v)
        out.clips = await db
          .select(clipCols)
          .from(clips)
          .where(or(eq(clips.vodId, v.id), eq(clips.broadcastId, v.broadcastId)));
      break;
    }
    case "clip":
      out.clips = await db.select(clipCols).from(clips).where(eq(clips.id, item.subjectId));
      break;
    case "broadcast":
      out.vods = await db.select(vodCols).from(vods).where(eq(vods.broadcastId, item.subjectId));
      out.clips = await db.select(clipCols).from(clips).where(eq(clips.broadcastId, item.subjectId));
      out.prefixes = [thumbnailPrefix(item.subjectId)];
      break;
    case null:
      break;
  }
  return out;
}

/** The ids covered by several items at once (to find material another active notice still holds). */
export async function coveredIds(db: Executor, items: readonly ItemSubject[]) {
  const vodIds = new Set<string>();
  const clipIds = new Set<string>();
  for (const i of items) {
    const c = await coveredBy(db, i);
    for (const v of c.vods) vodIds.add(v.id);
    for (const x of c.clips) clipIds.add(x.id);
  }
  return { vodIds, clipIds };
}

/**
 * Whether covered media is still being written (a VOD recording or finalizing, a clip still
 * rendering): its final files land after any move, so the takedown is not complete yet.
 */
export function stillWriting(c: Covered): boolean {
  return (
    c.vods.some((v) => v.status === "recording" || v.status === "processing") ||
    c.clips.some((x) => x.status === "processing")
  );
}

/** Object keys and prefixes of covered rows that are not deleted. */
export function objectsOf(c: Covered, skip: { vodIds?: Set<string>; clipIds?: Set<string> } = {}) {
  const keys: string[] = [];
  const prefixes = [...c.prefixes];
  for (const v of c.vods) {
    if (v.status === "deleted" || skip.vodIds?.has(v.id)) continue;
    const prefix = v.storagePrefix.startsWith("vods/") ? v.storagePrefix : vodPrefix(v.id);
    prefixes.push(prefix);
    if (v.thumbnailKey && !v.thumbnailKey.startsWith(prefix)) keys.push(v.thumbnailKey);
  }
  for (const x of c.clips) {
    if (x.status === "deleted" || skip.clipIds?.has(x.id)) continue;
    for (const k of [x.storageKey, x.thumbnailKey]) if (k) keys.push(k);
  }
  return { keys: [...new Set(keys)], prefixes: [...new Set(prefixes)] };
}

/** Move public objects to the DMCA prefix. Safe to repeat: a missing source already moved. */
export async function hideObjects(
  storage: ObjectStorage,
  bucket: string,
  o: { keys: string[]; prefixes: string[] },
): Promise<number> {
  const keys = [...o.keys];
  for (const p of o.prefixes) for await (const obj of storage.list(bucket, p)) keys.push(obj.key);
  let moved = 0;
  for (const k of new Set(keys)) if (await moveObject(storage, bucket, k, dmcaHiddenKey(k))) moved++;
  return moved;
}

/** Move hidden objects back to their public keys. Safe to repeat. */
export async function unhideObjects(
  storage: ObjectStorage,
  bucket: string,
  o: { keys: string[]; prefixes: string[] },
): Promise<number> {
  const hidden = o.keys.map(dmcaHiddenKey);
  for (const p of o.prefixes) for await (const obj of storage.list(bucket, dmcaHiddenKey(p))) hidden.push(obj.key);
  let moved = 0;
  for (const h of new Set(hidden)) {
    const original = dmcaOriginalKey(h);
    if (original && (await moveObject(storage, bucket, h, original))) moved++;
  }
  return moved;
}
