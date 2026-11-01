// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `bundle` export kind (ADR 0037): a ZIP with `bundle.json` (`PortabilityBundle` v1,
 * `source: "commonair"`), the panel and emote images under `files/`, and the manifest with each
 * file's size and SHA-256. `buildExport` (`build.ts`) calls `buildBundle` for a `bundle` export and
 * keeps the rest of the export pipeline (claim, cooldown, upload, TTL, mail, cleanup).
 *
 * The channel's rows are read in one read-only snapshot; the images come from the media bucket. An
 * image that is gone, unreadable, of an unknown type or over its cap is left out: the panel keeps
 * its text with no image, the emote is dropped. The schedule is empty (CommonAir has none yet).
 *
 * The bundle carries a standing statement signed with `PORTABILITY_SIGNING_KEY`, bound to the
 * bundle (its digest with `standing` null) and naming this instance as issuer (`standing.ts`).
 */
import { SITE } from "@commonair/config/site";
import {
  type BundleEmote,
  type BundleManifestEntry,
  type BundlePanel,
  PORTABILITY_BUNDLE_VERSION,
  PORTABILITY_LIMITS,
  PortabilityBundle,
} from "@commonair/contracts/portability";
import { schema as s } from "@commonair/db";
import type { StandingSigningKey } from "@commonair/tokens/standing";
import { asc, eq } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import { writeBundleArchive } from "../portability/archive.ts";
import {
  buildStatement,
  ensurePortabilityKey,
  envPortabilityKey,
  issuerOrigin,
  signStatement,
  standingFacts,
} from "../portability/standing.ts";

export interface BundleInput {
  exportId: string;
  userId: string;
  /** The requester's channel (a bundle is always a channel's). */
  channelId: string;
  generatedAt: Date;
}

export interface BundleOptions {
  /** Tests pass a key; the worker uses `PORTABILITY_SIGNING_KEY`. */
  key?: StandingSigningKey;
}

type ImageType = BundleManifestEntry["contentType"];
const TYPE_OF_EXT: Record<string, ImageType> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};
const EXT_OF_TYPE: Record<ImageType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/**
 * The storage key behind a stored image reference: a key, or this instance's media URL of one
 * (`setPanels` accepts both). Only the channel's own uploads of the given purpose qualify.
 */
export function imageKeyOf(ref: string | null, channelId: string, purpose: "panel" | "emote"): string | null {
  if (!ref) return null;
  let path = ref;
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) {
    try {
      path = decodeURIComponent(new URL(ref).pathname);
    } catch {
      return null;
    }
  }
  const m = new RegExp(
    `(?:^|/)(channels/${channelId.toLowerCase()}/${purpose}/[0-9a-f-]{36}\\.(?:png|jpg|webp|gif))$`,
  ).exec(path);
  return m?.[1] ?? null;
}

const contentTypeOf = (key: string): ImageType | null => TYPE_OF_EXT[key.slice(key.lastIndexOf(".") + 1)] ?? null;

const validUrl = (u: string | null): string | null => {
  if (!u || u.length > 2000) return null;
  const p = URL.parse(u);
  return p && (p.protocol === "https:" || p.protocol === "http:") ? p.toString() : null;
};

/** Read one image, or null when it is missing or over `cap`. Never throws for a missing object. */
async function readImage(ctx: WorkerContext, key: string, cap: number): Promise<Uint8Array | null> {
  if (!ctx.storage) throw new Error("object storage is not configured");
  const res = await ctx.storage.get(ctx.mediaBucket, key);
  if (!res) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  return bytes.byteLength > 0 && bytes.byteLength <= cap ? bytes : null;
}

/** The finished archive's bytes. */
export async function buildBundle(
  ctx: WorkerContext,
  input: BundleInput,
  opts: BundleOptions = {},
): Promise<Uint8Array> {
  if (!ctx.site) throw new Error("a bundle export needs the instance site (WorkerContext.site)");
  const site = ctx.site;
  const snapshot = await ctx.db.transaction(
    async (tx) => {
      const [c] = await tx
        .select({ channel: s.channels, categorySlug: s.categories.slug, categoryName: s.categories.name })
        .from(s.channels)
        .leftJoin(s.categories, eq(s.categories.id, s.channels.categoryId))
        .where(eq(s.channels.id, input.channelId));
      if (!c) throw new Error("bundle for a channel that does not exist");
      const panels = await tx
        .select()
        .from(s.channelPanels)
        .where(eq(s.channelPanels.channelId, input.channelId))
        .orderBy(asc(s.channelPanels.position));
      const emotes = await tx
        .select()
        .from(s.emotes)
        .where(eq(s.emotes.channelId, input.channelId))
        .orderBy(asc(s.emotes.code));
      const facts = await standingFacts(tx, input.channelId, input.generatedAt);
      return { ...c, panels, emotes, facts };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );

  const files = new Map<string, { bytes: Uint8Array; contentType: ImageType }>();
  const panels: BundlePanel[] = [];
  for (const [i, p] of snapshot.panels.slice(0, PORTABILITY_LIMITS.maxPanels).entries()) {
    const key = imageKeyOf(p.imageKey, input.channelId, "panel");
    const type = key ? contentTypeOf(key) : null;
    let image: BundlePanel["image"] = null;
    if (key && type) {
      const bytes = await readImage(ctx, key, PORTABILITY_LIMITS.maxPanelImageBytes);
      if (bytes) {
        const file = `files/panel-${i + 1}.${EXT_OF_TYPE[type]}`;
        files.set(file, { bytes, contentType: type });
        image = { file };
      }
    }
    panels.push({ title: p.title.slice(0, 60), body: p.body.slice(0, 5000), link: validUrl(p.linkUrl), image });
  }
  const emotes: BundleEmote[] = [];
  for (const e of snapshot.emotes) {
    if (emotes.length >= PORTABILITY_LIMITS.maxEmotes) break;
    if (!/^[A-Za-z0-9]{2,20}$/.test(e.code)) continue;
    const key = imageKeyOf(e.imageKey, input.channelId, "emote");
    const type = key ? contentTypeOf(key) : null;
    if (!key || !type) continue;
    const bytes = await readImage(ctx, key, PORTABILITY_LIMITS.maxEmoteBytes);
    if (!bytes) continue;
    const file = `files/emote-${e.code}.${EXT_OF_TYPE[type]}`;
    files.set(file, { bytes, contentType: type });
    emotes.push({ code: e.code, tier: Math.min(3, Math.max(0, e.tier)), animated: e.animated, file });
  }

  const c = snapshot.channel;
  const publicUrl = new URL(site.publicUrl);
  const unsigned = PortabilityBundle.parse({
    v: PORTABILITY_BUNDLE_VERSION,
    source: "commonair",
    exportedAt: input.generatedAt.toISOString(),
    instance: { domain: publicUrl.host.toLowerCase(), software: SITE.slug, version: site.sourceCommit.slice(0, 64) },
    channel: {
      title: c.title.slice(0, 140),
      description: c.description.slice(0, 2000),
      tags: c.tags.filter((t) => t.length >= 1 && t.length <= 25).slice(0, 10),
      language: /^[a-z]{2,3}(-[A-Za-z0-9]{2,4})?$/.test(c.language) ? c.language : "en",
      mature: c.mature,
      categorySlug: snapshot.categorySlug ? snapshot.categorySlug.slice(0, 100) : null,
      categoryName: snapshot.categoryName ? snapshot.categoryName.slice(0, 200) : null,
    },
    panels,
    emotes,
    schedule: [],
    standing: null,
  });

  const key = opts.key ?? (await envPortabilityKey());
  await ctx.db.transaction((tx) => ensurePortabilityKey(tx, key, ctx.now()));
  const statement = await buildStatement({
    key,
    issuer: issuerOrigin(site.publicUrl),
    channelId: input.channelId,
    bundle: unsigned,
    facts: snapshot.facts,
    issuedAt: input.generatedAt,
  });
  const bundle: PortabilityBundle = { ...unsigned, standing: await signStatement(key, statement) };
  const { bytes } = await writeBundleArchive(bundle, files, input.generatedAt);
  ctx.logger.info("portability bundle built", {
    exportId: input.exportId,
    channelId: input.channelId,
    panels: panels.length,
    emotes: emotes.length,
    files: files.size,
  });
  return bytes;
}
