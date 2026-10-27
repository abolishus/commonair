// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The daily coverage sweep (ADR 0019 decision 5; feature-wins §6 target: 100%): allowlisted audit
 * rows older than 5 minutes that should have a statement and have none. It uses the builder's own
 * selection (`pendingAuditRows`: the allowlist, `expectsStatement`, no statement for the row), so
 * a CSAM-list T0 match, an NCII request decided `rejected` or an NCII action that restricted
 * nothing is never counted. Exports `sor_missing_statements` and logs audit ids (never addresses)
 * at error level when it is not zero.
 */
import type { WorkerContext } from "../context.ts";
import { moderationMetrics } from "./metrics.ts";
import { pendingAuditRows } from "./sor-build.ts";

export const COVERAGE_GRACE_MS = 5 * 60_000;
/** Ids logged per run; the count is exact either way. */
const LOGGED_IDS = 100;

export interface CoverageResult {
  missing: number;
  byAction: Record<string, number>;
}

export async function sorCoverage(
  ctx: Pick<WorkerContext, "db" | "logger" | "now">,
  opts: { batch?: number } = {},
): Promise<CoverageResult> {
  const batch = opts.batch ?? 1000;
  const olderThan = new Date(ctx.now().getTime() - COVERAGE_GRACE_MS);
  const byAction: Record<string, number> = {};
  const ids: string[] = [];
  let missing = 0;
  let after: { createdAt: Date; id: string } | undefined;
  for (;;) {
    const rows = await pendingAuditRows(ctx.db, { limit: batch, olderThan, ...(after ? { after } : {}) });
    for (const r of rows) {
      missing += 1;
      byAction[r.action] = (byAction[r.action] ?? 0) + 1;
      if (ids.length < LOGGED_IDS) ids.push(r.id);
    }
    const last = rows.at(-1);
    if (!last || rows.length < batch) break;
    after = { createdAt: last.createdAt, id: last.id };
  }
  moderationMetrics.sorMissing.record(missing);
  if (missing > 0) {
    moderationMetrics.alerts.add(1, { alert: "sor_coverage" });
    ctx.logger.error("enforcement actions without a statement of reasons", {
      alert: "sor_coverage",
      missing,
      byAction,
      auditIds: ids,
    });
  }
  return { missing, byAction };
}
