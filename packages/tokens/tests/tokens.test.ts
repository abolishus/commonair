// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import vectors from "../vectors.json" with { type: "json" };
import {
  generateSigningKey,
  hmacHex,
  importSigningKey,
  randomSecret,
  randomTokenSecret,
  sha256Hex,
  signPlaybackToken,
  signReceipt,
  timingSafeEqual,
  verifyPlaybackToken,
  verifyPlaybackTokenSignature,
  verifyReceipt,
} from "../src/index.ts";

describe("vectors", () => {
  test("the RFC 8032 test key derives the expected public key", async () => {
    const key = await importSigningKey(vectors.privateKeyPkcs8);
    expect(key.publicKeyB64).toBe(vectors.publicKey);
    expect(Buffer.from(vectors.publicKey, "base64url").toString("hex")).toBe(
      "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    );
  });

  test("signing is deterministic and matches the committed vectors", async () => {
    const key = await importSigningKey(vectors.privateKeyPkcs8);
    expect(await signPlaybackToken(key, vectors.playback.claims as never)).toBe(vectors.playback.token);
    expect(await signPlaybackToken(key, vectors.playbackDataMode.claims as never)).toBe(vectors.playbackDataMode.token);
    expect(await signReceipt(key, vectors.receipt.payload as never)).toEqual(vectors.receipt.signed);
  });
});

describe("playback tokens", () => {
  const claims = { ...vectors.playback.claims, src: "relay" as const, v: 1 as const };

  test("verify within validity, reject after expiry and before issue", async () => {
    const key = await importSigningKey(vectors.privateKeyPkcs8);
    const ok = await verifyPlaybackToken(key.publicKey, vectors.playback.token, claims.iat + 10);
    expect(ok).toEqual({ ok: true, value: claims });
    expect(await verifyPlaybackToken(key.publicKey, vectors.playback.token, claims.exp + 31)).toEqual({
      ok: false,
      error: "expired",
    });
    expect(await verifyPlaybackToken(key.publicKey, vectors.playback.token, claims.iat - 31)).toEqual({
      ok: false,
      error: "not_yet_valid",
    });
  });

  test("signature-only verification ignores time but not the signature", async () => {
    const key = await importSigningKey(vectors.privateKeyPkcs8);
    const other = (await generateSigningKey()).key;
    // Long after expiry the signature still verifies (callers apply their own `iat` age policy).
    expect(await verifyPlaybackTokenSignature(key.publicKey, vectors.playback.token)).toEqual({
      ok: true,
      value: claims,
    });
    expect(await verifyPlaybackTokenSignature(other.publicKey, vectors.playback.token)).toEqual({
      ok: false,
      error: "bad_signature",
    });
    expect(await verifyPlaybackTokenSignature(key.publicKey, "a.b.c")).toEqual({ ok: false, error: "malformed" });
  });

  test("reject tampering, foreign keys and garbage", async () => {
    const key = await importSigningKey(vectors.privateKeyPkcs8);
    const other = (await generateSigningKey()).key;
    const [body, sig] = vectors.playback.token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...claims, path: "live/mallory" })).toString("base64url");
    expect((await verifyPlaybackToken(key.publicKey, `${forged}.${sig}`, claims.iat)).ok).toBe(false);
    expect(await verifyPlaybackToken(other.publicKey, vectors.playback.token, claims.iat)).toEqual({
      ok: false,
      error: "bad_signature",
    });
    expect(await verifyPlaybackToken(key.publicKey, "garbage", claims.iat)).toEqual({
      ok: false,
      error: "malformed",
    });
    expect(await verifyPlaybackToken(key.publicKey, `${body}.${sig}.x`, claims.iat)).toEqual({
      ok: false,
      error: "malformed",
    });
  });
});

describe("receipts", () => {
  test("round-trip and reject a payload altered after signing", async () => {
    const key = await importSigningKey(vectors.privateKeyPkcs8);
    expect(await verifyReceipt(key.publicKeyB64, vectors.receipt.signed)).toEqual({
      ok: true,
      value: vectors.receipt.payload,
    });
    const inflated = {
      ...vectors.receipt.payload,
      entries: [{ ...vectors.receipt.payload.entries[0]!, bytes: 999_999_999 }],
    };
    const tampered = {
      payload: Buffer.from(JSON.stringify(inflated)).toString("base64url"),
      signature: vectors.receipt.signed.signature,
    };
    expect(await verifyReceipt(key.publicKeyB64, tampered)).toEqual({
      ok: false,
      error: "bad_signature",
    });
  });
});

describe("claims", () => {
  test("rid is required exactly when the source is a relay", async () => {
    const key = await importSigningKey(vectors.privateKeyPkcs8);
    const base = { ...vectors.playback.claims, v: 1 as const };
    await expect(signPlaybackToken(key, { ...base, src: "relay", rid: undefined } as never)).rejects.toThrow(
      /rid is required/,
    );
    await expect(signPlaybackToken(key, { ...base, src: "origin" } as never)).rejects.toThrow(/rid is required/);
  });
});

describe("data mode claim (ADR 0018)", () => {
  /** Signs raw claims, bypassing the schema, as a forger with the key would. */
  async function signRaw(claims: Record<string, unknown>): Promise<string> {
    const key = await importSigningKey(vectors.privateKeyPkcs8);
    const body = new TextEncoder().encode(JSON.stringify(claims));
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, body));
    return `${Buffer.from(body).toString("base64url")}.${Buffer.from(sig).toString("base64url")}`;
  }

  test("the data-mode vector verifies with its ceiling", async () => {
    const key = await importSigningKey(vectors.privateKeyPkcs8);
    const r = await verifyPlaybackTokenSignature(key.publicKey, vectors.playbackDataMode.token);
    expect(r).toEqual({ ok: true, value: vectors.playbackDataMode.claims });
    expect(r.ok && r.value.dm).toBe(111_111);
  });

  test.each([
    ["on a relay token", { ...vectors.playback.claims }],
    ["on a VOD path", { path: "vod/01890000-0000-7000-8000-000000000009" }],
    ["below the floor", { dm: 1000 }],
    ["above the ceiling", { dm: 9_000_000 }],
    ["as a string", { dm: "1" }],
  ])("refuses dm %s as malformed", async (_, patch) => {
    const key = await importSigningKey(vectors.privateKeyPkcs8);
    const claims = { ...vectors.playbackDataMode.claims, ...patch, dm: "dm" in patch ? patch.dm : 111_111 };
    const token = await signRaw(claims);
    expect(await verifyPlaybackTokenSignature(key.publicKey, token)).toEqual({ ok: false, error: "malformed" });
    await expect(signPlaybackToken(key, claims as never)).rejects.toThrow(/dm|Too|expected/);
  });
});

describe("helpers", () => {
  test("hashes and secrets", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await hmacHex("k", "v")).not.toBe(await hmacHex("k2", "v"));
    expect(randomSecret("live_")).toMatch(/^live_[A-Za-z0-9_-]{43}$/);
    // Access tokens survive the lowercasing Twitch-style IRC clients apply to PASS.
    const token = randomTokenSecret("ca_");
    expect(token).toMatch(/^ca_[0-9a-f]{64}$/);
    expect(token.toLowerCase()).toBe(token);
    expect(randomTokenSecret("ca_")).not.toBe(token);
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
  });
});
