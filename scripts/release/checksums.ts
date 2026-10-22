// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `SHA256SUMS` over every release asset in a directory, in `sha256sum` format (two spaces,
 * sorted by name), so operators can check it with `sha256sum -c` and `selfhost.sh` can parse it.
 *
 *   bun scripts/release/checksums.ts <dir>   → writes <dir>/SHA256SUMS
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHECKSUMS_ASSET } from "./manifest.ts";
import { sha256Hex } from "./tools.ts";

/** Never listed: the sums file itself and its signature bundle. */
export const EXCLUDED = new Set([CHECKSUMS_ASSET, `${CHECKSUMS_ASSET}.sigstore.json`]);

export function formatSums(entries: { name: string; sha256: string }[]): string {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of sorted) {
    if (!/^[0-9a-f]{64}$/.test(e.sha256)) throw new Error(`bad sha256 for ${e.name}`);
    if (e.name.includes("/") || /\s/.test(e.name)) throw new Error(`asset names must be flat and unspaced: ${e.name}`);
  }
  return sorted.map((e) => `${e.sha256}  ${e.name}\n`).join("");
}

export function sumsForDir(dir: string): string {
  const entries = readdirSync(dir)
    .filter((name) => !EXCLUDED.has(name) && statSync(join(dir, name)).isFile())
    .map((name) => ({ name, sha256: sha256Hex(readFileSync(join(dir, name))) }));
  if (entries.length === 0) throw new Error(`no assets in ${dir}`);
  return formatSums(entries);
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: checksums.ts <dir>");
    process.exit(2);
  }
  const sums = sumsForDir(dir);
  writeFileSync(join(dir, CHECKSUMS_ASSET), sums);
  console.log(`${join(dir, CHECKSUMS_ASSET)}: ${sums.trim().split("\n").length} assets`);
}
