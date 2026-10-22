// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The release plan: which tag, version, commit and registry a release workflow run builds,
 * whether it is a dry run, and the build matrix. Run by the release workflow's prepare job,
 * which passes the event and inputs through the environment (never interpolated into shell).
 *
 *   EVENT_NAME, GITHUB_REF, INPUT_TAG, INPUT_DRY_RUN, INPUT_SIGN, INPUT_PLATFORMS,
 *   REPOSITORY_OWNER, RUN_NUMBER  →  key=value lines appended to $GITHUB_OUTPUT
 */
import { appendFileSync, readFileSync } from "node:fs";
import { SITE } from "../../packages/config/src/site.ts";
import { buildMatrix, parsePlatforms, releaseBuilds, type MatrixEntry, type Platform } from "./images.ts";
import { RELEASE_IMAGES, RELEASE_PLATFORMS, isPrerelease, versionFromTag } from "./manifest.ts";

/** Dry runs push to a throwaway registry service container on the runner. */
export const DRY_RUN_REGISTRY = `localhost:5000/${SITE.slug}`;

export interface PlanInput {
  eventName: string;
  ref: string;
  /** Workflow inputs arrive as strings; empty when the event has no inputs (a tag push). */
  inputTag: string;
  inputDryRun: string;
  inputSign: string;
  inputPlatforms: string;
  owner: string;
  runNumber: string;
}

export interface Plan {
  tag: string;
  version: string;
  dryRun: boolean;
  sign: boolean;
  prerelease: boolean;
  /** Move the `latest` tag: stable, real releases only. */
  latest: boolean;
  registry: string;
  platforms: Platform[];
}

/** `ghcr.io/<owner>/commonair`: forks publish under their own namespace with no code change. */
export function registryFor(owner: string): string {
  const host = SITE.containerRegistry.split("/")[0];
  if (!/^[A-Za-z0-9-]+$/.test(owner)) throw new Error(`invalid repository owner: ${owner}`);
  return `${host}/${owner.toLowerCase()}/${SITE.slug}`;
}

export function plan(i: PlanInput): Plan {
  const tagPush = i.eventName === "push" && i.ref.startsWith("refs/tags/");
  // Fail safe: anything that is not a tag push or an explicit dry_run=false is a dry run.
  const dryRun = i.inputDryRun === "true" || (i.inputDryRun === "" && !tagPush);
  let tag = i.inputTag.trim();
  if (tagPush && i.inputDryRun === "") tag = i.ref.slice("refs/tags/".length);
  if (tag === "") {
    if (!dryRun) throw new Error("a release needs a tag");
    if (!/^\d+$/.test(i.runNumber)) throw new Error(`invalid run number: ${i.runNumber}`);
    tag = `v0.0.0-dryrun.${i.runNumber}`;
  }
  // Keyless signatures name the workflow ref (ADR 0023 §3 verifies `release.yml@refs/tags/v…`),
  // and every job must run the tag's code, so a real release runs only from the tag itself.
  if (!dryRun && i.ref !== `refs/tags/${tag}`) {
    throw new Error(
      `a real release must run from refs/tags/${tag}, not ${i.ref}: ` +
        `gh workflow run release.yml --ref ${tag} -f tag=${tag} -f dry_run=false`,
    );
  }
  const version = versionFromTag(tag);
  const prerelease = isPrerelease(version);
  return {
    tag,
    version,
    dryRun,
    sign: !dryRun || i.inputSign === "true",
    prerelease,
    latest: !dryRun && !prerelease,
    registry: dryRun ? DRY_RUN_REGISTRY : registryFor(i.owner),
    platforms: parsePlatforms(i.inputPlatforms.trim() || RELEASE_PLATFORMS.join(",")),
  };
}

export function outputs(p: Plan, commit: string, matrix: MatrixEntry[]): Record<string, string> {
  return {
    tag: p.tag,
    version: p.version,
    commit,
    dry_run: String(p.dryRun),
    sign: String(p.sign),
    prerelease: String(p.prerelease),
    latest: String(p.latest),
    registry: p.registry,
    platforms: p.platforms.join(","),
    build_matrix: JSON.stringify({ include: matrix }),
    images: JSON.stringify(RELEASE_IMAGES),
  };
}

function git(args: string[]): string | null {
  const r = Bun.spawnSync(["git", ...args]);
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}

if (import.meta.main) {
  const env = (k: string) => process.env[k] ?? "";
  const p = plan({
    eventName: env("EVENT_NAME"),
    ref: env("GITHUB_REF"),
    inputTag: env("INPUT_TAG"),
    inputDryRun: env("INPUT_DRY_RUN"),
    inputSign: env("INPUT_SIGN"),
    inputPlatforms: env("INPUT_PLATFORMS"),
    owner: env("REPOSITORY_OWNER"),
    runNumber: env("RUN_NUMBER"),
  });
  // A real release builds exactly the tagged commit; a dry run builds what was checked out.
  const commit = p.dryRun ? git(["rev-parse", "HEAD"]) : git(["rev-parse", `refs/tags/${p.tag}^{commit}`]);
  if (!commit || !/^[0-9a-f]{40}$/.test(commit)) {
    console.error(p.dryRun ? "cannot resolve HEAD" : `tag ${p.tag} does not exist in this repository`);
    process.exit(1);
  }
  const matrix = buildMatrix(releaseBuilds(readFileSync("compose.yaml", "utf8")), p.platforms);
  const out = outputs(p, commit, matrix);
  const lines = Object.entries(out).map(([k, v]) => `${k}=${v}`);
  const target = process.env.GITHUB_OUTPUT;
  if (target) appendFileSync(target, `${lines.join("\n")}\n`);
  for (const [k, v] of Object.entries(out)) if (k !== "build_matrix") console.log(`${k}=${v}`);
  console.log(`build_matrix: ${matrix.length} jobs`);
}
