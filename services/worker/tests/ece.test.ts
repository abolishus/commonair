// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** RFC 8291 / RFC 8188 message encryption (ADR 0028 decision 1), against the RFCs' own examples. */
import { NOTIFY_RULES } from "@commonair/contracts/notify";
import { b64url, fromB64url } from "@commonair/tokens";
import { describe, expect, test } from "vite-plus/test";
import {
  decryptAes128gcm,
  decryptPushPayload,
  encryptPushPayload,
  hkdfExpand,
  hkdfExtract,
  PushPayloadTooLarge,
} from "../src/notify/push/ece.ts";

/** RFC 8291 Appendix A. */
const A = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  message:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

/** RFC 8188 §3.1: one record, rs 4096, no key id. */
const R8188 = {
  plaintext: "I am the walrus",
  key: "yqdlZ-tYemfogSmv7Ws5PQ",
  message: "I1BsxtFttlv3u_Oo94xnmwAAEAAA-NAVub2qFgBEuQKRapoZu-IxkIva3MEB1PD-ly8Thjg",
};

const enc = new TextEncoder();
const dec = new TextDecoder();

/** An ECDH P-256 pair from the RFC's raw private scalar and public point. */
async function ecdhPair(privateB64: string, publicB64: string): Promise<CryptoKeyPair> {
  const pub = fromB64url(publicB64);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: b64url(pub.subarray(1, 33)),
    y: b64url(pub.subarray(33, 65)),
    d: privateB64,
  };
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const publicKey = await crypto.subtle.importKey("raw", pub, { name: "ECDH", namedCurve: "P-256" }, true, []);
  return { privateKey, publicKey };
}

async function browser() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  return {
    pair,
    uaPublic: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
    authSecret: crypto.getRandomValues(new Uint8Array(16)),
  };
}

describe("HKDF", () => {
  test("RFC 5869 test case 1", async () => {
    const ikm = new Uint8Array(22).fill(0x0b);
    const salt = Uint8Array.from(Buffer.from("000102030405060708090a0b0c", "hex"));
    const info = Uint8Array.from(Buffer.from("f0f1f2f3f4f5f6f7f8f9", "hex"));
    const prk = await hkdfExtract(salt, ikm);
    expect(Buffer.from(prk).toString("hex")).toBe("077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5");
    // The RFC's OKM is 42 bytes; its first 32 come from the first block.
    expect(Buffer.from(await hkdfExpand(prk, info, 32)).toString("hex")).toBe(
      "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf",
    );
    await expect(hkdfExpand(prk, info, 33)).rejects.toThrow(/one SHA-256 block/);
  });
});

describe("encryptPushPayload", () => {
  test("RFC 8291 Appendix A, byte for byte", async () => {
    const out = await encryptPushPayload({
      plaintext: enc.encode(A.plaintext),
      uaPublic: fromB64url(A.uaPublic),
      authSecret: fromB64url(A.authSecret),
      asKeyPair: await ecdhPair(A.asPrivate, A.asPublic),
      salt: fromB64url(A.salt),
    });
    expect(b64url(out)).toBe(A.message);
  });

  test("RFC 8291 Appendix A decrypts with the user agent's private key", async () => {
    const ua = await ecdhPair(A.uaPrivate, A.uaPublic);
    const plain = await decryptPushPayload({
      message: fromB64url(A.message),
      uaPrivateKey: ua.privateKey,
      uaPublic: fromB64url(A.uaPublic),
      authSecret: fromB64url(A.authSecret),
    });
    expect(dec.decode(plain)).toBe(A.plaintext);
  });

  test("round trip with fresh keys; every message has its own salt and server key", async () => {
    const b = await browser();
    const plaintext = enc.encode(JSON.stringify({ v: 1, type: "go_live", slug: "abc", title: "Hello" }));
    const one = await encryptPushPayload({ plaintext, uaPublic: b.uaPublic, authSecret: b.authSecret });
    const two = await encryptPushPayload({ plaintext, uaPublic: b.uaPublic, authSecret: b.authSecret });
    expect(b64url(one.subarray(0, 16))).not.toBe(b64url(two.subarray(0, 16)));
    expect(b64url(one.subarray(21, 86))).not.toBe(b64url(two.subarray(21, 86)));
    // Header: rs = 4096, idlen = 65, then the server's public point.
    expect(new DataView(one.buffer).getUint32(16)).toBe(4096);
    expect(one[20]).toBe(65);
    expect(one[21]).toBe(0x04);
    // One record: plaintext + delimiter + 16-byte tag.
    expect(one.length).toBe(86 + plaintext.length + 1 + 16);
    for (const m of [one, two]) {
      const back = await decryptPushPayload({
        message: m,
        uaPrivateKey: b.pair.privateKey,
        uaPublic: b.uaPublic,
        authSecret: b.authSecret,
      });
      expect(dec.decode(back)).toBe(dec.decode(plaintext));
    }
  });

  test("the payload bound: exactly the limit encrypts, one byte more is refused", async () => {
    const b = await browser();
    const max = NOTIFY_RULES.maxPushPayloadBytes;
    const ok = await encryptPushPayload({
      plaintext: new Uint8Array(max).fill(0x61),
      uaPublic: b.uaPublic,
      authSecret: b.authSecret,
    });
    expect(ok.length).toBeLessThanOrEqual(86 + 4096);
    await expect(
      encryptPushPayload({ plaintext: new Uint8Array(max + 1), uaPublic: b.uaPublic, authSecret: b.authSecret }),
    ).rejects.toBeInstanceOf(PushPayloadTooLarge);
  });

  test("an empty plaintext still makes a valid record", async () => {
    const b = await browser();
    const m = await encryptPushPayload({
      plaintext: new Uint8Array(0),
      uaPublic: b.uaPublic,
      authSecret: b.authSecret,
    });
    const back = await decryptPushPayload({
      message: m,
      uaPrivateKey: b.pair.privateKey,
      uaPublic: b.uaPublic,
      authSecret: b.authSecret,
    });
    expect(back.length).toBe(0);
  });

  test("refuses malformed keys", async () => {
    const b = await browser();
    const plaintext = enc.encode("x");
    await expect(
      encryptPushPayload({ plaintext, uaPublic: b.uaPublic.subarray(1), authSecret: b.authSecret }),
    ).rejects.toThrow(/P-256/);
    const compressedPrefix = b.uaPublic.slice();
    compressedPrefix[0] = 0x02;
    await expect(
      encryptPushPayload({ plaintext, uaPublic: compressedPrefix, authSecret: b.authSecret }),
    ).rejects.toThrow(/P-256/);
    await expect(
      encryptPushPayload({ plaintext, uaPublic: b.uaPublic, authSecret: b.authSecret.subarray(0, 15) }),
    ).rejects.toThrow(/16 bytes/);
    await expect(
      encryptPushPayload({ plaintext, uaPublic: b.uaPublic, authSecret: b.authSecret, salt: new Uint8Array(8) }),
    ).rejects.toThrow(/salt/);
  });

  test("a tampered tag, body or header fails to decrypt", async () => {
    const b = await browser();
    const m = await encryptPushPayload({
      plaintext: enc.encode("go live"),
      uaPublic: b.uaPublic,
      authSecret: b.authSecret,
    });
    const decrypt = (message: Uint8Array) =>
      decryptPushPayload({ message, uaPrivateKey: b.pair.privateKey, uaPublic: b.uaPublic, authSecret: b.authSecret });
    for (const at of [m.length - 1, 90, 3]) {
      const bad = m.slice();
      bad[at] = (bad[at] ?? 0) ^ 0x01;
      await expect(decrypt(bad)).rejects.toThrow(/operation/i);
    }
    // The wrong auth secret derives other keys.
    await expect(
      decryptPushPayload({
        message: m,
        uaPrivateKey: b.pair.privateKey,
        uaPublic: b.uaPublic,
        authSecret: new Uint8Array(16),
      }),
    ).rejects.toThrow(/operation/i);
    await expect(decrypt(m.subarray(0, 20))).rejects.toThrow(/truncated/);
  });
});

describe("decryptAes128gcm", () => {
  test("RFC 8188 §3.1", async () => {
    const plain = await decryptAes128gcm(fromB64url(R8188.message), (keyId) => {
      expect(keyId.length).toBe(0);
      return fromB64url(R8188.key);
    });
    expect(dec.decode(plain)).toBe(R8188.plaintext);
  });

  test("RFC 8188 §3.1 with a flipped tag bit fails", async () => {
    const bad = fromB64url(R8188.message);
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 0x80;
    await expect(decryptAes128gcm(bad, () => fromB64url(R8188.key))).rejects.toThrow(/operation/i);
  });
});
