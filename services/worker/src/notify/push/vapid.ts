// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * RFC 8292 VAPID (ADR 0028 decision 1): the `Authorization: vapid t=<jwt>, k=<key>` header that
 * identifies this instance to a push service. ES256 on Web Crypto, whose ECDSA signature is
 * already the 64-byte `r ‖ s` form JWS wants.
 */
import { b64url } from "@commonair/tokens";

/** How long a VAPID JWT is valid; RFC 8292 §2 caps it at 24 hours. */
export const VAPID_TTL_SECONDS = 12 * 3600;

const enc = new TextEncoder();
// Imported keys per process, by their PKCS#8 text: the key never changes while the worker runs.
const keys = new Map<string, Promise<CryptoKey>>();

/** The imported VAPID private key; rejects when `VAPID_PRIVATE_KEY` is not a P-256 PKCS#8 key. */
export function vapidSigningKey(privateKeyPkcs8: string): Promise<CryptoKey> {
  let key = keys.get(privateKeyPkcs8);
  if (!key) {
    key = crypto.subtle.importKey(
      "pkcs8",
      Uint8Array.from(Buffer.from(privateKeyPkcs8, "base64")),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    // A bad key must not stay cached as a rejected promise.
    key.catch(() => keys.delete(privateKeyPkcs8));
    keys.set(privateKeyPkcs8, key);
  }
  return key;
}

export interface VapidInput {
  /** The subscription's push endpoint: its origin is the JWT `aud`. */
  endpoint: string;
  /** `mailto:` the instance's general contact. */
  subject: string;
  /** base64url uncompressed P-256 point (the `k=` parameter). */
  publicKey: string;
  /** base64 PKCS#8 DER. */
  privateKeyPkcs8: string;
  now: Date;
}

/** `vapid t=<ES256 JWT>, k=<public key>` for one push endpoint. */
export async function vapidAuthorization(input: VapidInput): Promise<string> {
  const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(
    enc.encode(
      JSON.stringify({
        aud: new URL(input.endpoint).origin,
        exp: Math.floor(input.now.getTime() / 1000) + VAPID_TTL_SECONDS,
        sub: input.subject,
      }),
    ),
  );
  const signingInput = `${header}.${claims}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      await vapidSigningKey(input.privateKeyPkcs8),
      enc.encode(signingInput),
    ),
  );
  return `vapid t=${signingInput}.${b64url(signature)}, k=${input.publicKey}`;
}
