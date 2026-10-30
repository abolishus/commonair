// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * RFC 8058 unsubscribe tokens (ADR 0028 decision 4): `v1.<b64url(user id, 16 bytes)>.<b64url(mac, 16 bytes)>`,
 * mac = first 16 bytes of HMAC-SHA-256 over `"email-unsubscribe:" + list + ":" + userId` with a key
 * derived from AUTH_SECRET (purpose "email-unsubscribe"). No expiry: a link in an old email must
 * keep working (the action only turns mail off). Rotating AUTH_SECRET invalidates every link.
 */
import { b64url, fromB64url, timingSafeEqual } from "./index.ts";
import { hkdfKey } from "./secrets.ts";

const enc = new TextEncoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAC_BYTES = 16;

function uuidBytes(id: string): Uint8Array {
  const hex = id.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function mac(secret: string, userId: string, list: string): Promise<string> {
  const key = await hkdfKey(secret, "email-unsubscribe", ["sign"], { name: "HMAC", hash: "SHA-256" });
  const full = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`email-unsubscribe:${list}:${userId}`)));
  return b64url(full.slice(0, MAC_BYTES));
}

/** Throws on a user id that is not a lowercase UUID (a programming error, not user input). */
export async function signUnsubscribeToken(secret: string, userId: string, list: string): Promise<string> {
  if (!UUID.test(userId)) throw new Error("unsubscribe token needs a UUID user id");
  return `v1.${b64url(uuidBytes(userId))}.${await mac(secret, userId, list)}`;
}

/** The user id, or null for a malformed, foreign-list or forged token (constant-time compare). */
export async function verifyUnsubscribeToken(secret: string, token: string, list: string): Promise<string | null> {
  const [version, id, tag, extra] = token.split(".");
  if (version !== "v1" || !id || !tag || extra !== undefined) return null;
  let idBytes: Uint8Array;
  let tagBytes: Uint8Array;
  try {
    idBytes = fromB64url(id);
    tagBytes = fromB64url(tag);
  } catch {
    return null;
  }
  if (idBytes.length !== 16 || tagBytes.length !== MAC_BYTES) return null;
  const userId = bytesUuid(idBytes);
  return timingSafeEqual(await mac(secret, userId, list), tag) ? userId : null;
}
