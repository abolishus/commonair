// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The attestation job's pure parts: figures from rollup rows (integers only, the committed
 * breakdown), kind selection, the statement's byte order against `vectors.json`, and the worker
 * fixture chain the SDK tests verify (`packages/sdk/tests/attestation-worker-bundle.json`;
 * regenerate with `WRITE_ATTESTATION_FIXTURE=1`).
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type AttestationKey,
  type AttestationStatement,
  canonicalize,
  importAttestationSigningKey,
  reasonsCommitment,
  thresholdsHash,
  verify,
} from "@commonair/tokens/attestation";
import vectors from "@commonair/tokens/vectors.json" with { type: "json" };
import { describe, expect, test } from "vite-plus/test";
import {
  type AttestationFigures,
  type RollupTotalsRow,
  buildStatement,
  chooseKind,
  committedBreakdown,
  decodeStatement,
  figuresFromRollup,
  figuresOfStatement,
  sameFigures,
  signAndCheck,
  statementOrigin,
} from "../src/jobs/integrity-attestation.ts";

const V = vectors.attestation;

const rollup = (over: Partial<RollupTotalsRow> = {}): RollupTotalsRow => ({
  durationSeconds: 7200,
  peakVerifiedConcurrent: 42,
  verifiedViewerSeconds: 151200,
  unverifiedViewerSeconds: 3600,
  excludedViewerSeconds: 7200,
  excludedSecondsByCategory: { datacenter: 5400, playback_pattern: 1200, automation: 600 },
  bytesBySource: { origin: 1073741824, relay: 4294967296 },
  ...over,
});

describe("figures from the rollup", () => {
  test("integers only; missing sources are 0; p2p is not the instance's delivery", () => {
    const f = figuresFromRollup(rollup({ bytesBySource: { origin: 10, p2p: 99 } }));
    expect(f.deliveryBytes).toEqual({ origin: 10, relay: 0, cdn: 0 });
    expect(f.peakVerifiedConcurrent).toBe(42);
  });

  test("a float, a negative or an unsafe integer is refused, never rounded", () => {
    expect(() => figuresFromRollup(rollup({ verifiedViewerSeconds: 1.5 }))).toThrow(/integer/);
    expect(() => figuresFromRollup(rollup({ excludedViewerSeconds: -1 }))).toThrow(/integer/);
    expect(() => figuresFromRollup(rollup({ bytesBySource: { origin: 2 ** 53 } }))).toThrow(/integer/);
    expect(() => figuresFromRollup(rollup({ excludedSecondsByCategory: { other: 0.5 } }))).toThrow(/integer/);
  });

  test("the committed breakdown keeps categories above 0, in EXCLUSION_CATEGORIES order", () => {
    const b = committedBreakdown({ other: 3, datacenter: 0, automation: 7, concurrency: 1 });
    expect(b).toEqual({ concurrency: 1, automation: 7, other: 3 });
    expect(Object.keys(b)).toEqual(["concurrency", "automation", "other"]);
    expect(committedBreakdown({})).toEqual({});
  });
});

describe("kind selection", () => {
  const f = figuresFromRollup(rollup());
  test("no entry yet: broadcast", () => expect(chooseKind(null, f)).toBe("broadcast"));
  test("identical figures: nothing", () => expect(chooseKind({ figures: { ...f } }, f)).toBeNull());
  test("no rollup: nothing", () => expect(chooseKind(null, null)).toBeNull());
  test.each<[string, Partial<AttestationFigures>]>([
    ["verified seconds", { verifiedViewerSeconds: 151260 }],
    ["peak", { peakVerifiedConcurrent: 41 }],
    ["duration", { durationSeconds: 7201 }],
    ["unverified", { unverifiedViewerSeconds: 0 }],
    ["excluded", { excludedViewerSeconds: 7140 }],
    ["delivery", { deliveryBytes: { origin: 1, relay: 4294967296, cdn: 0 } }],
    ["breakdown", { breakdown: { datacenter: 5400, playback_pattern: 1200, automation: 540 } }],
    ["breakdown category moved", { breakdown: { datacenter: 5400, playback_pattern: 1200, concurrency: 600 } }],
  ])("a changed %s: supersede", (_name, over) => {
    expect(chooseKind({ figures: { ...f, ...over } }, f)).toBe("supersede");
  });
  test("breakdown key order does not count as a change", () => {
    expect(sameFigures(f, { ...f, breakdown: { automation: 600, playback_pattern: 1200, datacenter: 5400 } })).toBe(
      true,
    );
  });
});

/** The vectors' broadcast statement rebuilt from its rollup row through the job's builder. */
async function vectorStatement(): Promise<AttestationStatement> {
  const s = V.statement;
  return buildStatement({
    kind: "broadcast",
    origin: statementOrigin("https://INSTANCE.example/"),
    kid: V.kid,
    channelId: s.channelId,
    broadcastId: s.broadcastId,
    seq: 1,
    prevHash: null,
    supersedes: null,
    periodStart: new Date(s.periodStart),
    periodEnd: new Date(s.periodEnd),
    signedAt: new Date(s.signedAt),
    rulesetVersion: V.thresholds.rulesetVersion,
    thresholdsHash: await thresholdsHash(V.thresholds.rulesetVersion, V.thresholds.thresholds),
    reasonsCommitment: await reasonsCommitment(V.reasons.salt, figuresFromRollup(rollup()).breakdown),
    figures: figuresFromRollup(rollup()),
  });
}

describe("statement bytes against vectors.json", () => {
  test("the thresholds hash and the reasons commitment are the vectors'", async () => {
    expect(await thresholdsHash(V.thresholds.rulesetVersion, V.thresholds.thresholds)).toBe(V.thresholds.hash);
    expect(await reasonsCommitment(V.reasons.salt, committedBreakdown(V.reasons.breakdown))).toBe(V.reasons.commitment);
  });

  test("a statement built from the rollup row is the vector's statement, byte for byte", async () => {
    const s = await vectorStatement();
    expect(new TextDecoder().decode(canonicalize(s))).toBe(V.canonical);
    expect(Object.keys(s)).toEqual(Object.keys(V.statement));
  });

  test("signed with the vector key it is the vector envelope, verifies, and hashes to its entryHash", async () => {
    const key = await importAttestationSigningKey(V.privateKeyPkcs8);
    expect(key.kid).toBe(V.kid);
    expect(key.publicKey).toBe(V.publicKey);
    const { signed, entryHash } = await signAndCheck(key, await vectorStatement());
    expect(signed).toEqual(V.signed);
    expect(entryHash).toBe(V.entryHash);
    expect(decodeStatement(signed.payload)).toEqual(V.statement);
  });

  test("the vectors' supersede entry: figures differ from the broadcast entry, so kind is supersede", () => {
    const before = figuresOfStatement(V.statement as AttestationStatement, V.reasons.breakdown);
    const after = figuresOfStatement(V.supersede.statement as AttestationStatement, V.reasons.breakdown);
    expect(chooseKind({ figures: before }, after)).toBe("supersede");
  });

  test("signAndCheck refuses a statement whose kid is not the key's", async () => {
    const key = await importAttestationSigningKey(V.privateKeyPkcs8);
    const s = { ...(await vectorStatement()), kid: "AAAAAAAAAAAAAAAAAAAAAA" };
    await expect(signAndCheck(key, s)).rejects.toThrow(/kid/);
  });

  test("buildStatement refuses a float figure and a malformed origin", async () => {
    const s = await vectorStatement();
    const base = {
      kind: "broadcast" as const,
      origin: s.origin,
      kid: s.kid,
      channelId: s.channelId,
      broadcastId: s.broadcastId,
      seq: 1,
      prevHash: null,
      supersedes: null,
      periodStart: new Date(s.periodStart),
      periodEnd: new Date(s.periodEnd),
      signedAt: new Date(s.signedAt),
      rulesetVersion: 1,
      thresholdsHash: s.thresholdsHash,
      reasonsCommitment: s.reasonsCommitment,
    };
    const f = figuresFromRollup(rollup());
    expect(() => buildStatement({ ...base, figures: { ...f, verifiedViewerSeconds: 0.5 } })).toThrow(/expected int/i);
    expect(() => buildStatement({ ...base, origin: "https://x.example/path", figures: f })).toThrow(/invalid string/i);
  });
});

describe("statementOrigin", () => {
  test("scheme, host and port only, lowercase", () => {
    expect(statementOrigin("http://LOCALHOST:3000/")).toBe("http://localhost:3000");
    expect(statementOrigin("https://example.test/app")).toBe("https://example.test");
  });
});

// ------------------------------------------------------------------ the worker fixture chain

const FIXTURE = path.resolve(import.meta.dirname, "../../../packages/sdk/tests/attestation-worker-bundle.json");
const CHANNEL = "01890000-0000-7000-8000-00000000c001";
const B1 = "01890000-0000-7000-8000-00000000b001";
const B2 = "01890000-0000-7000-8000-00000000b002";
const SALTS = ["AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8", "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8"];

/**
 * Three entries of one chain as the worker builds them: broadcast B1, broadcast B2, then a
 * supersede of B1 after a re-score moved 60 excluded seconds to verified.
 */
export async function workerFixtureChain() {
  const key = await importAttestationSigningKey(V.privateKeyPkcs8);
  const tHash = await thresholdsHash(V.thresholds.rulesetVersion, V.thresholds.thresholds);
  const rows: { broadcastId: string; figures: AttestationFigures; at: string; salt: string }[] = [
    { broadcastId: B1, figures: figuresFromRollup(rollup()), at: "2023-11-15T02:13:20.000Z", salt: SALTS[0] as string },
    {
      broadcastId: B2,
      figures: figuresFromRollup(
        rollup({ verifiedViewerSeconds: 3600, peakVerifiedConcurrent: 3, excludedSecondsByCategory: {} }),
      ),
      at: "2023-11-16T02:13:20.000Z",
      salt: SALTS[1] as string,
    },
    {
      broadcastId: B1,
      figures: figuresFromRollup(
        rollup({
          verifiedViewerSeconds: 151260,
          excludedViewerSeconds: 7140,
          excludedSecondsByCategory: { datacenter: 5340, playback_pattern: 1200, automation: 600 },
        }),
      ),
      at: "2023-11-17T02:13:20.000Z",
      salt: SALTS[0] as string,
    },
  ];
  const entries: { seq: number; kind: string; entryHash: string; envelope: { payload: string; signature: string } }[] =
    [];
  const latest = new Map<string, string>();
  for (const [i, r] of rows.entries()) {
    const supersedes = latest.get(r.broadcastId) ?? null;
    const s = buildStatement({
      kind: supersedes ? "supersede" : "broadcast",
      origin: "https://instance.example",
      kid: key.kid,
      channelId: CHANNEL,
      broadcastId: r.broadcastId,
      seq: i + 1,
      prevHash: entries.at(-1)?.entryHash ?? null,
      supersedes,
      periodStart: new Date("2023-11-14T22:13:20.000Z"),
      periodEnd: new Date("2023-11-15T00:13:20.000Z"),
      signedAt: new Date(r.at),
      rulesetVersion: 1,
      thresholdsHash: tHash,
      reasonsCommitment: await reasonsCommitment(r.salt, r.figures.breakdown),
      figures: r.figures,
    });
    const { signed, entryHash } = await signAndCheck(key, s);
    entries.push({ seq: s.seq, kind: s.kind, entryHash, envelope: signed });
    latest.set(r.broadcastId, entryHash);
  }
  const keys: AttestationKey[] = V.keys as AttestationKey[];
  return { entries, keys: { origin: "https://instance.example", keys } };
}

describe("the worker fixture chain", () => {
  test("is the committed SDK fixture, and every entry verifies", async () => {
    const chain = await workerFixtureChain();
    for (const e of chain.entries) expect((await verify(e.envelope, chain.keys.keys)).ok).toBe(true);
    const text = `${JSON.stringify(chain, null, 2)}\n`;
    if (process.env.WRITE_ATTESTATION_FIXTURE === "1") await writeFile(FIXTURE, text);
    expect(await readFile(FIXTURE, "utf8")).toBe(text);
  });
});
