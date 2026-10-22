// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure helpers for the data-export link (a SigV4 presigned GET): find it in the email, read its
 * expiry, change one signature character, drop the signature. The link is a bearer credential:
 * none of these functions log it, and the scenario never writes it to the report.
 */
import { exportObjectKey } from "@commonair/contracts/internal";

export const SIGNATURE_PARAM = "X-Amz-Signature";
export const EXPIRES_PARAM = "X-Amz-Expires";
export const DATE_PARAM = "X-Amz-Date";

/** True when `url` is a presigned GET for exactly `key` (path-style or virtual-hosted). */
export function isPresignedFor(url: string, key: string): boolean {
  if (!URL.canParse(url)) return false;
  const u = new URL(url);
  if (!u.searchParams.has(SIGNATURE_PARAM)) return false;
  const path = decodeURIComponent(u.pathname);
  return path === `/${key}` || path.endsWith(`/${key}`);
}

/** The presigned link for one export among a mail's links, or null. */
export function exportLinkIn(links: readonly string[], userId: string, exportId: string): string | null {
  const key = exportObjectKey(userId, exportId);
  return links.find((l) => isPresignedFor(l, key)) ?? null;
}

/** `X-Amz-Expires` in seconds, or null when absent or not a non-negative integer. */
export function presignExpiresSeconds(url: string): number | null {
  const v = new URL(url).searchParams.get(EXPIRES_PARAM);
  if (v === null || !/^\d+$/.test(v)) return null;
  return Number(v);
}

/** `X-Amz-Date` (`YYYYMMDDTHHMMSSZ`) as epoch ms, or null when absent or malformed. */
export function presignSignedAt(url: string): number | null {
  if (!URL.canParse(url)) return null;
  const v = new URL(url).searchParams.get(DATE_PARAM);
  const m = v === null ? null : /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number) as [number, number, number, number, number, number, number];
  const at = Date.UTC(y, mo - 1, d, h, mi, s);
  return Number.isFinite(at) ? at : null;
}

/** The last instant the link is valid (`X-Amz-Date + X-Amz-Expires`) as epoch ms, or null. */
export function presignValidUntil(url: string): number | null {
  const signedAt = presignSignedAt(url);
  const expires = URL.canParse(url) ? presignExpiresSeconds(url) : null;
  return signedAt === null || expires === null ? null : signedAt + expires * 1000;
}

/**
 * True when the presigned link stops working no later than `expiresAt` (+ `toleranceS` for the
 * second-precision `X-Amz-Date` and the signing happening just after the row was written).
 */
export function linkWithinExpiry(url: string, expiresAt: string | null, toleranceS = 5): boolean {
  const until = presignValidUntil(url);
  const limit = expiresAt === null ? NaN : Date.parse(expiresAt);
  return until !== null && Number.isFinite(limit) && until <= limit + toleranceS * 1000;
}

/** Links that look presigned (a SigV4 signature) or that point at `origin` (the storage host). */
export function storageLinks(links: readonly string[], origin?: string): string[] {
  return links.filter((l) => {
    if (!URL.canParse(l)) return false;
    const u = new URL(l);
    return u.searchParams.has(SIGNATURE_PARAM) || (origin !== undefined && u.origin === origin);
  });
}

/**
 * The same link with one character of the signature changed (hex: the first character is
 * replaced by a different hex digit). Throws when there is no signature to tamper with.
 */
export function tamperSignature(url: string): string {
  const u = new URL(url);
  const sig = u.searchParams.get(SIGNATURE_PARAM);
  if (!sig) throw new Error("not a presigned URL (no signature)");
  const first = sig[0] ?? "0";
  const replacement = first === "0" ? "1" : "0";
  u.searchParams.set(SIGNATURE_PARAM, `${replacement}${sig.slice(1)}`);
  return u.toString();
}

/** The object URL with every query parameter removed (an anonymous GET of the key). */
export function unsignedUrl(url: string): string {
  const u = new URL(url);
  u.search = "";
  u.hash = "";
  return u.toString();
}

/** Whole seconds between two instants (b − a), rounded. */
export function secondsBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 1000);
}
