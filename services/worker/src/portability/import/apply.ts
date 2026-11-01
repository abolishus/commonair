// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `applyBundle`: the one importer (ADR 0037 decision 5, batch 7 decision (j)). The portability
 * import job and N3's Twitch import both call it.
 *
 * ## Contract (for callers, N3 included)
 *
 * `applyBundle(ctx, { importId, bundle, files, choices }, opts?)`
 *
 * - **`importId`** names a `portability_imports` row the caller created for the importing channel
 *   (`channel_id`) and account (`user_id`), in status `queued` or `running`. The row's channel and
 *   user are the only ones written to; nothing in the bundle names a destination.
 * - **`bundle`** is an already parsed `PortabilityBundle` (`parseBundle` or `readBundleArchive`);
 *   **`files`** maps each `files/<name>` it refers to onto bytes the caller already checked
 *   against the manifest. A missing file is reported per item, never thrown.
 * - **`choices`** (`ImportChoices`): whether to apply the channel fields, the panels, and which
 *   emote codes. Everything not chosen is reported `skipped` / `not_chosen`.
 * - The standing statement is **not** checked here: the preview (or N3, whose bundles carry none)
 *   already did. `applyBundle` checks only the importer: an active local legal hold on the account
 *   or a suspended channel fails the import (`importer_legal_hold`, `channel_suspended`).
 *
 * What it does:
 *
 * - **Channel fields** go through the studio edit's rules (`rules.ts`): an import never clears an
 *   existing mature label, and `mature: true` sets it; the category maps by slug, then exact name,
 *   else stays as it is. A `channel.update` event is written in the same transaction.
 * - **Images** are written under `incoming/` and committed through the API's upload pipeline
 *   (`INTERNAL_ROUTES.uploadCommit`: magic bytes, hash lists with the T0 path, classifier). A
 *   refusal skips the item as `rejected` / `upload_rejected`, the same opaque reason a user gets.
 * - **Panels** replace the channel's panels through the `setPanels` rules (only committed images of
 *   the channel; http(s) links; at most 20). A panel whose image is refused is left out.
 * - **Emotes** follow the emote create rules: the code pattern, an existing code is `skipped` /
 *   `code_taken`, at most `MAX_EMOTES` (`emote_limit`), an NCII-revoked key is refused.
 * - **The schedule** is recorded `skipped` / `carried_not_applied`.
 * - It finishes by writing `result`, `status = done`, `finished_at` and the internal
 *   `portability.import.finished` event in one transaction.
 *
 * **Idempotent.** Each item's outcome (and a committed image's key) is saved as it completes, in
 * the transaction that writes the item. A retried call skips what is already saved, so nothing is
 * inserted twice; a `done` import returns its stored result. Transport failures of the upload
 * route (the API down) throw, so the job retries.
 */
import type { ImportItemKind, ImportItemOutcome } from "@commonair/contracts/enums";
import { type UploadCommitBody, type UploadCommitResult } from "@commonair/contracts/internal";
import type { BundleEmote, PortabilityBundle } from "@commonair/contracts/portability";
import { UPLOAD_TYPES } from "@commonair/contracts/shapes";
import { type Database, type Executor, schema, uuidv7 } from "@commonair/db";
import { INCOMING_PREFIX } from "@commonair/moderation";
import type { ObjectStorage } from "@commonair/storage";
import { and, eq, isNull, sql } from "drizzle-orm";
import { commitUpload as commitViaApi } from "../../b7/upload-commit.ts";
import type { WorkerContext } from "../../context.ts";
import { emit } from "../../moderation/records.ts";
import { type CategoryRow, channelPatch, EMOTE_CODE, MAX_EMOTES, MAX_PANELS, mapCategory, panelText } from "./rules.ts";

const { portabilityImports: imports, channels, channelPanels, emotes, categories } = schema;

export interface ImportChoices {
  channel: boolean;
  panels: boolean;
  /** Emote codes to import. */
  emotes: readonly string[];
}

export interface ApplyBundleInput {
  importId: string;
  bundle: PortabilityBundle;
  files: ReadonlyMap<string, Uint8Array>;
  choices: ImportChoices;
}

export interface ApplyBundleOptions {
  /** The upload pipeline; defaults to the API's internal route. Tests may inject the same contract. */
  commitUpload?: (body: UploadCommitBody) => Promise<UploadCommitResult>;
}

/** One stored line of an import's result (`ImportItem` plus the committed key, never served). */
export interface StoredItem {
  kind: ImportItemKind;
  ref: string;
  label: string;
  outcome: ImportItemOutcome | null;
  reason: string | null;
  /** Internal: the committed image key, so a retry reuses it. */
  key?: string;
}

export type ApplyBundleResult =
  | { ok: true; status: "done"; items: StoredItem[] }
  | { ok: false; status: "failed"; reason: "importer_legal_hold" | "channel_suspended" | "not_runnable" };

type Ctx = Pick<WorkerContext, "db" | "logger" | "mediaBucket" | "now"> & { storage?: ObjectStorage };

const itemId = (kind: ImportItemKind, ref: string) => `${kind}:${ref}`;
const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Sniff an image type from its magic bytes (the API checks again). */
export function sniffImageType(bytes: Uint8Array): string | null {
  const at = (i: number, ...b: number[]) => b.every((x, j) => bytes[i + j] === x);
  const ascii = (i: number, s: string) => at(i, ...Array.from(s, (c) => c.charCodeAt(0)));
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  return null;
}

/** The importer gates of decision (o). */
export async function importerRefusal(
  db: Executor,
  userId: string,
  channelId: string,
): Promise<"importer_legal_hold" | "channel_suspended" | null> {
  const [hold] = await db
    .select({ id: schema.legalHolds.id })
    .from(schema.legalHolds)
    .where(and(eq(schema.legalHolds.userId, userId), isNull(schema.legalHolds.releasedAt)))
    .limit(1);
  if (hold) return "importer_legal_hold";
  const [c] = await db
    .select({ suspendedAt: channels.suspendedAt, ownerId: channels.ownerId })
    .from(channels)
    .where(eq(channels.id, channelId));
  if (!c || c.suspendedAt) return "channel_suspended";
  // The owner's own legal hold counts too when an editor imports.
  if (c.ownerId !== userId) {
    const [ownerHold] = await db
      .select({ id: schema.legalHolds.id })
      .from(schema.legalHolds)
      .where(and(eq(schema.legalHolds.userId, c.ownerId), isNull(schema.legalHolds.releasedAt)))
      .limit(1);
    if (ownerHold) return "importer_legal_hold";
  }
  return null;
}

async function saveItem(tx: Executor, importId: string, item: StoredItem, now: Date): Promise<void> {
  // Replace the item's line (if any) and append: one statement, so concurrent writers cannot lose one.
  await tx
    .update(imports)
    .set({
      result: sql`coalesce((select jsonb_agg(e) from jsonb_array_elements(coalesce(${imports.result}, '[]'::jsonb)) e
        where not (e->>'kind' = ${item.kind} and e->>'ref' = ${item.ref})), '[]'::jsonb) || ${JSON.stringify([item])}::jsonb`,
      updatedAt: now,
    })
    .where(eq(imports.id, importId));
}

/** Write the bytes under `incoming/` and run them through the API's upload pipeline. */
async function commitImage(
  ctx: Ctx,
  commit: NonNullable<ApplyBundleOptions["commitUpload"]>,
  who: { channelId: string; userId: string },
  purpose: "panel" | "emote",
  bytes: Uint8Array | undefined,
): Promise<{ ok: true; key: string } | { ok: false; reason: string }> {
  if (!bytes) return { ok: false, reason: "missing_file" };
  const type = sniffImageType(bytes);
  if (!type || !(UPLOAD_TYPES[purpose] as readonly string[]).includes(type))
    return { ok: false, reason: "unsupported_type" };
  if (!ctx.storage) throw new Error("object storage is not configured");
  const key = `${INCOMING_PREFIX}channels/${who.channelId}/${purpose}/${uuidv7()}.${EXT[type]}`;
  await ctx.storage.put(ctx.mediaBucket, key, Buffer.from(bytes), { contentType: type });
  const r = await commit({ channelId: who.channelId, userId: who.userId, key, purpose });
  return r.ok ? { ok: true, key: r.key } : { ok: false, reason: r.code };
}

/** See the module comment. */
export async function applyBundle(
  ctx: Ctx,
  input: ApplyBundleInput,
  opts: ApplyBundleOptions = {},
): Promise<ApplyBundleResult> {
  const commit = opts.commitUpload ?? ((b: UploadCommitBody) => commitViaApi(b));
  const db: Database = ctx.db;
  const [row] = await db.select().from(imports).where(eq(imports.id, input.importId));
  if (!row) return { ok: false, status: "failed", reason: "not_runnable" };
  if (row.status === "done") return { ok: true, status: "done", items: (row.result ?? []) as unknown as StoredItem[] };
  if (row.status !== "queued" && row.status !== "running")
    return { ok: false, status: "failed", reason: "not_runnable" };
  const who = { channelId: row.channelId, userId: row.userId };

  const refusal = await importerRefusal(db, who.userId, who.channelId);
  if (refusal) {
    await finish(ctx, input.importId, "failed", [
      { kind: "channel", ref: "channel", label: "", outcome: "rejected", reason: refusal },
    ]);
    return { ok: false, status: "failed", reason: refusal };
  }
  await db
    .update(imports)
    .set({ status: "running", updatedAt: ctx.now() })
    .where(and(eq(imports.id, input.importId), eq(imports.status, "queued")));

  // Every saved line; one with an outcome is finished, one without holds a committed image key.
  const saved = new Map<string, StoredItem>();
  for (const it of (row.result ?? []) as unknown as StoredItem[]) saved.set(itemId(it.kind, it.ref), it);
  const finished = (kind: ImportItemKind, ref: string) => (saved.get(itemId(kind, ref))?.outcome ?? null) !== null;
  const record = async (item: StoredItem, write?: (tx: Executor) => Promise<void>) => {
    await db.transaction(async (tx) => {
      if (write) await write(tx);
      await saveItem(tx, input.importId, item, ctx.now());
    });
    saved.set(itemId(item.kind, item.ref), item);
  };
  const { bundle, choices } = input;

  // Channel fields.
  if (!finished("channel", "channel")) {
    const label = bundle.channel.title;
    if (!choices.channel)
      await record({ kind: "channel", ref: "channel", label, outcome: "skipped", reason: "not_chosen" });
    else
      await record({ kind: "channel", ref: "channel", label, outcome: "imported", reason: null }, (tx) =>
        applyChannelFields(tx, who.channelId, bundle, ctx.now()),
      );
  }

  // Panels: images first (each committed key saved at once), then one replace through the setPanels rules.
  const panels = bundle.panels.slice(0, MAX_PANELS);
  const panelRef = (i: number) => String(i + 1);
  if (!choices.panels) {
    for (const [i, p] of panels.entries())
      if (!finished("panel", panelRef(i)))
        await record({ kind: "panel", ref: panelRef(i), label: p.title, outcome: "skipped", reason: "not_chosen" });
  } else if (panels.some((_, i) => !finished("panel", panelRef(i)))) {
    const final: StoredItem[] = [];
    for (const [i, p] of panels.entries()) {
      const ref = panelRef(i);
      const base = { kind: "panel" as const, ref, label: p.title };
      const prior = saved.get(itemId("panel", ref));
      if (prior && prior.outcome !== null) final.push(prior);
      else if (!p.image) final.push({ ...base, outcome: "imported", reason: null });
      else if (prior?.key) final.push({ ...base, outcome: "imported", reason: null, key: prior.key });
      else {
        const r = await commitImage(ctx, commit, who, "panel", input.files.get(p.image.file));
        if (r.ok) {
          await record({ ...base, outcome: null, reason: null, key: r.key });
          final.push({ ...base, outcome: "imported", reason: null, key: r.key });
        } else final.push({ ...base, outcome: "rejected", reason: r.reason });
      }
    }
    await db.transaction(async (tx) => {
      const rows: (typeof channelPanels.$inferInsert)[] = [];
      for (const [i, p] of panels.entries()) {
        const item = final[i];
        if (!item || item.outcome !== "imported") continue;
        if (item.key && !(await usableUpload(tx, item.key, who.channelId, "panel"))) {
          final[i] = { ...item, outcome: "rejected", reason: "upload_rejected" };
          continue;
        }
        rows.push({ channelId: who.channelId, position: rows.length, ...panelText(p), imageKey: item.key ?? null });
      }
      await tx.delete(channelPanels).where(eq(channelPanels.channelId, who.channelId));
      if (rows.length) await tx.insert(channelPanels).values(rows);
      for (const item of final) await saveItem(tx, input.importId, item, ctx.now());
    });
    for (const item of final) saved.set(itemId(item.kind, item.ref), item);
  }

  // Emotes.
  const chosen = new Set(choices.emotes);
  for (const e of bundle.emotes) {
    if (finished("emote", e.code)) continue;
    if (!chosen.has(e.code)) {
      await record({ kind: "emote", ref: e.code, label: e.code, outcome: "skipped", reason: "not_chosen" });
      continue;
    }
    await importEmote(ctx, commit, who, input, e, saved.get(itemId("emote", e.code))?.key ?? null, record);
  }

  // The schedule is carried, never applied (decision (b)).
  if (bundle.schedule.length > 0 && !finished("schedule", "schedule"))
    await record({
      kind: "schedule",
      ref: "schedule",
      label: String(bundle.schedule.length),
      outcome: "skipped",
      reason: "carried_not_applied",
    });

  const items = await finish(ctx, input.importId, "done", null);
  ctx.logger.info("portability import applied", {
    importId: input.importId,
    channelId: who.channelId,
    items: items.length,
    imported: items.filter((i) => i.outcome === "imported").length,
  });
  return { ok: true, status: "done", items };
}

async function applyChannelFields(tx: Executor, channelId: string, bundle: PortabilityBundle, now: Date) {
  const [current] = await tx.select().from(channels).where(eq(channels.id, channelId)).for("update");
  if (!current) throw new Error("import into a channel that does not exist");
  const cats: CategoryRow[] = [];
  const conds = [
    bundle.channel.categorySlug ? eq(categories.slug, bundle.channel.categorySlug) : undefined,
    bundle.channel.categoryName ? eq(categories.name, bundle.channel.categoryName) : undefined,
  ].filter((c) => c !== undefined);
  for (const cond of conds)
    cats.push(
      ...(await tx
        .select({ id: categories.id, slug: categories.slug, name: categories.name, mature: categories.mature })
        .from(categories)
        .where(cond)),
    );
  const category = mapCategory(cats, bundle.channel.categorySlug, bundle.channel.categoryName);
  const patch = channelPatch({ mature: current.mature }, bundle.channel, category);
  const [row] = await tx.update(channels).set(patch).where(eq(channels.id, channelId)).returning();
  if (!row) throw new Error("channel update returned no row");
  if (row.liveBroadcastId)
    await tx
      .update(schema.broadcasts)
      .set({ title: row.title, categoryId: row.categoryId, mature: row.mature })
      .where(eq(schema.broadcasts.id, row.liveBroadcastId));
  const [cat] = row.categoryId
    ? await tx.select({ name: categories.name }).from(categories).where(eq(categories.id, row.categoryId))
    : [];
  await emit(
    tx,
    "channel.update",
    row.id,
    {
      broadcaster_user_id: row.ownerId,
      broadcaster_user_login: row.slug,
      broadcaster_user_name: row.displayName,
      title: row.title,
      language: row.language,
      category_id: row.categoryId,
      category_name: cat?.name ?? null,
      tags: row.tags,
      mature: row.mature,
    },
    now,
  );
}

/**
 * A committed image key may still be referenced: the channel's own public key of that purpose,
 * not revoked by an NCII removal (under the advisory lock NCII removal takes, held to commit).
 */
async function usableUpload(tx: Executor, key: string, channelId: string, purpose: "panel" | "emote") {
  if (!key.startsWith(`channels/${channelId}/${purpose}/`)) return false;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  const [revoked] = await tx
    .select({ id: schema.nciiRequestItems.id })
    .from(schema.nciiRequestItems)
    .where(sql`${schema.nciiRequestItems.uploadKey} = ${key} and ${schema.nciiRequestItems.removedAt} is not null`)
    .limit(1);
  return revoked === undefined;
}

async function importEmote(
  ctx: Ctx,
  commit: NonNullable<ApplyBundleOptions["commitUpload"]>,
  who: { channelId: string; userId: string },
  input: ApplyBundleInput,
  e: BundleEmote,
  committedKey: string | null,
  record: (item: StoredItem, write?: (tx: Executor) => Promise<void>) => Promise<void>,
) {
  const base = { kind: "emote" as const, ref: e.code, label: e.code };
  if (!EMOTE_CODE.test(e.code)) return record({ ...base, outcome: "rejected", reason: "invalid_code" });
  const state = await emoteState(ctx.db, who.channelId, e.code);
  if (state.taken) return record({ ...base, outcome: "skipped", reason: "code_taken" });
  if (state.count >= MAX_EMOTES) return record({ ...base, outcome: "skipped", reason: "emote_limit" });
  let key = committedKey;
  if (!key) {
    const r = await commitImage(ctx, commit, who, "emote", input.files.get(e.file));
    if (!r.ok) return record({ ...base, outcome: "rejected", reason: r.reason });
    key = r.key;
    // Saved before the insert: a retry reuses the committed key instead of uploading again.
    await record({ ...base, outcome: null, reason: null, key });
  }
  const imageKey = key;
  try {
    await record({ ...base, outcome: "imported", reason: null, key: imageKey }, async (tx) => {
      if (!(await usableUpload(tx, imageKey, who.channelId, "emote"))) throw new RevokedUploadError();
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(emotes)
        .where(eq(emotes.channelId, who.channelId));
      if (Number(n) >= MAX_EMOTES) throw new EmoteLimitError();
      const inserted = await tx
        .insert(emotes)
        .values({
          channelId: who.channelId,
          code: e.code,
          imageKey,
          tier: e.tier,
          animated: imageKey.endsWith(".gif"),
        })
        .onConflictDoNothing()
        .returning({ id: emotes.id });
      if (inserted.length === 0) throw new CodeTakenError();
    });
  } catch (err) {
    if (err instanceof CodeTakenError) return record({ ...base, outcome: "skipped", reason: "code_taken" });
    if (err instanceof EmoteLimitError) return record({ ...base, outcome: "skipped", reason: "emote_limit" });
    if (err instanceof RevokedUploadError) return record({ ...base, outcome: "rejected", reason: "upload_rejected" });
    throw err;
  }
}

class CodeTakenError extends Error {}
class RevokedUploadError extends Error {}
class EmoteLimitError extends Error {}

async function emoteState(db: Executor, channelId: string, code: string): Promise<{ taken: boolean; count: number }> {
  const [r] = await db
    .select({
      n: sql<number>`count(*)::int`,
      taken: sql<boolean>`coalesce(bool_or(${emotes.code} = ${code}), false)`,
    })
    .from(emotes)
    .where(eq(emotes.channelId, channelId));
  return { taken: Boolean(r?.taken), count: Number(r?.n ?? 0) };
}

/** Finish: status, result (when given), `finished_at` and the event, in one transaction. */
async function finish(
  ctx: Ctx,
  importId: string,
  status: "done" | "failed",
  result: StoredItem[] | null,
): Promise<StoredItem[]> {
  return ctx.db.transaction(async (tx) => {
    const now = ctx.now();
    const [row] = await tx
      .update(imports)
      .set({ status, finishedAt: now, updatedAt: now, ...(result ? { result: result as never } : {}) })
      .where(eq(imports.id, importId))
      .returning({ result: imports.result });
    await emit(tx, "portability.import.finished", null, { import_id: importId }, now);
    return (row?.result ?? []) as unknown as StoredItem[];
  });
}
