// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Ed25519 playback tokens and relay receipts (WebCrypto; works in Bun, Node and
 * browsers), plus hashing helpers for secrets and identifiers.
 * Formats are specified in @commonair/contracts/tokens; vectors.json pins them
 * for the Go implementation in relay/.
 */
import { PlaybackClaims, ReceiptPayload } from "@commonair/contracts";

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}
const B64URL = /^[A-Za-z0-9_-]*$/;

/** Strict base64url decode: rejects padding, foreign characters and non-canonical encodings. */
export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  if (!B64URL.test(s) || s.length % 4 === 1) throw new Error("invalid base64url");
  const bytes = Uint8Array.from(Buffer.from(s, "base64url"));
  if (Buffer.from(bytes).toString("base64url") !== s) throw new Error("non-canonical base64url");
  return bytes;
}

export interface SigningKey {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  /** Raw 32-byte public key, base64url (43 chars). */
  publicKeyB64: string;
}

export async function generateSigningKey(): Promise<{ key: SigningKey; pkcs8B64: string }> {
  const generated: unknown = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pair = generated as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return {
    key: await importSigningKey(Buffer.from(pkcs8).toString("base64")),
    pkcs8B64: Buffer.from(pkcs8).toString("base64"),
  };
}

/** Import a PKCS#8 (DER, standard base64) Ed25519 private key, e.g. PLAYBACK_SIGNING_KEY. */
export async function importSigningKey(pkcs8B64: string): Promise<SigningKey> {
  const der = Uint8Array.from(Buffer.from(pkcs8B64, "base64"));
  // Import once as extractable only to derive the public key, then keep a non-extractable signing key.
  const temp = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", temp);
  if (!jwk.x) throw new Error("not an Ed25519 private key");
  const privateKey = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
  const publicKey = await importVerifyKey(jwk.x);
  return { privateKey, publicKey, publicKeyB64: jwk.x };
}

export async function importVerifyKey(publicKeyB64: string): Promise<CryptoKey> {
  const raw = fromB64url(publicKeyB64);
  if (raw.length !== 32) throw new Error("Ed25519 public keys are 32 bytes");
  return crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, true, ["verify"]);
}

async function sign(key: CryptoKey, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, data));
}
async function verify(key: CryptoKey, sig: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>): Promise<boolean> {
  if (sig.length !== 64) return false;
  return crypto.subtle.verify({ name: "Ed25519" }, key, sig, data);
}

export async function signPlaybackToken(key: SigningKey, claims: PlaybackClaims): Promise<string> {
  const body = enc.encode(JSON.stringify(PlaybackClaims.parse(claims)));
  return `${b64url(body)}.${b64url(await sign(key.privateKey, body))}`;
}

export type TokenError = "malformed" | "bad_signature" | "expired" | "not_yet_valid";
export type VerifyResult<T> = { ok: true; value: T } | { ok: false; error: TokenError };

/**
 * Verify signature and claims shape only, with no time checks. For long-lived connections that
 * apply their own age policy to `iat` (the P2P tracker, ADR 0005); everything else uses
 * `verifyPlaybackToken`.
 */
export async function verifyPlaybackTokenSignature(
  publicKey: CryptoKey,
  token: string,
): Promise<VerifyResult<PlaybackClaims>> {
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return { ok: false, error: "malformed" };
  let bytes: Uint8Array<ArrayBuffer>;
  let sigBytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromB64url(body);
    sigBytes = fromB64url(sig);
  } catch {
    return { ok: false, error: "malformed" };
  }
  if (!(await verify(publicKey, sigBytes, bytes))) return { ok: false, error: "bad_signature" };
  try {
    const parsed = PlaybackClaims.safeParse(JSON.parse(dec.decode(bytes)));
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: "malformed" };
  } catch {
    return { ok: false, error: "malformed" };
  }
}

/** Verify signature and expiry. `skewSeconds` tolerates small clock differences between hosts. */
export async function verifyPlaybackToken(
  publicKey: CryptoKey,
  token: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  skewSeconds = 30,
): Promise<VerifyResult<PlaybackClaims>> {
  const r = await verifyPlaybackTokenSignature(publicKey, token);
  if (!r.ok) return r;
  if (r.value.exp + skewSeconds < nowSeconds) return { ok: false, error: "expired" };
  if (r.value.iat - skewSeconds > nowSeconds) return { ok: false, error: "not_yet_valid" };
  return r;
}

export interface SignedReceipt {
  payload: string;
  signature: string;
}

export async function signReceipt(key: SigningKey, payload: ReceiptPayload): Promise<SignedReceipt> {
  const bytes = enc.encode(JSON.stringify(ReceiptPayload.parse(payload)));
  return { payload: b64url(bytes), signature: b64url(await sign(key.privateKey, bytes)) };
}

export async function verifyReceipt(
  relayPublicKeyB64: string,
  receipt: SignedReceipt,
): Promise<VerifyResult<ReceiptPayload>> {
  let bytes: Uint8Array<ArrayBuffer>;
  let sigBytes: Uint8Array<ArrayBuffer>;
  let key: CryptoKey;
  try {
    bytes = fromB64url(receipt.payload);
    sigBytes = fromB64url(receipt.signature);
    key = await importVerifyKey(relayPublicKeyB64);
  } catch {
    return { ok: false, error: "malformed" };
  }
  if (!(await verify(key, sigBytes, bytes))) return { ok: false, error: "bad_signature" };
  try {
    const parsed = ReceiptPayload.safeParse(JSON.parse(dec.decode(bytes)));
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: "malformed" };
  } catch {
    return { ok: false, error: "malformed" };
  }
}

/** Hex SHA-256, used to store stream keys, tokens and secrets (never the plaintext). */
export async function sha256Hex(value: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Keyed hash for identifiers we must compare but must not store (IPs, device ids). */
export async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const d = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(value)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** URL-safe random secret, `bytes` of entropy. Prefixes make leaked secrets greppable (e.g. "live_", "relay_"). */
export function randomSecret(prefix = "", bytes = 32): string {
  return prefix + b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * Random secret in lowercase hex, for OAuth access tokens. Twitch-compatible IRC clients (tmi.js
 * and others) lowercase the `PASS oauth:<token>` they send, so a mixed-case token could never sign
 * in through the IRC gateway. `bytes` of entropy, as `randomSecret`.
 */
export function randomTokenSecret(prefix = "", bytes = 32): string {
  return (
    prefix + Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("")
  );
}

export { decryptSecret, encryptSecret, signChatToken, verifyChatToken } from "./secrets.ts";
export { signUnsubscribeToken, verifyUnsubscribeToken } from "./unsubscribe.ts";
