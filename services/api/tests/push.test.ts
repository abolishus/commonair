// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Push subscription validation (ADR 0028 decision 6): endpoints and browser keys. Pure. */
import { PushSubscriptionKeys } from "@commonair/contracts/notify";
import { b64url, decryptSecret, hmacHex } from "@commonair/tokens";
import { describe, expect, test } from "vite-plus/test";
import {
  endpointHash,
  MAX_ENDPOINT_LENGTH,
  normalizeKeys,
  sealSubscription,
  validateEndpoint,
} from "../src/notifications/push/subscriptions.ts";

async function browserKeys() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const point = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { point, auth, p256dh: b64url(point), authB64: b64url(auth) };
}

const status = (fn: () => unknown): number | undefined => {
  try {
    fn();
  } catch (err) {
    return (err as { status?: number }).status;
  }
  return undefined;
};

describe("validateEndpoint", () => {
  test("accepts vendor-shaped https endpoints as given", () => {
    for (const e of [
      "https://fcm.googleapis.com/fcm/send/abc:def",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
      "https://web.push.apple.com/QH0x?q=1",
    ])
      expect(validateEndpoint(e, false)).toBe(e);
  });

  test("http only with the harness flag", () => {
    expect(status(() => validateEndpoint("http://push.example.test/a", false))).toBe(400);
    expect(validateEndpoint("http://push.example.test/a", true)).toBe("http://push.example.test/a");
  });

  test("refuses other schemes, credentials, relative and oversized URLs", () => {
    for (const e of [
      "ftp://push.example.test/a",
      "javascript:alert(1)",
      "https://user:pw@push.example.test/a",
      "https://user@push.example.test/a",
      "/push/a",
      "file:///etc/passwd",
    ])
      expect(status(() => validateEndpoint(e, true))).toBe(400);
    const long = `https://push.example.test/${"a".repeat(MAX_ENDPOINT_LENGTH)}`;
    expect(status(() => validateEndpoint(long, false))).toBe(400);
    const max = `https://push.example.test/${"a".repeat(MAX_ENDPOINT_LENGTH - 26)}`;
    expect(max.length).toBe(MAX_ENDPOINT_LENGTH);
    expect(validateEndpoint(max, false)).toBe(max);
  });
});

describe("normalizeKeys", () => {
  test("accepts a browser's keys, unpadded or padded, and stores them unpadded", async () => {
    const k = await browserKeys();
    expect(normalizeKeys({ p256dh: k.p256dh, auth: k.authB64 })).toEqual({ p256dh: k.p256dh, auth: k.authB64 });
    const padded = { p256dh: `${k.p256dh}=`, auth: `${k.authB64}==` };
    expect(PushSubscriptionKeys.safeParse(padded).success).toBe(true);
    expect(normalizeKeys(padded)).toEqual({ p256dh: k.p256dh, auth: k.authB64 });
  });

  test("refuses a point without the 0x04 prefix", async () => {
    const k = await browserKeys();
    const compressed = k.point.slice();
    compressed[0] = 0x02;
    expect(status(() => normalizeKeys({ p256dh: b64url(compressed), auth: k.authB64 }))).toBe(400);
  });

  test("refuses wrong lengths and non-canonical encodings", async () => {
    const k = await browserKeys();
    expect(status(() => normalizeKeys({ p256dh: b64url(k.point.subarray(0, 64)), auth: k.authB64 }))).toBe(400);
    expect(status(() => normalizeKeys({ p256dh: k.p256dh, auth: b64url(new Uint8Array(15)) }))).toBe(400);
    expect(status(() => normalizeKeys({ p256dh: k.p256dh, auth: "!!!!" }))).toBe(400);
    // 22 characters whose last one carries stray low bits ("B"): never the canonical encoding of 16 bytes.
    const bad = `${k.authB64.slice(0, 21)}B`;
    expect(bad).not.toBe(k.authB64);
    expect(status(() => normalizeKeys({ p256dh: k.p256dh, auth: bad }))).toBe(400);
  });
});

describe("hash and seal", () => {
  test("the endpoint hash is the contract's HMAC; the sealed value hides the endpoint and keys", async () => {
    const secret = "auth-secret-0123456789-abcdefghijklmnopqrst";
    const endpoint = "https://push.example.test/wpush/abc";
    expect(await endpointHash(secret, endpoint)).toBe(await hmacHex(secret, `push-endpoint:${endpoint}`));
    expect(await endpointHash(secret, endpoint)).not.toBe(await endpointHash(secret, `${endpoint}x`));
    const k = await browserKeys();
    const sealed = await sealSubscription(secret, endpoint, { p256dh: k.p256dh, auth: k.authB64 });
    expect(sealed).not.toContain("push.example.test");
    expect(sealed).not.toContain(k.p256dh);
    expect(JSON.parse(await decryptSecret(secret, "push-subscription", sealed))).toEqual({
      endpoint,
      p256dh: k.p256dh,
      auth: k.authB64,
    });
  });
});
