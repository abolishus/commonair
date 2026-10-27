// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Stub executables for the shell tests, each written once per content and linked into a fixture.
 *
 * macOS scans every newly written executable on its first exec (XProtect, about half a second,
 * serialized through one daemon); fixtures that wrote a dozen fresh stubs per test spent most of
 * their time there, and running test files side by side only lengthened the queue. A cached file
 * is scanned once, so the cache is content-addressed and outlives a run. Files in it are
 * read-only: a test that writes through a link fails instead of changing every other test's stub.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CACHE = join(tmpdir(), "commonair-test-exec");

/** The cached executable with this content (written on first use). */
export function cachedExecutable(content: string): string {
  const path = join(CACHE, createHash("sha256").update(content).digest("hex").slice(0, 24));
  if (existsSync(path)) return path;
  mkdirSync(CACHE, { recursive: true });
  // Written aside and renamed: a concurrent test file never sees a half-written stub.
  const tmp = `${path}.${process.pid}.${crypto.randomUUID()}`;
  writeFileSync(tmp, content);
  chmodSync(tmp, 0o555);
  renameSync(tmp, path);
  return path;
}

/** Links `dir/<name>` to a cached executable per entry, replacing whatever is there. */
export function linkExecutables(dir: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const link = join(dir, name);
    rmSync(link, { force: true });
    symlinkSync(cachedExecutable(content), link);
  }
}
