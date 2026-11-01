// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Batch 7 decision (p): the worker hands an image it fetched (a bundle's or Twitch's emote or panel
 * art) to the API's upload pipeline, so there is one pipeline (hash lists, T0, classifier). The
 * caller first writes the image under `incoming/`, then calls `commitUpload` here; the API runs
 * the same `commitUpload` a user upload runs and answers `UploadCommitResult`.
 *
 * A refusal is a result (`{ok: false, code: "upload_rejected"}`), never an exception: the caller
 * skips the item with the same opaque reason a user upload gets. Transport failures (the API down,
 * a 5xx, a timeout, a malformed answer) throw `UploadCommitError`, so the job retries.
 */
import { internalEnv, loadEnv } from "@commonair/config";
import {
  INTERNAL_ROUTES,
  INTERNAL_SECRET_HEADER,
  UploadCommitBody,
  UploadCommitResult,
} from "@commonair/contracts/internal";
import { z } from "zod";

export interface UploadCommitClientOptions {
  /** `API_INTERNAL_URL`. */
  baseUrl: string;
  /** `INTERNAL_API_SECRET`. */
  secret: string;
  /** Default 30 s: the API scans the image before it answers. */
  timeoutMs?: number;
  /** Tests inject one. */
  fetch?: typeof fetch;
}

export class UploadCommitError extends Error {
  constructor(
    message: string,
    /** The API's HTTP status, when it answered. */
    readonly status: number | null,
  ) {
    super(message);
    this.name = "UploadCommitError";
  }
}

const uploadEnv = z.object({
  API_INTERNAL_URL: internalEnv.shape.API_INTERNAL_URL,
  INTERNAL_API_SECRET: internalEnv.shape.INTERNAL_API_SECRET,
});

let cached: UploadCommitClientOptions | undefined;

/** Read once per process from the env `workerEnv` validated at start-up; tests pass their own source. */
export function uploadCommitOptions(source?: Record<string, string | undefined>): UploadCommitClientOptions {
  if (!source && cached) return cached;
  const env = loadEnv(uploadEnv, source ?? process.env);
  const opts = { baseUrl: env.API_INTERNAL_URL, secret: env.INTERNAL_API_SECRET };
  if (!source) cached = opts;
  return opts;
}

/** POST `INTERNAL_ROUTES.uploadCommit`. See the module comment for what throws and what returns. */
export async function commitUpload(
  body: UploadCommitBody,
  opts: UploadCommitClientOptions = uploadCommitOptions(),
): Promise<UploadCommitResult> {
  const payload = UploadCommitBody.parse(body);
  const url = `${opts.baseUrl.replace(/\/+$/, "")}${INTERNAL_ROUTES.uploadCommit}`;
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: opts.secret },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
  } catch (err) {
    throw new UploadCommitError(`upload commit request failed: ${err instanceof Error ? err.name : "error"}`, null);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new UploadCommitError(`upload commit answered ${res.status}`, res.status);
  }
  const parsed = UploadCommitResult.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new UploadCommitError("upload commit answered a malformed body", res.status);
  return parsed.data;
}
