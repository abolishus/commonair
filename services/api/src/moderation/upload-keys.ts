// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Upload keys (ADR 0006 Q6). Presigned PUTs land under the unpublished `incoming/` prefix;
 * `channels.commitUpload` scans the object and copies it to the public key, which is the same
 * key without the prefix. Pure functions, unit-tested.
 */
import {
  UPLOAD_PURPOSES,
  UPLOAD_TYPES as CONTRACT_UPLOAD_TYPES,
  type UploadPurpose,
} from "@commonair/contracts/shapes";
import { INCOMING_PREFIX } from "@commonair/moderation";

export { UPLOAD_PURPOSES, type UploadPurpose };
/** The contract's per-purpose types, widened so key parsing can look up any string. */
export const UPLOAD_TYPES: Record<UploadPurpose, readonly string[]> = CONTRACT_UPLOAD_TYPES;
/** Purposes that are images (scanned on commit); `alert_sound` is size- and type-checked only. */
export const IMAGE_PURPOSES: readonly UploadPurpose[] = ["avatar", "banner", "panel", "emote", "alert_image"];

export const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
};
const TYPE_OF_EXT: Record<string, string> = Object.fromEntries(Object.entries(EXT).map(([t, e]) => [e, t]));

/** Largest upload the contract accepts (`channels.uploadUrl.sizeBytes`). */
export const MAX_UPLOAD_BYTES = 10_000_000;

export const incomingKey = (channelId: string, purpose: UploadPurpose, id: string, contentType: string) =>
  `${INCOMING_PREFIX}channels/${channelId}/${purpose}/${id}.${EXT[contentType] ?? "bin"}`;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const KEY_RE = new RegExp(
  `^${INCOMING_PREFIX}channels/(${UUID})/(${UPLOAD_PURPOSES.join("|")})/(${UUID})\\.(png|jpg|webp|gif|mp3|ogg)$`,
);

export interface ParsedIncomingKey {
  incoming: string;
  publicKey: string;
  purpose: UploadPurpose;
  contentType: string;
  uploadId: string;
}

/**
 * Parse an incoming key and check it belongs to `channelId`, and that its extension is allowed
 * for its purpose. Anything else is null: a caller cannot commit someone else's object, a public
 * key, or a path that climbs.
 */
export function parseIncomingKey(key: string, channelId: string): ParsedIncomingKey | null {
  const m = KEY_RE.exec(key);
  if (!m) return null;
  const [, channel, purpose, uploadId, ext] = m;
  if (channel !== channelId.toLowerCase() || !purpose || !uploadId || !ext) return null;
  const p = purpose as UploadPurpose;
  const contentType = TYPE_OF_EXT[ext];
  if (!contentType || !UPLOAD_TYPES[p].includes(contentType)) return null;
  return { incoming: key, publicKey: key.slice(INCOMING_PREFIX.length), purpose: p, contentType, uploadId };
}

/** A committed (public) key for the channel and purpose: never `incoming/`, never climbing. */
export function isCommittedKeyShape(key: string, channelId: string, purpose: UploadPurpose): boolean {
  if (key.startsWith(INCOMING_PREFIX)) return false;
  const m = /^channels\/([0-9a-f-]{36})\/([a-z_]+)\/([0-9a-f-]{36})\.([a-z0-9]{2,4})$/.exec(key);
  if (!m) return false;
  if (m[1] !== channelId.toLowerCase() || m[2] !== purpose) return false;
  const contentType = TYPE_OF_EXT[m[4] ?? ""];
  return contentType !== undefined && UPLOAD_TYPES[purpose].includes(contentType);
}

/**
 * Magic-byte check: the bytes are what the key's extension says. The presigned PUT pins the
 * Content-Type header, but the body is the client's; ffmpeg would otherwise decode anything.
 */
export function sniffMatches(bytes: Uint8Array, contentType: string): boolean {
  const at = (i: number, ...b: number[]) => b.every((x, j) => bytes[i + j] === x);
  const ascii = (i: number, s: string) => at(i, ...Array.from(s, (c) => c.charCodeAt(0)));
  switch (contentType) {
    case "image/png":
      return at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/jpeg":
      return at(0, 0xff, 0xd8, 0xff);
    case "image/gif":
      return ascii(0, "GIF87a") || ascii(0, "GIF89a");
    case "image/webp":
      return ascii(0, "RIFF") && ascii(8, "WEBP");
    case "audio/ogg":
      return ascii(0, "OggS");
    case "audio/mpeg":
      // ID3v2 tag or an MPEG audio frame sync.
      return ascii(0, "ID3") || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0);
    default:
      return false;
  }
}
