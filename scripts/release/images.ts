// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The release image build matrix, read from compose.yaml's build sections (the source of truth
 * for how each image is built) plus the relay's own Containerfile.
 *
 *   bun scripts/release/images.ts matrix --platforms linux/amd64,linux/arm64
 *       → JSON [{ image, platform, arch, runner }] for a GitHub Actions matrix
 *   bun scripts/release/images.ts build --image api --platform linux/arm64 --version 0.1.0 \
 *       --commit <sha> --source <repo url> --out dist/images/api-arm64.tar [--dry-print]
 *       → podman build + podman save (OCI archive); --dry-print only prints the commands
 *
 * Builds run natively per architecture (no QEMU), so `--platform` must match the runner.
 */
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { RELEASE_IMAGES, RELEASE_PLATFORMS, type ReleaseImage } from "./manifest.ts";

export interface ImageBuild {
  image: ReleaseImage;
  /** Build context, relative to the repository root. */
  context: string;
  /** Containerfile path, relative to the repository root. */
  containerfile: string;
  /** Build args exactly as compose passes them. */
  args: Record<string, string>;
}

export type Platform = (typeof RELEASE_PLATFORMS)[number];

/** GitHub-hosted native runner per platform. */
export const RUNNERS: Record<Platform, string> = {
  "linux/amd64": "ubuntu-24.04",
  "linux/arm64": "ubuntu-24.04-arm",
};

const IMAGE_NAME = /\/([a-z0-9-]+):\$\{IMAGE_TAG/;

interface ComposeService {
  image?: string;
  build?: string | { context?: string; dockerfile?: string; args?: Record<string, unknown> | string[] };
}

function argsRecord(args: Record<string, unknown> | string[] | undefined): Record<string, string> {
  if (!args) return {};
  if (Array.isArray(args))
    return Object.fromEntries(
      args.map((a) => {
        const i = a.indexOf("=");
        return i < 0 ? [a, ""] : [a.slice(0, i), a.slice(i + 1)];
      }),
    );
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)]));
}

/** Every image compose builds from our Containerfiles, one entry per image name. */
export function composeBuilds(composeYaml: string): ImageBuild[] {
  const doc = Bun.YAML.parse(composeYaml) as { services?: Record<string, ComposeService> };
  const byImage = new Map<string, ImageBuild>();
  for (const [service, s] of Object.entries(doc.services ?? {})) {
    if (!s.build) continue;
    const name = s.image ? IMAGE_NAME.exec(s.image)?.[1] : undefined;
    if (!name) throw new Error(`compose service ${service} builds an image without a templated name: ${s.image}`);
    if (!(RELEASE_IMAGES as readonly string[]).includes(name))
      throw new Error(`compose builds ${name} (service ${service}), which is not in RELEASE_IMAGES`);
    const b = typeof s.build === "string" ? { context: s.build } : s.build;
    const context = (b.context ?? ".").replace(/^\.\/?$/, ".");
    const build: ImageBuild = {
      image: name as ReleaseImage,
      context,
      containerfile: b.dockerfile
        ? context === "."
          ? b.dockerfile
          : `${context}/${b.dockerfile}`
        : `${context}/Containerfile`,
      args: argsRecord(b.args),
    };
    const seen = byImage.get(name);
    // migrate and garage-init share the tools image: they must build it the same way.
    if (seen && JSON.stringify(seen) !== JSON.stringify(build))
      throw new Error(`compose builds ${name} two different ways (service ${service})`);
    byImage.set(name, build);
  }
  return [...byImage.values()];
}

/** The relay is not in compose; it builds from relay/ with its own Containerfile. */
export const RELAY_BUILD: ImageBuild = {
  image: "relay",
  context: "relay",
  containerfile: "relay/Containerfile",
  args: {},
};

/** All release builds, in RELEASE_IMAGES order. Throws unless they cover it exactly. */
export function releaseBuilds(composeYaml: string): ImageBuild[] {
  const builds = [...composeBuilds(composeYaml), RELAY_BUILD];
  const names = builds.map((b) => b.image);
  const missing = RELEASE_IMAGES.filter((n) => !names.includes(n));
  if (missing.length > 0) throw new Error(`no build for release images: ${missing.join(", ")}`);
  if (new Set(names).size !== names.length) throw new Error("duplicate release image builds");
  return RELEASE_IMAGES.map((n) => builds.find((b) => b.image === n) as ImageBuild);
}

export function parsePlatforms(list: string): Platform[] {
  const items = list
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (items.length === 0) throw new Error("no platforms");
  for (const p of items)
    if (!(RELEASE_PLATFORMS as readonly string[]).includes(p))
      throw new Error(`unsupported platform ${p} (want one of ${RELEASE_PLATFORMS.join(", ")})`);
  return RELEASE_PLATFORMS.filter((p) => items.includes(p));
}

export interface MatrixEntry {
  image: ReleaseImage;
  platform: Platform;
  arch: string;
  runner: string;
}

export function buildMatrix(builds: ImageBuild[], platforms: Platform[]): MatrixEntry[] {
  return builds.flatMap((b) =>
    platforms.map((platform) => ({
      image: b.image,
      platform,
      arch: platform.split("/")[1] as string,
      runner: RUNNERS[platform],
    })),
  );
}

/** `ARG` names a Containerfile declares; build args it does not declare are not passed. */
export function declaredArgs(containerfile: string): Set<string> {
  const names = new Set<string>();
  for (const m of containerfile.matchAll(/^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) names.add(m[1] as string);
  return names;
}

export interface BuildOptions {
  platform: Platform;
  version: string;
  commit: string;
  /** Repository web URL, for org.opencontainers.image.source. */
  source: string;
  /** RFC 3339 build time; use the commit time so rebuilds of a commit agree. */
  created: string;
  /** Local tag for the built image. */
  tag: string;
  /** ARGs the Containerfile declares (see declaredArgs). */
  declared: Set<string>;
}

/**
 * `org.opencontainers.image.licenses` per image (SPDX): the main work plus what we add on top.
 * FFmpeg from Debian (with libx264) is GPL-2.0-or-later; the probe images add BusyBox
 * (GPL-2.0-only); our Postgres adds WAL-G (Apache-2.0). Base OS packages are in the SBOM.
 */
export const IMAGE_LICENSES: Record<ReleaseImage, string> = {
  api: "AGPL-3.0-or-later AND GPL-2.0-or-later",
  chat: "AGPL-3.0-or-later",
  irc: "AGPL-3.0-or-later",
  media: "AGPL-3.0-or-later AND GPL-2.0-or-later",
  origin: "AGPL-3.0-or-later",
  "otel-collector": "Apache-2.0 AND GPL-2.0-only",
  loki: "AGPL-3.0-only AND GPL-2.0-only",
  postgres: "PostgreSQL AND Apache-2.0",
  relay: "AGPL-3.0-or-later",
  tempo: "AGPL-3.0-only AND GPL-2.0-only",
  tools: "AGPL-3.0-or-later",
  tracker: "AGPL-3.0-or-later",
  web: "AGPL-3.0-or-later",
  worker: "AGPL-3.0-or-later AND GPL-2.0-or-later",
};

/** RFC 3339 in UTC, second precision: the same instant always renders the same string. */
export function utcTimestamp(time: string): string {
  const ms = Date.parse(time);
  if (!Number.isFinite(ms)) throw new Error(`invalid created time: ${time}`);
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** OCI metadata, applied both as image labels and as manifest annotations. */
export function ociMetadata(b: ImageBuild, o: Pick<BuildOptions, "version" | "commit" | "source" | "created">) {
  return {
    "org.opencontainers.image.title": `commonair-${b.image}`,
    "org.opencontainers.image.source": o.source,
    "org.opencontainers.image.revision": o.commit,
    "org.opencontainers.image.version": o.version,
    "org.opencontainers.image.licenses": IMAGE_LICENSES[b.image],
    "org.opencontainers.image.created": utcTimestamp(o.created),
  };
}

/**
 * The exact `podman build` argv. Compose's args first; SOURCE_COMMIT and VERSION only when
 * the Containerfile declares them (the service image reports its commit, the relay its version).
 */
export function buildArgv(b: ImageBuild, o: BuildOptions): string[] {
  const args: Record<string, string> = { ...b.args };
  if (o.declared.has("SOURCE_COMMIT")) args.SOURCE_COMMIT = o.commit;
  if (o.declared.has("VERSION")) args.VERSION = o.version;
  const meta = ociMetadata(b, o);
  const epoch = Math.floor(Date.parse(o.created) / 1000);
  return [
    "podman",
    "build",
    "--platform",
    o.platform,
    "--file",
    b.containerfile,
    // Layer and config timestamps from the commit, not the clock.
    "--timestamp",
    String(epoch),
    "--pull=missing",
    "--format",
    "oci",
    ...Object.entries(args).flatMap(([k, v]) => ["--build-arg", `${k}=${v}`]),
    ...Object.entries(meta).flatMap(([k, v]) => ["--label", `${k}=${v}`, "--annotation", `${k}=${v}`]),
    "--tag",
    o.tag,
    b.context,
  ];
}

export function saveArgv(tag: string, out: string): string[] {
  return ["podman", "save", "--format", "oci-archive", "--output", out, tag];
}

function run(argv: string[]): void {
  console.log(`$ ${argv.map((a) => (/^[\w./:=@,+-]+$/.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`)).join(" ")}`);
  const r = Bun.spawnSync(argv, { stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`${argv[0]} ${argv[1]} failed (exit ${r.exitCode})`);
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const builds = releaseBuilds(readFileSync("compose.yaml", "utf8"));
  if (cmd === "matrix") {
    console.log(JSON.stringify(buildMatrix(builds, parsePlatforms(opt("platforms") ?? RELEASE_PLATFORMS.join(",")))));
  } else if (cmd === "build") {
    const image = opt("image");
    const build = builds.find((b) => b.image === image);
    const [platform] = parsePlatforms(opt("platform") ?? "");
    const version = opt("version");
    const commit = opt("commit");
    const source = opt("source");
    const out = opt("out");
    if (!build || !platform || !version || !commit || !source || !out) {
      console.error(
        "usage: images.ts build --image <name> --platform <os/arch> --version <v> --commit <sha> --source <url> --out <file.tar> [--created <rfc3339>] [--dry-print]",
      );
      process.exit(2);
    }
    const created =
      opt("created") ?? Bun.spawnSync(["git", "show", "-s", "--format=%cI", commit]).stdout.toString().trim();
    const tag = `localhost/commonair/${build.image}:${version}-${platform.split("/")[1]}`;
    const declared = declaredArgs(readFileSync(build.containerfile, "utf8"));
    const steps = [
      buildArgv(build, { platform, version, commit, source, created, tag, declared }),
      ["mkdir", "-p", dirname(out)],
      saveArgv(tag, out),
    ];
    if (args.includes("--dry-print")) for (const s of steps) console.log(s.join(" "));
    else for (const s of steps) run(s);
  } else {
    console.error("usage: images.ts matrix|build …");
    process.exit(2);
  }
}
