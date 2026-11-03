// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `TWITCH_JOBS.import` for one import (ADR 0031, batch 7 decision (j)): the Twitch import's apply.
 *
 * The API stored the preview (public Helix data, no token) and the choices. This job fetches each
 * chosen emote's image from `TWITCH_IMAGE_HOSTS` only (`fetch-image.ts`: SSRF guard, size cap),
 * builds the `twitch` bundle with `toBundle`, and hands both to W3-portability's `applyBundle`,
 * which does the moderation (every image through the API's upload pipeline, the T0 path
 * included), the re-hosting under our storage, the clash and skip reporting and the result.
 * Nothing hotlinks Twitch.
 *
 * Idempotent: `applyBundle` saves each item as it completes and skips saved ones on a retry; the
 * job also skips fetching images of emotes already saved. A transport failure (the API's upload
 * route down) throws so the job retries; the last attempt fails the import.
 */
import { developerEnv, loadEnv, twitchImportEnv } from "@commonair/config";
import { ImportChoices as ImportChoicesSchema } from "@commonair/contracts/dto";
import { PORTABILITY_LIMITS } from "@commonair/contracts/portability";
import { schema } from "@commonair/db";
import { toBundle, TwitchSnapshot } from "@commonair/twitch";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { WorkerContext } from "../context.ts";
import { emit } from "../moderation/records.ts";
import { applyBundle, type ApplyBundleOptions, type StoredItem } from "../portability/import/index.ts";
import { fetchTwitchImage, type FetchImageOptions, type FetchImageResult } from "./fetch-image.ts";

const { portabilityImports: imports, channels, emotes } = schema;

const twitchJobEnv = z.object({
  ...twitchImportEnv.shape,
  OUTBOUND_ALLOW_PRIVATE_NETWORKS: developerEnv.shape.OUTBOUND_ALLOW_PRIVATE_NETWORKS,
});

export interface TwitchJobConfig {
  enabled: boolean;
  imageHosts: readonly string[];
  allowInsecure: boolean;
}

let cached: TwitchJobConfig | undefined;

/** Read once per process from the env `workerEnv` validated at start-up; tests pass their own source. */
export function twitchJobConfig(source?: Record<string, string | undefined>): TwitchJobConfig {
  if (!source && cached) return cached;
  const env = loadEnv(twitchJobEnv, source ?? process.env);
  const cfg = {
    enabled: env.TWITCH_IMPORT_ENABLED,
    imageHosts: env.TWITCH_IMAGE_HOSTS,
    allowInsecure: env.OUTBOUND_ALLOW_PRIVATE_NETWORKS,
  };
  if (!source) cached = cfg;
  return cfg;
}

export interface TwitchImportOptions extends ApplyBundleOptions {
  /** True on the job's last attempt: a failure then fails the import instead of retrying. */
  lastAttempt?: boolean;
  config?: TwitchJobConfig;
  /** Test seam. */
  fetchImage?: (url: string, opts: FetchImageOptions) => Promise<FetchImageResult>;
}

async function failImport(ctx: WorkerContext, importId: string, reason: string): Promise<Record<string, number>> {
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
  ctx.logger.warn("twitch import failed", { importId, reason });
  return { failed: 1 };
}

const domainOf = (ctx: WorkerContext): string => {
  try {
    return new URL(ctx.site?.publicUrl ?? "http://localhost").host;
  } catch {
    return "localhost";
  }
};

/** See the module comment. */
export async function runTwitchImport(
  ctx: WorkerContext,
  importId: string,
  opts: TwitchImportOptions = {},
): Promise<Record<string, number>> {
  const [row] = await ctx.db.select().from(imports).where(eq(imports.id, importId));
  if (!row || row.source !== "twitch") return { skipped: 1 };
  if (row.status !== "queued" && row.status !== "running") return { skipped: 1 };
  const cfg = opts.config ?? twitchJobConfig();
  // Turned off between start and run: nothing is fetched from Twitch.
  if (!cfg.enabled) return failImport(ctx, importId, "twitch_import_unavailable");
  const snap = TwitchSnapshot.safeParse((row.preview as { twitch?: unknown }).twitch);
  if (!snap.success) return failImport(ctx, importId, "preview_missing");
  try {
    const choices = ImportChoicesSchema.parse(row.choices ?? { channel: false, panels: false, emotes: [] });
    const [channel] = await ctx.db
      .select({ language: channels.language })
      .from(channels)
      .where(eq(channels.id, row.channelId));
    const { bundle, sources } = toBundle(snap.data, {
      domain: domainOf(ctx),
      exportedAt: ctx.now(),
      fallbackLanguage: channel?.language ?? "en",
    });

    // Fetch only chosen images not already saved by an earlier attempt.
    const saved = new Map<string, StoredItem>();
    for (const it of (row.result ?? []) as unknown as StoredItem[]) if (it.kind === "emote") saved.set(it.ref, it);
    const chosen = new Set(choices.emotes);
    // A code the channel already has is reported `code_taken` by applyBundle: no image needed.
    for (const e of await ctx.db.select({ code: emotes.code }).from(emotes).where(eq(emotes.channelId, row.channelId)))
      chosen.delete(e.code);
    const fetchImage = opts.fetchImage ?? fetchTwitchImage;
    const files = new Map<string, Uint8Array>();
    for (const s of sources) {
      const prior = saved.get(s.code);
      if (!chosen.has(s.code) || (prior?.outcome ?? null) !== null || prior?.key) continue;
      const got = await fetchImage(s.url, {
        allowedHosts: cfg.imageHosts,
        allowInsecure: cfg.allowInsecure,
        maxBytes: PORTABILITY_LIMITS.maxEmoteBytes,
      });
      if (got.ok) files.set(s.file, got.bytes);
      // The emote is then reported `missing_file` by applyBundle: never a hotlink, never a retry loop.
      else ctx.logger.warn("twitch emote image not fetched", { importId, reason: got.reason });
    }

    const out = await applyBundle(
      ctx,
      {
        importId,
        bundle,
        files,
        // The streamer's per-field choices (batch 8); absent means every field.
        choices: {
          channel: choices.channel,
          ...(choices.fields ? { fields: choices.fields } : {}),
          panels: false,
          emotes: choices.emotes,
        },
      },
      opts.commitUpload ? { commitUpload: opts.commitUpload } : {},
    );
    return out.ok ? { applied: 1, items: out.items.length, fetched: files.size } : { failed: 1 };
  } catch (err) {
    if (opts.lastAttempt) return failImport(ctx, importId, "import_failed");
    throw err;
  }
}
