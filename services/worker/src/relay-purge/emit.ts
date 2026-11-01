// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The relay purge emitter (batch 7 decision (x), ADR 0016 Amendment 1 A1.1). One job per outbox
 * event that takes media off the air (`b7JobsFor` picks them): it writes the `relay_purges` rows
 * relays long-poll, then nudges the API's held polls over Valkey.
 *
 * | event                                      | prefixes                                         | reason            |
 * | ------------------------------------------ | ------------------------------------------------ | ----------------- |
 * | `media.vod.state` (public false)           | `dvr/<vodId>/`                                   | `vod_hidden`      |
 * | `moderation.restriction` (restricted true) | `live/<slug>/`, `dvr/<vodId>/` of its recording  | `restricted`      |
 * | `channel.suspension` (suspended true)      | `live/<slug>/`, `dvr/<vodId>/` of any recording  | `suspended`       |
 * | `stream.offline`                           | `dvr/<vodId>/` of the ended broadcast's VODs     | `recording_ended` |
 *
 * `live/<slug>/` covers `live/<slug>/captions/`; nothing purges captions alone today (no event
 * takes only captions off the air).
 *
 * **Idempotent per event.** Each prefix is written under a transaction-scoped advisory lock on
 * the prefix, and skipped when a row for it already exists that was created at or after the
 * event occurred. Such a row reaches every relay after the event, which is all a purge for this
 * event promises, so a redelivered event (or a second event for the same prefix in the meantime)
 * adds nothing. The rows are the dedupe marker: no other table is written.
 *
 * **No relays, no rows.** An instance with no relay (none registered, or all retired) has no
 * cache to purge, and a relay that registers later starts with an empty one.
 */
import { RELAY_PURGE_PREFIX } from "@commonair/contracts/dto";
import { RELAY_PURGE_RULES, type RelayPurgeReason } from "@commonair/contracts/enums";
import { EVENTS, type EventType } from "@commonair/contracts/events";
import { schema, type Executor } from "@commonair/db";
import { and, desc, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { z } from "zod";
import type { WorkerContext } from "../context.ts";

const { events, relayPurges, relayNodes, channels, broadcasts, vods } = schema;

/**
 * Valkey pub/sub channel the emitter publishes to after a commit, waking the API's held
 * `relays.purges` polls. The API listens on the same name (`services/api/src/relay/purges.ts`).
 * Contract request: `BUS.relayPurges` in `@commonair/contracts/events`.
 */
export const RELAY_PURGE_NUDGE_CHANNEL = "bus:relay-purges";

export interface PurgeRow {
  prefix: string;
  reason: RelayPurgeReason;
}

type EventRow = typeof events.$inferSelect;

const payloadOf = <T extends EventType>(type: T, row: EventRow) =>
  EVENTS[type].payload.parse(row.payload) as z.output<(typeof EVENTS)[T]["payload"]>;

export const dvrPrefix = (vodId: string) => `dvr/${vodId}/`;
export const livePrefix = (slug: string) => `live/${slug}/`;

/** A prefix relays accept (the wire rule); anything else is never written. */
export const validPrefix = (p: string) => p.length <= RELAY_PURGE_RULES.prefixMaxLength && RELAY_PURGE_PREFIX.test(p);

async function slugOf(tx: Executor, channelId: string): Promise<string | null> {
  const [c] = await tx.select({ slug: channels.slug }).from(channels).where(eq(channels.id, channelId));
  return c?.slug ?? null;
}

/** VODs still recording (so still served as DVR), of one broadcast or of a whole channel. */
async function recordingVods(tx: Executor, where: { broadcastId: string } | { channelId: string }): Promise<string[]> {
  const rows = await tx
    .select({ id: vods.id })
    .from(vods)
    .where(
      and(
        eq(vods.status, "recording"),
        "broadcastId" in where ? eq(vods.broadcastId, where.broadcastId) : eq(vods.channelId, where.channelId),
      ),
    );
  return rows.map((r) => r.id);
}

/** The prefixes one event purges, in a stable order; empty when it purges nothing. */
export async function purgeRowsFor(tx: Executor, row: EventRow): Promise<PurgeRow[]> {
  switch (row.type) {
    case "media.vod.state": {
      const p = payloadOf("media.vod.state", row);
      return p.public ? [] : [{ prefix: dvrPrefix(p.vod_id), reason: "vod_hidden" }];
    }
    case "moderation.restriction": {
      const p = payloadOf("moderation.restriction", row);
      if (!p.restricted) return [];
      const slug = await slugOf(tx, p.channel_id);
      const dvr = await recordingVods(tx, { broadcastId: p.broadcast_id });
      return [
        ...(slug ? [{ prefix: livePrefix(slug), reason: "restricted" as const }] : []),
        ...dvr.map((id) => ({ prefix: dvrPrefix(id), reason: "restricted" as const })),
      ];
    }
    case "channel.suspension": {
      const p = payloadOf("channel.suspension", row);
      if (!p.suspended) return [];
      const slug = await slugOf(tx, p.channel_id);
      const dvr = await recordingVods(tx, { channelId: p.channel_id });
      return [
        ...(slug ? [{ prefix: livePrefix(slug), reason: "suspended" as const }] : []),
        ...dvr.map((id) => ({ prefix: dvrPrefix(id), reason: "suspended" as const })),
      ];
    }
    case "stream.offline": {
      if (!row.channelId) return [];
      // The broadcast this event ended: the channel's newest live broadcast ended by then (the
      // hook stamps both with the same instant). Rehearsals record nothing and have no DVR.
      const [b] = await tx
        .select({ id: broadcasts.id })
        .from(broadcasts)
        .where(
          and(
            eq(broadcasts.channelId, row.channelId),
            eq(broadcasts.kind, "live"),
            isNotNull(broadcasts.endedAt),
            lte(broadcasts.endedAt, sql`${row.occurredAt.toISOString()}::timestamptz + interval '1 second'`),
          ),
        )
        .orderBy(desc(broadcasts.endedAt))
        .limit(1);
      if (!b) return [];
      const rows = await tx.select({ id: vods.id }).from(vods).where(eq(vods.broadcastId, b.id));
      return rows.map((v) => ({ prefix: dvrPrefix(v.id), reason: "recording_ended" as const }));
    }
    default:
      return [];
  }
}

export type EmitResult = { written: number; skipped: number; noRelays?: 1; missing?: 1 };

/**
 * Write the rows for one event (see the module comment). Returns what it wrote; the caller
 * nudges the feed after the commit when anything was written.
 */
export async function emitPurges(ctx: Pick<WorkerContext, "db" | "logger">, eventId: string): Promise<EmitResult> {
  return ctx.db.transaction(async (tx) => {
    const [relay] = await tx
      .select({ id: relayNodes.id })
      .from(relayNodes)
      .where(isNull(relayNodes.retiredAt))
      .limit(1);
    if (!relay) return { written: 0, skipped: 0, noRelays: 1 };
    const [row] = await tx.select().from(events).where(eq(events.id, eventId));
    if (!row) return { written: 0, skipped: 0, missing: 1 };
    const wanted = (await purgeRowsFor(tx, row)).filter((r) => {
      if (validPrefix(r.prefix)) return true;
      ctx.logger.warn("relay purge prefix refused by the wire rule; not written", { event: row.type });
      return false;
    });
    // One row per prefix, locked in a stable order so two events never deadlock.
    const unique = [...new Map(wanted.map((r) => [r.prefix, r])).values()].sort((a, b) =>
      a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0,
    );
    let written = 0;
    for (const r of unique)
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`relay-purge:${r.prefix}`}, 0))`);
    const prefixes = unique.map((r) => r.prefix);
    const existing =
      prefixes.length === 0
        ? []
        : await tx
            .select({ prefix: relayPurges.prefix })
            .from(relayPurges)
            .where(
              and(
                inArray(relayPurges.prefix, prefixes),
                sql`${relayPurges.createdAt} >= ${row.occurredAt.toISOString()}::timestamptz`,
              ),
            );
    const done = new Set(existing.map((e) => e.prefix));
    const fresh = unique.filter((r) => !done.has(r.prefix));
    if (fresh.length > 0) {
      // One writer at a time until commit (taken last, after the prefix locks, so never in a
      // cycle): `seq` order is then commit order, and the feed never hands a relay a cursor that a
      // slower transaction later commits a row below.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('relay-purge:insert', 0))`);
      await tx.insert(relayPurges).values(fresh.map((r) => ({ prefix: r.prefix, reason: r.reason })));
      written = fresh.length;
    }
    return { written, skipped: unique.length - written };
  });
}

/** Wake the API's held polls. Best effort: a lost nudge only delays delivery to the next poll. */
export async function nudge(ctx: Pick<WorkerContext, "valkey" | "logger">): Promise<void> {
  try {
    await ctx.valkey.publish(RELAY_PURGE_NUDGE_CHANNEL, "1");
  } catch (err) {
    ctx.logger.warn("relay purge nudge failed", { err: (err as Error).name });
  }
}
