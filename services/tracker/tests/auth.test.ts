// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { b64url, generateSigningKey, signPlaybackToken } from "@commonair/tokens";
import { heartbeatFresh, HEARTBEAT_STALE_MS, IAT_SKEW_SECONDS, tokenAge, verifyTrackerToken } from "../src/auth.ts";
import { TokenBucket } from "../src/ratelimit.ts";

const NOW = 1_800_000_000;
const MAX_AGE = 43_200;

describe("tokenAge", () => {
  test.each([
    [NOW, "ok"],
    [NOW - MAX_AGE, "ok"],
    [NOW - MAX_AGE - 1, "too_old"],
    [NOW + IAT_SKEW_SECONDS, "ok"],
    [NOW + IAT_SKEW_SECONDS + 1, "future"],
  ])("iat %i → %s", (iat, want) => {
    expect(tokenAge(iat, NOW, MAX_AGE)).toBe(want);
  });
});

describe("verifyTrackerToken", async () => {
  const { key } = await generateSigningKey();
  const { key: otherKey } = await generateSigningKey();
  const claims = (iat: number) => ({
    v: 1 as const,
    sid: "0190f1c2-0000-7000-8000-000000000001",
    cid: "0190f1c2-0000-7000-8000-000000000002",
    path: "live/x",
    src: "origin" as const,
    iat,
    exp: iat + 120,
  });

  test("accepts an expired token whose iat is within the max age", async () => {
    const token = await signPlaybackToken(key, claims(NOW - 3600));
    const r = await verifyTrackerToken(key.publicKey, token, NOW, MAX_AGE);
    expect(r.ok && r.claims.sid).toBe("0190f1c2-0000-7000-8000-000000000001");
  });
  test("refuses a too old iat, a future iat and a bad signature", async () => {
    expect(
      await verifyTrackerToken(key.publicKey, await signPlaybackToken(key, claims(NOW - MAX_AGE - 1)), NOW, MAX_AGE),
    ).toEqual({
      ok: false,
      error: "too_old",
    });
    expect(
      await verifyTrackerToken(key.publicKey, await signPlaybackToken(key, claims(NOW + 60)), NOW, MAX_AGE),
    ).toEqual({
      ok: false,
      error: "future",
    });
    expect(
      await verifyTrackerToken(key.publicKey, await signPlaybackToken(otherKey, claims(NOW)), NOW, MAX_AGE),
    ).toEqual({
      ok: false,
      error: "bad_signature",
    });
  });
  test("a body tampered to a newer iat fails the signature", async () => {
    const token = await signPlaybackToken(key, claims(NOW - MAX_AGE - 100));
    const sig = token.split(".")[1];
    const forged = `${b64url(new TextEncoder().encode(JSON.stringify(claims(NOW))))}.${sig}`;
    expect(await verifyTrackerToken(key.publicKey, forged, NOW, MAX_AGE)).toEqual({
      ok: false,
      error: "bad_signature",
    });
  });
  test.each([null, "", "abc", "a.b.c", "!!!.xyz", `${b64url(new TextEncoder().encode('{"iat":"x"}'))}.AA`])(
    "malformed %s",
    async (t) => {
      expect(await verifyTrackerToken(key.publicKey, t, NOW, MAX_AGE)).toEqual({ ok: false, error: "malformed" });
    },
  );
});

describe("heartbeatFresh", () => {
  const now = 1_000_000;
  test.each([
    [null, false],
    [undefined, false],
    ["nope", false],
    [String(now), true],
    [String(now - HEARTBEAT_STALE_MS), true],
    [String(now - HEARTBEAT_STALE_MS - 1), false],
    [now - 5, true],
  ])("%s → %s", (score, want) => {
    expect(heartbeatFresh(score, now)).toBe(want);
  });
});

describe("TokenBucket", () => {
  test("allows a burst, then refills at the rate", () => {
    const b = new TokenBucket(3, 2, 0);
    expect([b.take(0), b.take(0), b.take(0), b.take(0)]).toEqual([true, true, true, false]);
    expect(b.take(400)).toBe(false); // 0.8 tokens
    expect(b.take(500)).toBe(true); // 1.0
    expect(b.take(500)).toBe(false);
  });
  test("never exceeds the burst after a long idle", () => {
    const b = new TokenBucket(2, 100, 0);
    b.take(0);
    expect([b.take(60_000), b.take(60_000), b.take(60_000)]).toEqual([true, true, false]);
  });
  test("a clock going backwards does not mint tokens", () => {
    const b = new TokenBucket(1, 1, 10_000);
    expect(b.take(10_000)).toBe(true);
    expect(b.take(5_000)).toBe(false);
    expect(b.take(10_500)).toBe(false);
    expect(b.take(11_000)).toBe(true);
  });
});
