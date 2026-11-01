// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Bundle imports, the API's half (ADR 0037 decision 5). The worker does the reading, checking and
 * applying (`services/worker/src/portability/import/`); the API records, presigns and queues.
 *
 * - `upload` presigns a PUT of the archive to `incoming/portability/<channel>/<uuid>.zip`.
 * - `preview` checks the key is this channel's, creates the import (`previewed`, preview pending),
 *   runs the worker's preview and waits (60 s). A refusal (a bad bundle, a gate) answers
 *   BAD_REQUEST with `data.reason`, and the import stays as `failed` with that reason.
 * - `start` stores the choices (emotes need the streamer's assertion of rights to the art, ADR
 *   0031) and queues the apply.
 *
 * Only the channel's owner imports: an import replaces the channel's setup.
 */
import { and, desc, eq } from "drizzle-orm";
import type { z } from "zod";
import type { dto } from "@commonair/contracts";
import { PORTABILITY_LIMITS } from "@commonair/contracts/portability";
import { INCOMING_PREFIX } from "@commonair/moderation";
import { schema, uuidv7 } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { iso, isoOrNull } from "../lib/dto.ts";
import { apiError, badRequest, conflict, notFound } from "../lib/errors.ts";
import { portabilityQueue } from "./queue.ts";

const { portabilityImports: imports } = schema;
type ImportRow = typeof imports.$inferSelect;
type ImportDto = z.infer<typeof dto.PortabilityImport>;
type ImportItem = z.infer<typeof dto.ImportItem>;

export const ARCHIVE_UPLOAD_TTL_SECONDS = 900;
/** The wording version of the emote-art assertion the studio shows (ADR 0031). */
export const EMOTE_RIGHTS_ASSERTION_VERSION = "2026-11-01";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export const archiveKey = (channelId: string, id: string) => `${INCOMING_PREFIX}portability/${channelId}/${id}.zip`;

/** An archive key of this channel, as `upload` mints them; anything else is refused. */
export function isArchiveKey(key: string, channelId: string): boolean {
  return new RegExp(`^${INCOMING_PREFIX}portability/${channelId.toLowerCase()}/${UUID}\\.zip$`).test(key);
}

/** Served items: the stored lines without internal fields. */
function items(raw: unknown): ImportItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x) => {
    const i = x as Partial<ImportItem>;
    if (!i || typeof i.kind !== "string" || typeof i.ref !== "string") return [];
    return [
      {
        kind: i.kind,
        ref: i.ref,
        label: typeof i.label === "string" ? i.label : "",
        outcome: i.outcome ?? null,
        reason: typeof i.reason === "string" ? i.reason.slice(0, 64) : null,
      },
    ];
  });
}

export function toImportDto(row: ImportRow): ImportDto {
  const preview = row.preview as {
    state?: string;
    channel?: Record<string, unknown>;
    items?: unknown;
    standing?: unknown;
  };
  return {
    id: row.id,
    source: row.source,
    status: row.status,
    standingVerified: row.standingVerified,
    standingIssuer: row.standingIssuer,
    preview: {
      channel: {
        ...preview.channel,
        state: preview.state ?? "pending",
        ...(preview.standing ? { standing: preview.standing } : {}),
      },
      items: items(preview.items),
    },
    result: row.result ? items(row.result) : null,
    assertedAt: isoOrNull(row.assertedAt),
    createdAt: iso(row.createdAt),
    finishedAt: isoOrNull(row.finishedAt),
  };
}

export async function presignArchive(deps: Deps, channelId: string, sizeBytes: number) {
  if (sizeBytes > PORTABILITY_LIMITS.maxArchiveBytes) throw badRequest("The bundle is too large");
  const key = archiveKey(channelId, uuidv7());
  const uploadUrl = await deps.storage.presignPut(deps.env.S3_BUCKET_MEDIA, key, {
    expiresSeconds: ARCHIVE_UPLOAD_TTL_SECONDS,
    contentType: "application/zip",
    contentLength: sizeBytes,
  });
  return {
    key,
    uploadUrl,
    headers: { "content-type": "application/zip", "content-length": String(sizeBytes) },
    expiresAt: iso(new Date(deps.now().getTime() + ARCHIVE_UPLOAD_TTL_SECONDS * 1000)),
  };
}

async function load(deps: Deps, channelId: string, id: string): Promise<ImportRow> {
  const [row] = await deps.db
    .select()
    .from(imports)
    .where(and(eq(imports.id, id), eq(imports.channelId, channelId)));
  if (!row) throw notFound("Import not found");
  return row;
}

export async function previewImport(
  deps: Deps,
  input: { channelId: string; userId: string; key: string },
): Promise<ImportDto> {
  if (!isArchiveKey(input.key, input.channelId)) throw badRequest("Upload the bundle first");
  const head = await deps.storage.head(deps.env.S3_BUCKET_MEDIA, input.key);
  if (!head) throw notFound("Upload not found or expired");
  const [existing] = await deps.db
    .select({ id: imports.id })
    .from(imports)
    .where(and(eq(imports.channelId, input.channelId), eq(imports.archiveKey, input.key)));
  if (existing) throw conflict("This upload was already previewed");
  const id = uuidv7();
  await deps.db.insert(imports).values({
    id,
    userId: input.userId,
    channelId: input.channelId,
    source: "commonair",
    status: "previewed",
    archiveKey: input.key,
    preview: { state: "pending" },
    createdAt: deps.now(),
  });
  try {
    await portabilityQueue(deps).preview(id);
  } catch (err) {
    // The worker is slow or down: the import stays pending and `imports.get` shows it later.
    deps.logger.warn("import preview did not finish in time", { importId: id, err: (err as Error).name });
  }
  const row = await load(deps, input.channelId, id);
  if (row.status === "failed") {
    const reason = (row.preview as { refusal?: string }).refusal ?? "refused";
    throw apiError("BAD_REQUEST", "This bundle cannot be imported", { reason });
  }
  return toImportDto(row);
}

export async function startImport(
  deps: Deps,
  input: {
    channelId: string;
    userId: string;
    id: string;
    choices: { channel: boolean; panels: boolean; emotes: string[] };
    assertEmoteRights: boolean;
  },
): Promise<ImportDto> {
  const now = deps.now();
  const row = await deps.db.transaction(async (tx) => {
    const [cur] = await tx
      .select()
      .from(imports)
      .where(and(eq(imports.id, input.id), eq(imports.channelId, input.channelId)))
      .for("update");
    if (!cur) throw notFound("Import not found");
    // A Twitch preview starts only through the Twitch start (its expiry, audit and panel rules).
    if (
      cur.status !== "previewed" ||
      cur.source !== "commonair" ||
      (cur.preview as { state?: string }).state !== "ready"
    )
      throw conflict("This import is not ready to start");
    const available = new Set(
      items((cur.preview as { items?: unknown }).items)
        .filter((i) => i.kind === "emote")
        .map((i) => i.ref),
    );
    const emotes = [...new Set(input.choices.emotes)].filter((c) => available.has(c));
    if (emotes.length > 0 && !input.assertEmoteRights)
      throw apiError("PRECONDITION_FAILED", "Confirm you have the right to use this emote art", {
        requirement: "emote_rights",
      });
    const [updated] = await tx
      .update(imports)
      .set({
        status: "queued",
        choices: { channel: input.choices.channel, panels: input.choices.panels, emotes },
        ...(emotes.length > 0 ? { assertedAt: now, assertionVersion: EMOTE_RIGHTS_ASSERTION_VERSION } : {}),
        updatedAt: now,
      })
      .where(eq(imports.id, cur.id))
      .returning();
    await audit(tx, {
      actorType: "user",
      actorId: input.userId,
      action: "portability.import.start",
      subjectType: "portability_import",
      subjectId: cur.id,
      channelId: input.channelId,
      details: { emotes: emotes.length, channel: input.choices.channel, panels: input.choices.panels },
    });
    return updated ?? cur;
  });
  try {
    await portabilityQueue(deps).start(row.id);
  } catch (err) {
    // Never leave an import queued that the worker will not hear of: hand it back to the preview.
    deps.logger.error("import enqueue failed", { importId: row.id, err: (err as Error).name });
    await deps.db
      .update(imports)
      .set({ status: "previewed", updatedAt: deps.now() })
      .where(and(eq(imports.id, row.id), eq(imports.status, "queued")));
    throw err;
  }
  return toImportDto(row);
}

export async function getImport(deps: Deps, channelId: string, id: string): Promise<ImportDto> {
  return toImportDto(await load(deps, channelId, id));
}

export async function listImports(deps: Deps, channelId: string): Promise<ImportDto[]> {
  const rows = await deps.db
    .select()
    .from(imports)
    .where(eq(imports.channelId, channelId))
    .orderBy(desc(imports.createdAt), desc(imports.id))
    .limit(50);
  return rows.map(toImportDto);
}
