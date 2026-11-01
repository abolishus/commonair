// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `src/attestation.ts` may not import `@commonair/contracts` (the Apache-2.0 SDK inlines it,
 * batch 6 decision (q)), so it keeps its own copy of the kinds. This test (which may import both)
 * keeps the copy and the API entities in step with the wire format the vectors pin.
 */
import {
  ATTESTATION_KINDS as CONTRACT_KINDS,
  EXCLUSION_CATEGORIES as CONTRACT_CATEGORIES,
} from "@commonair/contracts/enums";
import {
  AttestationEntry,
  AttestationEnvelope,
  AttestationKeyHistory,
  AttestationVerifyResult,
} from "@commonair/contracts/dto";
import { describe, expect, test } from "vite-plus/test";
import vectors from "../vectors.json" with { type: "json" };
import {
  ATTESTATION_ALGORITHM,
  ATTESTATION_KINDS,
  type AttestationError,
  EXCLUSION_CATEGORIES,
} from "../src/attestation.ts";

const v = vectors.attestation;

describe("attestation format and the contracts", () => {
  test("ATTESTATION_KINDS is the contracts enum, in order", () => {
    expect([...ATTESTATION_KINDS]).toEqual([...CONTRACT_KINDS]);
  });

  test("EXCLUSION_CATEGORIES is the contracts enum, in order", () => {
    expect([...EXCLUSION_CATEGORIES]).toEqual([...CONTRACT_CATEGORIES]);
  });

  test("the signed envelopes are contract envelopes", () => {
    expect(AttestationEnvelope.parse(v.signed)).toEqual(v.signed);
    expect(AttestationEnvelope.parse(v.supersede.signed)).toEqual(v.supersede.signed);
    // Every tamper case reaches the verifier: the contract checks lengths, not the charset.
    for (const c of v.cases) expect(AttestationEnvelope.safeParse(c.signed).success, c.name).toBe(true);
  });

  test("an entry built from the vectors parses: hex hashes, the derived kid", () => {
    const s = v.supersede.statement;
    const entry = {
      id: "01890000-0000-7000-8000-00000000e002",
      channelSlug: "vectors",
      broadcastId: s.broadcastId,
      seq: s.seq,
      kind: s.kind,
      kid: s.kid,
      entryHash: v.supersede.entryHash,
      prevHash: s.prevHash,
      supersedes: s.supersedes,
      signedAt: s.signedAt,
      envelope: v.supersede.signed,
      superseded: false,
      breakdown: null,
      salt: null,
    };
    expect(AttestationEntry.parse(entry)).toEqual(entry);
    // The owner's view: the committed breakdown (only some categories) and its salt.
    const owned = { ...entry, breakdown: v.reasons.breakdown, salt: v.reasons.salt };
    expect(AttestationEntry.parse(owned)).toEqual(owned);
    expect(AttestationEntry.parse({ ...entry, breakdown: {}, salt: v.reasons.salt }).breakdown).toEqual({});
    expect(AttestationEntry.safeParse({ ...owned, breakdown: { datacenter_asn: 1 } }).success).toBe(false);
    expect(AttestationEntry.safeParse({ ...entry, entryHash: v.supersede.entryHash.toUpperCase() }).success).toBe(
      false,
    );
    expect(AttestationEntry.safeParse({ ...entry, kid: `${s.kid}=` }).success).toBe(false);
  });

  test("the key history is a contract key history", () => {
    const history = { origin: v.statement.origin, keys: v.keys };
    expect(AttestationKeyHistory.parse(history)).toEqual(history);
    for (const k of v.keys) expect(k.algorithm).toBe(ATTESTATION_ALGORITHM);
  });

  test("every verify error is a contract problem", () => {
    const problems = AttestationVerifyResult.shape.problem.unwrap().options as readonly string[];
    const errors: AttestationError[] = [
      "malformed",
      "non_canonical",
      "bad_signature",
      "kid_mismatch",
      "unknown_kid",
      "compromised_kid",
    ];
    for (const e of errors) expect(problems).toContain(e);
    const caseErrors = v.cases.flatMap((c) => (c.error ? [c.error] : []));
    expect(caseErrors.length).toBeGreaterThan(0);
    expect(problems).toEqual(expect.arrayContaining(caseErrors));
  });
});
