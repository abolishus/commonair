// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The `Digest` header (RFC 3230, as Mastodon sends it): `SHA-256=<base64 of the body's hash>`. */

export type Body = string | Uint8Array;

const enc = new TextEncoder();

export function bodyBytes(body: Body): Uint8Array<ArrayBuffer> {
  return typeof body === "string" ? enc.encode(body) : new Uint8Array(body);
}

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The header value for a body: `SHA-256=` and the base64 SHA-256 of its bytes. */
export async function digest(body: Body): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bodyBytes(body)));
  return `SHA-256=${toBase64(hash)}`;
}

/**
 * True when a `Digest` header carries a SHA-256 entry equal to the body's. The algorithm name is
 * case-insensitive and other algorithms in a list are ignored; a header with no SHA-256 entry
 * fails, so a sender cannot pick a weaker hash.
 */
export async function verifyDigest(header: string, body: Body): Promise<boolean> {
  const expected = (await digest(body)).slice("SHA-256=".length);
  let found = false;
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim().toLowerCase() !== "sha-256") continue;
    found = true;
    if (part.slice(eq + 1).trim() !== expected) return false;
  }
  return found;
}
