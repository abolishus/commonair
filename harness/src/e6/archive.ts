// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Reading a data-export archive (docs/testing/e6-selectors.md, "Data export") and scanning it for
 * values that must never be in it. The scanner reports which needle (by label) was found in which
 * file, never the value itself: needles are other people's identities and secrets.
 */
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";

export interface ArchiveManifest {
  formatVersion: number;
  kind: string;
  exportId: string;
  userId: string;
  generatedAt: string;
  files: { name: string; rows: number }[];
}

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

/** The zip's files by name (directories dropped). Throws ArchiveError for anything but a zip. */
export function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  // "PK\x03\x04" (a local file header) or "PK\x05\x06" (an empty archive).
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new ArchiveError("not a zip archive");
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (err) {
    throw new ArchiveError(`unreadable zip: ${err instanceof Error ? err.message : String(err)}`);
  }
  const out = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(entries)) if (!name.endsWith("/")) out.set(name, data);
  return out;
}

export function jsonEntry(files: ReadonlyMap<string, Uint8Array>, name: string): unknown {
  const bytes = files.get(name);
  if (!bytes) throw new ArchiveError(`${name} is missing`);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new ArchiveError(`${name} is not JSON`);
  }
}

export function parseManifest(value: unknown): ArchiveManifest {
  const m = value as Partial<ArchiveManifest> | null;
  if (
    typeof m !== "object" ||
    m === null ||
    typeof m.formatVersion !== "number" ||
    typeof m.kind !== "string" ||
    typeof m.exportId !== "string" ||
    typeof m.userId !== "string" ||
    typeof m.generatedAt !== "string" ||
    !Array.isArray(m.files) ||
    m.files.some((f) => typeof f?.name !== "string" || typeof f?.rows !== "number")
  ) {
    throw new ArchiveError("manifest.json does not have the spec's shape");
  }
  return m as ArchiveManifest;
}

export interface ManifestCheck {
  /** Files in the zip that the manifest does not list (manifest.json itself excepted). */
  unlisted: string[];
  /** Files the manifest lists that the zip does not hold. */
  missing: string[];
  /** Listed files whose `rows` disagrees with the JSON (array length; 1 for an object). */
  rowMismatches: { name: string; listed: number; actual: number }[];
}

/**
 * Rows of one archive file, as the manifest counts them (spec "Data export"): an array counts its
 * elements; an object without arrays is one row; an object holding arrays counts their elements,
 * plus one when it also holds a non-array value.
 */
export function rowCount(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (Array.isArray(value)) return value.length;
  if (typeof value !== "object") return 1;
  const members = Object.values(value as Record<string, unknown>);
  const arrays = members.filter(Array.isArray);
  if (arrays.length === 0) return 1;
  const record = members.some((m) => m !== null && !Array.isArray(m)) ? 1 : 0;
  return record + arrays.reduce((n, a) => n + a.length, 0);
}

/** Compare the manifest with what the zip holds. */
export function checkManifest(files: ReadonlyMap<string, Uint8Array>, manifest: ArchiveManifest): ManifestCheck {
  const listed = new Set(manifest.files.map((f) => f.name));
  const unlisted = [...files.keys()].filter((n) => n !== "manifest.json" && !listed.has(n)).sort();
  const missing = [...listed].filter((n) => !files.has(n)).sort();
  const rowMismatches: ManifestCheck["rowMismatches"] = [];
  for (const f of manifest.files) {
    if (!files.has(f.name) || !f.name.endsWith(".json")) continue;
    const actual = rowCount(jsonEntry(files, f.name));
    if (actual !== f.rows) rowMismatches.push({ name: f.name, listed: f.rows, actual });
  }
  return { unlisted, missing, rowMismatches };
}

export function manifestOk(c: ManifestCheck): boolean {
  return c.unlisted.length === 0 && c.missing.length === 0 && c.rowMismatches.length === 0;
}

// ---------------------------------------------------------------- PII and secret scanning

export interface Needle {
  /** What the value is (`v.email`, `u.session-token`): reported instead of the value. */
  label: string;
  value?: string;
  pattern?: RegExp;
  caseInsensitive?: boolean;
}

export interface NeedleHit {
  file: string;
  label: string;
}

/** Values shorter than this are not scanned for: they would match by chance. */
export const MIN_NEEDLE_LENGTH = 6;

/** Needles for exact values; empty, short and duplicate values are dropped. */
export function valueNeedles(label: string, values: readonly (string | null | undefined)[], caseInsensitive = false) {
  const seen = new Set<string>();
  const out: Needle[] = [];
  for (const raw of values) {
    const v = raw?.trim();
    if (!v || v.length < MIN_NEEDLE_LENGTH) continue;
    const key = caseInsensitive ? v.toLowerCase() : v;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, value: v, caseInsensitive });
  }
  return out;
}

/**
 * Needles for secret values and the ways a store might hash them: the value itself and its
 * SHA-256 as hex, base64url and base64 (a hash in an archive is as bad as the value).
 */
export function secretNeedles(label: string, values: readonly (string | null | undefined)[]): Needle[] {
  const out: Needle[] = [];
  for (const raw of values) {
    const v = raw?.trim();
    if (!v) continue;
    const digest = createHash("sha256").update(v).digest();
    out.push(
      ...valueNeedles(label, [v]),
      ...valueNeedles(`${label}:sha256-hex`, [digest.toString("hex")], true),
      ...valueNeedles(`${label}:sha256-b64url`, [digest.toString("base64url")]),
      ...valueNeedles(`${label}:sha256-b64`, [digest.toString("base64")]),
    );
  }
  return out;
}

/**
 * Shapes of secrets whatever their value: password hashes (scrypt `salt:key` hex as better-auth
 * stores them, bcrypt, argon2) and PEM private keys.
 */
export const SECRET_PATTERNS: readonly Needle[] = [
  { label: "password-hash:scrypt", pattern: /\b[0-9a-f]{32}:[0-9a-f]{128}\b/i },
  { label: "password-hash:bcrypt", pattern: /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/ },
  { label: "password-hash:argon2", pattern: /\$argon2(?:id|i|d)\$/ },
  { label: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

function matches(text: string, lower: string, n: Needle): boolean {
  if (n.pattern) return n.pattern.test(text);
  if (!n.value) return false;
  return n.caseInsensitive ? lower.includes(n.value.toLowerCase()) : text.includes(n.value);
}

/** Every (file, label) whose needle occurs in the file's text. Never returns matched text. */
export function scanFiles(files: ReadonlyMap<string, Uint8Array>, needles: readonly Needle[]): NeedleHit[] {
  const hits: NeedleHit[] = [];
  const decoder = new TextDecoder();
  for (const [file, bytes] of files) {
    const text = decoder.decode(bytes);
    const lower = text.toLowerCase();
    const labels = new Set<string>();
    for (const n of needles) if (!labels.has(n.label) && matches(text, lower, n)) labels.add(n.label);
    for (const label of [...labels].sort()) hits.push({ file, label });
  }
  return hits;
}

/** True when `needle` (an exact value) occurs in some file. */
export function containsValue(
  files: ReadonlyMap<string, Uint8Array>,
  value: string,
  only?: (name: string) => boolean,
): boolean {
  const decoder = new TextDecoder();
  for (const [name, bytes] of files) {
    if (only && !only(name)) continue;
    if (decoder.decode(bytes).includes(value)) return true;
  }
  return false;
}
