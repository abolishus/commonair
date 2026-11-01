// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The `signed` / `tamper` steps' pure helpers, against `vectors.json`'s attestation section. */
import { verify } from "@commonair/tokens/attestation";
import vectors from "@commonair/tokens/vectors.json" with { type: "json" };
import { describe, expect, test } from "vite-plus/test";
import { decodeStatement, leakedIds, tamperedPayload, verdictMismatches } from "../../src/w2/attestations.ts";

const V = vectors.attestation;

describe("attestation step helpers", () => {
  test("decodeStatement reads the vector's statement", () => {
    expect(decodeStatement(V.signed.payload)).toEqual(V.statement);
  });

  test("tamperedPayload changes one figure canonically, so the signature fails", async () => {
    const forged = tamperedPayload(V.signed.payload);
    expect(decodeStatement(forged).verifiedViewerSeconds).toBe(V.statement.verifiedViewerSeconds + 1);
    expect(await verify({ payload: forged, signature: V.signed.signature }, V.publicKey)).toEqual({
      ok: false,
      error: "bad_signature",
    });
  });

  test("verdictMismatches names each disagreeing figure", () => {
    const s = decodeStatement(V.signed.payload);
    expect(verdictMismatches(s, { verified: 151200, unverified: 3600, excluded: 7200 })).toEqual([]);
    expect(verdictMismatches(s, { verified: 1, unverified: 3600, excluded: 0 })).toEqual([
      "verified 151200 != 1",
      "excluded 7200 != 0",
    ]);
  });

  test("leakedIds finds ids in the payload", () => {
    expect(leakedIds(V.signed.payload, [V.statement.channelId, "01890000-0000-7000-8000-0000000000ff"])).toEqual([
      V.statement.channelId,
    ]);
  });
});
