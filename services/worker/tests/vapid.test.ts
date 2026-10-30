// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** RFC 8292 VAPID `Authorization` (ADR 0028 decision 1). */
import { b64url, fromB64url } from "@commonair/tokens";
import { describe, expect, test } from "vite-plus/test";
import { VAPID_TTL_SECONDS, vapidAuthorization } from "../src/notify/push/vapid.ts";

/** A VAPID pair as init-env makes it: raw public point (base64url), PKCS#8 private key (base64). */
async function vapidPair() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return {
    publicKey: b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    privateKeyPkcs8: Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64"),
  };
}

const HEADER = /^vapid t=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/;
const dec = new TextDecoder();

async function verify(publicKey: string, signingInput: string, signature: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    fromB64url(publicKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    fromB64url(signature),
    new TextEncoder().encode(signingInput),
  );
}

describe("vapidAuthorization", () => {
  const now = new Date("2026-10-30T12:00:00.000Z");
  const subject = "mailto:hello@example.test";

  test("header format, ES256 JWT that verifies with the public key, and its claims", async () => {
    const keys = await vapidPair();
    const header = await vapidAuthorization({ endpoint: "https://push.example.test/send/abc", subject, ...keys, now });
    const m = HEADER.exec(header);
    expect(m).not.toBeNull();
    const [, h, c, s, k] = m!;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(dec.decode(fromB64url(h!)))).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(dec.decode(fromB64url(c!)))).toEqual({
      aud: "https://push.example.test",
      exp: Math.floor(now.getTime() / 1000) + VAPID_TTL_SECONDS,
      sub: subject,
    });
    // JWS ES256: the raw 64-byte r ‖ s.
    expect(fromB64url(s!).length).toBe(64);
    expect(await verify(keys.publicKey, `${h}.${c}`, s!)).toBe(true);
    // Another key does not verify it.
    expect(await verify((await vapidPair()).publicKey, `${h}.${c}`, s!)).toBe(false);
  });

  test("aud is the endpoint's origin: path, query and default port dropped, explicit port kept", async () => {
    const keys = await vapidPair();
    const aud = async (endpoint: string) => {
      const c = HEADER.exec(await vapidAuthorization({ endpoint, subject, ...keys, now }))![2]!;
      return (JSON.parse(dec.decode(fromB64url(c))) as { aud: string }).aud;
    };
    expect(await aud("https://fcm.googleapis.com/fcm/send/xyz?foo=bar#frag")).toBe("https://fcm.googleapis.com");
    expect(await aud("https://updates.push.services.mozilla.com:443/wpush/v2/abc")).toBe(
      "https://updates.push.services.mozilla.com",
    );
    expect(await aud("http://host.containers.internal:41234/push/a1")).toBe("http://host.containers.internal:41234");
  });

  test("the expiry stays within RFC 8292's 24 hours", () => {
    expect(VAPID_TTL_SECONDS).toBeLessThanOrEqual(24 * 3600);
  });

  test("a bad private key or endpoint throws, and the bad key is not cached", async () => {
    const keys = await vapidPair();
    const bad = { ...keys, privateKeyPkcs8: Buffer.from("not a key").toString("base64") };
    await expect(vapidAuthorization({ endpoint: "https://p.example.test/", subject, ...bad, now })).rejects.toThrow(
      /keyData/,
    );
    await expect(vapidAuthorization({ endpoint: "https://p.example.test/", subject, ...bad, now })).rejects.toThrow(
      /keyData/,
    );
    await expect(vapidAuthorization({ endpoint: "not a url", subject, ...keys, now })).rejects.toThrow(/URL/);
  });
});
