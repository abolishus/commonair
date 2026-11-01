// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `raids-execute` (ADR 0026 decision 4): every raid whose countdown ended is executed or canceled in
 * its own transaction. Due raids are claimed `FOR UPDATE SKIP LOCKED`, so overlapping runs (and the
 * owner's cancel) never act on the same raid twice. Everything is re-checked at execute: the
 * target's policy may have changed, either side may have gone offline or been suspended. An executed
 * raid carries the source's gate-eligible viewers at that moment, capped by `raidIntegrity`, and
 * writes `channel.raid` on the target. The `raid` frame goes to the source's room after commit.
 *
 * Surge raids (batch 7 decision (w), ADR 0039 §4): when the target has the surge guard on with
 * "Protect raids" (`surgeGuard.onRaid`) and the instance runs the guard, the same transaction opens
 * or extends the target's surge (`chat-gate/raid.ts`, a savepoint: outbox and audit rows, then the
 * override compare-and-set). After the commit the raiders who were verified watchers of the source
 * carry that standing to the target, then the begin marker and the `surge` frame. A failure there
 * never blocks the raid: chat fails open, as the gate does when Valkey is unreadable.
 */
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { ChatControlMessage } from "@commonair/contracts/chat";
import { BUS } from "@commonair/contracts/events";
import { ChannelChatSettings } from "@commonair/contracts/shapes";
import { schema, type Executor } from "@commonair/db";
import {
  emitEvent,
  raidEventPayload,
  raidExecuteCancelReason,
  raidFrame,
  raidOpensSurge,
  raidViewerCount,
  raidViewersQuery,
} from "@commonair/interact";
import { type ChatGateConfig, chatGateConfig } from "../../chat-gate/config.ts";
import {
  applyRaidSurge,
  carryRaiders,
  decideRaidSurge,
  RaidSurgeConflict,
  type RaidSurgeOverride,
} from "../../chat-gate/raid.ts";
import { readOverride, SURGE_OPEN_TTL_SECONDS, surgeOpenKey } from "../../chat-gate/state.ts";
import { publish as publishSurge } from "../../chat-gate/surge.ts";
import type { WorkerContext } from "../../context.ts";
import { safeErrorCode } from "../../moderation/records.ts";

const { channels, follows, raids } = schema;

/** At most this many raids per run; the next run (2 s later) takes the rest. */
export const RAIDS_PER_RUN = 100;

export interface RaidsExecuteResult {
  executed: number;
  canceled: number;
}

/** What the raid did to the target's surge, for the work after the commit. */
interface SurgeOutcome {
  target: { id: string; slug: string; liveBroadcastId: string; minVerifiedWatchSeconds: number };
  source: { id: string; liveBroadcastId: string };
  /** The override now stored (surge mode on until `next.until`). */
  next: RaidSurgeOverride;
  /** A begin was recorded: set the begin-without-end marker. */
  began: boolean;
}

type Outcome = { frame: ChatControlMessage; sourceId: string; executed: boolean; surge: SurgeOutcome | null } | null;

/** Compare-and-set attempts before the raid goes ahead without a surge (moderators acting at once). */
const SURGE_ATTEMPTS = 3;

async function ownerFollows(tx: Executor, ownerId: string, channelId: string): Promise<boolean> {
  const [row] = await tx
    .select({ one: sql<number>`1` })
    .from(follows)
    .where(and(eq(follows.followerId, ownerId), eq(follows.channelId, channelId), sql`${follows.excludedAt} is null`))
    .limit(1);
  return row !== undefined;
}

/** Claim and settle one due raid: `"none"` when none is left to claim, null when it vanished. */
/**
 * Open or extend the target's surge inside the raid's transaction (a savepoint per attempt). Null
 * when the target is not protected, a moderator's suppression wins, or it failed (logged).
 */
async function raidSurge(
  ctx: WorkerContext,
  tx: Executor,
  cfg: ChatGateConfig,
  p: {
    raidId: string;
    viewers: number;
    source: typeof schema.channels.$inferSelect;
    target: typeof schema.channels.$inferSelect;
    now: Date;
  },
): Promise<SurgeOutcome | null> {
  const parsed = ChannelChatSettings.safeParse(p.target.chatSettings ?? {});
  const settings = parsed.success ? parsed.data : ChannelChatSettings.parse({});
  if (!raidOpensSurge(cfg.surgeGuard, settings.surgeGuard)) return null;
  // Both are live: the re-checks above cancel a raid otherwise.
  if (!p.target.liveBroadcastId || !p.source.liveBroadcastId) return null;
  const raid = { fromChannel: p.source.slug, verifiedCount: p.viewers };
  for (let attempt = 1; attempt <= SURGE_ATTEMPTS; attempt++) {
    try {
      const done = await tx.transaction(async (sp) => {
        const stored = await readOverride(ctx.valkey, p.target.id);
        const open = (await ctx.valkey.exists(surgeOpenKey(p.target.id))) === 1;
        const actions = decideRaidSurge({ now: p.now, current: stored.value, open, raid });
        const next = await applyRaidSurge(sp, ctx.valkey, stored, actions, {
          raidId: p.raidId,
          targetId: p.target.id,
          sourceId: p.source.id,
          now: p.now,
        });
        return next ? { next, began: actions.some((a) => a.kind === "begin") } : null;
      });
      if (!done) return null;
      return {
        target: {
          id: p.target.id,
          slug: p.target.slug,
          liveBroadcastId: p.target.liveBroadcastId,
          minVerifiedWatchSeconds: settings.minVerifiedWatchSeconds,
        },
        source: { id: p.source.id, liveBroadcastId: p.source.liveBroadcastId },
        ...done,
      };
    } catch (err) {
      if (err instanceof RaidSurgeConflict && attempt < SURGE_ATTEMPTS) continue;
      ctx.logger.warn("raid surge failed; the raid goes ahead without it", {
        channelId: p.target.id,
        errorCode: safeErrorCode(err),
      });
      return null;
    }
  }
  return null;
}

/** After the commit: the carry first (raiders arrive with the frame), then the marker and the `surge` frame. */
async function afterRaidSurge(ctx: WorkerContext, cfg: ChatGateConfig, s: SurgeOutcome, now: Date): Promise<number> {
  let carried = 0;
  try {
    carried = await carryRaiders(ctx, {
      sourceId: s.source.id,
      sourceBroadcastId: s.source.liveBroadcastId,
      targetId: s.target.id,
      targetBroadcastId: s.target.liveBroadcastId,
      targetMinVerifiedWatchSeconds: s.target.minVerifiedWatchSeconds,
      surgeUntil: new Date(s.next.until),
      now,
      secret: cfg.secret,
    });
  } catch (err) {
    // The raiders then wait for the target's own scoring passes, like anyone new.
    ctx.logger.warn("raid carry failed", { channelId: s.target.id, errorCode: safeErrorCode(err) });
  }
  if (s.began)
    try {
      await ctx.valkey.set(surgeOpenKey(s.target.id), "1", "EX", SURGE_OPEN_TTL_SECONDS);
    } catch (err) {
      ctx.logger.warn("raid surge marker write failed", { channelId: s.target.id, errorCode: safeErrorCode(err) });
    }
  await publishSurge(ctx, s.target, { state: "on", until: s.next.until });
  return carried;
}

async function settleOne(ctx: WorkerContext, now: Date, cfg: ChatGateConfig): Promise<Outcome | "none"> {
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
      return { frame: raidFrame(canceled, source, target), sourceId: source.id, executed: false, surge: null };
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
    const surge = await raidSurge(ctx, tx, cfg, { raidId: raid.id, viewers, source, target, now });
    return { frame: raidFrame(done, source, target), sourceId: source.id, executed: true, surge };
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

export async function executeDueRaids(
  ctx: WorkerContext,
  limit = RAIDS_PER_RUN,
  cfg: ChatGateConfig = chatGateConfig(),
): Promise<RaidsExecuteResult> {
  const result: RaidsExecuteResult = { executed: 0, canceled: 0 };
  const now = ctx.now();
  for (let i = 0; i < limit; i++) {
    const outcome = await settleOne(ctx, now, cfg);
    if (outcome === "none") break;
    // Unreachable (the row is locked and both FKs cascade), but retrying would claim the same raid
    // again: stop this run instead of spinning on it.
    if (!outcome) break;
    if (outcome.executed) result.executed++;
    else result.canceled++;
    if (outcome.surge) await afterRaidSurge(ctx, cfg, outcome.surge, now);
    await publishFrame(ctx, outcome.sourceId, outcome.frame);
  }
  return result;
}
