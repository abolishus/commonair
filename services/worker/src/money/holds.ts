// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Hold release: creator shares older than `payout.rules.holdDays` move from `creator-hold` to
 * `creator` (available). The rules are read per run, so a governance change applies at the next
 * tick; `releaseDueHolds` is idempotent per payment, so overlapping or repeated runs are safe.
 */
import { loadMoneySettings, releaseDueHolds, type ReleaseResult } from "@commonair/ledger";
import type { WorkerContext } from "../context.ts";
import { moneyMetrics } from "./metrics.ts";

export async function releaseHolds(ctx: WorkerContext): Promise<ReleaseResult & { holdDays: number }> {
  const { payoutRules } = await loadMoneySettings(ctx.db);
  const r = await releaseDueHolds(ctx.db, {
    asOf: ctx.now(),
    holdDays: payoutRules.holdDays,
    currency: payoutRules.currency,
  });
  if (r.totalCents > 0) moneyMetrics.released.add(r.totalCents, { currency: payoutRules.currency });
  // Counts only: which creators were paid out of the hold is the ledger's business, not the log's.
  if (r.released > 0) ctx.logger.info("released creator holds", { released: r.released, totalCents: r.totalCents });
  return { ...r, holdDays: payoutRules.holdDays };
}
