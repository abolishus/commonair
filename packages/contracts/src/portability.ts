// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The portability bundle (batch 7 decision (j), ADR 0037): one archive format for leaving an
 * instance and for importing from Twitch. A bundle is a ZIP holding `bundle.json` (a
 * `PortabilityBundle`), `manifest.json` (a `BundleManifest`: every file's size and SHA-256) and the
 * image bytes under `files/`. W3-portability builds, verifies and applies it; N3 maps Twitch data
 * into it (`source: "twitch"`, `standing: null`) and calls the same `applyBundle`.
 *
 * `parseBundle` checks shape and limits only. Callers still check each file's bytes against the
 * manifest, and verify the standing statement (`packages/tokens` `standing.ts`).
 */
import { z } from "zod";
import { PORTABILITY_SOURCES } from "./enums.ts";

/** The only bundle version this build reads and writes. */
export const PORTABILITY_BUNDLE_VERSION = 1;
/** Archive entry names. */
export const BUNDLE_FILES = { bundle: "bundle.json", manifest: "manifest.json", dir: "files/" } as const;

/**
 * Limits, matching the studio's own: emotes per channel (the emote create rule), panels per
 * channel (`channels.setPanels`), and the byte caps per image. The archive cap bounds what an
 * import downloads before it parses anything.
 */
export const PORTABILITY_LIMITS = {
  maxEmotes: 100,
  maxPanels: 20,
  maxScheduleEntries: 200,
  maxEmoteBytes: 1_000_000,
  maxPanelImageBytes: 5_000_000,
  maxFiles: 120,
  maxArchiveBytes: 150_000_000,
} as const;

/**
 * A file inside the archive: `files/<name>`, where the name is a flat, safe file name (no
 * directories, no `..`, no leading dot), so extracting can never escape the archive's folder.
 */
export const BundleFileName = z
  .string()
  .regex(/^files\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, "a flat file name under files/")
  .refine((n) => !n.includes(".."), "no parent references");
export type BundleFileName = z.infer<typeof BundleFileName>;

const Iso = z.iso.datetime({ offset: true });

/** One entry of `manifest.json`. */
export const BundleManifestEntry = z.object({
  file: BundleFileName,
  sizeBytes: z.number().int().positive().max(PORTABILITY_LIMITS.maxPanelImageBytes),
  /** Lowercase hex SHA-256 of the file's bytes. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  contentType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
});
export type BundleManifestEntry = z.infer<typeof BundleManifestEntry>;
export const BundleManifest = z
  .object({
    v: z.literal(PORTABILITY_BUNDLE_VERSION),
    files: z.array(BundleManifestEntry).max(PORTABILITY_LIMITS.maxFiles),
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    for (const [i, f] of m.files.entries()) {
      if (seen.has(f.file)) ctx.addIssue({ code: "custom", path: ["files", i, "file"], message: "duplicate file" });
      seen.add(f.file);
    }
  });
export type BundleManifest = z.infer<typeof BundleManifest>;

/**
 * The signed standing statement (decision (n)), in the attestation envelope form: `payload` is the
 * base64url of the canonical statement JSON, `signature` the base64url Ed25519 signature over those
 * bytes. Its contents and verification live in `packages/tokens` (`standing.ts`).
 */
export const StandingStatementEnvelope = z.object({
  payload: z
    .string()
    .min(1)
    .max(8_192)
    .regex(/^[A-Za-z0-9_-]+$/),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
export type StandingStatementEnvelope = z.infer<typeof StandingStatementEnvelope>;

export const BundleChannel = z.object({
  title: z.string().max(140),
  description: z.string().max(2000),
  tags: z.array(z.string().min(1).max(25)).max(10),
  /** BCP 47 tag. */
  language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,4})?$/),
  /** `true` sets the mature label on import; an import never clears one. */
  mature: z.boolean(),
  /** Mapped by slug, then by exact name; unknown leaves the category unset. */
  categorySlug: z.string().max(100).nullable(),
  categoryName: z.string().max(200).nullable(),
});
export type BundleChannel = z.infer<typeof BundleChannel>;

export const BundlePanel = z.object({
  title: z.string().max(60),
  body: z.string().max(5000),
  link: z.url().max(2000).nullable(),
  image: z.object({ file: BundleFileName }).nullable(),
});
export type BundlePanel = z.infer<typeof BundlePanel>;

export const BundleEmote = z.object({
  /** The emote create rule's code pattern. */
  code: z.string().regex(/^[A-Za-z0-9]{2,20}$/),
  tier: z.number().int().min(0).max(3),
  animated: z.boolean(),
  file: BundleFileName,
});
export type BundleEmote = z.infer<typeof BundleEmote>;

/** A schedule entry: carried in the bundle, never applied (decision (b)). */
export const BundleScheduleEntry = z.object({
  startsAt: Iso,
  endsAt: Iso.nullable(),
  title: z.string().max(140),
  category: z.string().max(200).nullable(),
});
export type BundleScheduleEntry = z.infer<typeof BundleScheduleEntry>;

/** `bundle.json`, version 1. */
export const PortabilityBundle = z
  .object({
    v: z.literal(PORTABILITY_BUNDLE_VERSION),
    source: z.enum(PORTABILITY_SOURCES),
    exportedAt: Iso,
    /** The exporting instance; for Twitch bundles, the importing instance that built it. */
    instance: z.object({
      domain: z
        .string()
        .min(1)
        .max(253)
        .regex(/^[a-z0-9.-]+(:[0-9]{1,5})?$/),
      software: z.string().min(1).max(64),
      version: z.string().max(64),
    }),
    channel: BundleChannel,
    panels: z.array(BundlePanel).max(PORTABILITY_LIMITS.maxPanels),
    emotes: z.array(BundleEmote).max(PORTABILITY_LIMITS.maxEmotes),
    schedule: z.array(BundleScheduleEntry).max(PORTABILITY_LIMITS.maxScheduleEntries),
    /** Null for Twitch bundles, and for an instance that could not sign one. */
    standing: StandingStatementEnvelope.nullable(),
  })
  .superRefine((b, ctx) => {
    if (b.source === "twitch" && b.standing !== null)
      ctx.addIssue({
        code: "custom",
        path: ["standing"],
        message: "a Twitch bundle never carries a standing statement",
      });
    const codes = new Set<string>();
    for (const [i, e] of b.emotes.entries()) {
      const k = e.code.toLowerCase();
      if (codes.has(k)) ctx.addIssue({ code: "custom", path: ["emotes", i, "code"], message: "duplicate emote code" });
      codes.add(k);
    }
  });
export type PortabilityBundle = z.infer<typeof PortabilityBundle>;

/** Every `files/` name a bundle refers to. */
export function bundleFileRefs(bundle: PortabilityBundle): string[] {
  const refs = new Set<string>();
  for (const p of bundle.panels) if (p.image) refs.add(p.image.file);
  for (const e of bundle.emotes) refs.add(e.file);
  return [...refs].sort();
}

export type ParseBundleResult =
  | { ok: true; bundle: PortabilityBundle; manifest: BundleManifest }
  | { ok: false; error: "unsupported_version" | "malformed" | "missing_file" | "file_too_large" };

const versionOf = (json: unknown): unknown =>
  typeof json === "object" && json !== null && "v" in json ? (json as { v: unknown }).v : undefined;

/**
 * Parse `bundle.json` and `manifest.json` (already JSON-decoded). Refuses an unknown version before
 * anything else, a shape or limit violation, a referenced file the manifest does not list, and an
 * emote over the emote byte cap. File bytes and the standing statement are the caller's to check.
 */
export function parseBundle(bundleJson: unknown, manifestJson: unknown): ParseBundleResult {
  if (versionOf(bundleJson) !== PORTABILITY_BUNDLE_VERSION || versionOf(manifestJson) !== PORTABILITY_BUNDLE_VERSION)
    return { ok: false, error: "unsupported_version" };
  const bundle = PortabilityBundle.safeParse(bundleJson);
  const manifest = BundleManifest.safeParse(manifestJson);
  if (!bundle.success || !manifest.success) return { ok: false, error: "malformed" };
  const listed = new Map(manifest.data.files.map((f) => [f.file, f]));
  for (const ref of bundleFileRefs(bundle.data)) if (!listed.has(ref)) return { ok: false, error: "missing_file" };
  for (const e of bundle.data.emotes)
    if ((listed.get(e.file)?.sizeBytes ?? 0) > PORTABILITY_LIMITS.maxEmoteBytes)
      return { ok: false, error: "file_too_large" };
  return { ok: true, bundle: bundle.data, manifest: manifest.data };
}
