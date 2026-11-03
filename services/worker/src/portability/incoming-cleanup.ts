// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Failed and abandoned import archives (batch 8 decision (i)). A bundle import uploads its archive
 * to `incoming/portability/<channel>/<id>.zip` (`services/api/src/portability/imports.ts`), and a
 * successful apply deletes it. This daily sweep deletes the rest:
 *
 * - the archive of an import that `failed`, or that was `previewed` and left for more than
 *   `ABANDONED_AFTER_MS` (24 h), then clears its `archive_key`. A `done` import whose own delete
 *   failed (the apply ignores that error) is tidied the same way;
 * - an object under the prefix that no import names, once it is older than 24 h: an upload still
 *   in flight has no row yet, so a fresh one is never touched.
 *
 * An abandoned preview that loses its archive is marked `failed` (`archive_missing`) in the same
 * transaction, so it can no longer be started into a job that would fail for want of the archive.
 *
 * A `queued` or `running` import is never touched. Each row is locked while its archive goes, so an
 * import cannot start from it at the same moment. When the storage delete fails the key is kept and
 * the next run tries again.
 */
import { schema, type Executor } from "@commonair/db";
import { INCOMING_PREFIX } from "@commonair/moderation";
import { and, eq, inArray, isNotNull, lt, or } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import { emit } from "../moderation/records.ts";

const { portabilityImports: imports } = schema;

export const INCOMING_PORTABILITY_PREFIX = `${INCOMING_PREFIX}portability/`;
/** A preview left this long is abandoned, and an unclaimed upload this old is an orphan. */
export const ABANDONED_AFTER_MS = 24 * 3_600_000;

export interface IncomingCleanupResult {
  /** Archives of failed, abandoned or finished imports deleted (and their keys cleared). */
  deleted: number;
  /** Objects under the prefix that no import names, deleted. */
  orphans: number;
  /** Deletes that failed; the key stays for the next run. */
  failed: number;
  /** Set when object storage is not configured. */
  skipped?: number;
}

/** The rows whose archive may go: never `queued` or `running`. */
const cleanable = (cutoff: Date) =>
  and(
    isNotNull(imports.archiveKey),
    or(
      inArray(imports.status, ["failed", "done"]),
      and(eq(imports.status, "previewed"), lt(imports.createdAt, cutoff)),
    ),
  );

export async function cleanIncomingArchives(ctx: WorkerContext, batch = 500): Promise<IncomingCleanupResult> {
  const storage = ctx.storage;
  if (!storage) return { deleted: 0, orphans: 0, failed: 0, skipped: 1 };
  const now = ctx.now();
  const cutoff = new Date(now.getTime() - ABANDONED_AFTER_MS);
  const out: IncomingCleanupResult = { deleted: 0, orphans: 0, failed: 0 };

  const due = await ctx.db
    .select({ id: imports.id })
    .from(imports)
    .where(cleanable(cutoff))
    .orderBy(imports.createdAt)
    .limit(batch);
  for (const { id } of due) {
    const outcome = await ctx.db.transaction(async (tx) => {
      // Re-checked under the row lock: an import started since the select is left alone.
      const [row] = await tx
        .select({ key: imports.archiveKey, status: imports.status })
        .from(imports)
        .where(and(eq(imports.id, id), cleanable(cutoff)))
        .for("update");
      if (!row?.key) return "gone" as const;
      try {
        await storage.delete(ctx.mediaBucket, row.key);
      } catch {
        return "failed" as const;
      }
      if (row.status === "previewed") {
        await tx
          .update(imports)
          .set({
            archiveKey: null,
            status: "failed",
            finishedAt: now,
            updatedAt: now,
            result: [{ kind: "channel", ref: "channel", label: "", outcome: "rejected", reason: "archive_missing" }],
          })
          .where(eq(imports.id, id));
        await emit(tx, "portability.import.finished", null, { import_id: id }, now);
      } else await tx.update(imports).set({ archiveKey: null, updatedAt: now }).where(eq(imports.id, id));
      return "deleted" as const;
    });
    if (outcome === "deleted") out.deleted++;
    else if (outcome === "failed") out.failed++;
  }

  out.orphans = await deleteOrphans(ctx, storage, cutoff, out);
  if (out.deleted + out.orphans + out.failed > 0) ctx.logger.info("portability incoming cleanup", { ...out });
  if (out.failed > 0) ctx.logger.warn("portability incoming cleanup: deletes failed", { failed: out.failed });
  return out;
}

/** Objects older than the cutoff that no import row names. */
async function deleteOrphans(
  ctx: WorkerContext,
  storage: NonNullable<WorkerContext["storage"]>,
  cutoff: Date,
  out: IncomingCleanupResult,
): Promise<number> {
  let deleted = 0;
  let page: string[] = [];
  const flush = async () => {
    if (page.length === 0) return;
    const named = await namedKeys(ctx.db, page);
    for (const key of page) {
      if (named.has(key)) continue;
      try {
        await storage.delete(ctx.mediaBucket, key);
        deleted++;
      } catch {
        out.failed++;
      }
    }
    page = [];
  };
  for await (const o of storage.list(ctx.mediaBucket, INCOMING_PORTABILITY_PREFIX)) {
    if (o.lastModified.getTime() >= cutoff.getTime()) continue;
    page.push(o.key);
    if (page.length >= 200) await flush();
  }
  await flush();
  return deleted;
}

async function namedKeys(db: Executor, keys: readonly string[]): Promise<Set<string>> {
  const rows = await db
    .select({ key: imports.archiveKey })
    .from(imports)
    .where(inArray(imports.archiveKey, [...keys]));
  return new Set(rows.flatMap((r) => (r.key ? [r.key] : [])));
}
