// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The harness's own Web Push decryptor and VAPID verifier (ADR 0028), against RFC 8291 Appendix A. */
import { describe, expect, test } from "vite-plus/test";
import {
  decryptPushBody,
  type HarnessPushSubscription,
  newHarnessSubscription,
  verifyVapidAuthorization,
} from "../../src/n1/ece.ts";

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const unb64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64url"));
const te = new TextEncoder();

/** RFC 8291 Appendix A. */
const A = {
  plaintext: "When I grow up, I want to be a watermelon",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  message:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

async function rfcSubscription(): Promise<HarnessPushSubscription> {
  const pub = unb64(A.uaPublic);
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: b64(pub.subarray(1, 33)), y: b64(pub.subarray(33, 65)), d: A.uaPrivate },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  return { endpoint: "https://push.example.test/x", keys: { p256dh: A.uaPublic, auth: A.authSecret }, privateKey };
}

describe("newHarnessSubscription", () => {
  test("browser-shaped keys: a 65-byte uncompressed point and 16 auth bytes, base64url", async () => {
    const s = await newHarnessSubscription("http://host.containers.internal:1/push/a");
    expect(s.endpoint).toBe("http://host.containers.internal:1/push/a");
    expect(s.keys.p256dh).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(s.keys.auth).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(unb64(s.keys.p256dh)[0]).toBe(0x04);
    expect(s.privateKey.extractable).toBe(false);
    const t = await newHarnessSubscription("x");
    expect(t.keys.auth).not.toBe(s.keys.auth);
  });
});

describe("decryptPushBody", () => {
  test("RFC 8291 Appendix A", async () => {
    const plain = await decryptPushBody(unb64(A.message), await rfcSubscription());
    expect(new TextDecoder().decode(plain)).toBe(A.plaintext);
  });

  test("a flipped bit, the wrong auth secret or a truncated body fails", async () => {
    const sub = await rfcSubscription();
    const bad = unb64(A.message);
    bad[bad.length - 3] = (bad[bad.length - 3] ?? 0) ^ 0x01;
    await expect(decryptPushBody(bad, sub)).rejects.toThrow(/operation/i);
    await expect(
      decryptPushBody(unb64(A.message), { ...sub, keys: { ...sub.keys, auth: b64(new Uint8Array(16)) } }),
    ).rejects.toThrow(/operation/i);
    await expect(decryptPushBody(unb64(A.message).subarray(0, 40), sub)).rejects.toThrow(/too short/);
  });

  test("a body with the wrong key id length is refused before decrypting", async () => {
    const m = unb64(A.message);
    m[20] = 0;
    await expect(decryptPushBody(m, await rfcSubscription())).rejects.toThrow(/keyid/);
  });
});

/** A VAPID header made here by hand (not with the worker's code). */
async function signVapid(claims: Record<string, unknown>, opts: { header?: Record<string, unknown> } = {}) {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const k = b64(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  const input = `${b64(te.encode(JSON.stringify(opts.header ?? { typ: "JWT", alg: "ES256" })))}.${b64(te.encode(JSON.stringify(claims)))}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, te.encode(input)),
  );
  return { k, header: `vapid t=${input}.${b64(sig)}, k=${k}` };
}

describe("verifyVapidAuthorization", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  const endpoint = "http://host.containers.internal:41000/push/api-1?x=1";
  const good = { aud: "http://host.containers.internal:41000", exp: now / 1000 + 12 * 3600, sub: "mailto:a@b.test" };

  test("returns the claims of a valid header", async () => {
    const { k, header } = await signVapid(good);
    expect(await verifyVapidAuthorization(header, endpoint, k, now)).toEqual(good);
  });

  test("refuses another key, a wrong aud, an expired or far-future exp, a non-ES256 header", async () => {
    const { k, header } = await signVapid(good);
    const other = await signVapid(good);
    await expect(verifyVapidAuthorization(header, endpoint, other.k, now)).rejects.toThrow(/k=/);
    // k= matches but the signature is someone else's.
    await expect(
      verifyVapidAuthorization(header.replace(/, k=.*$/, `, k=${other.k}`), endpoint, other.k, now),
    ).rejects.toThrow(/verify/);
    await expect(verifyVapidAuthorization(header, "https://elsewhere.test/push/a", k, now)).rejects.toThrow(/aud/);
    await expect(verifyVapidAuthorization(header, endpoint, k, now + 13 * 3600_000)).rejects.toThrow(/expired/);
    const far = await signVapid({ ...good, exp: now / 1000 + 48 * 3600 });
    await expect(verifyVapidAuthorization(far.header, endpoint, far.k, now)).rejects.toThrow(/24 hours/);
    const hs = await signVapid(good, { header: { typ: "JWT", alg: "HS256" } });
    await expect(verifyVapidAuthorization(hs.header, endpoint, hs.k, now)).rejects.toThrow(/ES256/);
    const noSub = await signVapid({ ...good, sub: "a@b.test" });
    await expect(verifyVapidAuthorization(noSub.header, endpoint, noSub.k, now)).rejects.toThrow(/sub/);
    await expect(verifyVapidAuthorization("Bearer abc", endpoint, k, now)).rejects.toThrow(/vapid/);
    await expect(verifyVapidAuthorization(`vapid k=${k}`, endpoint, k, now)).rejects.toThrow(/t= and k=/);
  });
});
