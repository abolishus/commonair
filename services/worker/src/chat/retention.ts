// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Chat retention (ADR 0012 amendment 1 decision 6). A message is deleted when it is older than
 * `CHAT_REPLAY_MAX_DAYS`, or older than `CHAT_RETENTION_DAYS` and its broadcast has no VOD that
 * still exists. A message whose author is under an unreleased legal hold is never deleted. A filed
 * report keeps the reported body as its own evidence, so nothing else needs to change.
 */
import { chatEnv, loadEnv } from "@commonair/config";
import { legalHoldLockKey } from "@commonair/db";
import { sql, type SQL } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";

export interface ChatRetentionConfig {
  /** Chat with no live VOD (VOD off, deleted, removed, or sent offline) is kept this many days. */
  retentionDays: number;
  /** Chat is never kept longer than this, VOD or not. */
  maxDays: number;
}

export interface ChatRetentionOptions {
  /** Rows per delete statement (one transaction each). */
  batchSize?: number;
  /** Time budget of one run; the rest waits for the next tick. At least one batch always runs. */
  budgetMs?: number;
}

export const CHAT_RETENTION_BATCH = 5_000;
export const CHAT_RETENTION_BUDGET_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

let cached: ChatRetentionConfig | undefined;

/** The worker's chat env (validated at startup as part of `workerEnv`), read once per process. */
export function chatRetentionConfigFromEnv(source?: Record<string, string | undefined>): ChatRetentionConfig {
  if (!source && cached) return cached;
  const env = loadEnv(chatEnv, source ?? process.env);
  const cfg = { retentionDays: env.CHAT_RETENTION_DAYS, maxDays: env.CHAT_REPLAY_MAX_DAYS };
  if (!source) cached = cfg;
  return cfg;
}

const tsz = (d: Date): SQL => sql`${d.toISOString()}::timestamptz`;

/** True while the message's author has an unreleased legal hold (the `ownerHeld` pattern, by author). */
const authorHeld = sql`exists (select 1 from legal_holds h where h.user_id = m.user_id and h.released_at is null)`;

/** The broadcast has a VOD that still exists: not deleted and not removed (by its owner, a takedown or retention). */
const vodAlive = sql`exists (select 1 from vods v
                              where v.broadcast_id = m.broadcast_id
                                and v.status <> 'deleted'
                                and v.removed_reason is null)`;

/** Messages the rule deletes, held or not. */
function due(now: Date, cfg: ChatRetentionConfig): SQL {
  const maxCutoff = new Date(now.getTime() - cfg.maxDays * DAY_MS);
  const retentionCutoff = new Date(now.getTime() - cfg.retentionDays * DAY_MS);
  return sql`(m.created_at < ${tsz(maxCutoff)}
              or (m.created_at < ${tsz(retentionCutoff)} and (m.broadcast_id is null or not ${vodAlive})))`;
}

interface Candidate {
  id: string;
  user_id: string;
}

/** One batch: pick, lock the authors' hold keys, re-check holds, delete. Returns rows deleted and rows found held at the re-check. */
async function deleteBatch(
  ctx: WorkerContext,
  where: SQL,
  batchSize: number,
): Promise<{ picked: number; deleted: number; heldLate: number }> {
  return ctx.db.transaction(async (tx) => {
    const picked = (await tx.execute(sql`
      select m.id, m.user_id
        from chat_messages m
       where ${where} and not ${authorHeld}
       order by m.created_at
       limit ${batchSize}`)) as unknown as Candidate[];
    if (picked.length === 0) return { picked: 0, deleted: 0, heldLate: 0 };
    // Placing a hold takes the same per-user lock (`lockLegalHold`): after these, a hold either
    // committed already (the re-check below sees it) or waits until this batch is gone. Sorted, so
    // two lockers never take the same keys in opposite orders.
    const keys = [...new Set(picked.map((c) => c.user_id))].map(legalHoldLockKey).sort();
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(k, 0))
        from (select k from unnest(array[${sql.join(
          keys.map((k) => sql`${k}`),
          sql`, `,
        )}]::text[]) as k order by k) s`);
    const removed = (await tx.execute(sql`
      delete from chat_messages m
       where m.id in ${picked.map((c) => c.id)}
         and not ${authorHeld}
       returning m.id`)) as unknown as { id: string }[];
    return { picked: picked.length, deleted: removed.length, heldLate: picked.length - removed.length };
  });
}

/**
 * Delete chat past its retention window, in batches, until nothing is due or the budget is spent.
 * `held` counts the due rows skipped because their author is under a legal hold.
 */
export async function enforceChatRetention(
  ctx: WorkerContext,
  cfg: ChatRetentionConfig = chatRetentionConfigFromEnv(),
  opts: ChatRetentionOptions = {},
): Promise<{ deleted: number; held: number }> {
  const batchSize = opts.batchSize ?? CHAT_RETENTION_BATCH;
  const budgetMs = opts.budgetMs ?? CHAT_RETENTION_BUDGET_MS;
  const now = ctx.now();
  const started = Date.now();
  const where = due(now, cfg);
  const [heldRow] = (await ctx.db.execute(sql`
    select count(*)::int as n from chat_messages m where ${where} and ${authorHeld}`)) as unknown as { n: number }[];
  let held = Number(heldRow?.n ?? 0);
  let deleted = 0;
  for (;;) {
    const r = await deleteBatch(ctx, where, batchSize);
    deleted += r.deleted;
    held += r.heldLate;
    if (r.picked < batchSize) break;
    if (Date.now() - started >= budgetMs) {
      ctx.logger.info("chat retention stopped at its time budget; the next run continues", { deleted, budgetMs });
      break;
    }
  }
  if (deleted > 0 || held > 0) ctx.logger.info("chat retention", { deleted, held });
  return { deleted, held };
}
