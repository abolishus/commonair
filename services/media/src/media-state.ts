// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Media-state events (batch 7 decision (z)). Every path here that can make a VOD or clip public or
 * stop it being public runs its writes inside `withMediaState`: the rows in scope are locked and
 * read before, read again after, and one internal event is written per row whose state changed, in
 * the caller's transaction. The API and the worker carry the same rules (and also track
 * suspensions): `services/api/src/events/media-state.ts`, `services/worker/src/media-state.ts`.
 * `tests/media-state-sites.test.ts` lists every write site here, so a new path without events fails.
 *
 * "Public" is what the row itself says, as the API's `media/visibility.ts` reads it for an
 * anonymous viewer: a VOD is `ready`, `public` and not removed; a clip is `ready`, not removed, and
 * no VOD of its content (the VOD it was cut from, or a VOD of its broadcast) is non-public or
 * removed. A T1 restriction and a channel suspension have their own events.
 */
import { eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { MediaStateReason } from "@commonair/contracts/enums";
import { EVENTS, type EventPayload, type EventType } from "@commonair/contracts/events";
import { schema, uuidv7, type Executor } from "@commonair/db";

const { vods, clips } = schema;

/** One outbox row, validated against the catalog (a bad payload throws and rolls back). */
async function emit<T extends EventType>(
  tx: Executor,
  type: T,
  channelId: string,
  payload: EventPayload<T>,
  now: Date,
): Promise<void> {
  const def = EVENTS[type];
  const parsed = def.payload.parse(payload) as Record<string, unknown>;
  await tx
    .insert(schema.events)
    .values({ id: uuidv7(now.getTime()), type, version: def.version, channelId, payload: parsed, occurredAt: now });
}

/** A VOD everyone may watch, as far as its own row says. */
export const vodPublic = sql<boolean>`(${vods.status} = 'ready' and ${vods.visibility} = 'public' and ${vods.removedReason} is null)`;

/**
 * A clip everyone may watch: never more visible than its source (the API's `media/visibility.ts`).
 * The outer columns are spelled out: Drizzle leaves them unqualified in a single-table select, and
 * inside the subquery an unqualified `broadcast_id` would mean the VOD's own.
 */
export const clipPublic = sql<boolean>`(${clips.status} = 'ready' and ${clips.removedReason} is null and not exists (select 1 from vods sv where (sv.id = "clips"."vod_id" or sv.broadcast_id = "clips"."broadcast_id") and (sv.visibility <> 'public' or (sv.status = 'deleted' and sv.removed_reason is distinct from 'retention') or sv.removed_reason in ('owner', 'creator', 'dmca'))))`;

/** The VODs and clips a write may change. The clips of every VOD in scope are added. */
export interface MediaScope {
  vods?: SQL;
  clips?: SQL;
}

/** The scope of a VOD, clip or broadcast subject (moderation, NCII, DMCA items); null for anything else. */
export function mediaScopeOf(subjectType: string | null, subjectId: string | null): MediaScope | null {
  if (!subjectId) return null;
  if (subjectType === "vod") return { vods: eq(vods.id, subjectId) };
  if (subjectType === "clip") return { clips: eq(clips.id, subjectId) };
  if (subjectType === "broadcast")
    return { vods: eq(vods.broadcastId, subjectId), clips: eq(clips.broadcastId, subjectId) };
  return null;
}

/** One row: its channel, and whether it is public. */
interface State {
  channelId: string;
  on: boolean;
}

interface Snapshot {
  vods: Map<string, State>;
  clips: Map<string, State>;
}

async function snapshot(tx: Executor, scope: MediaScope): Promise<Snapshot> {
  // Locked in a fixed order (VODs, then clips, by id), as the removal paths write them.
  const vodRows = scope.vods
    ? await tx
        .select({ id: vods.id, channelId: vods.channelId, broadcastId: vods.broadcastId, on: vodPublic })
        .from(vods)
        .where(scope.vods)
        .orderBy(vods.id)
        .for("update", { of: vods })
    : [];
  const clipWhere = or(
    scope.clips,
    vodRows.length > 0
      ? inArray(
          clips.vodId,
          vodRows.map((v) => v.id),
        )
      : undefined,
    vodRows.length > 0 ? inArray(clips.broadcastId, [...new Set(vodRows.map((v) => v.broadcastId))]) : undefined,
  );
  const clipRows = clipWhere
    ? await tx
        .select({ id: clips.id, channelId: clips.channelId, on: clipPublic })
        .from(clips)
        .where(clipWhere)
        .orderBy(clips.id)
        .for("update", { of: clips })
    : [];
  return {
    vods: new Map(vodRows.map((r) => [r.id, { channelId: r.channelId, on: r.on }])),
    clips: new Map(clipRows.map((r) => [r.id, { channelId: r.channelId, on: r.on }])),
  };
}

async function reread(tx: Executor, before: Snapshot): Promise<Snapshot> {
  const vodIds = [...before.vods.keys()];
  const clipIds = [...before.clips.keys()];
  const vodRows =
    vodIds.length > 0
      ? await tx
          .select({ id: vods.id, channelId: vods.channelId, on: vodPublic })
          .from(vods)
          .where(inArray(vods.id, vodIds))
      : [];
  const clipRows =
    clipIds.length > 0
      ? await tx
          .select({ id: clips.id, channelId: clips.channelId, on: clipPublic })
          .from(clips)
          .where(inArray(clips.id, clipIds))
      : [];
  return {
    vods: new Map(vodRows.map((r) => [r.id, { channelId: r.channelId, on: r.on }])),
    clips: new Map(clipRows.map((r) => [r.id, { channelId: r.channelId, on: r.on }])),
  };
}

/** Pure: the rows whose state changed (a row gone afterwards counts as off). Sorted by id. */
export function changedStates(
  before: ReadonlyMap<string, State>,
  after: ReadonlyMap<string, State>,
): { id: string; channelId: string; on: boolean }[] {
  const out: { id: string; channelId: string; on: boolean }[] = [];
  for (const [id, b] of [...before].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    const on = after.get(id)?.on ?? false;
    if (on !== b.on) out.push({ id, channelId: b.channelId, on });
  }
  return out;
}

/**
 * Run `write` (which changes VODs or clips in `scope`) and write `media.vod.state` and
 * `media.clip.state` for every row it made public or non-public, in the same transaction.
 */
export async function withMediaState<T>(
  tx: Executor,
  scope: MediaScope,
  reason: MediaStateReason,
  now: Date,
  write: () => Promise<T>,
): Promise<T> {
  const before = await snapshot(tx, scope);
  const out = await write();
  const after = await reread(tx, before);
  for (const v of changedStates(before.vods, after.vods))
    await emit(
      tx,
      "media.vod.state",
      v.channelId,
      { vod_id: v.id, channel_id: v.channelId, public: v.on, reason },
      now,
    );
  for (const c of changedStates(before.clips, after.clips))
    await emit(
      tx,
      "media.clip.state",
      c.channelId,
      { clip_id: c.id, channel_id: c.channelId, public: c.on, reason },
      now,
    );
  return out;
}
