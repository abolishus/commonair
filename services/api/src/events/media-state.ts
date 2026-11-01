// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Media-state and suspension events (batch 7 decision (z)). Every path that can make a VOD or clip
 * public or stop it being public runs its writes inside `withMediaState`, and every suspension path
 * inside `withSuspensionState`: the rows in scope are locked and read before, read again after, and
 * one internal event is written per row whose state changed, in the caller's transaction. The
 * worker and media services carry the same rules (`services/{worker,media}/src/media-state.ts`);
 * `tests/media-state-sites.test.ts` lists every write site, so a new path without events fails.
 *
 * "Public" is what the row itself says, as `media/visibility.ts` reads it for an anonymous viewer:
 * a VOD is `ready`, `public` and not removed; a clip is `ready`, not removed, and no VOD of its
 * content (the VOD it was cut from, or a VOD of its broadcast) is non-public or removed. A T1
 * restriction and a channel suspension have their own events (`moderation.restriction`,
 * `channel.suspension`), so they are not folded in here.
 */
import { eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { MediaStateReason } from "@commonair/contracts/enums";
import { schema, type Executor } from "@commonair/db";
import { emit } from "./outbox.ts";

const { vods, clips, channels } = schema;

/** A VOD everyone may watch, as far as its own row says. */
export const vodPublic = sql<boolean>`(${vods.status} = 'ready' and ${vods.visibility} = 'public' and ${vods.removedReason} is null)`;

/**
 * A VOD whose live DVR may be serving (the row's part of `dvrServable`): recording, not removed.
 * Removing it mid-broadcast changes no "public" state, yet relays must drop `dvr/<vodId>/` at once
 * (decision (x)), so that removal writes `media.vod.state {public: false}` too.
 */
export const vodDvrLive = sql<boolean>`(${vods.status} = 'recording' and ${vods.removedReason} is null)`;
const vodRemoved = sql<boolean>`(${vods.removedReason} is not null or ${vods.status} = 'deleted')`;

/**
 * A clip everyone may watch: never more visible than its source (`media/visibility.ts`).
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

/** One row: its channel, and whether it is public (or, for a channel, suspended). */
interface State {
  channelId: string;
  on: boolean;
  /** VODs, before the write: DVR may be serving (`vodDvrLive`). */
  dvr?: boolean;
  /** VODs, after the write: removed or deleted. */
  removed?: boolean;
}

interface Snapshot {
  vods: Map<string, State>;
  clips: Map<string, State>;
}

async function snapshot(tx: Executor, scope: MediaScope): Promise<Snapshot> {
  // Locked in a fixed order (VODs, then clips, by id), as the removal paths write them.
  const vodRows = scope.vods
    ? await tx
        .select({
          id: vods.id,
          channelId: vods.channelId,
          broadcastId: vods.broadcastId,
          on: vodPublic,
          dvr: vodDvrLive,
        })
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
    vods: new Map(vodRows.map((r) => [r.id, { channelId: r.channelId, on: r.on, dvr: r.dvr }])),
    clips: new Map(clipRows.map((r) => [r.id, { channelId: r.channelId, on: r.on }])),
  };
}

async function reread(tx: Executor, before: Snapshot): Promise<Snapshot> {
  const vodIds = [...before.vods.keys()];
  const clipIds = [...before.clips.keys()];
  const vodRows =
    vodIds.length > 0
      ? await tx
          .select({ id: vods.id, channelId: vods.channelId, on: vodPublic, removed: vodRemoved })
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
    vods: new Map(vodRows.map((r) => [r.id, { channelId: r.channelId, on: r.on, removed: r.removed }])),
    clips: new Map(clipRows.map((r) => [r.id, { channelId: r.channelId, on: r.on }])),
  };
}

/**
 * Pure: the rows whose state changed (a row gone afterwards counts as off), plus VODs whose DVR a
 * removal stopped. Sorted by id.
 */
export function changedStates(
  before: ReadonlyMap<string, State>,
  after: ReadonlyMap<string, State>,
): { id: string; channelId: string; on: boolean }[] {
  const out: { id: string; channelId: string; on: boolean }[] = [];
  for (const [id, b] of [...before].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    const a = after.get(id);
    const on = a?.on ?? false;
    if (on !== b.on) out.push({ id, channelId: b.channelId, on });
    // A recording VOD removed mid-broadcast: still not public, but its DVR must stop.
    else if (b.dvr === true && !on && (a === undefined || a.removed === true))
      out.push({ id, channelId: b.channelId, on: false });
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

/**
 * Whether a channel is suspended for decision (z): the channel itself, or its owner's account
 * while that suspension is in force (a DMCA repeat-infringer or T0 ban suspends the account).
 */
const channelSuspended = (now: Date) =>
  sql<boolean>`(${channels.suspendedAt} is not null or exists (select 1 from users su where su.id = "channels"."owner_id" and su.banned and (su.ban_expires is null or su.ban_expires > ${now.toISOString()}::timestamptz)))`;

/** The channels a suspension of this account or channel can change. */
export function suspensionScope(target: { userId?: string | null; channelId?: string | null }): SQL | undefined {
  return or(
    target.channelId ? inArray(channels.id, [target.channelId]) : undefined,
    target.userId ? inArray(channels.ownerId, [target.userId]) : undefined,
  );
}

/**
 * Run `write` (a suspension or unsuspension) and write `channel.suspension` for every channel in
 * `where` whose suspended state it changed, in the same transaction.
 */
export async function withSuspensionState<T>(
  tx: Executor,
  where: SQL | undefined,
  now: Date,
  write: () => Promise<T>,
): Promise<T> {
  if (!where) return write();
  const read = (lock: boolean) => {
    const q = tx
      .select({ id: channels.id, channelId: channels.id, on: channelSuspended(now) })
      .from(channels)
      .where(where)
      .orderBy(channels.id);
    return lock ? q.for("update", { of: channels }) : q;
  };
  const before = new Map((await read(true)).map((r) => [r.id, { channelId: r.channelId, on: r.on }]));
  const out = await write();
  const after = new Map((await read(false)).map((r) => [r.id, { channelId: r.channelId, on: r.on }]));
  for (const c of changedStates(before, after))
    await emit(tx, "channel.suspension", c.channelId, { channel_id: c.channelId, suspended: c.on }, now);
  return out;
}
