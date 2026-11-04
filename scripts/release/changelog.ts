// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Release notes from Conventional Commits (ADR 0023 §5).
 *
 *   bun scripts/release/changelog.ts --to <ref> --version <x.y.z> [--from <ref> | --since-tag <tag>]
 *       [--repo <url>] [--platforms linux/amd64,linux/arm64] [--out <file>]
 *   bun scripts/release/changelog.ts --version <x.y.z> --check [--changelog <file>]
 *
 * With `--platforms`, the notes end with the CPU features an image needs on those platforms
 * beyond the baseline (CPU_REQUIREMENTS: whisper's AVX2 on amd64).
 *
 * The range starts at `--from`, else at `--since-tag`, whose default is the newest `v*` tag that is
 * not a prerelease and is already in `--to`'s history, leaving out the tag being released and any
 * tag on `--to` itself. U3 cuts a minor every two weeks: its notes run from the last minor or
 * patch, not from its own release candidates. Before the first such release (only `-rc` tags, as
 * for `v0.1.0`) it falls back to the nearest `v*` tag before `--to`, and to all history when there
 * is none.
 *
 * `--check` reads `CHANGELOG.md` (or `--changelog`) and exits 1 unless it has a section for
 * `--version` (`## [<version>]`), so a release cannot go out without its curated notes. For a
 * release that is not a prerelease the heading must also carry its date (`## [0.1.0] - 2026-11-16`),
 * so a section still marked "unreleased" cannot ship. It needs no git.
 *
 * Breaking changes (`type!:` or a `BREAKING CHANGE:` footer) come first, then the types in
 * TYPE_ORDER, then everything that is not a Conventional Commit under "Other". Trailers
 * (Signed-off-by, Co-Authored-By, …) never reach the notes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePlatforms } from "./images.ts";
import { cpuRequirementLines, cpuRequirements } from "./manifest.ts";

export interface Commit {
  sha: string;
  subject: string;
  body: string;
}

export interface ParsedCommit {
  sha: string;
  type: string | null;
  scope: string | null;
  description: string;
  breaking: boolean;
  /** Text of a `BREAKING CHANGE:` footer, if any. */
  breakingNote: string | null;
}

export const TYPE_ORDER = ["feat", "fix", "perf", "refactor", "docs", "build", "ci", "test", "chore"] as const;
export const TYPE_TITLES: Record<(typeof TYPE_ORDER)[number], string> = {
  feat: "Features",
  fix: "Fixes",
  perf: "Performance",
  refactor: "Refactoring",
  docs: "Documentation",
  build: "Build",
  ci: "CI",
  test: "Tests",
  chore: "Chores",
};

// Field and record separators for `git log --format`; neither appears in commit messages.
const FS = "\x1f";
const RS = "\x1e";
export const GIT_LOG_FORMAT = `%H${FS}%s${FS}%b${RS}`;

export function parseGitLog(raw: string): Commit[] {
  return raw
    .split(RS)
    .map((r) => r.replace(/^\n+/, ""))
    .filter((r) => r.trim() !== "")
    .map((r) => {
      const [sha = "", subject = "", body = ""] = r.split(FS);
      return { sha: sha.trim(), subject: subject.trim(), body: body.trim() };
    });
}

const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^()\r\n]+)\))?(?<bang>!)?: (?<desc>\S.*)$/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE: *(.+)$/m;

export function parseCommit(c: Commit): ParsedCommit {
  const m = HEADER.exec(c.subject);
  const footer = BREAKING_FOOTER.exec(c.body);
  const breakingNote = footer?.[1]?.trim() ?? null;
  if (!m?.groups)
    return { sha: c.sha, type: null, scope: null, description: c.subject, breaking: false, breakingNote: null };
  return {
    sha: c.sha,
    type: m.groups.type ?? null,
    scope: m.groups.scope?.trim() ?? null,
    description: m.groups.desc ?? c.subject,
    breaking: m.groups.bang === "!" || breakingNote !== null,
    breakingNote,
  };
}

export interface NotesOptions {
  version: string;
  previousTag: string | null;
  /** Repository web URL, for commit links. */
  repoUrl?: string;
  /** Images that need more of a CPU than their platform's baseline (cpuRequirementLines). */
  requirements?: string[];
}

function requirementsSection(lines: string[] | undefined): string[] {
  if (!lines || lines.length === 0) return [];
  return [
    "",
    "### Platform requirements",
    "",
    ...lines.map((l) => `- ${l}; selfhost.sh checks the host before it runs that image.`),
  ];
}

function line(c: ParsedCommit, repoUrl?: string): string {
  const short = c.sha.slice(0, 7);
  const ref = repoUrl ? `[${short}](${repoUrl}/commit/${c.sha})` : short;
  const scope = c.scope ? `**${c.scope}:** ` : "";
  return `- ${scope}${c.description} (${ref})`;
}

/** Markdown release notes. Commits come newest first, as `git log` lists them. */
export function releaseNotes(commits: Commit[], opts: NotesOptions): string {
  const parsed = commits.map(parseCommit);
  const out: string[] = [];
  const since = opts.previousTag ? `since ${opts.previousTag}` : "since the first commit";
  out.push(`Changes in ${opts.version}, ${since}.`);
  if (parsed.length === 0) {
    out.push("", "No changes.", ...requirementsSection(opts.requirements));
    return `${out.join("\n")}\n`;
  }

  const breaking = parsed.filter((c) => c.breaking);
  if (breaking.length > 0) {
    out.push("", "### Breaking changes", "");
    for (const c of breaking) {
      out.push(line(c, opts.repoUrl));
      if (c.breakingNote) out.push(`  ${c.breakingNote}`);
    }
  }
  for (const type of TYPE_ORDER) {
    const group = parsed.filter((c) => c.type === type);
    if (group.length === 0) continue;
    out.push("", `### ${TYPE_TITLES[type]}`, "");
    for (const c of group) out.push(line(c, opts.repoUrl));
  }
  const known = new Set<string>(TYPE_ORDER);
  const other = parsed.filter((c) => c.type === null || !known.has(c.type));
  if (other.length > 0) {
    out.push("", "### Other", "");
    for (const c of other)
      out.push(line(c.type === null ? c : { ...c, description: `${c.type}: ${c.description}` }, opts.repoUrl));
  }
  out.push(...requirementsSection(opts.requirements));
  return `${out.join("\n")}\n`;
}

function git(args: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["git", ...args]);
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim() };
}

// Semver 2.0 core plus an optional prerelease, no build metadata: what release tags are (manifest.ts).
const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** Prerelease identifiers (`rc.2` is ["rc", "2"]); empty for a release. */
  pre: string[];
}

/** A version or a `v` tag, or null when it is not semver. */
export function parseVersion(v: string): Version | null {
  const m = SEMVER.exec(v);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split(".") : [] };
}

/** Semver precedence (§11): negative when a ranks below b. Throws on a value that is not semver. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x) throw new Error(`not a version: ${a}`);
  if (!y) throw new Error(`not a version: ${b}`);
  for (const k of ["major", "minor", "patch"] as const) if (x[k] !== y[k]) return x[k] - y[k];
  // A release ranks above its own prereleases.
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

export const isPrerelease = (tag: string): boolean => (parseVersion(tag)?.pre.length ?? 0) > 0;

/**
 * `--since-tag`'s default from the tags already in `--to`'s history: the newest `v*` tag that is
 * not a prerelease, leaving out `exclude` (the tag being released, any tag on `--to`). Tags that
 * are not semver are ignored. Null when there is none.
 */
export function newestReleaseTag(tags: readonly string[], exclude: readonly string[] = []): string | null {
  let best: string | null = null;
  for (const t of tags) {
    if (!t.startsWith("v") || parseVersion(t) === null || isPrerelease(t) || exclude.includes(t)) continue;
    if (best === null || compareVersions(t, best) > 0) best = t;
  }
  return best;
}

/** Whether a Keep a Changelog file has a section for `version`: `## [0.1.0]`, dated or not. */
export function hasChangelogSection(markdown: string, version: string): boolean {
  const v = version.replace(/^v/, "");
  return markdown.split("\n").some((l) => {
    const m = /^## \[([^\]]+)\](?:\s+-\s+\S.*)?\s*$/.exec(l);
    return m?.[1] === v;
  });
}

/**
 * Why `--check` refuses `version` (null: it passes). A prerelease needs only its section; a
 * release needs the section dated `YYYY-MM-DD`, not "unreleased" or missing.
 */
export function changelogSectionProblem(markdown: string, version: string): string | null {
  const v = version.replace(/^v/, "");
  if (!hasChangelogSection(markdown, v))
    return `has no section for ${v}; add "## [${v}] - <YYYY-MM-DD>" before releasing`;
  if (isPrerelease(`v${v}`)) return null;
  const dated = new RegExp(`^## \\[${v.replace(/\./g, "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}\\s*$`, "m");
  return dated.test(markdown)
    ? null
    : `section ${v} is not dated; change its heading to "## [${v}] - <YYYY-MM-DD>" before releasing`;
}

/** `--since-tag`'s default for a release of `version` at `to` (newestReleaseTag over git's tags). */
export function defaultSinceTag(to: string, version: string): string | null {
  const merged = git(["tag", "--list", "v[0-9]*", "--merged", to]);
  if (!merged.ok) return null;
  const atTo = git(["tag", "--list", "v[0-9]*", "--points-at", to]);
  const exclude = [`v${version.replace(/^v/, "")}`, ...(atTo.ok ? atTo.out.split("\n").filter(Boolean) : [])];
  return newestReleaseTag(merged.out.split("\n").filter(Boolean), exclude);
}

/** The nearest `v*` tag strictly before `to`, or null when there is none. */
export function previousTag(to: string): string | null {
  const r = git(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", `${to}^`]);
  return r.ok && r.out !== "" ? r.out : null;
}

export function commitsBetween(from: string | null, to: string): Commit[] {
  const range = from ? `${from}..${to}` : to;
  const r = git(["log", "--no-merges", `--format=${GIT_LOG_FORMAT}`, range]);
  if (!r.ok) throw new Error(`git log ${range} failed`);
  return parseGitLog(r.out);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const to = opt("to") ?? "HEAD";
  const version = opt("version");
  if (!version) {
    console.error(
      "usage: changelog.ts --version <x.y.z> [--to <ref>] [--from <ref> | --since-tag <tag>] [--repo <url>] " +
        "[--platforms <list>] [--out <file>]\n       changelog.ts --version <x.y.z> --check [--changelog <file>]",
    );
    process.exit(2);
  }
  if (args.includes("--check")) {
    const file = opt("changelog") ?? join(import.meta.dir, "../../CHANGELOG.md");
    const v = version.replace(/^v/, "");
    const problem = changelogSectionProblem(readFileSync(file, "utf8"), v);
    if (problem) {
      console.error(`changelog: ${file} ${problem}`);
      process.exit(1);
    }
    process.stdout.write(`changelog: ${file} has a section for ${v}\n`);
    process.exit(0);
  }
  const from = opt("from") ?? opt("since-tag") ?? defaultSinceTag(to, version) ?? previousTag(to);
  const platforms = opt("platforms");
  const notes = releaseNotes(commitsBetween(from, to), {
    version,
    previousTag: from,
    repoUrl: opt("repo"),
    requirements: platforms ? cpuRequirementLines(cpuRequirements(parsePlatforms(platforms))) : undefined,
  });
  const out = opt("out");
  if (out) writeFileSync(out, notes);
  else process.stdout.write(notes);
}
