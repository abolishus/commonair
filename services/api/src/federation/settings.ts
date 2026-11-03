// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Studio federation settings and remote followers (ADR 0030 decisions 1, 4 and 6).
 *
 * - Turning federation on creates the actor row and its RSA-2048 key the first time (private key
 *   encrypted), and sets `channels.federation_settings.enabled` and `federation_actors.enabled`
 *   together.
 * - Turning it off keeps the key and stops delivery: the actor answers 410 from then on. The
 *   change writes `channel.federation {enabled: false}` (and `federation.actor.disabled` when the
 *   actor was on) in the setting's transaction (batch 8 decision (h)). The worker's outbox relay
 *   turns those into the actor `Delete` to every follower inbox and the follower cleanup, so the
 *   API queues no delivery and deletes no follower itself, and a crash after commit loses nothing.
 *   Remote servers drop the follow on that `Delete`, and the rows hold remote people's handles
 *   (decision 6). A toggle never writes the public `channel.update`.
 * - Followers are listed to the owner (handle and server) and removable; removal deletes the row.
 */
import { ChannelFederationSettings } from "@commonair/contracts/shapes";
import { schema } from "@commonair/db";
import { and, count, desc, eq, sql } from "drizzle-orm";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { emit } from "../events/outbox.ts";
import { decodeCursor, encodeCursor, isKeyCursor, pageOf } from "../lib/cursor.ts";
import { iso } from "../lib/dto.ts";
import { apiError, notFound } from "../lib/errors.ts";
import { actorUrl, handleOf, keyIdOf, suspendedSql } from "./ids.ts";
import { newActorKey } from "./keys.ts";

const { channels, federationActors, federationFollowers, users } = schema;

// The cursor carries milliseconds; created_at has microseconds. Comparing at millisecond
// precision keeps rows that share a millisecond from being skipped between pages.
const followerCreatedMs = sql<Date>`date_trunc('milliseconds', ${federationFollowers.createdAt})`;

type ChannelRow = typeof channels.$inferSelect;

/** FORBIDDEN with an i18n-ready reason while the instance has federation off (decision (c)). */
export function requireFederationEnabled(deps: Pick<Deps, "env">): void {
  if (!deps.env.FEDERATION_ENABLED)
    throw apiError("FORBIDDEN", "Federation is not enabled on this instance", { reason: "federation_disabled" });
}

/** The followers list and changes are the owner's alone: they are other people's handles. */
export function requireOwner(channel: ChannelRow, userId: string): void {
  if (channel.ownerId !== userId)
    throw apiError("FORBIDDEN", "Only the channel owner can do this", { reason: "owner_only" });
}

export async function getSettings(deps: Deps, channel: ChannelRow) {
  const [[actor], [followers]] = await Promise.all([
    deps.db
      .select({ enabled: federationActors.enabled })
      .from(federationActors)
      .where(eq(federationActors.channelId, channel.id)),
    deps.db.select({ n: count() }).from(federationFollowers).where(eq(federationFollowers.channelId, channel.id)),
  ]);
  const enabled = Boolean(ChannelFederationSettings.parse(channel.federationSettings).enabled && actor?.enabled);
  return {
    enabled,
    instanceEnabled: deps.env.FEDERATION_ENABLED,
    handle: enabled ? handleOf(deps.site, channel.slug) : null,
    actorId: enabled ? actorUrl(deps.site, channel.id) : null,
    followers: followers?.n ?? 0,
  };
}

export async function updateSettings(deps: Deps, channel: ChannelRow, userId: string, enabled: boolean | undefined) {
  if (enabled === undefined) return getSettings(deps, channel);
  const actor = actorUrl(deps.site, channel.id);

  if (enabled) {
    // Generated before the transaction (RSA is slow-ish); unused when the actor already exists.
    const [existing] = await deps.db
      .select({ id: federationActors.channelId })
      .from(federationActors)
      .where(eq(federationActors.channelId, channel.id));
    const fresh = existing ? null : await newActorKey(deps.env.AUTH_SECRET);
    await deps.db.transaction(async (tx) => {
      const [c] = await tx
        .select({ settings: channels.federationSettings, suspended: suspendedSql(deps.now()) })
        .from(channels)
        .innerJoin(users, eq(users.id, channels.ownerId))
        .where(eq(channels.id, channel.id))
        .for("update", { of: channels });
      if (!c) throw notFound("Channel not found");
      if (c.suspended)
        throw apiError("FORBIDDEN", "A suspended channel cannot federate", { reason: "channel_suspended" });
      const [prior] = await tx
        .select({ enabled: federationActors.enabled })
        .from(federationActors)
        .where(eq(federationActors.channelId, channel.id))
        .for("update");
      const was = Boolean(ChannelFederationSettings.parse(c.settings).enabled && prior?.enabled);
      await tx
        .update(channels)
        .set({ federationSettings: { ...ChannelFederationSettings.parse(c.settings), enabled: true } })
        .where(eq(channels.id, channel.id));
      const now = deps.now();
      if (fresh)
        await tx
          .insert(federationActors)
          .values({
            channelId: channel.id,
            enabled: true,
            keyId: keyIdOf(actor),
            publicKeyPem: fresh.publicKeyPem,
            privateKeyEnc: fresh.privateKeyEnc,
            keyCreatedAt: now,
          })
          .onConflictDoUpdate({ target: federationActors.channelId, set: { enabled: true, updatedAt: now } });
      else
        await tx
          .update(federationActors)
          .set({ enabled: true, updatedAt: now })
          .where(eq(federationActors.channelId, channel.id));
      // Audited, and announced to the worker, on a change only: a repeated "on" is a no-op.
      if (!was) {
        await audit(tx, {
          actorType: "user",
          actorId: userId,
          action: "federation.channel.enable",
          subjectType: "channel",
          subjectId: channel.id,
          channelId: channel.id,
        });
        await emit(tx, "channel.federation", channel.id, { channel_id: channel.id, enabled: true }, now);
      }
    });
  } else {
    await deps.db.transaction(async (tx) => {
      const [c] = await tx
        .select({ settings: channels.federationSettings })
        .from(channels)
        .where(eq(channels.id, channel.id))
        .for("update");
      if (!c) throw notFound("Channel not found");
      const was = ChannelFederationSettings.parse(c.settings).enabled;
      await tx
        .update(channels)
        .set({ federationSettings: { ...ChannelFederationSettings.parse(c.settings), enabled: false } })
        .where(eq(channels.id, channel.id));
      const now = deps.now();
      const off = await tx
        .update(federationActors)
        .set({ enabled: false, updatedAt: now })
        .where(and(eq(federationActors.channelId, channel.id), eq(federationActors.enabled, true)))
        .returning({ id: federationActors.channelId });
      if (!was && off.length === 0) return;
      const [followers] = await tx
        .select({ n: count() })
        .from(federationFollowers)
        .where(eq(federationFollowers.channelId, channel.id));
      await audit(tx, {
        actorType: "user",
        actorId: userId,
        action: "federation.channel.disable",
        subjectType: "channel",
        subjectId: channel.id,
        channelId: channel.id,
        details: { followers: followers?.n ?? 0 },
      });
      // The relay queues the actor `Delete` per inbox and the follower cleanup from these; both
      // events for one change name the same deliveries, so each inbox gets one `Delete`.
      await emit(tx, "channel.federation", channel.id, { channel_id: channel.id, enabled: false }, now);
      if (off.length > 0) await emit(tx, "federation.actor.disabled", channel.id, { channel_id: channel.id }, now);
    });
  }
  const [fresh] = await deps.db.select().from(channels).where(eq(channels.id, channel.id));
  return getSettings(deps, fresh ?? channel);
}

export async function listFollowers(deps: Deps, channelId: string, input: { cursor?: string; limit: number }) {
  const cursor = decodeCursor(input.cursor, isKeyCursor);
  const rows = await deps.db
    .select()
    .from(federationFollowers)
    .where(
      and(
        eq(federationFollowers.channelId, channelId),
        cursor
          ? sql`(${followerCreatedMs}, ${federationFollowers.id}) < (${cursor.t}::timestamptz, ${cursor.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(followerCreatedMs), desc(federationFollowers.id))
    .limit(input.limit + 1);
  return pageOf(
    rows,
    input.limit,
    (r) => ({ id: r.id, actor: r.actorId, handle: r.handle, domain: r.domain, createdAt: iso(r.createdAt) }),
    (last) => encodeCursor({ t: iso(last.createdAt), id: last.id }),
  );
}

export async function removeFollower(deps: Deps, channelId: string, id: string) {
  const gone = await deps.db
    .delete(federationFollowers)
    .where(and(eq(federationFollowers.channelId, channelId), eq(federationFollowers.id, id)))
    .returning({ id: federationFollowers.id });
  if (gone.length === 0) throw notFound("Follower not found");
  return { ok: true as const };
}
