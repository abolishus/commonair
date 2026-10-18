// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Symmetric helpers: AES-256-GCM encryption of secrets at rest (simulcast stream
 * keys, webhook secrets), and HMAC-signed chat connection tokens.
 */
import { ChatTokenClaims } from "@commonair/contracts/internal";
import { b64url, fromB64url, timingSafeEqual } from "./index.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

async function hkdfKey(
  secret: string,
  info: string,
  usage: KeyUsage[],
  algo: AesKeyAlgorithm | HmacImportParams,
): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("commonair"), info: enc.encode(info) },
    ikm,
    algo,
    false,
    usage,
  );
}

/** Encrypt with a key derived from `secret` (e.g. AUTH_SECRET) for `purpose`. Output: "v1." + b64url(iv ‖ ciphertext). */
export async function encryptSecret(secret: string, purpose: string, plaintext: string): Promise<string> {
  const key = await hkdfKey(secret, `secret:${purpose}`, ["encrypt"], {
    name: "AES-GCM",
    length: 256,
  });
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode(purpose) },
      key,
      enc.encode(plaintext),
    ),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return `v1.${b64url(out)}`;
}

export async function decryptSecret(secret: string, purpose: string, ciphertext: string): Promise<string> {
  if (!ciphertext.startsWith("v1.")) throw new Error("unknown ciphertext version");
  const raw = fromB64url(ciphertext.slice(3));
  const key = await hkdfKey(secret, `secret:${purpose}`, ["decrypt"], {
    name: "AES-GCM",
    length: 256,
  });
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: raw.slice(0, 12), additionalData: enc.encode(purpose) },
    key,
    raw.slice(12),
  );
  return dec.decode(pt);
}

async function chatKey(internalSecret: string): Promise<CryptoKey> {
  const k = await crypto.subtle.importKey("raw", enc.encode(internalSecret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const derived = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode("chat-token-v1")));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function signChatToken(internalSecret: string, claims: ChatTokenClaims): Promise<string> {
  const body = enc.encode(JSON.stringify(ChatTokenClaims.parse(claims)));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await chatKey(internalSecret), body));
  return `${b64url(body)}.${b64url(mac)}`;
}

export async function verifyChatToken(
  internalSecret: string,
  token: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<ChatTokenClaims | null> {
  const [body, mac, extra] = token.split(".");
  if (!body || !mac || extra !== undefined) return null;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromB64url(body);
  } catch {
    return null;
  }
  const expected = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", await chatKey(internalSecret), bytes)));
  if (!timingSafeEqual(expected, mac)) return null;
  try {
    const claims = ChatTokenClaims.parse(JSON.parse(dec.decode(bytes)));
    return claims.exp >= nowSeconds ? claims : null;
  } catch {
    return null;
  }
}
