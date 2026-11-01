// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The portability importer. `applyBundle` (see `apply.ts` for its contract) is the entry point N3's
 * Twitch import shares; `runImportJob` is what `PORTABILITY_JOBS.import` runs for an uploaded
 * CommonAir bundle: the preview while the row waits for one, else the apply.
 */
import { ImportChoices as ImportChoicesSchema } from "@commonair/contracts/dto";
import { schema } from "@commonair/db";
import { and, eq, inArray } from "drizzle-orm";
import type { WorkerContext } from "../../context.ts";
import { emit } from "../../moderation/records.ts";
import { readBundleArchive, sha256Hex } from "../archive.ts";
import { applyBundle, type ApplyBundleOptions } from "./apply.ts";
import { type PreviewOptions, runPreview, type StoredPreview } from "./preview.ts";

export {
  applyBundle,
  importerRefusal,
  sniffImageType,
  type ApplyBundleInput,
  type ApplyBundleOptions,
  type ApplyBundleResult,
  type ImportChoices,
  type StoredItem,
} from "./apply.ts";
export { runPreview, previewItems, standingSummary, type StoredPreview } from "./preview.ts";
export { checkStanding, refusesImport, standingVerifiedColumn, type StandingCheck } from "./standing-check.ts";
export { channelPatch, mapCategory, matureAfterImport, normalizeTags, MAX_EMOTES } from "./rules.ts";

const { portabilityImports: imports } = schema;

export interface ImportJobOptions extends PreviewOptions, ApplyBundleOptions {
  /** True on the job's last attempt: a failure then fails the import instead of retrying. */
  lastAttempt?: boolean;
}

async function failImport(ctx: WorkerContext, importId: string, reason: string) {
  await ctx.db.transaction(async (tx) => {
    const now = ctx.now();
    const [row] = await tx
      .update(imports)
      .set({
        status: "failed",
        finishedAt: now,
        updatedAt: now,
        result: [{ kind: "channel", ref: "channel", label: "", outcome: "rejected", reason }],
      })
      .where(and(eq(imports.id, importId), inArray(imports.status, ["queued", "running"])))
      .returning({ id: imports.id });
    if (row) await emit(tx, "portability.import.finished", null, { import_id: importId }, now);
  });
  ctx.logger.warn("portability import failed", { importId, reason });
  return { failed: 1 };
}

/** `PORTABILITY_JOBS.import` for one import id. */
export async function runImportJob(
  ctx: WorkerContext,
  importId: string,
  opts: ImportJobOptions = {},
): Promise<Record<string, number>> {
  const [row] = await ctx.db.select().from(imports).where(eq(imports.id, importId));
  if (!row || row.source !== "commonair") return { skipped: 1 };
  if (row.status === "previewed") return runPreview(ctx, importId, opts);
  if (row.status !== "queued" && row.status !== "running") return { skipped: 1 };
  try {
    const preview = row.preview as unknown as StoredPreview;
    if (!ctx.storage) throw new Error("object storage is not configured");
    const res = row.archiveKey ? await ctx.storage.get(ctx.mediaBucket, row.archiveKey) : null;
    if (!res) return failImport(ctx, importId, "archive_missing");
    const bytes = new Uint8Array(await res.arrayBuffer());
    // The archive previewed is the archive applied: a replaced upload is refused.
    if (!preview.archiveSha256 || (await sha256Hex(bytes)) !== preview.archiveSha256)
      return failImport(ctx, importId, "archive_changed");
    const read = await readBundleArchive(bytes);
    if (!read.ok) return failImport(ctx, importId, `bundle_${read.error}`);
    const choices = ImportChoicesSchema.parse(row.choices ?? { channel: false, panels: false, emotes: [] });
    const out = await applyBundle(
      ctx,
      { importId, bundle: read.bundle, files: read.files, choices },
      opts.commitUpload ? { commitUpload: opts.commitUpload } : {},
    );
    if (out.ok) {
      // The archive is no longer needed once applied.
      await ctx.storage.delete(ctx.mediaBucket, row.archiveKey ?? "").catch(() => {});
      return { applied: 1, items: out.items.length };
    }
    return { failed: 1 };
  } catch (err) {
    if (opts.lastAttempt) return failImport(ctx, importId, "import_failed");
    throw err;
  }
}
