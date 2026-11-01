// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Studio federation settings and remote followers (ADR 0030 decisions 1, 4 and 6).
 *
 * - Turning federation on creates the actor row and its RSA-2048 key the first time (private key
 *   encrypted), and sets `channels.federation_settings.enabled` and `federation_actors.enabled`
 *   together.
 * - Turning it off keeps the key and stops delivery: the actor answers 410 from then on, and the
 *   actor `Delete` is queued to every follower inbox (deliver jobs; the worker signs and sends).
 *   The follower rows go in the same transaction, because a remote server drops the follow when
 *   it gets that `Delete`, and the rows hold remote people's handles (decision 6).
 * - Followers are listed to the owner (handle and server) and removable; removal deletes the row.
 */
import { AS2_CONTEXT, AS2_PUBLIC } from "@commonair/federation";
import { ChannelFederationSettings } from "@commonair/contracts/shapes";
import { schema, uuidv7 } from "@commonair/db";
import { and, count, desc, eq, lt, or } from "drizzle-orm";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { decodeCursor, encodeCursor, isKeyCursor, pageOf } from "../lib/cursor.ts";
import { iso } from "../lib/dto.ts";
import { apiError, notFound } from "../lib/errors.ts";
import { actorUrl, handleOf, keyIdOf, suspendedSql } from "./ids.ts";
import { newActorKey } from "./keys.ts";
import { federationQueue } from "./queue.ts";

const { channels, federationActors, federationFollowers, users } = schema;

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

/** The actor `Delete` sent when a channel stops federating (one per distinct inbox). */
export function actorDeleteActivity(actor: string, id: string) {
  return {
    "@context": AS2_CONTEXT,
    id: `${actor}#delete-${id}`,
    type: "Delete",
    actor,
    object: actor,
    to: [AS2_PUBLIC],
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
      await audit(tx, {
        actorType: "user",
        actorId: userId,
        action: "federation.channel.enable",
        subjectType: "channel",
        subjectId: channel.id,
        channelId: channel.id,
      });
    });
  } else {
    const inboxes = await deps.db.transaction(async (tx) => {
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
      const off = await tx
        .update(federationActors)
        .set({ enabled: false, updatedAt: deps.now() })
        .where(and(eq(federationActors.channelId, channel.id), eq(federationActors.enabled, true)))
        .returning({ id: federationActors.channelId });
      const followers = await tx
        .delete(federationFollowers)
        .where(eq(federationFollowers.channelId, channel.id))
        .returning({ inbox: federationFollowers.inbox, sharedInbox: federationFollowers.sharedInbox });
      if (was || off.length > 0)
        await audit(tx, {
          actorType: "user",
          actorId: userId,
          action: "federation.channel.disable",
          subjectType: "channel",
          subjectId: channel.id,
          channelId: channel.id,
          details: { followersDropped: followers.length },
        });
      return off.length > 0 ? [...new Set(followers.map((f) => f.sharedInbox ?? f.inbox))] : [];
    });
    if (inboxes.length > 0) {
      const deleteId = uuidv7(deps.now().getTime());
      const activity = actorDeleteActivity(actor, deleteId);
      for (const [i, inbox] of inboxes.entries())
        await federationQueue(deps)
          .deliver({ channelId: channel.id, inbox, objectId: null, activity, attempt: 1 }, `${deleteId}-${i}`)
          .catch((err: unknown) =>
            deps.logger.error("federation delete enqueue failed", { channelId: channel.id, err: (err as Error).name }),
          );
    }
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
          ? or(
              lt(federationFollowers.createdAt, new Date(cursor.t)),
              and(eq(federationFollowers.createdAt, new Date(cursor.t)), lt(federationFollowers.id, cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(federationFollowers.createdAt), desc(federationFollowers.id))
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
