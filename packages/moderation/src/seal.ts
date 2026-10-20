// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Sealed evidence (ADR 0006 Q4): anonymous public-key encryption to the operator's evidence key,
 * WebCrypto only. Media, the worker and the API seal with the public key; only the API's legal
 * view holds the private key, so the services that handle frames cannot read evidence back, and
 * database dumps carry ciphertext only.
 *
 * Format v1 (all integers big-endian, header = first 65 bytes):
 *
 *   "CAEV" (4) | version 0x01 (1) | key id (16) | ephemeral X25519 public key (32) | nonce (12)
 *   | AES-256-GCM ciphertext with its 16-byte tag
 *
 * - key id = the first 16 bytes of sha256(recipient raw public key); hex of it is `keyId`.
 * - shared = X25519(ephemeral private, recipient public); an all-zero result is refused.
 * - key = HKDF-SHA256(ikm = shared, salt = ephemeral public ‖ recipient public,
 *   info = "commonair-evidence-v1", 32 bytes).
 * - AAD = the whole header, so the version, key id and ephemeral key cannot be swapped.
 *
 * A fresh ephemeral key per object means a nonce is never reused under one key.
 */

const MAGIC = new Uint8Array([0x43, 0x41, 0x45, 0x56]);
export const SEAL_VERSION = 1;
export const SEAL_HEADER_BYTES = 65;
/** Header plus the GCM tag: sealed size = plaintext size + this. */
export const SEAL_OVERHEAD_BYTES = SEAL_HEADER_BYTES + 16;
const INFO = new TextEncoder().encode("commonair-evidence-v1");

export class SealError extends Error {
  override name = "SealError";
}

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64urlDecode = (s: string) =>
  b64(s.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (s.length % 4)) % 4));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
/** WebCrypto wants ArrayBuffer-backed views; callers may pass any Uint8Array (copied). */
const own = (u: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(u);
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", own(b)));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

async function keyIdBytes(rawPublic: Uint8Array): Promise<Uint8Array> {
  return (await sha256(rawPublic)).subarray(0, 16);
}

/** `keyId` of a raw 32-byte X25519 public key: 32 hex characters. Stored with every sealed object. */
export async function evidenceKeyId(publicKeyB64: string): Promise<string> {
  return hex(await keyIdBytes(b64(publicKeyB64)));
}

async function aesKey(shared: Uint8Array, ephPublic: Uint8Array, recipientPublic: Uint8Array, usage: KeyUsage) {
  if (shared.every((b) => b === 0)) throw new SealError("degenerate X25519 shared secret");
  const ikm = await crypto.subtle.importKey("raw", own(shared), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: own(concat(ephPublic, recipientPublic)), info: INFO },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

export interface SealingKey {
  readonly keyId: string;
  seal(plaintext: Uint8Array): Promise<Uint8Array>;
}

export interface OpeningKey {
  readonly keyId: string;
  open(sealed: Uint8Array): Promise<Uint8Array>;
}

/** Import `EVIDENCE_PUBLIC_KEY` (base64 raw 32 bytes). */
export async function importSealingKey(publicKeyB64: string): Promise<SealingKey> {
  const recipientPublic = b64(publicKeyB64);
  if (recipientPublic.length !== 32) throw new SealError("evidence public key must be 32 bytes");
  const recipient = await crypto.subtle.importKey("raw", own(recipientPublic), { name: "X25519" }, false, []);
  const idBytes = await keyIdBytes(recipientPublic);
  return {
    keyId: hex(idBytes),
    async seal(plaintext) {
      const eph = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as unknown as {
        publicKey: CryptoKey;
        privateKey: CryptoKey;
      };
      const ephPublic = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
      const shared = new Uint8Array(
        await crypto.subtle.deriveBits({ name: "X25519", public: recipient }, eph.privateKey, 256),
      );
      const key = await aesKey(shared, ephPublic, recipientPublic, "encrypt");
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const header = concat(MAGIC, new Uint8Array([SEAL_VERSION]), idBytes, ephPublic, nonce);
      const ct = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: header }, key, own(plaintext)),
      );
      return concat(header, ct);
    },
  };
}

/** Import `EVIDENCE_PRIVATE_KEY` (base64 X25519 PKCS#8). Only the API's legal handlers do this. */
export async function importOpeningKey(privateKeyPkcs8B64: string): Promise<OpeningKey> {
  const extractable = await crypto.subtle.importKey("pkcs8", b64(privateKeyPkcs8B64), { name: "X25519" }, true, [
    "deriveBits",
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", extractable);
  if (!jwk.x) throw new SealError("evidence private key has no public half");
  const recipientPublic = b64urlDecode(jwk.x);
  const privateKey = await crypto.subtle.importKey("pkcs8", b64(privateKeyPkcs8B64), { name: "X25519" }, false, [
    "deriveBits",
  ]);
  const idBytes = await keyIdBytes(recipientPublic);
  const keyId = hex(idBytes);
  return {
    keyId,
    async open(sealed) {
      if (sealed.length < SEAL_OVERHEAD_BYTES) throw new SealError("sealed object is truncated");
      if (!MAGIC.every((b, i) => sealed[i] === b)) throw new SealError("not a sealed evidence object");
      if (sealed[4] !== SEAL_VERSION) throw new SealError(`unsupported seal version ${sealed[4]}`);
      if (hex(sealed.subarray(5, 21)) !== keyId) throw new SealError("sealed to a different evidence key");
      const header = sealed.subarray(0, SEAL_HEADER_BYTES);
      const ephPublic = sealed.subarray(21, 53);
      const nonce = sealed.subarray(53, 65);
      const eph = await crypto.subtle.importKey("raw", own(ephPublic), { name: "X25519" }, false, []);
      const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: eph }, privateKey, 256));
      const key = await aesKey(shared, ephPublic, recipientPublic, "decrypt");
      try {
        return new Uint8Array(
          await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: own(nonce), additionalData: own(header) },
            key,
            own(sealed.subarray(SEAL_HEADER_BYTES)),
          ),
        );
      } catch {
        throw new SealError("sealed object failed authentication");
      }
    },
  };
}

/** sha256 hex of plaintext, as stored in `evidence_objects.sha256` and checked by the daily audit. */
export const plaintextSha256 = async (plaintext: Uint8Array) => hex(await sha256(plaintext));

/** Seal a JSON value (the NCMEC draft snapshot). */
export const sealJson = (key: SealingKey, value: unknown) => key.seal(new TextEncoder().encode(JSON.stringify(value)));
export const openJson = async (key: OpeningKey, sealed: Uint8Array): Promise<unknown> =>
  JSON.parse(new TextDecoder().decode(await key.open(sealed)));
