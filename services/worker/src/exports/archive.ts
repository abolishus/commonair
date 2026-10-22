// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The export archive: one JSON file per entry plus `manifest.json`, zipped with fflate. */
import { EXPORT_FORMAT_VERSION } from "@commonair/contracts/internal";
import { strToU8, zipSync, type Zippable } from "fflate";
import type { ExportKind } from "./collectors.ts";

export const MANIFEST = "manifest.json";

export interface Manifest {
  formatVersion: number;
  kind: ExportKind;
  exportId: string;
  userId: string;
  generatedAt: string;
  files: { name: string; rows: number }[];
}

/**
 * Rows in a file's value: an array's length; for an object, its array members' lengths plus
 * one when it also holds a non-array member (a record such as the account itself); null is 0.
 */
export function countRows(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (Array.isArray(value)) return value.length;
  if (typeof value !== "object") return 1;
  const members = Object.values(value as Record<string, unknown>);
  const arrays = members.filter(Array.isArray);
  if (arrays.length === 0) return 1;
  const records = members.some((m) => m !== null && !Array.isArray(m)) ? 1 : 0;
  return records + arrays.reduce((n, a) => n + a.length, 0);
}

// Dates become ISO 8601 UTC (Date#toJSON); bigint never reaches here (cents are numbers).
const json = (value: unknown) => strToU8(`${JSON.stringify(value, null, 2)}\n`);

export function buildArchive(input: {
  kind: ExportKind;
  exportId: string;
  userId: string;
  generatedAt: Date;
  files: ReadonlyMap<string, unknown>;
}): { bytes: Uint8Array; manifest: Manifest } {
  const manifest: Manifest = {
    formatVersion: EXPORT_FORMAT_VERSION,
    kind: input.kind,
    exportId: input.exportId,
    userId: input.userId,
    generatedAt: input.generatedAt.toISOString(),
    files: [...input.files].map(([name, value]) => ({ name, rows: countRows(value) })),
  };
  const entries: Zippable = { [MANIFEST]: json(manifest) };
  for (const [name, value] of input.files) {
    if (name === MANIFEST || name in entries) throw new Error(`duplicate archive entry ${name}`);
    entries[name] = json(value);
  }
  // A fixed mtime keeps the archive free of the build host's clock and time zone.
  return { bytes: zipSync(entries, { level: 6, mtime: input.generatedAt }), manifest };
}
