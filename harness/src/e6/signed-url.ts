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
