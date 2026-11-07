// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What a failed API call means for the page (F1, F2): a definitive answer (signed out, not
 * allowed, gone), a busy or unreachable server that a retry will likely get past, or anything
 * else. Works on oRPC client errors (`code`, `status`, `data`) and on raw fetch failures.
 */
import { errorCode } from "./api.ts";

export type LoadFailureKind =
  /** 401: the session is gone. The only failure that means "signed out". */
  | "unauthorized"
  /** 403. */
  | "forbidden"
  /** 404. */
  | "notFound"
  /** 429: rate limited, usually with `retryAfterSeconds`. */
  | "busy"
  /** 502, 503, 504, or no answer at all (network down, API unreachable). */
  | "unavailable"
  /** Anything else (a 500, a 400, a bug). Retrying by hand may help; retrying by itself will not. */
  | "failed";

const CODE_KINDS: Record<string, LoadFailureKind> = {
  UNAUTHORIZED: "unauthorized",
  FORBIDDEN: "forbidden",
  NOT_FOUND: "notFound",
  RATE_LIMITED: "busy",
  TOO_MANY_REQUESTS: "busy",
  BAD_GATEWAY: "unavailable",
  SERVICE_UNAVAILABLE: "unavailable",
  GATEWAY_TIMEOUT: "unavailable",
};

/** The HTTP status a failed call carried, if any. */
export function errorStatus(err: unknown): number | null {
  if (typeof err !== "object" || err === null || !("status" in err)) return null;
  const status = err.status;
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

/** The server's retry hint (`RATE_LIMITED` carries `data.retryAfterSeconds`), in seconds. */
export function retryAfterSeconds(err: unknown): number | null {
  if (typeof err !== "object" || err === null || !("data" in err)) return null;
  const data = err.data;
  if (typeof data !== "object" || data === null || !("retryAfterSeconds" in data)) return null;
  const seconds = data.retryAfterSeconds;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function kindOfStatus(status: number): LoadFailureKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "notFound";
  if (status === 429) return "busy";
  if (status === 502 || status === 503 || status === 504) return "unavailable";
  return "failed";
}

export function loadFailureKind(err: unknown): LoadFailureKind {
  const status = errorStatus(err);
  const code = errorCode(err);
  // A defined code is the API's own word; a status-derived one says the same as the status.
  const byCode = code === null ? undefined : CODE_KINDS[code];
  if (byCode) return byCode;
  if (status !== null) return kindOfStatus(status);
  // `fetch` rejects with a TypeError when nothing answered ("Failed to fetch", "fetch failed").
  if (code === null && err instanceof TypeError) return "unavailable";
  return "failed";
}

/** Busy or unreachable: worth retrying by itself, after a wait. */
export function isTransientFailure(err: unknown): boolean {
  const kind = loadFailureKind(err);
  return kind === "busy" || kind === "unavailable";
}
