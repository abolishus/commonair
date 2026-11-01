// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The portability bundle archive (ADR 0037 decision 1): a ZIP holding `bundle.json`,
 * `manifest.json` and the images under `files/`. Writing and reading are pure (bytes in, bytes
 * out), so the export, the import preview, `applyBundle` and N3's Twitch import share them.
 *
 * Reading refuses, before anything is applied: an archive over `PORTABILITY_LIMITS.maxArchiveBytes`;
 * any entry other than the two JSON files and flat `files/<name>` (absolute paths, `..`,
 * directories, dot files); an entry whose declared size is over the per-file cap (checked before it
 * is inflated, then again on the bytes); an unknown `v`; a shape or limit violation
 * (`parseBundle`); a manifest entry with no file, a file the manifest does not list, and a file
 * whose size or SHA-256 differs from the manifest.
 */
import {
  BUNDLE_FILES,
  type BundleManifest,
  type BundleManifestEntry,
  PORTABILITY_BUNDLE_VERSION,
  PORTABILITY_LIMITS,
  type PortabilityBundle,
  parseBundle,
} from "@commonair/contracts/portability";
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";

export type BundleReadError =
  | "archive_too_large"
  | "not_a_zip"
  | "unsafe_path"
  | "too_many_files"
  | "unsupported_version"
  | "malformed"
  | "missing_file"
  | "file_too_large"
  | "hash_mismatch";

export interface ReadBundle {
  bundle: PortabilityBundle;
  manifest: BundleManifest;
  /** `files/<name>` → bytes, each checked against the manifest. */
  files: ReadonlyMap<string, Uint8Array>;
}

export type ReadBundleResult = ({ ok: true } & ReadBundle) | { ok: false; error: BundleReadError };

/** Any `files/` entry larger than this is refused unread (the larger of the two image caps). */
const MAX_FILE_BYTES = Math.max(PORTABILITY_LIMITS.maxEmoteBytes, PORTABILITY_LIMITS.maxPanelImageBytes);
/** `bundle.json` and `manifest.json` are small; a larger one is a bomb, not a bundle. */
const MAX_JSON_BYTES = 2_000_000;
const FILE_ENTRY = /^files\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** What a name inside the archive may be: the two JSON files or a flat `files/` name. */
export function isSafeEntryName(name: string): boolean {
  if (name === BUNDLE_FILES.bundle || name === BUNDLE_FILES.manifest) return true;
  return FILE_ENTRY.test(name) && !name.includes("..");
}

const json = (value: unknown) => strToU8(`${JSON.stringify(value, null, 2)}\n`);

/**
 * Write an archive. `files` maps each `files/<name>` the bundle refers to onto its bytes and type;
 * the manifest is computed here, so it always matches.
 */
export async function writeBundleArchive(
  bundle: PortabilityBundle,
  files: ReadonlyMap<string, { bytes: Uint8Array; contentType: BundleManifestEntry["contentType"] }>,
  mtime: Date,
): Promise<{ bytes: Uint8Array; manifest: BundleManifest }> {
  const entries: BundleManifestEntry[] = [];
  const zippable: Zippable = {};
  for (const [file, f] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (!FILE_ENTRY.test(file)) throw new Error(`unsafe bundle file name ${file}`);
    entries.push({ file, sizeBytes: f.bytes.byteLength, sha256: await sha256Hex(f.bytes), contentType: f.contentType });
    // Images are already compressed: store them.
    zippable[file] = [f.bytes, { level: 0 }];
  }
  const manifest: BundleManifest = { v: PORTABILITY_BUNDLE_VERSION, files: entries };
  zippable[BUNDLE_FILES.bundle] = json(bundle);
  zippable[BUNDLE_FILES.manifest] = json(manifest);
  return { bytes: zipSync(zippable, { level: 6, mtime }), manifest };
}

/** Read and check an archive. Never throws for bad input: every refusal is a code. */
export async function readBundleArchive(bytes: Uint8Array): Promise<ReadBundleResult> {
  if (bytes.byteLength > PORTABILITY_LIMITS.maxArchiveBytes) return { ok: false, error: "archive_too_large" };
  let unsafe = false;
  let oversized = false;
  let count = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (f) => {
        // The `files/` directory entry some zip tools write carries nothing: skip it.
        if (f.name === BUNDLE_FILES.dir && f.originalSize === 0) return false;
        if (!isSafeEntryName(f.name)) {
          unsafe = true;
          return false;
        }
        if (++count > PORTABILITY_LIMITS.maxFiles + 2) return false;
        const cap = f.name.startsWith(BUNDLE_FILES.dir) ? MAX_FILE_BYTES : MAX_JSON_BYTES;
        if (f.originalSize > cap) {
          oversized = true;
          return false;
        }
        return true;
      },
    });
  } catch {
    return { ok: false, error: "not_a_zip" };
  }
  if (unsafe) return { ok: false, error: "unsafe_path" };
  if (oversized) return { ok: false, error: "file_too_large" };
  if (count > PORTABILITY_LIMITS.maxFiles + 2) return { ok: false, error: "too_many_files" };
  const bundleBytes = entries[BUNDLE_FILES.bundle];
  const manifestBytes = entries[BUNDLE_FILES.manifest];
  if (!bundleBytes || !manifestBytes) return { ok: false, error: "malformed" };
  let bundleJson: unknown;
  let manifestJson: unknown;
  try {
    bundleJson = JSON.parse(strFromU8(bundleBytes));
    manifestJson = JSON.parse(strFromU8(manifestBytes));
  } catch {
    return { ok: false, error: "malformed" };
  }
  const parsed = parseBundle(bundleJson, manifestJson);
  if (!parsed.ok) return parsed;
  const files = new Map<string, Uint8Array>();
  for (const entry of parsed.manifest.files) {
    const data = entries[entry.file];
    if (!data) return { ok: false, error: "missing_file" };
    if (data.byteLength !== entry.sizeBytes) return { ok: false, error: "hash_mismatch" };
    if (data.byteLength > MAX_FILE_BYTES) return { ok: false, error: "file_too_large" };
    if ((await sha256Hex(data)) !== entry.sha256) return { ok: false, error: "hash_mismatch" };
    files.set(entry.file, data);
  }
  // Every file in the archive is listed: nothing rides along unchecked.
  for (const name of Object.keys(entries))
    if (name.startsWith(BUNDLE_FILES.dir) && !files.has(name)) return { ok: false, error: "hash_mismatch" };
  for (const e of parsed.bundle.emotes)
    if ((files.get(e.file)?.byteLength ?? 0) > PORTABILITY_LIMITS.maxEmoteBytes)
      return { ok: false, error: "file_too_large" };
  return { ok: true, bundle: parsed.bundle, manifest: parsed.manifest, files };
}
