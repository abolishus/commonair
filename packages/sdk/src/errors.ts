// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: Apache-2.0

/** Errors the SDK throws. API (oRPC) errors are oRPC's own `ORPCError`, typed by the contract. */
import type { OAUTH_ERROR_CODES } from "@commonair/contracts/oauth";

/** The RFC 6749 §5.2 / RFC 8628 §3.5 `error` codes, plus `invalid_response` (not an OAuth answer). */
export type OAuthErrorCode = (typeof OAUTH_ERROR_CODES)[number] | "invalid_response";

/** A refusal from an OAuth endpoint (token, revoke, device). Never carries a token. */
export class OAuthError extends Error {
  override readonly name = "OAuthError";
  constructor(
    readonly code: OAuthErrorCode,
    readonly description: string | undefined,
    /** HTTP status, or 0 when the error was raised on the client (a device code that ran out). */
    readonly status: number,
  ) {
    super(description ? `${code}: ${description}` : code);
  }
}

/**
 * The user must authorize the app again: the refresh token was refused (`invalid_grant`, e.g. a
 * replayed refresh token killed the family, or the user revoked the app), or an EventSub socket was
 * closed with 4008 (the authorization was revoked). Retrying with the old tokens cannot succeed.
 */
export class ReauthorizeError extends Error {
  override readonly name = "ReauthorizeError";
  constructor(
    readonly reason: "invalid_grant" | "authorization_revoked",
    options?: { cause?: unknown },
  ) {
    super(`re-authorize: ${reason}`, options);
  }
}

/** `err.code` of an oRPC error (`RATE_LIMITED`, `FORBIDDEN`, …), or null. */
export function errorCode(err: unknown): string | null {
  const c = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof c === "string" ? c : null;
}

/** Seconds to wait from a `RATE_LIMITED` oRPC error's data, or null for any other error. */
export function retryAfterSeconds(err: unknown): number | null {
  if (errorCode(err) !== "RATE_LIMITED") return null;
  const data = (err as { data?: unknown }).data;
  const s =
    typeof data === "object" && data !== null ? (data as { retryAfterSeconds?: unknown }).retryAfterSeconds : null;
  return typeof s === "number" && Number.isFinite(s) ? s : null;
}
