// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Data exports (docs/testing/e6-selectors.md "Data export", ADR 0021). The API records the request
 * and enqueues the build; the worker builds the archive. A download link is presigned for exactly
 * the export's own object key and never outlives `expires_at`.
 */
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import type { z } from "zod";
import type { dto } from "@commonair/contracts";
import type { EXPORT_KINDS } from "@commonair/contracts/enums";
import { EXPORT_COOLDOWN_SECONDS, EXPORT_TTL_SECONDS, exportObjectKey } from "@commonair/contracts/internal";
import { schema } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { iso, isoOrNull } from "../lib/dto.ts";
import { precondition, rateLimited } from "../lib/errors.ts";
import { lockUser } from "../moderation/deletion.ts";
import { exportQueue } from "./export-queue.ts";

const { channels, dataExports } = schema;
type ExportRow = typeof dataExports.$inferSelect;
export type ExportKind = (typeof EXPORT_KINDS)[number];
type ExportJob = z.infer<typeof dto.ExportJob>;

/** Exports in these states hold the cooldown; a failed one does not, so the user can try again. */
export const COOLDOWN_STATUSES = ["queued", "running", "ready"] as const;

/** Seconds until another export of this kind may be requested (0: allowed now). */
export function exportCooldownRemaining(lastCreatedAt: Date | null, now: Date): number {
  if (!lastCreatedAt) return 0;
  const left = EXPORT_COOLDOWN_SECONDS * 1000 - (now.getTime() - lastCreatedAt.getTime());
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

/**
 * Seconds a link presigned now stays valid: until `expires_at`, never past the SigV4 maximum
 * (which is also the export TTL). 0: no link.
 */
export function downloadLinkSeconds(expiresAt: Date | null, now: Date): number {
  if (!expiresAt) return 0;
  const left = Math.floor((expiresAt.getTime() - now.getTime()) / 1000);
  return left > 0 ? Math.min(left, EXPORT_TTL_SECONDS) : 0;
}

/** `<instance>-<kind>-<YYYY-MM-DD>.zip`, the name the browser saves the archive under. */
export function exportFilename(siteName: string, kind: ExportKind, at: Date): string {
  const name =
    siteName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "export";
  return `${name}-${kind}-${at.toISOString().slice(0, 10)}.zip`;
}

export async function createExport(deps: Deps, userId: string, kind: ExportKind): Promise<ExportJob> {
  const now = deps.now();
  const row = await deps.db.transaction(async (tx) => {
    // Serialize one user's requests so two concurrent ones cannot both pass the cooldown check.
    await lockUser(tx, userId);
    if (kind === "channel") {
      const [own] = await tx.select({ id: channels.id }).from(channels).where(eq(channels.ownerId, userId)).limit(1);
      if (!own) throw precondition("channel_owner", "Only channel owners can export a channel");
    }
    const [last] = await tx
      .select({ createdAt: dataExports.createdAt })
      .from(dataExports)
      .where(
        and(
          eq(dataExports.userId, userId),
          eq(dataExports.kind, kind),
          inArray(dataExports.status, [...COOLDOWN_STATUSES]),
          gt(dataExports.createdAt, new Date(now.getTime() - EXPORT_COOLDOWN_SECONDS * 1000)),
        ),
      )
      .orderBy(desc(dataExports.createdAt))
      .limit(1);
    const wait = exportCooldownRemaining(last?.createdAt ?? null, now);
    if (wait > 0) throw rateLimited(wait);
    const [inserted] = await tx
      .insert(dataExports)
      .values({ userId, kind, status: "queued", createdAt: now })
      .returning();
    if (!inserted) throw new Error("export insert returned no row");
    await audit(tx, {
      actorType: "user",
      actorId: userId,
      action: "export.request",
      subjectType: "data_export",
      subjectId: inserted.id,
      details: { kind },
    });
    return inserted;
  });
  try {
    await exportQueue(deps).enqueue(row.id);
  } catch (err) {
    deps.logger.error("export enqueue failed", { exportId: row.id, err: (err as Error).name });
    // Never leave an export queued forever when the worker will not hear of it; a failed export
    // does not hold the cooldown, so the user can ask again.
    const [failed] = await deps.db
      .update(dataExports)
      .set({ status: "failed", error: "enqueue_failed" })
      .where(and(eq(dataExports.id, row.id), eq(dataExports.status, "queued")))
      .returning();
    return toExportJob(failed ?? row, null);
  }
  return toExportJob(row, null);
}

export function toExportJob(row: ExportRow, downloadUrl: string | null): ExportJob {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    downloadUrl,
    sizeBytes: row.sizeBytes ?? null,
    expiresAt: isoOrNull(row.expiresAt),
    createdAt: iso(row.createdAt),
    completedAt: isoOrNull(row.completedAt),
  };
}

/** A fresh link for a ready, unexpired export whose stored key is exactly its own; else null. */
export async function downloadUrlFor(deps: Deps, row: ExportRow, now: Date): Promise<string | null> {
  if (row.status !== "ready") return null;
  const seconds = downloadLinkSeconds(row.expiresAt, now);
  if (seconds <= 0) return null;
  const key = exportObjectKey(row.userId, row.id);
  if (row.storageKey !== key) {
    // Only the worker writes storage_key; anything else is tampering or a bug. Never sign it.
    deps.logger.error("export storage key mismatch: refusing to sign", { exportId: row.id });
    return null;
  }
  return deps.storage.presignGet(deps.env.S3_BUCKET_EXPORTS, key, {
    expiresSeconds: seconds,
    filename: exportFilename(deps.site.name, row.kind, row.completedAt ?? row.createdAt),
  });
}

export async function listExports(deps: Deps, userId: string): Promise<ExportJob[]> {
  const now = deps.now();
  const rows = await deps.db
    .select()
    .from(dataExports)
    .where(eq(dataExports.userId, userId))
    .orderBy(desc(dataExports.createdAt), desc(dataExports.id))
    .limit(50);
  return Promise.all(
    rows.map(async (r) => {
      // Past its expiry an export reads as expired even before the cleanup job has run.
      const lapsed = r.status === "ready" && downloadLinkSeconds(r.expiresAt, now) === 0;
      return toExportJob(lapsed ? { ...r, status: "expired" } : r, await downloadUrlFor(deps, r, now));
    }),
  );
}
