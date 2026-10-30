// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Gather every release asset into one directory, check it holds exactly the expected set,
 * write `SHA256SUMS` and, when signing, `SHA256SUMS.sigstore.json` (ADR 0023 §4–5).
 *
 *   bun scripts/release/assemble.ts --dist dist --published <publish-image outputs> \
 *     --relay <relay.ts output> [--sign true|false]
 *
 * `dist` must already hold `release-manifest.json` and the self-host bundle.
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  imageAssetBase,
  imageProvenanceAsset,
  predicateAsset,
  envelopeAsset,
  provenanceAsset,
  sbomAsset,
  signatureAsset,
} from "./assets.ts";
import { EXCLUDED, sumsForDir } from "./checksums.ts";
import {
  CHECKSUMS_ASSET,
  MANIFEST_ASSET,
  RELAY_TARGETS,
  RELEASE_IMAGES,
  type ReleaseManifest,
  bundleAssetName,
  parseManifest,
  relayAssetName,
} from "./manifest.ts";

export interface ExpectedAssets {
  /** Copied in from the image publish jobs. */
  images: string[];
  /** Copied in from the relay job. */
  relay: string[];
  /** Already in dist: the manifest and the bundle. */
  dist: string[];
}

export function expectedAssets(m: ReleaseManifest, sign: boolean): ExpectedAssets {
  const images = RELEASE_IMAGES.flatMap((image) => [
    ...m.platforms.map((p) => sbomAsset(imageAssetBase(image, m.version, p))),
    imageProvenanceAsset(image, m.version),
  ]);
  const relay = RELAY_TARGETS.flatMap((t) => {
    const name = relayAssetName(m.version, t);
    return [
      name,
      sbomAsset(name),
      predicateAsset(name),
      ...(sign ? [signatureAsset(name), provenanceAsset(name), envelopeAsset(name)] : []),
    ];
  });
  return { images, relay, dist: [MANIFEST_ASSET, bundleAssetName(m.version)] };
}

/** Problems with the assembled directory: missing or unexpected assets. */
export function checkAssets(expected: ExpectedAssets, present: string[]): string[] {
  const want = new Set([...expected.images, ...expected.relay, ...expected.dist]);
  const have = new Set(present.filter((n) => !EXCLUDED.has(n)));
  return [
    ...[...want].filter((n) => !have.has(n)).map((n) => `missing: ${n}`),
    ...[...have].filter((n) => !want.has(n)).map((n) => `unexpected: ${n}`),
  ].sort();
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const [distArg, published, relay] = [opt("dist"), opt("published"), opt("relay")];
  if (!distArg || !published || !relay) {
    console.error("usage: assemble.ts --dist <dir> --published <dir> --relay <dir> [--sign true|false]");
    process.exit(2);
  }
  const dist = resolve(distArg);
  const sign = opt("sign") === "true";
  const m = parseManifest(readFileSync(join(dist, MANIFEST_ASSET), "utf8"));
  const expected = expectedAssets(m, sign);
  for (const [from, names] of [
    [published, expected.images],
    [relay, expected.relay],
  ] as const)
    for (const n of names) if (existsSync(join(from, n))) copyFileSync(join(from, n), join(dist, n));
  const problems = checkAssets(expected, readdirSync(dist));
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  writeFileSync(join(dist, CHECKSUMS_ASSET), sumsForDir(dist));
  if (sign) {
    const argv = [
      "cosign",
      "sign-blob",
      "--yes",
      "--bundle",
      join(dist, `${CHECKSUMS_ASSET}.sigstore.json`),
      join(dist, CHECKSUMS_ASSET),
    ];
    console.log(`$ ${argv.join(" ")}`);
    const r = Bun.spawnSync(argv, { stdout: "inherit", stderr: "inherit" });
    if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
  }
  console.log(`${dist}: ${readdirSync(dist).length} files for ${m.tag}`);
}
