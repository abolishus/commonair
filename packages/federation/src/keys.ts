// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Actor keys (ADR 0030 decision 4): RSA-2048, RSASSA-PKCS1-v1_5 with SHA-256, on Web Crypto.
 * Public keys travel as SPKI PEM (`BEGIN PUBLIC KEY`, what Mastodon publishes as
 * `publicKeyPem`); remote PKCS#1 PEM (`BEGIN RSA PUBLIC KEY`) is accepted too. Private keys are
 * PKCS#8 PEM, stored with `encryptSecret` by the caller and never logged.
 */
import { fromBase64, toBase64 } from "./digest.ts";

export const RSA_ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
export const ACTOR_KEY_BITS = 2048;
/** Remote keys below this size are refused. */
export const MIN_RSA_BITS = 2048;
/** And above this (a huge modulus is a cheap way to make us burn CPU). */
export const MAX_RSA_BITS = 8192;

export interface ActorKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

function toPem(label: string, der: Uint8Array): string {
  const b64 = toBase64(der);
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

const PEM = /^-----BEGIN ([A-Z ]+)-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END ([A-Z ]+)-----\s*$/;

function fromPem(pem: string): { label: string; der: Uint8Array<ArrayBuffer> } {
  const m = PEM.exec(pem.trim());
  if (!m || m[1] !== m[3]) throw new Error("not a PEM block");
  return { label: m[1] as string, der: fromBase64((m[2] as string).replace(/\s+/g, "")) };
}

/** DER length octets. */
function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return [0x80 | bytes.length, ...bytes];
}

function der(tag: number, content: Uint8Array): Uint8Array {
  const len = derLength(content.length);
  const out = new Uint8Array(1 + len.length + content.length);
  out[0] = tag;
  out.set(len, 1);
  out.set(content, 1 + len.length);
  return out;
}

/** AlgorithmIdentifier { rsaEncryption, NULL }. */
const RSA_ALGORITHM_ID = Uint8Array.from([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]);

/** Wrap a PKCS#1 RSAPublicKey in a SubjectPublicKeyInfo, which Web Crypto imports. */
export function pkcs1ToSpki(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const bitString = new Uint8Array(pkcs1.length + 1);
  bitString.set(pkcs1, 1);
  const body = der(0x03, bitString);
  const seq = new Uint8Array(RSA_ALGORITHM_ID.length + body.length);
  seq.set(RSA_ALGORITHM_ID, 0);
  seq.set(body, RSA_ALGORITHM_ID.length);
  return new Uint8Array(der(0x30, seq));
}

function checkBits(key: CryptoKey): CryptoKey {
  const bits = (key.algorithm as RsaHashedKeyAlgorithm).modulusLength;
  if (bits < MIN_RSA_BITS || bits > MAX_RSA_BITS) throw new Error(`RSA key size ${bits} is out of bounds`);
  return key;
}

/** A fresh RSA-2048 actor key pair as PEM. */
export async function generateActorKey(): Promise<ActorKeyPair> {
  const pair = (await crypto.subtle.generateKey(
    { ...RSA_ALGORITHM, modulusLength: ACTOR_KEY_BITS, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  return {
    publicKeyPem: await exportPublicKeyPem(pair.publicKey),
    privateKeyPem: await exportPrivateKeyPem(pair.privateKey),
  };
}

export async function exportPublicKeyPem(key: CryptoKey): Promise<string> {
  return toPem("PUBLIC KEY", new Uint8Array(await crypto.subtle.exportKey("spki", key)));
}

export async function exportPrivateKeyPem(key: CryptoKey): Promise<string> {
  return toPem("PRIVATE KEY", new Uint8Array(await crypto.subtle.exportKey("pkcs8", key)));
}

/** Import a remote or stored public key (SPKI or PKCS#1 PEM) for verification. */
export async function importPublicKeyPem(pem: string): Promise<CryptoKey> {
  const { label, der: bytes } = fromPem(pem);
  let spki: Uint8Array<ArrayBuffer>;
  if (label === "PUBLIC KEY") spki = bytes;
  else if (label === "RSA PUBLIC KEY") spki = pkcs1ToSpki(bytes);
  else throw new Error(`unsupported public key PEM (${label})`);
  return checkBits(await crypto.subtle.importKey("spki", spki, RSA_ALGORITHM, true, ["verify"]));
}

/** Import a stored PKCS#8 private key for signing. Not extractable once imported. */
export async function importPrivateKeyPem(pem: string): Promise<CryptoKey> {
  const { label, der: bytes } = fromPem(pem);
  if (label !== "PRIVATE KEY") throw new Error(`unsupported private key PEM (${label})`);
  return checkBits(await crypto.subtle.importKey("pkcs8", bytes, RSA_ALGORITHM, false, ["sign"]));
}

/** The SPKI PEM of a PKCS#8 private key PEM (to rebuild the actor document from a stored key). */
export async function publicKeyPemFromPrivate(privateKeyPem: string): Promise<string> {
  const { label, der: bytes } = fromPem(privateKeyPem);
  if (label !== "PRIVATE KEY") throw new Error(`unsupported private key PEM (${label})`);
  const extractable = await crypto.subtle.importKey("pkcs8", bytes, RSA_ALGORITHM, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", extractable);
  const pub = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e }, RSA_ALGORITHM, true, ["verify"]);
  return exportPublicKeyPem(pub);
}
