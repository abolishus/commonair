// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Every shadcn file we ship is either the upstream CLI output (upstream/, made by
 * `bun scripts/shadcn-add.ts --snapshot`) or a deliberate, documented deviation.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { COMPONENTS, upstreamName } from "../scripts/shadcn-add.ts";

const pkgRoot = join(import.meta.dirname, "..");
const deviations = readFileSync(join(pkgRoot, "DEVIATIONS.md"), "utf8");
/** First-column paths of every table row: | `src/components/button.tsx` | … */
const rows = [...deviations.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1]!);

const groups = [
  { dir: "src/components", upstream: "upstream/components", pattern: /\.tsx$/ },
  { dir: "src/hooks", upstream: "upstream/hooks", pattern: /\.ts$/ },
] as const;

const files = groups.flatMap(({ dir, upstream, pattern }) =>
  readdirSync(join(pkgRoot, dir))
    .filter((f) => pattern.test(f))
    .map((f) => ({ path: `${dir}/${f}`, upstream: `${upstream}/${upstreamName(f)}` })),
);

function read(path: string): string | undefined {
  const full = join(pkgRoot, path);
  return existsSync(full) ? readFileSync(full, "utf8") : undefined;
}

describe("DEVIATIONS.md", () => {
  test("lists rows", () => {
    expect(rows.length).toBeGreaterThan(10);
    expect(new Set(rows).size).toBe(rows.length);
  });

  test.each(files.map((f) => [f.path, f] as const))("%s equals upstream or has a row", (_path, file) => {
    const ours = read(file.path);
    const theirs = read(file.upstream);
    expect(theirs, `no upstream file ${file.upstream}; run bun scripts/shadcn-add.ts --snapshot`).toBeDefined();
    expect(ours === theirs || rows.includes(file.path), `${file.path} differs from upstream`).toBe(true);
  });

  test.each(rows)("%s exists", (path) => {
    expect(existsSync(join(pkgRoot, path))).toBe(true);
  });

  test.each(rows.filter((r) => r.startsWith("src/components/") || r.startsWith("src/hooks/")))(
    "%s really deviates (no stale row)",
    (path) => {
      const file = files.find((f) => f.path === path);
      expect(file).toBeDefined();
      expect(read(path)).not.toBe(read(file?.upstream ?? ""));
    },
  );

  test("the snapshot covers every component we carry, and nothing else", () => {
    const upstream = readdirSync(join(pkgRoot, "upstream/components")).map((f) => f.replace(/\.tsx\.txt$/, ""));
    expect(upstream.sort()).toEqual([...COMPONENTS].sort());
    const ours = readdirSync(join(pkgRoot, "src/components")).map((f) => f.replace(/\.tsx$/, ""));
    expect(ours.sort()).toEqual([...COMPONENTS].sort());
  });
});
