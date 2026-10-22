// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Assemble `release-manifest.json` (the ADR 0023 §6 contract) from the multi-arch index digest
 * of every released image, and validate it with the contract's own parser.
 *
 *   bun scripts/release/write-manifest.ts --digests <dir> --tag v0.1.0 --version 0.1.0 --commit <sha> \
 *     --registry ghcr.io/<owner>/commonair --platforms linux/amd64,linux/arm64 --out dist/release-manifest.json
 *
 * `<dir>` holds one `<image>.digest` file per image (written by the publish job), each
 * containing `sha256:<hex>`.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePlatforms } from "./images.ts";
import { RELEASE_IMAGES, type ReleaseManifest, parseManifest, versionFromTag } from "./manifest.ts";

export interface ManifestInput {
  tag: string;
  /** The version the workflow planned; must match the tag. */
  version?: string;
  commit: string;
  registry: string;
  platforms: string[];
  digests: Record<string, string>;
}

/** The validated manifest. Throws on a missing or malformed digest, an unknown image, or a bad tag. */
export function assembleManifest(input: ManifestInput): ReleaseManifest {
  const version = versionFromTag(input.tag);
  if (input.version !== undefined && input.version !== version)
    throw new Error(`tag/version mismatch: ${input.tag} is version ${version}, not ${input.version}`);
  const missing = RELEASE_IMAGES.filter((n) => !input.digests[n]);
  if (missing.length > 0) throw new Error(`missing digests: ${missing.join(", ")}`);
  const images = Object.fromEntries(
    Object.entries(input.digests)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, digest]) => [name, { digest: digest.trim() }]),
  );
  const manifest = {
    schema: 1,
    version,
    tag: input.tag,
    commit: input.commit,
    registry: input.registry,
    images,
    platforms: input.platforms,
  };
  return parseManifest(JSON.stringify(manifest));
}

/** `<dir>/<image>.digest` files → { image: digest }. */
export function readDigests(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith(".digest"))
      .map((f) => [f.slice(0, -".digest".length), readFileSync(join(dir, f), "utf8").trim()]),
  );
}

export function formatManifest(m: ReleaseManifest): string {
  return `${JSON.stringify(m, null, 2)}\n`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const [dir, tag, commit, registry, platforms, out] = [
    opt("digests"),
    opt("tag"),
    opt("commit"),
    opt("registry"),
    opt("platforms"),
    opt("out"),
  ];
  if (!dir || !tag || !commit || !registry || !platforms || !out) {
    console.error(
      "usage: write-manifest.ts --digests <dir> --tag <vX.Y.Z> [--version <X.Y.Z>] --commit <sha> --registry <r> --platforms <list> --out <file>",
    );
    process.exit(2);
  }
  const m = assembleManifest({
    tag,
    version: opt("version"),
    commit,
    registry,
    platforms: parsePlatforms(platforms),
    digests: readDigests(dir),
  });
  writeFileSync(out, formatManifest(m));
  console.log(`${out}: ${Object.keys(m.images).length} images, ${m.version}`);
}
