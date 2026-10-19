// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Socket authentication. A tracker socket outlives the 120 s playback token, so the token's
 * signature is checked without its `exp`; its age is bounded by `iat` instead
 * (TRACKER_TOKEN_MAX_AGE_SECONDS), and the session must be heartbeating (KEYS.viewers).
 */
import type { PlaybackClaims } from "@commonair/contracts";
import { fromB64url, verifyPlaybackToken } from "@commonair/tokens";

/** Clock skew tolerated for `iat` in the future. */
export const IAT_SKEW_SECONDS = 30;
/** A session whose last heartbeat is older than this is not watching (KEYS.viewers semantics). */
export const HEARTBEAT_STALE_MS = 30_000;

export type TokenAge = "ok" | "too_old" | "future";

export function tokenAge(iat: number, nowSeconds: number, maxAgeSeconds: number): TokenAge {
  if (iat - IAT_SKEW_SECONDS > nowSeconds) return "future";
  if (nowSeconds - iat > maxAgeSeconds) return "too_old";
  return "ok";
}

export type TrackerTokenResult =
  | { ok: true; claims: PlaybackClaims }
  | { ok: false; error: "malformed" | "bad_signature" | "too_old" | "future" };

/**
 * LOCAL WORKAROUND (contract request: `verifyPlaybackTokenSignature` in @commonair/tokens).
 * `verifyPlaybackToken` always enforces `exp`. To check only the signature and claims schema we
 * evaluate it at the token's own `iat` (unverified, read from the body), where its time checks
 * pass for any well-formed token; the real time policy is `tokenAge` against the actual clock.
 * The signature still covers the exact body bytes, so reading `iat` first gains a forger nothing.
 */
export async function verifyTrackerToken(
  publicKey: CryptoKey,
  token: string | null,
  nowSeconds: number,
  maxAgeSeconds: number,
): Promise<TrackerTokenResult> {
  if (!token || token.length > 4096) return { ok: false, error: "malformed" };
  const [body] = token.split(".");
  let iat: unknown;
  try {
    iat = (JSON.parse(new TextDecoder().decode(fromB64url(body ?? ""))) as { iat?: unknown }).iat;
  } catch {
    return { ok: false, error: "malformed" };
  }
  if (typeof iat !== "number" || !Number.isInteger(iat)) return { ok: false, error: "malformed" };
  const v = await verifyPlaybackToken(publicKey, token, iat);
  if (!v.ok) return { ok: false, error: v.error === "bad_signature" ? "bad_signature" : "malformed" };
  const age = tokenAge(v.value.iat, nowSeconds, maxAgeSeconds);
  if (age !== "ok") return { ok: false, error: age };
  return { ok: true, claims: v.value };
}

/** True when the heartbeat score (ms) is present and fresh. */
export function heartbeatFresh(score: string | number | null | undefined, nowMs: number): boolean {
  if (score === null || score === undefined) return false;
  const ms = Number(score);
  return Number.isFinite(ms) && nowMs - ms <= HEARTBEAT_STALE_MS;
}
