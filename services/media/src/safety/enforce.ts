// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Records hash-match checks and, on a match, acts at once: the channel is suspended and audited
 * in one transaction, the publisher is kicked off MediaMTX (which ends the broadcast through the
 * normal not-ready hook) and local work for the broadcast stops. The matched image is never
 * written anywhere and never logged; callers drop their copy.
 */
import { and, eq, isNull } from "drizzle-orm";
import { schema, type Database } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import type { MediaMtxClient } from "../mediamtx.ts";
import type { HashCheckContext, HashMatcher } from "./hashmatch.ts";

export const SUSPEND_REASON = "csam_hash_match";

export interface EnforcerDeps {
  db: Database;
  mtx: MediaMtxClient;
  matcher: HashMatcher;
  logger: Logger;
  /** Stop local workers for a broadcast (transcode, simulcast, recording, thumbnails). */
  stopBroadcast: (broadcastId: string) => Promise<void>;
}

export interface CheckTarget extends HashCheckContext {
  /** Live broadcast to end on a match, if any. */
  broadcastId?: string | null;
  /** MediaMTX path to kick on a match, if live. */
  path?: string | null;
}

export class HashMatchEnforcer {
  constructor(private readonly deps: EnforcerDeps) {}

  /** Check an image; returns true when it matched (the caller must then discard it). */
  async check(image: Uint8Array, target: CheckTarget): Promise<boolean> {
    const { matcher, logger } = this.deps;
    const ctx: HashCheckContext = {
      subjectType: target.subjectType,
      subjectId: target.subjectId,
      channelId: target.channelId,
    };
    const result = await matcher.check(image, ctx);
    if (!matcher.records && !result.matched) return false;
    const resultId = await this.record(target, result.matched, result.details);
    if (!result.matched) return false;
    logger.error("hash match: channel suspended", {
      provider: matcher.name,
      subjectType: target.subjectType,
      subjectId: target.subjectId,
      channelId: target.channelId,
      hashMatchResultId: resultId,
    });
    if (target.path) {
      try {
        await this.deps.mtx.kickPublisher(target.path);
      } catch (err) {
        // The suspension stands even if MediaMTX is unreachable: the auth hook refuses the
        // suspended channel on the next connect, and reconcile stops local work.
        logger.error("hash match: could not kick publisher", { err, path: target.path });
      }
    }
    // Not awaited: the caller is usually one of the broadcast's own workers, and stopping the
    // broadcast waits for that worker to finish.
    if (target.broadcastId)
      void this.deps.stopBroadcast(target.broadcastId).catch((err: unknown) => {
        logger.error("hash match: could not stop broadcast workers", { err, broadcastId: target.broadcastId });
      });
    return true;
  }

  private async record(target: CheckTarget, matched: boolean, details: Record<string, unknown>): Promise<string> {
    const { db, matcher } = this.deps;
    return db.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.hashMatchResults)
        .values({
          subjectType: target.subjectType,
          subjectId: target.subjectId,
          provider: matcher.name,
          matched,
          details,
        })
        .returning({ id: schema.hashMatchResults.id });
      if (!row) throw new Error("hash_match_results insert returned no row");
      if (!matched) return row.id;
      const now = new Date();
      await tx
        .update(schema.channels)
        .set({ suspendedAt: now, suspendedReason: SUSPEND_REASON })
        .where(and(eq(schema.channels.id, target.channelId), isNull(schema.channels.suspendedAt)));
      await tx.insert(schema.auditLog).values({
        actorType: "system",
        actorId: null,
        action: "channel.suspend",
        subjectType: "channel",
        subjectId: target.channelId,
        channelId: target.channelId,
        reason: SUSPEND_REASON,
        details: {
          provider: matcher.name,
          hashMatchResultId: row.id,
          matchSubjectType: target.subjectType,
          matchSubjectId: target.subjectId,
          broadcastId: target.broadcastId ?? null,
        },
      });
      return row.id;
    });
  }
}
