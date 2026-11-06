// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * CVE scan of every pinned third-party image with Grype (ADR 0022). Report only: it prints a
 * table of Critical and High advisories that have a fix, and appends it to the GitHub run summary.
 * It exits non-zero only when Grype cannot run or an image cannot be scanned, so a blind scan is
 * never mistaken for a clean one. Grype is installed at its pinned version and hash.
 *
 *   bun scripts/check-image-vulns.ts [--platform linux/arm64]
 */
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { install } from "./release/tools.ts";
import {
  type GrypeReport,
  type ImageVulns,
  imageBearing,
  imageRefs,
  imageVulnTable,
  imageVulns,
} from "./supply-chain.ts";

const platformAt = process.argv.indexOf("--platform");
const platform = platformAt >= 0 ? (process.argv[platformAt + 1] ?? "linux/amd64") : "linux/amd64";
// Grype pulls layers itself; a few at a time keeps it under registry rate limits.
const CONCURRENCY = 4;

const tracked = Bun.spawnSync(["git", "ls-files", "-z"]).stdout.toString().split("\0").filter(Boolean);
const images = [
  ...new Set(
    imageBearing(tracked)
      .filter((p) => existsSync(p))
      .flatMap((p) => imageRefs(readFileSync(p, "utf8")).map((r) => r.ref)),
  ),
].toSorted();

const dir = mkdtempSync(join(tmpdir(), "check-image-vulns-"));
try {
  const grype = await install("grype", dir);
  // One database download up front, so the parallel scans do not race to fetch it.
  const env = { ...process.env, GRYPE_DB_CACHE_DIR: join(dir, "db"), GRYPE_CHECK_FOR_APP_UPDATE: "false" };
  const db = Bun.spawnSync([grype, "db", "update"], { env, timeout: 300_000 });
  if (db.exitCode !== 0) throw new Error(`grype db update failed: ${db.stderr.toString().trim()}`);

  const scan = async (image: string): Promise<ImageVulns> => {
    const proc = Bun.spawn([grype, `registry:${image}`, "--platform", platform, "--only-fixed", "-o", "json", "-q"], {
      env: { ...env, GRYPE_DB_AUTO_UPDATE: "false" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) return { image, critical: [], high: [], error: err.trim().split("\n").at(-1) ?? `exit ${code}` };
    return imageVulns(image, JSON.parse(out) as GrypeReport);
  };

  const rows: ImageVulns[] = [];
  const queue = [...images];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let image = queue.shift(); image; image = queue.shift()) rows.push(await scan(image));
    }),
  );

  const table = imageVulnTable(rows);
  console.log(table);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table);
  if (rows.some((r) => r.error)) process.exitCode = 1;
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
