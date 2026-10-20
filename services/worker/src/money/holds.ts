// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Hold release: creator shares older than `payout.rules.holdDays` move from `creator-hold` to
 * `creator` (available). The rules are read per run, so a governance change applies at the next
 * tick; `releaseDueHolds` is idempotent per payment, so overlapping or repeated runs are safe.
 */
import { loadMoneySettings, releaseDueHolds, type ReleaseResult } from "@commonair/ledger";
import type { WorkerContext } from "../context.ts";
import { moneyConfig } from "./config.ts";
import { moneyMetrics } from "./metrics.ts";
import { runBatches } from "./time.ts";

/** Payments one `releaseDueHolds` call may release (each is its own small transaction). */
export const HOLD_RELEASE_LIMIT = 500;

export interface HoldReleaseOptions {
  limit?: number;
  budgetMs?: number;
  clock?: () => number;
}

export async function releaseHolds(
  ctx: WorkerContext,
  opts: HoldReleaseOptions = {},
): Promise<ReleaseResult & { holdDays: number; batches: number; exhausted: boolean }> {
  const { payoutRules } = await loadMoneySettings(ctx.db);
  const asOf = ctx.now();
  let released = 0;
  let totalCents = 0;
  // A call that released its full limit may have left more due lots: drain the backlog this run.
  const loop = await runBatches(
    {
      batchSize: opts.limit ?? HOLD_RELEASE_LIMIT,
      budgetMs: opts.budgetMs ?? moneyConfig(ctx).budgetMs,
      clock: opts.clock,
    },
    async (limit) => {
      const r = await releaseDueHolds(ctx.db, {
        asOf,
        holdDays: payoutRules.holdDays,
        currency: payoutRules.currency,
        limit,
      });
      released += r.released;
      totalCents += r.totalCents;
      return r.released;
    },
  );
  if (totalCents > 0) moneyMetrics.released.add(totalCents, { currency: payoutRules.currency });
  // Counts only: which creators were paid out of the hold is the ledger's business, not the log's.
  if (released > 0 || loop.exhausted) ctx.logger.info("released creator holds", { released, totalCents, ...loop });
  return { released, totalCents, holdDays: payoutRules.holdDays, batches: loop.batches, exhausted: loop.exhausted };
}
