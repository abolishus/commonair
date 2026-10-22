// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Data export build and expiry (docs/testing/e6-selectors.md "Data export", ADR 0021).
 *
 * Build: `queued` → `running` (compare-and-set) → every file of the kind collected in one
 * read-only repeatable-read transaction → zip → upload to `exportObjectKey(userId, exportId)` →
 * `ready` with `expires_at = completed_at + EXPORT_TTL_SECONDS` → after commit, mail the link.
 * A failure on the last attempt sets `failed` with a stable code and mails nothing; earlier
 * attempts put the row back to `queued` so the BullMQ retry can claim it again.
 *
 * Neither the address, the object key's signed URL nor the archive's contents are ever logged.
 */
import { EXPORT_TTL_SECONDS, exportObjectKey } from "@commonair/contracts/internal";
import { schema as s } from "@commonair/db";
import { and, asc, eq, inArray, lt } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import { safeErrorCode } from "../moderation/records.ts";
import { buildArchive } from "./archive.ts";
import { collect, type ExportKind } from "./collectors.ts";

/** Stable `data_exports.error` codes (never free text). */
export const EXPORT_ERRORS = {
  userDeleted: "user_deleted",
  noChannel: "no_channel",
  buildFailed: "build_failed",
} as const;

type ExportError = (typeof EXPORT_ERRORS)[keyof typeof EXPORT_ERRORS];

/** Thrown for outcomes no retry can change: the export fails at once. */
class PermanentExportError extends Error {
  constructor(readonly code: ExportError) {
    super(code);
    this.name = "PermanentExportError";
  }
}

const archiveName = (kind: ExportKind, exportId: string) => `export-${kind}-${exportId}.zip`;

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost|.+\.test)$/i;

/**
 * The storage origin export mail may link to: `S3_PUBLIC_ENDPOINT` only (never the internal
 * endpoint), and over https unless it is a local development host. A bearer link to a whole
 * personal-data archive must not travel in cleartext or point at an unreachable address.
 */
export function mailableStorageOrigin(publicEndpoint: string | undefined): string | undefined {
  if (!publicEndpoint) return undefined;
  let url: URL;
  try {
    url = new URL(publicEndpoint);
  } catch {
    return undefined;
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOST.test(url.hostname))) return url.origin;
  return undefined;
}

/**
 * The link mailed to the user: a presigned GET for exactly this export's key, valid until its
 * `expires_at`, on the storage origin the mailer accepts (`storageOrigin`) or the web origin.
 * Otherwise the instance's privacy page, which lists the export with a freshly signed link
 * (`me.exports.list`) after checking the session.
 */
export async function exportDownloadLink(
  ctx: WorkerContext,
  e: { id: string; userId: string; kind: ExportKind; expiresAt: Date },
): Promise<string | null> {
  if (!ctx.site) return null;
  const page = new URL("/settings/privacy", `${ctx.site.publicUrl}/`).toString();
  if (!ctx.storage) return page;
  const seconds = Math.min(EXPORT_TTL_SECONDS, Math.floor((e.expiresAt.getTime() - ctx.now().getTime()) / 1000));
  if (seconds < 1) return null;
  const signed = await ctx.storage.presignGet(ctx.exportsBucket, exportObjectKey(e.userId, e.id), {
    expiresSeconds: seconds,
    filename: archiveName(e.kind, e.id),
  });
  const origin = new URL(signed).origin;
  return origin === new URL(ctx.site.publicUrl).origin || origin === ctx.storageOrigin ? signed : page;
}

async function markFailed(ctx: WorkerContext, exportId: string, code: ExportError) {
  await ctx.db
    .update(s.dataExports)
    .set({ status: "failed", error: code, storageKey: null, sizeBytes: null })
    .where(and(eq(s.dataExports.id, exportId), eq(s.dataExports.status, "running")));
}

export interface BuildOptions {
  /** True on the last BullMQ attempt: a failure then marks the export `failed`. */
  lastAttempt: boolean;
}

/** Build one export. Returns counts only (the job result). */
export async function buildExport(
  ctx: WorkerContext,
  exportId: string,
  opts: BuildOptions,
): Promise<Record<string, number>> {
  const e = s.dataExports;
  const [row] = await ctx.db
    .update(e)
    .set({ status: "running", error: null })
    .where(and(eq(e.id, exportId), eq(e.status, "queued")))
    .returning({ id: e.id, userId: e.userId, kind: e.kind });
  // Not queued (already built, failed, expired, or deleted with the account): nothing to do.
  if (!row) return { skipped: 1 };
  const key = exportObjectKey(row.userId, row.id);
  let uploaded = false;
  try {
    const [user] = await ctx.db
      .select({ deletedAt: s.users.deletedAt, pseudonymizedAt: s.users.pseudonymizedAt })
      .from(s.users)
      .where(eq(s.users.id, row.userId));
    if (!user || user.deletedAt || user.pseudonymizedAt) throw new PermanentExportError(EXPORT_ERRORS.userDeleted);
    const [channel] = await ctx.db
      .select({ id: s.channels.id })
      .from(s.channels)
      .where(eq(s.channels.ownerId, row.userId));
    if (row.kind === "channel" && !channel) throw new PermanentExportError(EXPORT_ERRORS.noChannel);
    if (!ctx.storage) throw new Error("object storage is not configured");

    const scope = { userId: row.userId, channelId: channel?.id ?? null };
    // One snapshot for every file, so the archive is consistent with itself.
    const files = await ctx.db.transaction((tx) => collect(tx, row.kind, scope), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
    const { bytes } = buildArchive({
      kind: row.kind,
      exportId: row.id,
      userId: row.userId,
      generatedAt: ctx.now(),
      files,
    });
    await ctx.storage.put(ctx.exportsBucket, key, Buffer.from(bytes), { contentType: "application/zip" });
    uploaded = true;

    const completedAt = ctx.now();
    const expiresAt = new Date(completedAt.getTime() + EXPORT_TTL_SECONDS * 1000);
    const [done] = await ctx.db
      .update(e)
      .set({ status: "ready", storageKey: key, sizeBytes: bytes.byteLength, completedAt, expiresAt, error: null })
      .where(and(eq(e.id, row.id), eq(e.status, "running")))
      .returning({ id: e.id });
    if (!done) {
      // The row went away meanwhile (the account was deleted): leave no archive behind.
      await ctx.storage.delete(ctx.exportsBucket, key);
      return { skipped: 1 };
    }
    const emailed = await mailReady(ctx, { id: row.id, userId: row.userId, kind: row.kind, expiresAt });
    ctx.logger.info("data export ready", { exportId: row.id, kind: row.kind, sizeBytes: bytes.byteLength });
    return { built: 1, emailed: emailed ? 1 : 0, sizeBytes: bytes.byteLength };
  } catch (err) {
    const permanent = err instanceof PermanentExportError;
    const errorCode = permanent ? err.code : safeErrorCode(err);
    if (uploaded) await ctx.storage?.delete(ctx.exportsBucket, key).catch(() => {});
    if (permanent || opts.lastAttempt) {
      await markFailed(ctx, row.id, permanent ? err.code : EXPORT_ERRORS.buildFailed);
      ctx.logger.warn("data export failed", { exportId: row.id, kind: row.kind, errorCode });
      return { failed: 1 };
    }
    // Hand the row back so the retry can claim it.
    await ctx.db
      .update(e)
      .set({ status: "queued" })
      .where(and(eq(e.id, row.id), eq(e.status, "running")));
    ctx.logger.warn("data export attempt failed; retrying", { exportId: row.id, kind: row.kind, errorCode });
    throw err;
  }
}

/** Mail the ready export to the user's current address. Never fails the build. */
async function mailReady(
  ctx: WorkerContext,
  e: { id: string; userId: string; kind: ExportKind; expiresAt: Date },
): Promise<boolean> {
  if (!ctx.mailer) return false;
  try {
    const [user] = await ctx.db
      .select({ email: s.users.email, locale: s.users.locale })
      .from(s.users)
      .where(eq(s.users.id, e.userId));
    const downloadUrl = await exportDownloadLink(ctx, e);
    if (!user || !downloadUrl) return false;
    await ctx.mailer.send("dataExportReady", { downloadUrl, expiresAt: e.expiresAt, locale: user.locale }, user.email);
    return true;
  } catch (err) {
    ctx.logger.warn("data export mail failed", { exportId: e.id, errorCode: safeErrorCode(err) });
    return false;
  }
}

/**
 * A `running` export older than this was abandoned: its worker died after the claim (OOM,
 * SIGKILL) and BullMQ's re-delivery cannot claim it again (the claim is `queued` → `running`).
 * There is no claim timestamp, so the row's age is used, with room for a long queue backlog.
 */
export const STALE_RUNNING_MS = 6 * 3_600_000;

/**
 * `ready` exports past `expires_at`: delete the archive, then mark the export `expired` and
 * forget its key. Abandoned `running` builds (`STALE_RUNNING_MS`) are marked `failed`
 * (`build_failed`) and lose any archive they uploaded. Only an export's own key is ever deleted
 * (whatever `storage_key` says).
 */
export async function cleanupExports(
  ctx: WorkerContext,
  { batch = 100, sweepPrefix = "exports/" }: { batch?: number; sweepPrefix?: string } = {},
): Promise<Record<string, number>> {
  const e = s.dataExports;
  if (!ctx.storage) {
    ctx.logger.warn("export cleanup skipped: object storage is not configured");
    return { expired: 0, failed: 0, orphans: 0, abandoned: 0 };
  }
  const abandoned = await ctx.db
    .update(e)
    .set({ status: "failed", error: EXPORT_ERRORS.buildFailed, storageKey: null, sizeBytes: null })
    .where(and(eq(e.status, "running"), lt(e.createdAt, new Date(ctx.now().getTime() - STALE_RUNNING_MS))))
    .returning({ id: e.id, userId: e.userId, kind: e.kind });
  const due = await ctx.db
    .select({ id: e.id, userId: e.userId })
    .from(e)
    .where(and(eq(e.status, "ready"), lt(e.expiresAt, ctx.now())))
    .orderBy(asc(e.expiresAt))
    .limit(batch);
  let expired = 0;
  let failed = 0;
  for (const x of abandoned) {
    ctx.logger.warn("data export abandoned while running; marked failed", { exportId: x.id, kind: x.kind });
    try {
      await ctx.storage.delete(ctx.exportsBucket, exportObjectKey(x.userId, x.id));
    } catch (err) {
      // The orphan sweep below (or the next run's) deletes it: the row is no longer live.
      failed++;
      ctx.logger.error("export cleanup: abandoned archive deletion failed", {
        exportId: x.id,
        errorCode: safeErrorCode(err),
      });
    }
  }
  for (const x of due) {
    try {
      await ctx.storage.delete(ctx.exportsBucket, exportObjectKey(x.userId, x.id));
      const changed = await ctx.db
        .update(e)
        .set({ status: "expired", storageKey: null })
        .where(and(eq(e.id, x.id), eq(e.status, "ready")))
        .returning({ id: e.id });
      expired += changed.length;
    } catch (err) {
      failed++;
      ctx.logger.error("export cleanup: archive deletion failed", { exportId: x.id, errorCode: safeErrorCode(err) });
    }
  }
  const orphans = await sweepOrphans(ctx, sweepPrefix).catch((err: unknown) => {
    failed++;
    ctx.logger.error("export cleanup: orphan sweep failed", { errorCode: safeErrorCode(err) });
    return 0;
  });
  return { expired, failed, orphans, abandoned: abandoned.length };
}

const ARCHIVE_KEY = /^exports\/([0-9a-f-]{36})\/([0-9a-f-]{36})\.zip$/;

/**
 * Archives with no live export row (an account deletion whose after-commit delete failed, or a
 * crash between upload and failure): deleted, so no signed link outlives its row. Builds in
 * flight keep theirs (`queued`/`running` rows still exist).
 */
async function sweepOrphans(ctx: WorkerContext, prefix: string): Promise<number> {
  const storage = ctx.storage;
  if (!storage) return 0;
  const e = s.dataExports;
  let deleted = 0;
  for await (const obj of storage.list(ctx.exportsBucket, prefix)) {
    const m = ARCHIVE_KEY.exec(obj.key);
    const exportId = m?.[2];
    if (!m || !exportId) continue;
    const [live] = await ctx.db
      .select({ id: e.id })
      .from(e)
      .where(and(eq(e.id, exportId), eq(e.userId, m[1] ?? ""), inArray(e.status, ["queued", "running", "ready"])));
    if (live) continue;
    await storage.delete(ctx.exportsBucket, obj.key);
    deleted++;
  }
  return deleted;
}
