// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Records hash-match checks and acts on a match. The order matters: first the stream is cut
 * (publisher kicked off MediaMTX, local workers stopped without publishing a VOD), and only then
 * is the match written (result row, channel suspension, audit row in one transaction) with
 * retries, so a database outage can never keep a matched stream on air. Everything derived from
 * the broadcast is then quarantined (see quarantine.ts). The matched image itself is never
 * stored and never logged; callers drop their copy.
 */
import { and, eq, isNull } from "drizzle-orm";
import { schema, type Database } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import type { ObjectStorage } from "@commonair/storage";
import type { MediaMtxClient } from "../mediamtx.ts";
import type { HashCheckContext, HashMatcher } from "./hashmatch.ts";
import { CSAM_REASON, quarantineBroadcast } from "./quarantine.ts";

export const SUSPEND_REASON = CSAM_REASON;

export interface EnforcerDeps {
  db: Database;
  storage: ObjectStorage;
  bucket: string;
  mtx: Pick<MediaMtxClient, "kickPublisher">;
  matcher: HashMatcher;
  logger: Logger;
  /** Stop local workers for a broadcast without finalizing its VOD. */
  stopBroadcast: (broadcastId: string) => Promise<void>;
  /** Retry policy for the post-match writes (tests shorten it). */
  retry?: { attempts: number; initialMs: number; maxMs: number };
}

export interface CheckTarget extends HashCheckContext {
  /** Live broadcast to end on a match, if any. */
  broadcastId?: string | null;
  /** MediaMTX path to kick on a match, if live. */
  path?: string | null;
}

/** Run `fn` until it succeeds or attempts run out (exponential backoff). */
export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: { attempts: number; initialMs: number; maxMs: number },
  onError: (err: unknown, attempt: number) => void,
): Promise<T> {
  let delay = policy.initialMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      onError(err, attempt);
      if (attempt >= policy.attempts) throw err;
      await Bun.sleep(delay);
      delay = Math.min(policy.maxMs, delay * 2);
    }
  }
}

const DEFAULT_RETRY = { attempts: 10, initialMs: 500, maxMs: 30_000 };

export class HashMatchEnforcer {
  /** Broadcasts with a match in this process, known before the database write lands. */
  private readonly tainted = new Set<string>();
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly deps: EnforcerDeps) {}

  isTainted(broadcastId: string): boolean {
    return this.tainted.has(broadcastId);
  }

  /** Wait for in-flight post-match work (shutdown, tests). */
  async settle(): Promise<void> {
    await Promise.allSettled(this.pending);
  }

  /** Check an image; returns true when it matched (the caller must then discard it). */
  async check(image: Uint8Array, target: CheckTarget): Promise<boolean> {
    const { matcher } = this.deps;
    const result = await matcher.check(image, {
      subjectType: target.subjectType,
      subjectId: target.subjectId,
      channelId: target.channelId,
    });
    if (!result.matched) {
      if (matcher.records) await this.record(target, false, result.details);
      return false;
    }
    if (target.broadcastId) this.tainted.add(target.broadcastId);
    // 1. Cut the stream before anything else can fail.
    await this.kick(target);
    // 2–4 run detached: the caller is often one of the broadcast's own workers, and stopping the
    // broadcast waits for that worker to return.
    const work = this.afterMatch(target, result.details).finally(() => this.pending.delete(work));
    this.pending.add(work);
    return true;
  }

  private async kick(target: CheckTarget): Promise<void> {
    if (!target.path) return;
    const path = target.path;
    await withRetry(
      () => this.deps.mtx.kickPublisher(path),
      { attempts: 3, initialMs: 200, maxMs: 1000 },
      (err, attempt) => this.deps.logger.error("hash match: kick failed", { err, attempt, path }),
    ).catch(() => {
      // The suspension below still stands: the auth hook refuses the channel on reconnect and
      // reconcile stops local work.
    });
  }

  private async afterMatch(target: CheckTarget, details: Record<string, unknown>): Promise<void> {
    const { logger } = this.deps;
    const policy = this.deps.retry ?? DEFAULT_RETRY;
    const log = (what: string) => (err: unknown, attempt: number) =>
      logger.error(`hash match: ${what} failed`, { err, attempt, channelId: target.channelId });
    try {
      if (target.broadcastId) await this.deps.stopBroadcast(target.broadcastId);
      const resultId = await withRetry(() => this.record(target, true, details), policy, log("record"));
      logger.error("hash match: channel suspended", {
        provider: this.deps.matcher.name,
        subjectType: target.subjectType,
        subjectId: target.subjectId,
        channelId: target.channelId,
        hashMatchResultId: resultId,
      });
      const broadcastId = target.broadcastId;
      if (broadcastId) await withRetry(() => quarantineBroadcast(this.deps, broadcastId), policy, log("quarantine"));
    } catch (err) {
      logger.fatal("hash match: enforcement incomplete, operator action required", {
        err,
        channelId: target.channelId,
      });
    }
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
      await tx
        .update(schema.channels)
        .set({ suspendedAt: new Date(), suspendedReason: SUSPEND_REASON })
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
