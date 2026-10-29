// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `raids-execute` (ADR 0026 decision 4): every raid whose countdown ended is executed or canceled in
 * its own transaction. Due raids are claimed `FOR UPDATE SKIP LOCKED`, so overlapping runs (and the
 * owner's cancel) never act on the same raid twice. Everything is re-checked at execute: the
 * target's policy may have changed, either side may have gone offline or been suspended. An executed
 * raid carries the source's gate-eligible viewers at that moment, capped by `raidIntegrity`, and
 * writes `channel.raid` on the target. The `raid` frame goes to the source's room after commit.
 */
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { ChatControlMessage } from "@commonair/contracts/chat";
import { BUS } from "@commonair/contracts/events";
import { schema, type Executor } from "@commonair/db";
import {
  emitEvent,
  raidEventPayload,
  raidExecuteCancelReason,
  raidFrame,
  raidViewerCount,
  raidViewersQuery,
} from "@commonair/interact";
import type { WorkerContext } from "../../context.ts";

const { channels, follows, raids } = schema;

/** At most this many raids per run; the next run (2 s later) takes the rest. */
export const RAIDS_PER_RUN = 100;

export interface RaidsExecuteResult {
  executed: number;
  canceled: number;
}

type Outcome = { frame: ChatControlMessage; sourceId: string; executed: boolean } | null;

async function ownerFollows(tx: Executor, ownerId: string, channelId: string): Promise<boolean> {
  const [row] = await tx
    .select({ one: sql<number>`1` })
    .from(follows)
    .where(and(eq(follows.followerId, ownerId), eq(follows.channelId, channelId), sql`${follows.excludedAt} is null`))
    .limit(1);
  return row !== undefined;
}

/** Claim and settle one due raid: `"none"` when none is left to claim, null when it vanished. */
async function settleOne(ctx: WorkerContext, now: Date): Promise<Outcome | "none"> {
  return ctx.db.transaction(async (tx) => {
    const [raid] = await tx
      .select()
      .from(raids)
      .where(and(eq(raids.status, "pending"), lte(raids.executeAt, now)))
      .orderBy(asc(raids.executeAt), asc(raids.id))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!raid) return "none";
    const [source] = await tx.select().from(channels).where(eq(channels.id, raid.fromChannelId));
    const [target] = await tx.select().from(channels).where(eq(channels.id, raid.toChannelId));
    // Both FKs cascade: a raid row never outlives either channel.
    if (!source || !target) return null;

    const reason = raidExecuteCancelReason({
      source,
      target,
      targetOwnerFollowsSource:
        target.raidPolicy === "followed" ? await ownerFollows(tx, target.ownerId, source.id) : false,
    });
    if (reason) {
      const [canceled] = await tx
        .update(raids)
        .set({ status: "canceled", cancelReason: reason, canceledAt: now })
        .where(eq(raids.id, raid.id))
        .returning();
      if (!canceled) return null;
      return { frame: raidFrame(canceled, source, target), sourceId: source.id, executed: false };
    }

    const [counts] = (await tx.execute(raidViewersQuery(source.id, now))) as unknown as {
      live: number;
      verified: number;
    }[];
    const viewers = raidViewerCount(Number(counts?.live ?? 0), Number(counts?.verified ?? 0));
    const [done] = await tx
      .update(raids)
      .set({ status: "completed", executedAt: now, viewerCount: viewers })
      .where(eq(raids.id, raid.id))
      .returning();
    if (!done) return null;
    await emitEvent(tx, "channel.raid", target.id, raidEventPayload(source, target, viewers), now);
    return { frame: raidFrame(done, source, target), sourceId: source.id, executed: true };
  });
}

async function publishFrame(ctx: WorkerContext, sourceId: string, frame: ChatControlMessage): Promise<void> {
  try {
    await ctx.valkey.publish(BUS.chatControl(sourceId), JSON.stringify(ChatControlMessage.parse(frame)));
  } catch (err) {
    // The raid row is the truth; the studio and the player see it on their next read.
    ctx.logger.warn("raid frame publish failed", { channelId: sourceId, err });
  }
}

export async function executeDueRaids(ctx: WorkerContext, limit = RAIDS_PER_RUN): Promise<RaidsExecuteResult> {
  const result: RaidsExecuteResult = { executed: 0, canceled: 0 };
  const now = ctx.now();
  for (let i = 0; i < limit; i++) {
    const outcome = await settleOne(ctx, now);
    if (outcome === "none") break;
    // Unreachable (the row is locked and both FKs cascade), but retrying would claim the same raid
    // again: stop this run instead of spinning on it.
    if (!outcome) break;
    if (outcome.executed) result.executed++;
    else result.canceled++;
    await publishFrame(ctx, outcome.sourceId, outcome.frame);
  }
  return result;
}
