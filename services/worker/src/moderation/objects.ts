// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Object-storage helpers for moderation: reading whole (small) objects, the evidence key scheme
 * and the private prefix NCII auto-hide moves public objects to. Object keys never reach a log.
 */
import type { ObjectStorage } from "@commonair/storage";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))));
}

/** The whole object, or null when it does not exist. */
export async function readObject(storage: ObjectStorage, bucket: string, key: string): Promise<Uint8Array | null> {
  const res = await storage.get(bucket, key);
  if (!res) return null;
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Bucket evidence key: `evidence/<caseId>/<evidenceId>.<sha256 of the sealed bytes>`. The worker
 * cannot open sealed bytes, so the daily audit verifies an object against the digest in its key;
 * the manifest row's `sha256` stays the plaintext digest for the legal view.
 */
export const evidenceKey = (caseId: string, evidenceId: string, sealedSha256: string) =>
  `evidence/${caseId}/${evidenceId}.${sealedSha256}`;

const EVIDENCE_KEY = /^evidence\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.([0-9a-f]{64})$/;

/** The sealed-bytes digest recorded in an evidence key, or null if the key is malformed. */
export function sealedDigestOf(key: string): string | null {
  return EVIDENCE_KEY.exec(key)?.[1] ?? null;
}

/** Private prefix (never publicly routed) holding objects hidden by the NCII deadline. */
export const NCII_HIDDEN_PREFIX = "moderation/ncii-hidden/";
export const nciiHiddenKey = (key: string) => `${NCII_HIDDEN_PREFIX}${key}`;

/** Keys of the live thumbnails a broadcast owns (the media unit's layout). VOD prefixes: `../vod/prefixes.ts`. */
export const thumbnailPrefix = (broadcastId: string) => `thumbnails/${broadcastId}/`;

/** Copy an object to another key, then delete the original. Returns false when the source is gone. */
export async function moveObject(storage: ObjectStorage, bucket: string, from: string, to: string): Promise<boolean> {
  const res = await storage.get(bucket, from);
  if (!res) return false;
  const contentType = res.headers.get("content-type") ?? undefined;
  const bytes = new Uint8Array(await res.arrayBuffer());
  await storage.put(bucket, to, bytes, { contentType });
  const copy = await readObject(storage, bucket, to);
  if (!copy || (await sha256Hex(copy)) !== (await sha256Hex(bytes)))
    throw new Error("object copy could not be verified; the original was kept");
  await storage.delete(bucket, from);
  return true;
}
