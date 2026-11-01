// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PlaybackClaims } from "@commonair/contracts";
import { describe, expect, test } from "vite-plus/test";
import vectors from "../vectors.json" with { type: "json" };
import { generateSigningKey, importSigningKey, signPlaybackToken, verifyPlaybackToken } from "../src/index.ts";
import { PURGE_PREFIX, PurgeBatch, signPurgeBatch, verifyPurgeBatch } from "../src/purge.ts";
import {
  canonicalizeStanding,
  deriveStandingKid,
  importStandingSigningKey,
  signStanding,
  STANDING_TTL_DAYS,
  StandingStatement,
  type StandingKey,
  standingExpiry,
  verifyStanding,
} from "../src/standing.ts";
import { purgeVectors, standingVectors } from "../src/standing-vectors.ts";

const S = vectors.standing;
const P = vectors.purge;

describe("standing statement vectors", () => {
  test("the committed section is what the generator produces", async () => {
    expect(await standingVectors()).toEqual(S);
  });

  test("key, kid, canonical bytes and signature", async () => {
    const key = await importStandingSigningKey(S.privateKeyPkcs8);
    expect(key.publicKey).toBe(S.publicKey);
    expect(key.kid).toBe(S.kid);
    expect(await deriveStandingKid(S.publicKey)).toBe(S.kid);
    expect(new TextDecoder().decode(canonicalizeStanding(S.statement as StandingStatement))).toBe(S.canonical);
    expect(await signStanding(key, S.statement as StandingStatement)).toEqual(S.signed);
  });

  test.each(S.cases.map((c) => [c.name, c] as const))("%s", async (_, c) => {
    const keys = (c.keys ?? S.keys) as StandingKey[];
    const r = await verifyStanding(c.signed, keys, new Date(c.now));
    expect(r.ok ? null : r.error).toBe(c.error);
  });

  test("the valid cases also verify against the bare public key", async () => {
    const r = await verifyStanding(S.signed, S.publicKey, new Date(S.cases[0]?.now as string));
    expect(r).toEqual({ ok: true, statement: S.statement, key: null });
  });
});

describe("standing statement rules", () => {
  const base = S.statement as StandingStatement;

  test("valid for exactly 30 days", () => {
    expect(STANDING_TTL_DAYS).toBe(30);
    expect(standingExpiry(base.issuedAt)).toBe(base.expiresAt);
    expect(StandingStatement.safeParse({ ...base, expiresAt: base.issuedAt }).success).toBe(false);
    expect(StandingStatement.safeParse({ ...base, expiresAt: "2023-11-14T22:13:19.999Z" }).success).toBe(false);
  });

  test("refuses personal data, negative counts, unknown tiers and bad instants", () => {
    const bad: Partial<Record<string, unknown>>[] = [
      { email: "x" },
      { dmcaStrikes: -1 },
      { dmcaStrikes: 1.5 },
      { upheldActions: { t0: 0, t1: 0, t2: 0, t3: 1 } },
      { upheldActions: { t0: 0, t1: 0 } },
      { issuedAt: "2023-02-30T00:00:00.000Z", expiresAt: "2023-03-01T00:00:00.000Z" },
      { issuer: "https://instance.example/path" },
      { channelId: "not-a-uuid" },
      { activeSuspension: "no" },
    ];
    for (const over of bad) expect(StandingStatement.safeParse({ ...base, ...over }).success).toBe(false);
  });

  test("a fresh key round-trips; a statement naming another kid is refused", async () => {
    const { pkcs8B64 } = await generateSigningKey();
    const key = await importStandingSigningKey(pkcs8B64);
    const statement = { ...base, kid: key.kid };
    const signed = await signStanding(key, statement);
    expect((await verifyStanding(signed, key.publicKey, new Date("2023-11-20T00:00:00.000Z"))).ok).toBe(true);
    await expect(signStanding(key, base)).rejects.toThrow(/kid/);
    expect(await verifyStanding(S.signed, key.publicKey, new Date("2023-11-20T00:00:00.000Z"))).toEqual({
      ok: false,
      error: "bad_signature",
    });
    expect(await verifyStanding(S.signed, "short", new Date())).toEqual({ ok: false, error: "malformed" });
  });
});

describe("purge batch vectors", () => {
  test("the committed section is what the generator produces", async () => {
    expect(await purgeVectors()).toEqual(P);
  });

  test("signs with the playback key, deterministically", async () => {
    const key = await importSigningKey(vectors.privateKeyPkcs8);
    expect(await signPurgeBatch(key, P.batch)).toEqual(P.signed);
    expect(Buffer.from(P.signed.payload, "base64url").toString()).toBe(P.canonical);
  });

  test.each(P.cases.map((c) => [c.name, c] as const))("%s", async (_, c) => {
    const r = await verifyPurgeBatch(vectors.publicKey, c.signed);
    expect(r.ok ? null : r.error).toBe(c.error);
  });

  test("a malformed key is malformed", async () => {
    expect(await verifyPurgeBatch("nope", P.signed)).toEqual({ ok: false, error: "malformed" });
  });
});

describe("purge batch rules", () => {
  test("prefixes", () => {
    for (const ok of ["dvr/01890000-0000-7000-8000-000000000009/", "live/alice/", "live/alice/captions/", "live/a.b/"])
      expect(PURGE_PREFIX.test(ok)).toBe(true);
    for (const bad of [
      "",
      "live/",
      "live//",
      "live/../",
      "live/.x/",
      "vod/x/",
      "/live/a/",
      "live/a",
      "live/a b/",
      "LIVE/a/",
    ])
      expect(PURGE_PREFIX.test(bad)).toBe(false);
  });

  test("signing refuses an invalid batch", async () => {
    const key = await importSigningKey(vectors.privateKeyPkcs8);
    await expect(signPurgeBatch(key, { seq: 1, items: [{ seq: 2, prefix: "live/a/", reason: "x" }] })).rejects.toThrow(
      /seq/,
    );
    const many = Array.from({ length: 501 }, (_, i) => ({ seq: i + 1, prefix: "live/a/", reason: "x" }));
    expect(PurgeBatch.safeParse({ seq: 501, items: many }).success).toBe(false);
    expect(PurgeBatch.safeParse({ seq: 500, items: many.slice(0, 500) }).success).toBe(true);
    expect(PurgeBatch.safeParse({ seq: 0, items: [] }).success).toBe(true);
    expect(PurgeBatch.safeParse({ seq: 1, items: [{ seq: 1, prefix: "live/a/", reason: "Bad" }] }).success).toBe(false);
  });
});

describe("relay DVR tokens (decision (x))", () => {
  const D = vectors.playbackDvrRelay;

  test("the vector verifies and is a relay token for a dvr path", async () => {
    const key = await importSigningKey(vectors.privateKeyPkcs8);
    expect(await signPlaybackToken(key, D.claims as PlaybackClaims)).toBe(D.token);
    expect(await verifyPlaybackToken(key.publicKey, D.token, D.claims.iat)).toEqual({ ok: true, value: D.claims });
  });

  test("the contract allows dvr/<vodId> on relay and origin, never with dm or another shape", () => {
    const relay = D.claims;
    const { rid: _rid, ...origin } = { ...relay, src: "origin" };
    expect(PlaybackClaims.safeParse(relay).success).toBe(true);
    expect(PlaybackClaims.safeParse(origin).success).toBe(true);
    expect(PlaybackClaims.safeParse({ ...relay, dm: 96_000 }).success).toBe(false);
    expect(PlaybackClaims.safeParse({ ...origin, dm: 96_000 }).success).toBe(false);
    const { rid: _r, ...noRid } = relay;
    expect(PlaybackClaims.safeParse(noRid).success).toBe(false);
    for (const path of [
      "dvr/x",
      "dvr/",
      "dvr/01890000-0000-7000-8000-000000000009/",
      "dvr/01890000-0000-7000-8000-00000000000A",
    ])
      expect(PlaybackClaims.safeParse({ ...relay, path }).success).toBe(false);
  });
});
