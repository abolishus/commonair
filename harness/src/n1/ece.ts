// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The harness's side of Web Push, on WebCrypto (ADR 0028): make a subscription as a browser would,
 * decrypt what the push service received, and verify the VAPID `Authorization`. Written apart from
 * the worker's sender (it uses Web Crypto's own HKDF, not hand-rolled HMAC) so step 4 cross-checks
 * it. N1-pwa's step 7 imports it.
 */
import type { HarnessPushSubscription } from "./run.ts";

export type { HarnessPushSubscription } from "./run.ts";

const te = new TextEncoder();
const td = new TextDecoder();

const toB64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

function fromB64urlLoose(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*=*$/.test(s)) throw new Error("not base64url");
  return Uint8Array.from(Buffer.from(s.replace(/=+$/, ""), "base64url"));
}

function join(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** HKDF-SHA-256 (extract and expand) through Web Crypto. */
async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  bytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", join(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: join(salt), info: join(info) },
      key,
      bytes * 8,
    ),
  );
}

/** A P-256 ECDH key pair and 16 random auth bytes, as a browser makes them; `endpoint` is the receiver. */
export async function newHarnessSubscription(endpoint: string): Promise<HarnessPushSubscription> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const point = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    endpoint,
    keys: { p256dh: toB64url(point), auth: toB64url(crypto.getRandomValues(new Uint8Array(16))) },
    privateKey: pair.privateKey,
  };
}

/** RFC 8291 / RFC 8188 `aes128gcm`: the plaintext of one received push body. */
export async function decryptPushBody(body: Uint8Array, sub: HarnessPushSubscription): Promise<Uint8Array> {
  // RFC 8188 §2.1 header: salt(16) ‖ rs(uint32) ‖ idlen(uint8) ‖ keyid; RFC 8291 puts the sender's key in keyid.
  if (body.byteLength < 21) throw new Error("push body shorter than the aes128gcm header");
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0, false);
  const idlen = body[20];
  if (idlen !== 65) throw new Error(`push body keyid is ${idlen} bytes; RFC 8291 needs a 65-byte P-256 point`);
  const senderPoint = body.slice(21, 86);
  const ciphertext = body.slice(86);
  // RFC 8291 §4: one record only.
  if (ciphertext.byteLength > rs) throw new Error("push body has more than one record");
  if (ciphertext.byteLength < 17) throw new Error("push body record is too short");

  const uaPoint = fromB64urlLoose(sub.keys.p256dh);
  const authSecret = fromB64urlLoose(sub.keys.auth);
  const senderKey = await crypto.subtle.importKey("raw", senderPoint, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: senderKey }, sub.privateKey, 256),
  );
  // RFC 8291 §3.4: IKM = HKDF(auth, ecdh, "WebPush: info\0" ‖ ua ‖ as, 32).
  const ikm = await hkdf(authSecret, shared, join(te.encode("WebPush: info\0"), uaPoint, senderPoint), 32);
  // RFC 8188 §2.2, §2.3.
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext));

  let end = padded.byteLength;
  while (end > 0 && padded[end - 1] === 0x00) end--;
  if (end === 0 || padded[end - 1] !== 0x02) throw new Error("push body record lacks the last-record delimiter");
  return padded.slice(0, end - 1);
}

function decodeJson(part: string, what: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(td.decode(fromB64urlLoose(part)));
  } catch {
    throw new Error(`VAPID JWT ${what} is not base64url JSON`);
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`VAPID JWT ${what} is not an object`);
  return v as Record<string, unknown>;
}

/**
 * RFC 8292: the `Authorization: vapid t=<jwt>, k=<key>` header's JWT verifies (ES256) against
 * `vapidPublicKey`, `k` is that key, `aud` is the endpoint's origin and `exp` is in the future of
 * `nowMs`. Returns the claims; throws on any mismatch.
 */
export async function verifyVapidAuthorization(
  header: string,
  endpoint: string,
  vapidPublicKey: string,
  nowMs: number,
): Promise<{ aud: string; sub: string; exp: number }> {
  const scheme = /^vapid\s+(.+)$/i.exec(header.trim());
  if (!scheme?.[1]) throw new Error("Authorization is not the vapid scheme");
  const params = new Map<string, string>();
  for (const piece of scheme[1].split(",")) {
    const eq = piece.indexOf("=");
    if (eq < 0) throw new Error("malformed vapid parameter");
    params.set(piece.slice(0, eq).trim().toLowerCase(), piece.slice(eq + 1).trim());
  }
  const token = params.get("t");
  const k = params.get("k");
  if (!token || !k) throw new Error("vapid Authorization needs t= and k=");
  if (k.replace(/=+$/, "") !== vapidPublicKey.replace(/=+$/, ""))
    throw new Error("vapid k= is not the instance's VAPID public key");

  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("VAPID JWT does not have three parts");
  const [h, c, s] = parts as [string, string, string];
  const head = decodeJson(h, "header");
  if (head.alg !== "ES256") throw new Error(`VAPID JWT alg is ${String(head.alg)}, not ES256`);
  if (head.typ !== undefined && head.typ !== "JWT") throw new Error("VAPID JWT typ is not JWT");

  const verifyKey = await crypto.subtle.importKey(
    "raw",
    fromB64urlLoose(vapidPublicKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const signature = fromB64urlLoose(s);
  if (signature.byteLength !== 64) throw new Error("VAPID JWT signature is not 64 bytes (r ‖ s)");
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    verifyKey,
    signature,
    te.encode(`${h}.${c}`),
  );
  if (!valid) throw new Error("VAPID JWT signature does not verify against the VAPID public key");

  const claims = decodeJson(c, "claims");
  const { aud, sub, exp } = claims;
  if (typeof aud !== "string" || typeof sub !== "string" || typeof exp !== "number")
    throw new Error("VAPID JWT claims need aud, sub and exp");
  if (aud !== new URL(endpoint).origin) throw new Error(`VAPID aud ${aud} is not the endpoint origin`);
  if (exp * 1000 <= nowMs) throw new Error("VAPID JWT has expired");
  // RFC 8292 §2: no more than 24 hours ahead (a minute of clock slack).
  if (exp * 1000 > nowMs + 24 * 3600_000 + 60_000) throw new Error("VAPID JWT expires more than 24 hours out");
  if (!/^(mailto:|https:)/.test(sub)) throw new Error("VAPID sub is not a mailto: or https: URI");
  return { aud, sub, exp };
}
