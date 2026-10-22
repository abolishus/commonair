// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The release manifest (ADR 0023): the one file that ties a release tag to the exact image
 * digests it shipped. The release workflow writes it, the self-host bundle renders Quadlet
 * units from it, and `selfhost.sh` reads it to pull by digest. Orchestrator-owned contract.
 */
import { z } from "zod";
import { SITE } from "../../packages/config/src/site.ts";

/** Our own images, one per Containerfile build in compose.yaml plus the relay. */
export const RELEASE_IMAGES = [
  "api",
  "chat",
  "irc",
  "media",
  "origin",
  "otel-collector",
  "loki",
  "postgres",
  "relay",
  "tempo",
  "tools",
  "tracker",
  "web",
  "worker",
] as const;
export type ReleaseImage = (typeof RELEASE_IMAGES)[number];

export const RELEASE_PLATFORMS = ["linux/amd64", "linux/arm64"] as const;

/** Relay binary targets: `${os}/${arch}`. */
export const RELAY_TARGETS = [
  "linux/amd64",
  "linux/arm64",
  "darwin/amd64",
  "darwin/arm64",
  "windows/amd64",
  "windows/arm64",
] as const;

/** Default registry namespace for released images; forks and mirrors override it. */
export const DEFAULT_REGISTRY = `${SITE.containerRegistry}/${SITE.slug}`;

// Semver 2.0 core + optional prerelease, no build metadata (tags must be valid image tags).
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
// Lowercase registry host[:port] and path, as OCI references require.
const REGISTRY = /^[a-z0-9.-]+(:\d+)?(\/[a-z0-9._-]+)*$/;

/** `v0.1.0-rc.1` → `0.1.0-rc.1`; throws on anything that is not a `v`-prefixed semver tag. */
export function versionFromTag(tag: string): string {
  const version = tag.startsWith("v") ? tag.slice(1) : "";
  if (!SEMVER.test(version)) throw new Error(`not a release tag (want vMAJOR.MINOR.PATCH[-pre]): ${tag}`);
  return version;
}

export function isPrerelease(version: string): boolean {
  return version.includes("-");
}

export const releaseManifest = z
  .object({
    schema: z.literal(1),
    version: z.string().regex(SEMVER),
    tag: z.string(),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    /** Registry namespace the digests were pushed to, e.g. `ghcr.io/abolishus/commonair`. */
    registry: z.string().regex(REGISTRY),
    /** Manifest-list (multi-arch index) digest per image. */
    images: z.record(z.enum(RELEASE_IMAGES), z.object({ digest: z.string().regex(DIGEST) })),
    platforms: z.array(z.enum(RELEASE_PLATFORMS)).min(1),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.tag !== `v${m.version}`) ctx.addIssue({ code: "custom", path: ["tag"], message: "tag must be v<version>" });
    const missing = RELEASE_IMAGES.filter((n) => !m.images[n]);
    if (missing.length > 0)
      ctx.addIssue({ code: "custom", path: ["images"], message: `missing images: ${missing.join(", ")}` });
  });
export type ReleaseManifest = z.output<typeof releaseManifest>;

export function parseManifest(json: string): ReleaseManifest {
  return releaseManifest.parse(JSON.parse(json));
}

/**
 * The pinned reference a unit pulls: `<registry>/<name>:<version>@<digest>`. `registry`
 * overrides the manifest's for a mirror that holds the same digests (`cosign copy` keeps them).
 */
export function imageRef(m: ReleaseManifest, name: ReleaseImage, registry: string = m.registry): string {
  if (!REGISTRY.test(registry)) throw new Error(`invalid registry: ${registry}`);
  const image = m.images[name];
  if (!image) throw new Error(`manifest has no image ${name}`);
  return `${registry}/${name}:${m.version}@${image.digest}`;
}

/** Relay binary asset name, e.g. `commonair-relay_0.1.0_linux_amd64` (`.exe` on Windows). */
export function relayAssetName(version: string, target: (typeof RELAY_TARGETS)[number]): string {
  const [os, arch] = target.split("/");
  return `commonair-relay_${version}_${os}_${arch}${os === "windows" ? ".exe" : ""}`;
}

export const bundleAssetName = (version: string) => `commonair-selfhost_${version}.tar.gz`;
export const MANIFEST_ASSET = "release-manifest.json";
export const CHECKSUMS_ASSET = "SHA256SUMS";
