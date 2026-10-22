// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Publish one release image: push the per-arch OCI archives by digest, create the multi-arch
 * index tagged `<version>` (and `latest` for stable releases), write its SBOMs and provenance,
 * and, when signing, sign the index and its children and attach the SBOMs and provenance as
 * cosign attestations (ADR 0023 §4).
 *
 *   bun scripts/release/publish-image.ts --image api --version 0.1.0 --commit <sha> \
 *     --registry ghcr.io/<owner>/commonair --platforms linux/amd64,linux/arm64 \
 *     --archives <dir with <image>-<arch>.tar> --out <dir> [--latest true|false] [--sign true|false]
 *
 * Writes `<out>/<image>.digest`, `<out>/<image sbom per platform>` and the provenance predicate.
 * Registries on localhost (the dry-run Zot) are spoken to over plain HTTP.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { imageAssetBase, imageProvenanceAsset, sbomAsset } from "./assets.ts";
import { parsePlatforms, type Platform } from "./images.ts";
import { RELEASE_IMAGES, type ReleaseImage } from "./manifest.ts";
import { contextFromEnv, slsaPredicate } from "./provenance.ts";

const DIGEST = /^sha256:[0-9a-f]{64}$/;

export interface PublishOptions {
  image: ReleaseImage;
  version: string;
  registry: string;
  platforms: Platform[];
  archives: string;
}

/** A registry on the runner itself has no TLS. */
export function isInsecure(registry: string): boolean {
  return /^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(registry);
}

export const archiveName = (image: string, platform: Platform) => `${image}-${platform.split("/")[1]}.tar`;
export const localList = (o: Pick<PublishOptions, "image" | "version">) =>
  `localhost/commonair-release/${o.image}:${o.version}`;
export const remoteRef = (o: Pick<PublishOptions, "image" | "registry">) => `${o.registry}/${o.image}`;

/** Commands that create the index from the per-arch archives and push it under `tag`. */
export function indexArgv(o: PublishOptions, tag: string, digestFile: string): string[][] {
  const list = localList(o);
  const tls = isInsecure(o.registry) ? ["--tls-verify=false"] : [];
  return [
    ["podman", "manifest", "create", list],
    ...o.platforms.map((p) => [
      "podman",
      "manifest",
      "add",
      list,
      `oci-archive:${join(o.archives, archiveName(o.image, p))}`,
    ]),
    [
      "podman",
      "manifest",
      "push",
      "--all",
      "--format",
      "oci",
      ...tls,
      "--digestfile",
      digestFile,
      list,
      `docker://${remoteRef(o)}:${tag}`,
    ],
  ];
}

export function sbomArgv(o: PublishOptions, digest: string, platform: Platform, out: string): string[] {
  return [
    "syft",
    "scan",
    `registry:${remoteRef(o)}@${digest}`,
    "--platform",
    platform,
    "--output",
    `cyclonedx-json=${out}`,
  ];
}

export function signArgv(o: PublishOptions, digest: string, sboms: string[], provenance: string): string[][] {
  const ref = `${remoteRef(o)}@${digest}`;
  const insecure = isInsecure(o.registry) ? ["--allow-http-registry", "--allow-insecure-registry"] : [];
  return [
    // --recursive signs the index and every per-arch manifest it lists.
    ["cosign", "sign", "--yes", "--recursive", ...insecure, ref],
    ...sboms.map((s) => ["cosign", "attest", "--yes", ...insecure, "--type", "cyclonedx", "--predicate", s, ref]),
    ["cosign", "attest", "--yes", ...insecure, "--type", "slsaprovenance1", "--predicate", provenance, ref],
  ];
}

function run(argv: string[], env: Record<string, string> = {}): void {
  console.log(`$ ${argv.join(" ")}`);
  const r = Bun.spawnSync(argv, { env: { ...process.env, ...env }, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`${argv.slice(0, 3).join(" ")} failed (exit ${r.exitCode})`);
}

function readDigest(file: string): string {
  const d = readFileSync(file, "utf8").trim();
  if (!DIGEST.test(d)) throw new Error(`unexpected digest in ${file}: ${d}`);
  return d;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const flag = (name: string) => opt(name) === "true";
  const image = opt("image");
  const [version, commit, registry, platforms, archives, outArg] = [
    opt("version"),
    opt("commit"),
    opt("registry"),
    opt("platforms"),
    opt("archives"),
    opt("out"),
  ];
  if (!image || !(RELEASE_IMAGES as readonly string[]).includes(image) || !version || !commit || !registry) {
    console.error("usage: publish-image.ts --image <name> --version <v> --commit <sha> --registry <r> …");
    process.exit(2);
  }
  if (!platforms || !archives || !outArg) {
    console.error("publish-image.ts needs --platforms, --archives and --out");
    process.exit(2);
  }
  const out = resolve(outArg);
  mkdirSync(out, { recursive: true });
  const o: PublishOptions = {
    image: image as ReleaseImage,
    version,
    registry,
    platforms: parsePlatforms(platforms),
    archives: resolve(archives),
  };

  // Index under <version>; pushing the same list again under `latest` must give the same digest.
  const digestFile = join(out, `${o.image}.digest`);
  Bun.spawnSync(["podman", "manifest", "rm", localList(o)]);
  for (const argv of indexArgv(o, o.version, digestFile)) run(argv);
  const digest = readDigest(digestFile);
  writeFileSync(digestFile, `${digest}\n`);
  if (flag("latest")) {
    const latestFile = join(out, `${o.image}.latest-digest`);
    const push = indexArgv(o, "latest", latestFile).at(-1) as string[];
    run(push);
    if (readDigest(latestFile) !== digest) throw new Error("latest and version tags resolved to different digests");
    rmSync(latestFile);
  }
  console.log(`${remoteRef(o)}:${o.version}@${digest}`);

  const syftEnv: Record<string, string> = isInsecure(o.registry) ? { SYFT_REGISTRY_INSECURE_USE_HTTP: "true" } : {};
  const sboms = o.platforms.map((p) => {
    const file = join(out, sbomAsset(imageAssetBase(o.image, o.version, p)));
    run(sbomArgv(o, digest, p, file), syftEnv);
    return file;
  });
  const provenance = join(out, imageProvenanceAsset(o.image, o.version));
  const predicate = slsaPredicate(contextFromEnv(process.env), {
    artifact: `${remoteRef(o)}@${digest}`,
    version,
    commit,
  });
  writeFileSync(provenance, `${JSON.stringify(predicate, null, 2)}\n`);
  if (flag("sign")) for (const argv of signArgv(o, digest, sboms, provenance)) run(argv);
}
