// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Every procedure that accepts an image key (channel avatar and banner, panels, emotes, alert
 * images) takes only committed uploads: a public key of the channel and purpose whose object
 * exists. An `incoming/` key, which has not been scanned, or a key that was never committed is
 * refused.
 */
import { sql } from "drizzle-orm";
import { schema, type Executor } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { badRequest } from "../lib/errors.ts";
import { instanceMediaBase } from "../lib/media-ref.ts";
import { isCommittedKeyShape, type UploadPurpose } from "./upload-keys.ts";

/** The storage key of a ref that is either a key or this instance's media URL for one. */
export function keyOfRef(ref: string, mediaBase: string): string | null {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(ref)) return ref;
  if (!ref.startsWith(mediaBase)) return null;
  try {
    return decodeURIComponent(ref.slice(mediaBase.length));
  } catch {
    return null;
  }
}

/** Serialize image references with NCII removal until the transaction commits. */
export async function lockUploadReference(tx: Executor, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

export async function isCommittedUpload(
  deps: Deps,
  tx: Executor,
  ref: string,
  channelId: string,
  purpose: UploadPurpose,
): Promise<boolean> {
  const key = keyOfRef(ref, instanceMediaBase(deps.env));
  if (!key || !isCommittedKeyShape(key, channelId, purpose)) return false;
  await lockUploadReference(tx, key);
  const [revoked] = await tx
    .select({ id: schema.nciiRequestItems.id })
    .from(schema.nciiRequestItems)
    .where(sql`${schema.nciiRequestItems.uploadKey} = ${key} and ${schema.nciiRequestItems.removedAt} is not null`)
    .limit(1);
  if (revoked) return false;
  const head = await deps.storage.head(deps.env.S3_BUCKET_MEDIA, key);
  return head !== null;
}

export async function assertCommittedUpload(
  deps: Deps,
  tx: Executor,
  ref: string,
  channelId: string,
  purpose: UploadPurpose,
): Promise<void> {
  if (!(await isCommittedUpload(deps, tx, ref, channelId, purpose)))
    throw badRequest(`Upload the ${purpose} image and commit it first`);
}
