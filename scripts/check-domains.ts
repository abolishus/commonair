// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Fails if the site's domain or contact addresses appear outside the config
 * module. Code must import them from `@commonair/config/site`.
 *
 * Prose (Markdown) is exempt: governance docs, ADRs and SECURITY.md need to
 * name the flagship's addresses. Code, configs and templates are not exempt.
 */
import { readFileSync } from "node:fs";
import { PROTECTED_LITERALS } from "../packages/config/src/site.ts";

const ALLOWED_FILES = new Set(["packages/config/src/site.ts"]);
const EXEMPT = [/\.mdx?$/, /^LICENSES\//, /^LICENSE$/, /\.(png|jpe?g|webp|ico|woff2?|ttf|mp4|ts\.snap)$/];

export function listFiles(): string[] {
  const out = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (out.exitCode !== 0) throw new Error(out.stderr.toString());
  return out.stdout.toString().split("\0").filter(Boolean);
}

export function findStrayLiterals(
  files: Iterable<[path: string, content: string]>,
  literals: readonly string[] = PROTECTED_LITERALS,
): string[] {
  const problems: string[] = [];
  for (const [path, content] of files) {
    if (ALLOWED_FILES.has(path) || EXEMPT.some((r) => r.test(path))) continue;
    const lower = content.toLowerCase();
    for (const lit of literals) {
      let idx = lower.indexOf(lit.toLowerCase());
      while (idx !== -1) {
        const line = content.slice(0, idx).split("\n").length;
        problems.push(`${path}:${line}: hard-coded "${lit}" (import SITE from @commonair/config/site)`);
        idx = lower.indexOf(lit.toLowerCase(), idx + lit.length);
      }
    }
  }
  return problems;
}

if (import.meta.main) {
  const files = listFiles().flatMap((p): [string, string][] => {
    try {
      return [[p, readFileSync(p, "utf8")]];
    } catch {
      return []; // deleted in the working tree
    }
  });
  const problems = findStrayLiterals(files);
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    console.error(`\n${problems.length} stray domain/contact literal(s).`);
    process.exit(1);
  }
  console.log(`check-domains: ${files.length} files clean`);
}
