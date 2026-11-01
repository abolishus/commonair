// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `packages/contracts` may not import this package (we depend on it), so it mirrors two of our
 * wire shapes: the relay purge feed (`RelayPurgeFeed` / `RelayPurgeBatch`, mirroring `purge.ts`)
 * and the bundle's standing envelope (`StandingStatementEnvelope`, mirroring `SignedStanding`).
 * This test (which may import both) keeps each mirror equal to the original on every vector.
 */
import { RELAY_PURGE_PREFIX, RELAY_PURGE_REASON, RelayPurgeBatch, RelayPurgeFeed } from "@commonair/contracts/dto";
import { RELAY_PURGE_REASONS, RELAY_PURGE_RULES } from "@commonair/contracts/enums";
import { StandingStatementEnvelope } from "@commonair/contracts/portability";
import { describe, expect, test } from "vite-plus/test";
import vectors from "../vectors.json" with { type: "json" };
import { fromB64url, importSigningKey } from "../src/index.ts";
import {
  PURGE_BATCH_MAX_ITEMS,
  PURGE_PREFIX,
  PURGE_PREFIX_MAX_LENGTH,
  PURGE_REASON,
  PurgeBatch,
  signPurgeBatch,
} from "../src/purge.ts";
import { PLAYBACK_TEST_KEY, STANDING_TEST_KEY } from "../src/standing-vectors.ts";
import { importStandingSigningKey, signStanding, type StandingStatement } from "../src/standing.ts";

const dec = new TextDecoder();
const decode = (payload: string): unknown => {
  try {
    return JSON.parse(dec.decode(fromB64url(payload)));
  } catch {
    return undefined;
  }
};

describe("relay purge feed: contracts mirror packages/tokens", () => {
  test("constants agree", () => {
    expect(RELAY_PURGE_RULES.maxItems).toBe(PURGE_BATCH_MAX_ITEMS);
    expect(RELAY_PURGE_RULES.prefixMaxLength).toBe(PURGE_PREFIX_MAX_LENGTH);
    expect(RELAY_PURGE_PREFIX.source).toBe(PURGE_PREFIX.source);
    expect(RELAY_PURGE_REASON.source).toBe(PURGE_REASON.source);
    for (const reason of RELAY_PURGE_REASONS) expect(PURGE_REASON.test(reason)).toBe(true);
  });

  test("every signed vector is a contract feed answer", () => {
    expect(RelayPurgeFeed.parse(vectors.purge.signed)).toEqual(vectors.purge.signed);
    const signedOk = vectors.purge.cases.filter((c) => c.error !== "bad_signature" && !c.signed.payload.endsWith("="));
    for (const c of signedOk) expect(RelayPurgeFeed.safeParse(c.signed).success, c.name).toBe(true);
  });

  test("both schemas accept and refuse the same payloads", () => {
    const payloads = [vectors.purge.signed, ...vectors.purge.cases.map((c) => c.signed)].map((s) => decode(s.payload));
    const extra: unknown[] = [
      { seq: 0, items: [] },
      { seq: 1, items: [], reset: true },
      { seq: 1, items: [], reset: false },
      { seq: 1, items: [{ seq: 1, prefix: "live/a/", reason: "Upper" }] },
      { seq: 1, items: [{ seq: 1, prefix: `live/${"a".repeat(260)}/`, reason: "x" }] },
      { seq: 1, items: [{ seq: 0, prefix: "live/a/", reason: "x" }] },
      { seq: Number.MAX_SAFE_INTEGER + 1, items: [] },
      { seq: 1, items: Array.from({ length: 501 }, (_, i) => ({ seq: i + 1, prefix: "live/a/", reason: "x" })) },
    ];
    const canonical = (r: { success: boolean; data?: unknown }) => (r.success ? JSON.stringify(r.data) : null);
    let accepted = 0;
    for (const p of [...payloads, ...extra]) {
      const tokens = PurgeBatch.safeParse(p);
      const contracts = RelayPurgeBatch.safeParse(p);
      // Same verdict and, when accepted, the same canonical bytes (what the origin signs).
      expect(canonical(contracts), JSON.stringify(p)?.slice(0, 120)).toBe(canonical(tokens));
      accepted += tokens.success ? 1 : 0;
    }
    expect(accepted).toBeGreaterThan(3);
  });

  test("signPurgeBatch output is a contract feed answer whose payload is a contract batch", async () => {
    const key = await importSigningKey(PLAYBACK_TEST_KEY);
    for (const batch of [
      { seq: 7, items: [{ seq: 7, prefix: "dvr/01890000-0000-7000-8000-000000000009/", reason: "vod_hidden" }] },
      { seq: 120, items: [], reset: true as const },
    ]) {
      const signed = await signPurgeBatch(key, batch);
      expect(RelayPurgeFeed.parse(signed)).toEqual(signed);
      expect(RelayPurgeBatch.parse(decode(signed.payload))).toEqual(batch);
    }
  });
});

describe("standing statement envelope: contracts mirror packages/tokens", () => {
  test("every standing vector envelope is a contract envelope", () => {
    expect(StandingStatementEnvelope.parse(vectors.standing.signed)).toEqual(vectors.standing.signed);
    for (const c of vectors.standing.cases.filter((x) => x.error === null))
      expect(StandingStatementEnvelope.safeParse(c.signed).success, c.name).toBe(true);
  });

  test("signStanding output is a contract envelope with no extra keys", async () => {
    const key = await importStandingSigningKey(STANDING_TEST_KEY);
    const statement: StandingStatement = {
      v: 1,
      issuer: "https://instance.example",
      kid: key.kid,
      channelId: "01890000-0000-7000-8000-00000000c001",
      bundleSha256: "f".repeat(64),
      issuedAt: "2023-11-14T22:13:20.000Z",
      expiresAt: "2023-12-14T22:13:20.000Z",
      activeSuspension: true,
      legalHold: true,
      upheldActions: { t0: 9_999, t1: 9_999, t2: 9_999 },
      dmcaStrikes: 9_999,
    };
    const signed = await signStanding(key, statement);
    expect(Object.keys(signed).sort()).toEqual(Object.keys(StandingStatementEnvelope.shape).sort());
    expect(StandingStatementEnvelope.parse(signed)).toEqual(signed);
  });
});
