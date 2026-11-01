// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The import preview (ADR 0037 decision 5), run by the worker because the issuer's keys are
 * fetched here, never by the API. `portability.imports.preview` creates the row (status
 * `previewed`, `preview.state = "pending"`, the uploaded `archive_key`), enqueues the import job and
 * waits for this to finish, then answers from the row.
 *
 * It reads the archive (`readBundleArchive`: version, shape, caps, hashes, safe names), checks the
 * importer (legal hold, suspended channel) and the standing statement (`checkStanding`), and stores
 * public data only: the channel fields, one line per item with its default choice, the standing
 * summary, and the archive's SHA-256 (the apply step refuses an archive replaced since). A refusal
 * sets `status = failed` and `preview.state = "refused"` with a stable code.
 */
import type { PortabilityBundle } from "@commonair/contracts/portability";
import { schema } from "@commonair/db";
import { and, eq } from "drizzle-orm";
import type { WorkerContext } from "../../context.ts";
import { emit } from "../../moderation/records.ts";
import { readBundleArchive, sha256Hex } from "../archive.ts";
import { issuerOrigin } from "../standing.ts";
import { importerRefusal, type StoredItem } from "./apply.ts";
import type { FetchKeysOptions } from "./issuer-keys.ts";
import {
  checkStanding,
  refusesImport,
  standingVerifiedColumn,
  type StandingCheck,
  type StandingCheckDeps,
} from "./standing-check.ts";

const { portabilityImports: imports, emotes } = schema;

/** What `preview` holds. Public data only. */
export interface StoredPreview {
  state: "pending" | "ready" | "refused";
  refusal?: string;
  archiveSha256?: string;
  channel?: Record<string, unknown>;
  items?: StoredItem[];
  standing?: Record<string, unknown>;
}

export interface PreviewOptions {
  fetch?: FetchKeysOptions;
  fetchKeys?: StandingCheckDeps["fetchKeys"];
}

/** The preview's lines: one per item, `outcome` null (chosen at start), a known skip as `reason`. */
export function previewItems(bundle: PortabilityBundle, existingCodes: ReadonlySet<string>): StoredItem[] {
  const items: StoredItem[] = [
    { kind: "channel", ref: "channel", label: bundle.channel.title, outcome: null, reason: null },
  ];
  for (const [i, p] of bundle.panels.entries())
    items.push({ kind: "panel", ref: String(i + 1), label: p.title, outcome: null, reason: null });
  for (const e of bundle.emotes)
    items.push({
      kind: "emote",
      ref: e.code,
      label: e.code,
      outcome: existingCodes.has(e.code) ? "skipped" : null,
      reason: existingCodes.has(e.code) ? "code_taken" : null,
    });
  if (bundle.schedule.length > 0)
    items.push({
      kind: "schedule",
      ref: "schedule",
      label: String(bundle.schedule.length),
      outcome: "skipped",
      reason: "carried_not_applied",
    });
  return items;
}

/** The standing summary shown in the preview (counts and flags only). */
export function standingSummary(check: StandingCheck): Record<string, unknown> {
  if (check.state === "missing") return { state: "missing" };
  if (check.state === "unverified") return { state: "unverified", reason: check.reason };
  const s = check.statement;
  return {
    state: "verified",
    issuer: check.issuer,
    issuedAt: s.issuedAt,
    expiresAt: s.expiresAt,
    activeSuspension: s.activeSuspension,
    legalHold: s.legalHold,
    upheldActions: s.upheldActions,
    dmcaStrikes: s.dmcaStrikes,
  };
}

/** Fail a `previewed` import with a stable code (also used for a preview that cannot run). */
export async function refuse(
  ctx: WorkerContext,
  importId: string,
  refusal: string,
  extra: Partial<typeof imports.$inferInsert> = {},
) {
  const now = ctx.now();
  await ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .update(imports)
      .set({
        status: "failed",
        preview: { state: "refused", refusal },
        // The reason also rides in the result, so `imports.get` shows why.
        result: [{ kind: "channel", ref: "channel", label: "", outcome: "rejected", reason: refusal }],
        finishedAt: now,
        updatedAt: now,
        ...extra,
      })
      .where(and(eq(imports.id, importId), eq(imports.status, "previewed")))
      .returning({ id: imports.id });
    if (row) await emit(tx, "portability.import.finished", null, { import_id: importId }, now);
  });
  ctx.logger.info("portability import refused at preview", { importId, refusal });
  return { refused: 1 };
}

/** Run the preview of one `previewed` import whose preview is still pending. */
export async function runPreview(
  ctx: WorkerContext,
  importId: string,
  opts: PreviewOptions = {},
): Promise<Record<string, number>> {
  const [row] = await ctx.db.select().from(imports).where(eq(imports.id, importId));
  if (!row || row.status !== "previewed" || (row.preview as unknown as StoredPreview).state !== "pending")
    return { skipped: 1 };
  if (!ctx.storage) throw new Error("object storage is not configured");
  if (!ctx.site) throw new Error("an import preview needs the instance site (WorkerContext.site)");
  if (!row.archiveKey) return refuse(ctx, importId, "archive_missing");
  const res = await ctx.storage.get(ctx.mediaBucket, row.archiveKey);
  if (!res) return refuse(ctx, importId, "archive_missing");
  const bytes = new Uint8Array(await res.arrayBuffer());
  const read = await readBundleArchive(bytes);
  if (!read.ok) return refuse(ctx, importId, `bundle_${read.error}`);
  // Only CommonAir bundles come through an upload; a Twitch import is N3's own path. A hand-edited
  // `source` would otherwise preview, then be skipped by the apply and stay queued forever.
  if (read.bundle.source !== "commonair") return refuse(ctx, importId, "bundle_source");

  const gate = await importerRefusal(ctx.db, row.userId, row.channelId);
  if (gate) return refuse(ctx, importId, gate);

  const check = await checkStanding(read.bundle, {
    db: ctx.db,
    ownOrigin: issuerOrigin(ctx.site.publicUrl),
    fetch: opts.fetch ?? { allowInsecure: ctx.webhooks.allowInsecure },
    ...(opts.fetchKeys ? { fetchKeys: opts.fetchKeys } : {}),
    now: ctx.now(),
  });
  const standingColumns = {
    source: read.bundle.source,
    standingVerified: standingVerifiedColumn(read.bundle.source, check),
    standingIssuer: check.state === "verified" ? check.issuer : null,
  };
  const refusal = refusesImport(check);
  if (refusal) return refuse(ctx, importId, refusal, standingColumns);

  const existing = await ctx.db.select({ code: emotes.code }).from(emotes).where(eq(emotes.channelId, row.channelId));
  const c = read.bundle.channel;
  const preview: StoredPreview = {
    state: "ready",
    archiveSha256: await sha256Hex(bytes),
    channel: {
      title: c.title,
      description: c.description,
      tags: c.tags,
      language: c.language,
      mature: c.mature,
      categorySlug: c.categorySlug,
      categoryName: c.categoryName,
      panels: read.bundle.panels.length,
      emotes: read.bundle.emotes.length,
      instance: read.bundle.instance.domain,
      exportedAt: read.bundle.exportedAt,
    },
    items: previewItems(read.bundle, new Set(existing.map((e) => e.code))),
    standing: standingSummary(check),
  };
  await ctx.db
    .update(imports)
    .set({ ...standingColumns, preview: preview as unknown as Record<string, unknown>, updatedAt: ctx.now() })
    .where(and(eq(imports.id, importId), eq(imports.status, "previewed")));
  ctx.logger.info("portability import previewed", {
    importId,
    standing: check.state,
    items: preview.items?.length ?? 0,
  });
  return { previewed: 1 };
}
