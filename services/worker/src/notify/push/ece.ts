// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Web Push message encryption (ADR 0028 decision 1): RFC 8291 key derivation over RFC 8188
 * `aes128gcm`, on Web Crypto only. One record per message (a go-live payload is far below the
 * 4096-byte record), so the nonce is the derived one with sequence number 0.
 */
import { NOTIFY_RULES } from "@commonair/contracts/notify";

type Bytes = Uint8Array<ArrayBuffer>;

const enc = new TextEncoder();
/** RFC 8188 record size we write: the largest a push service must accept (RFC 8291 §4). */
export const PUSH_RECORD_SIZE = 4096;
const SALT_BYTES = 16;
const TAG_BYTES = 16;
const P256_POINT_BYTES = 65;
const AUTH_SECRET_BYTES = 16;
/** salt(16) ‖ rs(4) ‖ idlen(1). */
const FIXED_HEADER_BYTES = SALT_BYTES + 4 + 1;
const LAST_RECORD = 0x02;
const OTHER_RECORD = 0x01;

export class PushPayloadTooLarge extends Error {
  constructor(bytes: number) {
    super(`push plaintext is ${bytes} bytes; the limit is ${NOTIFY_RULES.maxPushPayloadBytes}`);
    this.name = "PushPayloadTooLarge";
  }
}

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Bytes> {
  const k = await crypto.subtle.importKey("raw", concat(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, concat(data)));
}

/** RFC 5869 HKDF-Extract with SHA-256. */
export const hkdfExtract = (salt: Uint8Array, ikm: Uint8Array): Promise<Bytes> => hmac(salt, ikm);

/** RFC 5869 HKDF-Expand for one block (`length` ≤ 32), which is all RFC 8291 and RFC 8188 need. */
export async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Bytes> {
  if (length > 32) throw new Error("hkdfExpand: one SHA-256 block at most");
  return (await hmac(prk, concat(info, Uint8Array.of(1)))).slice(0, length);
}

/** RFC 8188 §2.2/§2.3: the content key and nonce from the input keying material and the salt. */
async function contentKeys(ikm: Uint8Array, salt: Uint8Array): Promise<{ key: CryptoKey; nonce: Bytes }> {
  const prk = await hkdfExtract(salt, ikm);
  const cek = await hkdfExpand(prk, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdfExpand(prk, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt", "decrypt"]);
  return { key, nonce };
}

/** The nonce of record `seq` (RFC 8188 §2.3): the derived nonce XOR the big-endian sequence number. */
function recordNonce(nonce: Bytes, seq: number): Bytes {
  const out = nonce.slice();
  let s = seq;
  for (let i = out.length - 1; i >= 0 && s > 0; i--) {
    out[i] = (out[i] ?? 0) ^ (s & 0xff);
    s = Math.floor(s / 256);
  }
  return out;
}

/** RFC 8291 §3.3/§3.4: the IKM for `aes128gcm` from the ECDH secret and the auth secret. */
async function webPushIkm(
  ecdhSecret: Uint8Array,
  authSecret: Uint8Array,
  uaPublic: Uint8Array,
  asPublic: Uint8Array,
): Promise<Bytes> {
  const prkKey = await hkdfExtract(authSecret, ecdhSecret);
  return hkdfExpand(prkKey, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
}

async function ecdh(privateKey: CryptoKey, peerPublic: Uint8Array): Promise<Bytes> {
  const pub = await crypto.subtle.importKey(
    "raw",
    concat(peerPublic),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, privateKey, 256));
}

function checkPoint(name: string, point: Uint8Array): void {
  if (point.length !== P256_POINT_BYTES || point[0] !== 0x04)
    throw new Error(`${name} must be an uncompressed P-256 point (65 bytes, 0x04 first)`);
}

export interface EncryptPushInput {
  plaintext: Uint8Array;
  /** The browser's `p256dh` (65 bytes). */
  uaPublic: Uint8Array;
  /** The browser's `auth` (16 bytes). */
  authSecret: Uint8Array;
  /** Tests only: the application server's ECDH pair (fresh per message otherwise). */
  asKeyPair?: CryptoKeyPair;
  /** Tests only: the salt (16 random bytes per message otherwise). */
  salt?: Uint8Array;
}

/** RFC 8291 §3.4: one `aes128gcm` message to one browser. */
export async function encryptPushPayload(input: EncryptPushInput): Promise<Bytes> {
  const { plaintext, uaPublic, authSecret } = input;
  if (plaintext.length > NOTIFY_RULES.maxPushPayloadBytes) throw new PushPayloadTooLarge(plaintext.length);
  checkPoint("uaPublic", uaPublic);
  if (authSecret.length !== AUTH_SECRET_BYTES) throw new Error("authSecret must be 16 bytes");
  const salt = input.salt ?? crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  if (salt.length !== SALT_BYTES) throw new Error("salt must be 16 bytes");
  const pair =
    input.asKeyPair ??
    ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));

  const ikm = await webPushIkm(await ecdh(pair.privateKey, uaPublic), authSecret, uaPublic, asPublic);
  const { key, nonce } = await contentKeys(ikm, salt);
  const record = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: recordNonce(nonce, 0) },
      key,
      concat(plaintext, Uint8Array.of(LAST_RECORD)),
    ),
  );
  const header = new Uint8Array(FIXED_HEADER_BYTES);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(SALT_BYTES, PUSH_RECORD_SIZE);
  header[SALT_BYTES + 4] = asPublic.length;
  return concat(header, asPublic, record);
}

/**
 * RFC 8188 §2 decryption of an `aes128gcm` message whose IKM comes from its key id (`ikmFor`).
 * Every record's padding is checked (delimiter 0x01, or 0x02 on the last).
 */
export async function decryptAes128gcm(
  message: Uint8Array,
  ikmFor: (keyId: Bytes) => Promise<Uint8Array> | Uint8Array,
): Promise<Bytes> {
  if (message.length < FIXED_HEADER_BYTES) throw new Error("aes128gcm: truncated header");
  const salt = message.slice(0, SALT_BYTES);
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  const rs = view.getUint32(SALT_BYTES);
  const idlen = message[SALT_BYTES + 4] ?? 0;
  if (rs <= TAG_BYTES + 1) throw new Error("aes128gcm: record size too small");
  const start = FIXED_HEADER_BYTES + idlen;
  if (message.length < start + TAG_BYTES + 1) throw new Error("aes128gcm: truncated");
  const keyId = message.slice(FIXED_HEADER_BYTES, start);
  const { key, nonce } = await contentKeys(await ikmFor(keyId), salt);

  const parts: Bytes[] = [];
  let seq = 0;
  for (let at = start; at < message.length; at += rs, seq++) {
    const last = at + rs >= message.length;
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: recordNonce(nonce, seq) },
        key,
        message.slice(at, Math.min(at + rs, message.length)),
      ),
    );
    let end = plain.length - 1;
    while (end >= 0 && plain[end] === 0) end--;
    if (end < 0) throw new Error("aes128gcm: record without a delimiter");
    if (plain[end] !== (last ? LAST_RECORD : OTHER_RECORD)) throw new Error("aes128gcm: bad padding delimiter");
    parts.push(plain.slice(0, end));
  }
  return concat(...parts);
}

/** Tests: decrypt an RFC 8291 message with the browser's private key and auth secret. */
export async function decryptPushPayload(input: {
  message: Uint8Array;
  uaPrivateKey: CryptoKey;
  uaPublic: Uint8Array;
  authSecret: Uint8Array;
}): Promise<Bytes> {
  return decryptAes128gcm(input.message, async (asPublic) => {
    checkPoint("keyid", asPublic);
    return webPushIkm(await ecdh(input.uaPrivateKey, asPublic), input.authSecret, input.uaPublic, asPublic);
  });
}
