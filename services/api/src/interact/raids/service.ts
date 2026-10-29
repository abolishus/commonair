// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Raids (ADR 0026 decision 4): start, cancel, current state and the raid policy. Every refusal is
 * decided inside one transaction that holds the source channel's row lock, so two starts of one
 * channel serialize; the `raids_from_pending_uq` index is the backstop. The `raid` control frame is
 * published on the source's chat control after commit. Owned by E8-raids-goals.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { RAID_RULES } from "@commonair/contracts/enums";
import { schema, type Executor } from "@commonair/db";
import {
  RAID_REFUSALS,
  cooldownSecondsLeft,
  raidCooldownEndsAt,
  raidFrame,
  raidStartRefusal,
  toRaidView,
  type RaidPolicy,
} from "@commonair/interact";
import type { Deps } from "../../deps.ts";
import { audit } from "../../events/audit.ts";
import { publishControl } from "../../lib/control.ts";
import { apiError, badRequest, conflict, isUniqueViolation, notFound, precondition } from "../../lib/errors.ts";

const { channels, follows, raids } = schema;

type ChannelRow = typeof channels.$inferSelect;
type RaidRow = typeof raids.$inferSelect;
type RaidViewDto = ReturnType<typeof toRaidView>;

const pendingConflict = () => conflict("This channel already has a raid counting down");

const REFUSAL_MESSAGES: Record<string, string> = {
  [RAID_REFUSALS.sourceOffline]: "You can only raid while you are live",
  [RAID_REFUSALS.targetOffline]: "The channel you want to raid is not live",
  [RAID_REFUSALS.suspended]: "A suspended channel cannot raid or be raided",
  [RAID_REFUSALS.refused]: "That channel does not accept raids from you",
};

/** When the source's last raid ended (executed or canceled), the start of its cooldown. */
async function lastRaidEnd(tx: Executor, sourceId: string): Promise<Date | null> {
  const [row] = await tx
    .select({
      endedAt: sql<Date | null>`max(coalesce(${raids.executedAt}, ${raids.canceledAt}))`.mapWith(raids.executedAt),
    })
    .from(raids)
    .where(eq(raids.fromChannelId, sourceId));
  return row?.endedAt ?? null;
}

async function ownerFollows(tx: Executor, ownerId: string, channelId: string): Promise<boolean> {
  const [row] = await tx
    .select({ one: sql<number>`1` })
    .from(follows)
    .where(and(eq(follows.followerId, ownerId), eq(follows.channelId, channelId), sql`${follows.excludedAt} is null`))
    .limit(1);
  return row !== undefined;
}

async function channelById(tx: Executor, id: string): Promise<ChannelRow | null> {
  const [c] = await tx.select().from(channels).where(eq(channels.id, id)).limit(1);
  return c ?? null;
}

async function viewOf(tx: Executor, r: RaidRow, source: ChannelRow): Promise<RaidViewDto> {
  const target = await channelById(tx, r.toChannelId);
  // The FK cascades, so the target exists while the raid row does.
  if (!target) throw new Error("raid target vanished");
  return toRaidView(r, source, target);
}

export async function startRaid(deps: Deps, source: ChannelRow, actorId: string, toSlug: string): Promise<RaidViewDto> {
  if (toSlug === source.slug) throw badRequest("A channel cannot raid itself");
  const now = deps.now();
  let result: { raid: RaidRow; source: ChannelRow; target: ChannelRow };
  try {
    result = await deps.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(channels).where(eq(channels.id, source.id)).for("update");
      if (!locked) throw notFound("Channel not found");
      const [target] = await tx.select().from(channels).where(eq(channels.slug, toSlug)).limit(1);
      if (!target) throw notFound("Channel not found");
      if (target.id === locked.id) throw badRequest("A channel cannot raid itself");

      const refusal = raidStartRefusal({
        source: locked,
        target,
        targetOwnerFollowsSource:
          target.raidPolicy === "followed" ? await ownerFollows(tx, target.ownerId, locked.id) : false,
        lastEndedAt: await lastRaidEnd(tx, locked.id),
        now,
      });
      if (refusal) {
        if (refusal.cooldownEndsAt) {
          const s = cooldownSecondsLeft(refusal.cooldownEndsAt, now);
          throw precondition(refusal.code, `You can raid again in ${s} seconds`);
        }
        throw precondition(refusal.code, REFUSAL_MESSAGES[refusal.code]);
      }

      const [pending] = await tx
        .select({ id: raids.id })
        .from(raids)
        .where(and(eq(raids.fromChannelId, locked.id), eq(raids.status, "pending")))
        .limit(1);
      if (pending) throw pendingConflict();

      const [raid] = await tx
        .insert(raids)
        .values({
          fromChannelId: locked.id,
          toChannelId: target.id,
          status: "pending",
          createdById: actorId,
          createdAt: now,
          executeAt: new Date(now.getTime() + RAID_RULES.countdownSeconds * 1000),
        })
        .returning();
      if (!raid) throw new Error("raid insert returned no row");
      await audit(tx, {
        actorType: "user",
        actorId,
        action: "raid.start",
        subjectType: "raid",
        subjectId: raid.id,
        channelId: locked.id,
        details: { toChannelId: target.id },
      });
      return { raid, source: locked, target };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw pendingConflict();
    throw err;
  }
  await publishControl(deps, result.source.id, raidFrame(result.raid, result.source, result.target));
  return toRaidView(result.raid, result.source, result.target);
}

export async function cancelRaid(deps: Deps, source: ChannelRow, actorId: string): Promise<void> {
  const now = deps.now();
  const done = await deps.db.transaction(async (tx) => {
    // Guarded on `pending`: a raid the job is executing right now is locked, and once it commits
    // this update matches nothing.
    const [raid] = await tx
      .update(raids)
      .set({ status: "canceled", cancelReason: "owner", canceledAt: now })
      .where(and(eq(raids.fromChannelId, source.id), eq(raids.status, "pending")))
      .returning();
    if (!raid) return null;
    await audit(tx, {
      actorType: "user",
      actorId,
      action: "raid.cancel",
      subjectType: "raid",
      subjectId: raid.id,
      channelId: source.id,
      details: { reason: "owner" },
    });
    const target = await channelById(tx, raid.toChannelId);
    if (!target) throw new Error("raid target vanished");
    return { raid, target };
  });
  if (!done) throw notFound("No raid is counting down");
  await publishControl(deps, source.id, raidFrame(done.raid, source, done.target));
}

export async function raidState(deps: Deps, sourceId: string) {
  const db = deps.db;
  const source = await channelById(db, sourceId);
  if (!source) throw notFound("Channel not found");
  const [pending] = await db
    .select()
    .from(raids)
    .where(and(eq(raids.fromChannelId, source.id), eq(raids.status, "pending")))
    .limit(1);
  const [last] = pending
    ? [pending]
    : await db
        .select()
        .from(raids)
        .where(eq(raids.fromChannelId, source.id))
        .orderBy(desc(raids.createdAt), desc(raids.id))
        .limit(1);
  const cooldown = raidCooldownEndsAt(await lastRaidEnd(db, source.id), deps.now());
  return {
    raid: last ? await viewOf(db, last, source) : null,
    cooldownEndsAt: cooldown ? cooldown.toISOString() : null,
    policy: source.raidPolicy,
  };
}

export async function setRaidPolicy(deps: Deps, channel: ChannelRow, actorId: string, policy: RaidPolicy) {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .update(channels)
      .set({ raidPolicy: policy })
      .where(eq(channels.id, channel.id))
      .returning({ id: channels.id });
    if (!row) throw apiError("NOT_FOUND", "Channel not found");
    await audit(tx, {
      actorType: "user",
      actorId,
      action: "raid.policy",
      subjectType: "channel",
      subjectId: channel.id,
      channelId: channel.id,
      details: { policy },
    });
  });
  return raidState(deps, channel.id);
}
