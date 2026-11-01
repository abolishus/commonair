// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `POST INTERNAL_ROUTES.uploadCommit` (decision (p)): the worker's imports (portability bundles,
 * the Twitch import) write a fetched image under `incoming/` and hand it here, so it goes through
 * the one `commitUpload` a user upload goes through: magic bytes, hash lists (a match seals it and
 * enqueues `moderation.t0`), the classifier, then the copy to the public key. The worker never
 * matches hashes itself (only the API holds the lists).
 *
 * `http.ts` checks the internal secret first. A refusal is the same opaque `upload_rejected` a user
 * gets. The key must be the given channel's and carry the given purpose.
 */
import { ORPCError } from "@orpc/server";
import { UploadCommitBody, type UploadCommitResult } from "@commonair/contracts/internal";
import type { Deps } from "../deps.ts";
import { parseIncomingKey } from "./upload-keys.ts";
import { commitUpload } from "./uploads.ts";

const NO_STORE = { "cache-control": "no-store" };

/** `body` is the parsed JSON (null when missing, too large or malformed). */
export async function internalUploadCommit(deps: Deps, method: string, body: unknown): Promise<Response> {
  if (method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const parsed = UploadCommitBody.safeParse(body);
  if (!parsed.success) return new Response(null, { status: 400 });
  const { channelId, userId, key, purpose } = parsed.data;
  if (parseIncomingKey(key, channelId)?.purpose !== purpose) return new Response(null, { status: 400 });
  let result: UploadCommitResult;
  try {
    result = { ok: true, ...(await commitUpload(deps, { channelId, userId, key })) };
  } catch (err) {
    if (!(err instanceof ORPCError)) throw err;
    if ((err.data as { reason?: string } | undefined)?.reason === "upload_rejected")
      result = { ok: false, code: "upload_rejected" };
    else return new Response(null, { status: err.status === 404 ? 404 : 400 });
  }
  return Response.json(result, { headers: NO_STORE });
}
