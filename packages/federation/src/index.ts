// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * ActivityPub federation primitives (ADR 0030): draft-cavage HTTP Signatures, the `Digest`
 * header, RSA actor keys, and the ActivityStreams objects and activities. Web Crypto only, no
 * third-party code (batch 7 decision (ad)). `vectors.json` pins the signatures.
 */
export * from "./activities.ts";
export { type Body, digest, verifyDigest } from "./digest.ts";
export {
  ACTOR_KEY_BITS,
  type ActorKeyPair,
  checkKeyBits,
  exportPrivateKeyPem,
  exportPublicKeyPem,
  generateActorKey,
  importPrivateKeyPem,
  importPublicKeyPem,
  MAX_RSA_BITS,
  MIN_RSA_BITS,
  pkcs1ToSpki,
  publicKeyPemFromPrivate,
  RSA_ALGORITHM,
} from "./keys.ts";
export * from "./objects.ts";
export {
  DATE_SKEW_SECONDS,
  FUTURE_SKEW_SECONDS,
  type HeadersLike,
  normalizeHeaders,
  parseSignatureHeader,
  SIGNATURE_ALGORITHM,
  type SignatureError,
  type SenderKey,
  type SignatureParams,
  type SignRequestInput,
  signingString,
  signRequest,
  type VerifyOptions,
  type VerifyRequestInput,
  type VerifyRequestResult,
  verifyRequest,
} from "./signature.ts";
