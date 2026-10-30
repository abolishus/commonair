// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Which of CI's expensive jobs a push needs (`ci.yml` job `changes`). The gate always runs; the
 * harness shards skip a push that touches only docs and briefs; the release dry run and the
 * self-host end-to-end runs only when something they build or install changed. The nightly run and
 * a manual dispatch run everything, as does any push whose diff cannot be read.
 *
 * Usage (CI): `bun scripts/ci-changes.ts` with EVENT_NAME, BASE (the last green run's commit on
 * main) and SHA set; writes `code` and `deploy` to $GITHUB_OUTPUT. No dependencies: the job runs it
 * before `bun install`.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

export interface Changes {
  /** Anything beyond docs and briefs: the harness runs. */
  code: boolean;
  /** Images, the installer, release tooling, compose, workflows, lockfiles or migrations. */
  deploy: boolean;
}

export const EVERYTHING: Changes = { code: true, deploy: true };

/** Docs and planning text no test or build reads (docs/testing, docs/self-hosting and docs/developers are read by tests). */
export function isDocsOnly(path: string): boolean {
  if (path.startsWith(".claude/")) return true;
  if (path.startsWith("docs/")) return !/^docs\/(testing|self-hosting|developers)\//.test(path) && path.endsWith(".md");
  // Top-level prose (README, PROGRESS, PLAN, CHANGELOG, …); nested READMEs are prose too.
  if (!path.includes("/") && path.endsWith(".md")) return true;
  return /(^|\/)README\.md$/.test(path) && !path.startsWith("packages/db/src/legal/");
}

const DEPLOY: readonly RegExp[] = [
  /^infra\//,
  /^scripts\/selfhost(\.sh|\/)/,
  /^scripts\/release\//,
  /^scripts\/infra\.ts$/,
  /(^|\/)compose[^/]*\.ya?ml$/,
  /Containerfile/,
  /^\.github\/workflows\/(ci|release)\.yml$/,
  /(^|\/)bun\.lock$/,
  /^package\.json$/,
  /^relay\/go\.(mod|sum)$/,
  /^packages\/db\/drizzle\//,
  /^\.env\.example$/,
];

export const isDeploy = (path: string): boolean => DEPLOY.some((re) => re.test(path));

export function classify(files: readonly string[]): Changes {
  return { code: files.some((f) => !isDocsOnly(f)), deploy: files.some(isDeploy) };
}

/** A push's changes since BASE, or everything when the event is not a push or the diff cannot be read. */
export function changesFor(env: { EVENT_NAME?: string; BASE?: string; SHA?: string }): Changes {
  const { EVENT_NAME, BASE, SHA } = env;
  if (EVENT_NAME !== "push" || !BASE || !SHA || /^0+$/.test(BASE)) return EVERYTHING;
  try {
    const out = execFileSync("git", ["diff", "--name-only", BASE, SHA], { encoding: "utf8" });
    const files = out.split("\n").filter(Boolean);
    return files.length === 0 ? EVERYTHING : classify(files);
  } catch {
    return EVERYTHING;
  }
}

if (import.meta.main) {
  const { EVENT_NAME, BASE, SHA } = process.env;
  const changes = changesFor({ EVENT_NAME, BASE, SHA });
  const lines = `code=${changes.code}\ndeploy=${changes.deploy}\n`;
  process.stdout.write(lines);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
}
