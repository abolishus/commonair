// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Release notes from Conventional Commits (ADR 0023 §5).
 *
 *   bun scripts/release/changelog.ts --to <ref> --version <x.y.z> [--from <ref>] [--repo <url>] [--out <file>]
 *
 * `--from` defaults to the nearest `v*` tag before `--to` (all history when there is none).
 * Breaking changes (`type!:` or a `BREAKING CHANGE:` footer) come first, then the types in
 * TYPE_ORDER, then everything that is not a Conventional Commit under "Other". Trailers
 * (Signed-off-by, Co-Authored-By, …) never reach the notes.
 */
import { writeFileSync } from "node:fs";

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
    out.push("", "No changes.");
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
  return `${out.join("\n")}\n`;
}

function git(args: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["git", ...args]);
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim() };
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
    console.error("usage: changelog.ts --version <x.y.z> [--to <ref>] [--from <ref>] [--repo <url>] [--out <file>]");
    process.exit(2);
  }
  const from = opt("from") ?? previousTag(to);
  const notes = releaseNotes(commitsBetween(from, to), { version, previousTag: from, repoUrl: opt("repo") });
  const out = opt("out");
  if (out) writeFileSync(out, notes);
  else process.stdout.write(notes);
}
