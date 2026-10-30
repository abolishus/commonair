// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The harness's side of Web Push, on WebCrypto (ADR 0028): make a subscription as a browser would,
 * decrypt what the push service received, and verify the VAPID `Authorization`. The signatures are
 * final; N1-push fills the bodies (N1-pwa's step 7 imports them in the same wave).
 */
import type { HarnessPushSubscription } from "./run.ts";

export type { HarnessPushSubscription } from "./run.ts";

/** A P-256 ECDH key pair and 16 random auth bytes, as a browser makes them; `endpoint` is the receiver. */
export async function newHarnessSubscription(_endpoint: string): Promise<HarnessPushSubscription> {
  throw new Error("N1-push not merged");
}

/** RFC 8291 / RFC 8188 `aes128gcm`: the plaintext of one received push body. */
export async function decryptPushBody(_body: Uint8Array, _sub: HarnessPushSubscription): Promise<Uint8Array> {
  throw new Error("N1-push not merged");
}

/**
 * RFC 8292: the `Authorization: vapid t=<jwt>, k=<key>` header's JWT verifies (ES256) against
 * `vapidPublicKey`, `k` is that key, `aud` is the endpoint's origin and `exp` is in the future of
 * `nowMs`. Returns the claims; throws on any mismatch.
 */
export async function verifyVapidAuthorization(
  _header: string,
  _endpoint: string,
  _vapidPublicKey: string,
  _nowMs: number,
): Promise<{ aud: string; sub: string; exp: number }> {
  throw new Error("N1-push not merged");
}
