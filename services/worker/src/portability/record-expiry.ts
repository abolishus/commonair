// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Twitch import data expires (batch 8 decision (j); not reviewed by counsel, none retained). A
 * Twitch import keeps the public Twitch data it read, the Twitch user name included, in `preview`
 * and `result`. `IMPORT_RECORD_RETENTION_DAYS` after the import finished, this daily job sets
 * `preview = '{}'` and `result = null`. The row keeps its status, source, times and the emote
 * assertion fields, so the audit trail stands. Each run writes one `audit_log` row with a count
 * and no names.
 *
 * Bundle imports (`source = commonair`) hold no third-party data and are left alone. An import still
 * `queued` or `running` past the retention has no `finished_at`: it is skipped with a warning.
 */
import { schema, uuidv7 } from "@commonair/db";
import { and, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import { audit } from "../moderation/records.ts";

const { portabilityImports: imports } = schema;

export const IMPORT_RECORD_RETENTION_DAYS = 30;

export interface RecordExpiryResult {
  /** Imports whose Twitch data was cleared this run. */
  cleared: number;
  /** Imports still queued or running past the retention (skipped, logged). */
  stuck: number;
}

export async function expireImportRecords(ctx: WorkerContext): Promise<RecordExpiryResult> {
  const now = ctx.now();
  const cutoff = new Date(now.getTime() - IMPORT_RECORD_RETENTION_DAYS * 86_400_000);
  const twitch = eq(imports.source, "twitch");

  const [stuckRow] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(imports)
    .where(and(twitch, inArray(imports.status, ["queued", "running"]), lte(imports.createdAt, cutoff)));
  const stuck = stuckRow?.n ?? 0;
  if (stuck > 0) ctx.logger.warn("import record expiry: imports still running past retention", { stuck });

  const cleared = await ctx.db.transaction(async (tx) => {
    const rows = await tx
      .update(imports)
      .set({ preview: {}, result: null, updatedAt: now })
      .where(
        and(
          twitch,
          inArray(imports.status, ["done", "failed"]),
          isNotNull(imports.finishedAt),
          lte(imports.finishedAt, cutoff),
          or(sql`${imports.preview} <> '{}'::jsonb`, isNotNull(imports.result)),
        ),
      )
      .returning({ id: imports.id });
    // One row per run, the count only (zero included), so the audit shows the job ran.
    await audit(
      tx,
      {
        action: "portability.import.expire",
        subjectType: "job_run",
        subjectId: uuidv7(now.getTime()),
        details: { source: "twitch", cleared: rows.length, stuck, retentionDays: IMPORT_RECORD_RETENTION_DAYS },
      },
      now,
    );
    return rows.length;
  });
  if (cleared > 0) ctx.logger.info("import record expiry", { cleared });
  return { cleared, stuck };
}
