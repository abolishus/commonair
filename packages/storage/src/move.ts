// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Copying every object of one prefix to another (ADR 0009 amendment 1, decision 3): VOD objects
 * move between the public `vods/<id>/` and the private `recordings/<id>/`. This only copies and
 * verifies. The caller updates the database and deletes the source afterwards, so a crash at any
 * point leaves at least one complete copy. Keys never reach an error message.
 */
import type { ObjectStorage } from "./index.ts";

export interface MoveResult {
  /** Objects copied and verified. */
  copied: number;
  /** Their total size in bytes. */
  bytes: number;
}

/** A copy did not match its source: the source is untouched, nothing was deleted. */
export class CopyVerificationError extends Error {
  override name = "CopyVerificationError";
  constructor(readonly reason: "missing" | "size" | "etag") {
    super(`object copy could not be verified (${reason}); the source was kept`);
  }
}

/** S3 ETags are quoted; some stores omit the quotes or weak-prefix them. */
const normalizeEtag = (e: string) => e.replace(/^W\//, "").replace(/"/g, "");

/**
 * Server-side copy of every object under `fromPrefix` to the same relative key under `toPrefix`,
 * each verified by a HEAD of the copy (same size and, when the store reports both, same ETag).
 * Never deletes anything. Throws `CopyVerificationError` on the first copy that does not match.
 */
export async function moveVodObjects(
  storage: Pick<ObjectStorage, "list" | "copy" | "head">,
  bucket: string,
  fromPrefix: string,
  toPrefix: string,
): Promise<MoveResult> {
  if (!fromPrefix.endsWith("/") || !toPrefix.endsWith("/") || fromPrefix === toPrefix)
    throw new RangeError("moveVodObjects needs two different prefixes ending in '/'");
  if (fromPrefix.startsWith(toPrefix) || toPrefix.startsWith(fromPrefix))
    throw new RangeError("moveVodObjects prefixes must not contain each other");
  const result: MoveResult = { copied: 0, bytes: 0 };
  for await (const src of storage.list(bucket, fromPrefix)) {
    const to = toPrefix + src.key.slice(fromPrefix.length);
    await storage.copy(bucket, src.key, to);
    const copy = await storage.head(bucket, to);
    if (!copy) throw new CopyVerificationError("missing");
    if (copy.size !== src.size) throw new CopyVerificationError("size");
    if (src.etag && copy.etag && normalizeEtag(src.etag) !== normalizeEtag(copy.etag))
      throw new CopyVerificationError("etag");
    result.copied++;
    result.bytes += src.size;
  }
  return result;
}
