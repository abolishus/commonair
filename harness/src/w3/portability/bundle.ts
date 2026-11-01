// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Editing an exported portability bundle for the `portability` scenario (ADR 0037): step 4 adds an
 * emote whose image is the T0 fixture, which no channel could hold (its upload is refused at the
 * source), so the destination's upload pipeline is what refuses it. The manifest is rewritten so
 * the archive still reads; the standing statement no longer matches the bundle, so the import is
 * "standing not verified" (the binding check), which is expected.
 */
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";

interface ManifestEntry {
  file: string;
  sizeBytes: number;
  sha256: string;
  contentType: string;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The parsed `bundle.json` of an archive (for checks only). */
export function readBundleJson(archive: Uint8Array): Record<string, unknown> {
  const entries = unzipSync(archive);
  const raw = entries["bundle.json"];
  if (!raw) throw new Error("the archive has no bundle.json");
  return JSON.parse(strFromU8(raw)) as Record<string, unknown>;
}

/** The archive with one more PNG emote (`files/emote-<code>.png`), its manifest entry included. */
export async function withExtraEmote(archive: Uint8Array, code: string, png: Uint8Array): Promise<Uint8Array> {
  if (!/^[A-Za-z0-9]{2,20}$/.test(code)) throw new Error(`not an emote code: ${code}`);
  const entries = unzipSync(archive);
  const bundle = readBundleJson(archive);
  const manifestRaw = entries["manifest.json"];
  if (!manifestRaw) throw new Error("the archive has no manifest.json");
  const manifest = JSON.parse(strFromU8(manifestRaw)) as { v: number; files: ManifestEntry[] };
  const file = `files/emote-${code}.png`;
  const emotes = (bundle.emotes as { code: string }[]).filter((e) => e.code !== code);
  bundle.emotes = [...emotes, { code, tier: 0, animated: false, file }];
  manifest.files = [
    ...manifest.files.filter((f) => f.file !== file),
    { file, sizeBytes: png.byteLength, sha256: await sha256Hex(png), contentType: "image/png" },
  ];
  const out: Zippable = {};
  for (const [name, bytes] of Object.entries(entries)) out[name] = bytes;
  out[file] = [png, { level: 0 }];
  out["bundle.json"] = strToU8(JSON.stringify(bundle));
  out["manifest.json"] = strToU8(JSON.stringify(manifest));
  return zipSync(out);
}
