// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The SDK's attestation verifier: the bundle the worker's test fixture produces
 * (`attestation-worker-bundle.json`, written by services/worker/tests/integrity-attestation.test.ts)
 * verifies, and every tamper vector fails: payload and signature bytes, a dropped, reordered or
 * foreign entry, a relabelled listing, a compromised or unknown kid, another origin. The
 * `vectors.json` cases go through the re-exported single-statement verifier unchanged.
 */
import vectors from "@commonair/tokens/vectors.json" with { type: "json" };
import { describe, expect, test } from "vite-plus/test";
import {
  type AttestationKey,
  type AttestationKeyHistory,
  type ServedAttestationEntry,
  type SignedAttestation,
  AttestationStatement,
  canonicalize,
  fromB64url,
  toB64url,
  verifyAttestation,
  verifyAttestationBundle,
  verifyReasons,
  verifyServedBundle,
} from "../src/attestation.ts";
import fixture from "./attestation-worker-bundle.json" with { type: "json" };

const V = vectors.attestation;
const bundle = fixture as { entries: ServedAttestationEntry[]; keys: AttestationKeyHistory };
const envelopes = bundle.entries.map((e) => e.envelope);

const decode = (payload: string) => JSON.parse(new TextDecoder().decode(fromB64url(payload))) as AttestationStatement;
/** Re-encode a statement edited after signing, keeping the old signature. */
const forge = (env: SignedAttestation, edit: (s: AttestationStatement) => AttestationStatement): SignedAttestation => ({
  payload: toB64url(canonicalize(AttestationStatement.parse(edit(decode(env.payload))))),
  signature: env.signature,
});
const flip = (b64: string, at = 5) => {
  const bytes = fromB64url(b64);
  bytes[at] = (bytes[at] as number) ^ 1;
  return toB64url(bytes);
};

describe("the worker fixture bundle", () => {
  test("verifies: chain, signatures, origin; the latest entry per broadcast; the superseded one marked", async () => {
    const r = await verifyServedBundle(bundle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.origin).toBe("https://instance.example");
    expect(r.entries.map((e) => [e.statement.seq, e.statement.kind, e.superseded])).toEqual([
      [1, "broadcast", true],
      [2, "broadcast", false],
      [3, "supersede", false],
    ]);
    expect(r.latest.map((e) => e.statement.seq)).toEqual([2, 3]);
    expect(r.entries[2]?.statement.supersedes).toBe(r.entries[0]?.entryHash);
  });

  test("a window that starts mid-chain still verifies (its first entry is vouched for by the chain)", async () => {
    const r = await verifyAttestationBundle(envelopes.slice(1), bundle.keys);
    expect(r.ok).toBe(true);
  });

  test("the key rows alone (no origin to compare with) are enough", async () => {
    expect((await verifyAttestationBundle(envelopes, bundle.keys.keys)).ok).toBe(true);
  });
});

describe("tamper vectors", () => {
  const cases: [string, () => Promise<unknown>, unknown][] = [
    [
      "a figure changed after signing",
      () =>
        verifyAttestationBundle(
          [
            envelopes[0]!,
            forge(envelopes[1]!, (s) => ({ ...s, verifiedViewerSeconds: s.verifiedViewerSeconds + 1 })),
            envelopes[2]!,
          ],
          bundle.keys,
        ),
      { ok: false, problem: "bad_signature", index: 1 },
    ],
    [
      "a payload byte flipped",
      () => verifyAttestationBundle([{ ...envelopes[0]!, payload: flip(envelopes[0]!.payload, 40) }], bundle.keys),
      { ok: false, problem: "bad_signature", index: 0 },
    ],
    [
      "a signature bit flipped",
      () =>
        verifyAttestationBundle(
          [envelopes[0]!, { ...envelopes[1]!, signature: flip(envelopes[1]!.signature) }],
          bundle.keys,
        ),
      { ok: false, problem: "bad_signature", index: 1 },
    ],
    [
      "an entry dropped from the middle",
      () => verifyAttestationBundle([envelopes[0]!, envelopes[2]!], bundle.keys),
      { ok: false, problem: "chain_break", index: 1 },
    ],
    [
      "entries reordered",
      () => verifyAttestationBundle([envelopes[1]!, envelopes[0]!, envelopes[2]!], bundle.keys),
      { ok: false, problem: "chain_break", index: 1 },
    ],
    [
      "an entry repeated",
      () => verifyAttestationBundle([envelopes[0]!, envelopes[0]!], bundle.keys),
      { ok: false, problem: "chain_break", index: 1 },
    ],
    [
      "the key compromised, whatever the entry's date",
      () =>
        verifyAttestationBundle(envelopes, {
          ...bundle.keys,
          keys: bundle.keys.keys.map((k) => ({ ...k, compromisedAt: "2030-01-01T00:00:00.000Z" })),
        }),
      { ok: false, problem: "compromised_kid", index: 0 },
    ],
    [
      "a kid missing from the history",
      () => verifyAttestationBundle(envelopes, { ...bundle.keys, keys: [] }),
      { ok: false, problem: "unknown_kid", index: 0 },
    ],
    [
      "a history from another instance",
      () => verifyAttestationBundle(envelopes, { ...bundle.keys, origin: "https://other.example" }),
      { ok: false, problem: "wrong_origin", index: 0 },
    ],
    [
      "a history row whose kid is not its key's",
      () =>
        verifyAttestationBundle(envelopes, {
          ...bundle.keys,
          keys: bundle.keys.keys.map((k) => ({ ...k, publicKey: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" })),
        }),
      { ok: false, problem: "kid_mismatch", index: 0 },
    ],
    ["no entries", () => verifyAttestationBundle([], bundle.keys), { ok: false, problem: "empty", index: null }],
    [
      "a listing that relabels an entry's seq",
      () => verifyServedBundle({ ...bundle, entries: bundle.entries.map((e, i) => (i === 1 ? { ...e, seq: 7 } : e)) }),
      { ok: false, problem: "listing_mismatch", index: 1 },
    ],
    [
      "a listing that relabels a supersede as a broadcast",
      () =>
        verifyServedBundle({
          ...bundle,
          entries: bundle.entries.map((e, i) => (i === 2 ? { ...e, kind: "broadcast" } : e)),
        }),
      { ok: false, problem: "listing_mismatch", index: 2 },
    ],
    [
      "a listing with another entry hash",
      () =>
        verifyServedBundle({
          ...bundle,
          entries: bundle.entries.map((e, i) => (i === 0 ? { ...e, entryHash: "0".repeat(64) } : e)),
        }),
      { ok: false, problem: "listing_mismatch", index: 0 },
    ],
  ];
  test.each(cases)("%s fails", async (_name, run, expected) => {
    expect(await run()).toEqual(expected);
  });

  test("a validly signed entry of another channel, chained correctly, is refused", async () => {
    // Signed with the vectors' key (the fixture's), so only the channel differs.
    const { importAttestationSigningKey, sign } = await import("@commonair/tokens/attestation");
    const key = await importAttestationSigningKey(V.privateKeyPkcs8);
    const last = decode(envelopes[2]!.payload);
    const foreign = await sign(key, {
      ...last,
      kind: "broadcast",
      supersedes: null,
      channelId: "01890000-0000-7000-8000-00000000c002",
      broadcastId: "01890000-0000-7000-8000-00000000b003",
      seq: 4,
      prevHash: bundle.entries[2]!.entryHash,
    });
    expect(await verifyAttestationBundle([...envelopes, foreign], bundle.keys)).toEqual({
      ok: false,
      problem: "wrong_channel",
      index: 3,
    });
    // A supersede naming an entry of another broadcast inside the window.
    const wrongTarget = await sign(key, {
      ...last,
      seq: 4,
      prevHash: bundle.entries[2]!.entryHash,
      supersedes: bundle.entries[1]!.entryHash,
    });
    expect(await verifyAttestationBundle([...envelopes, wrongTarget], bundle.keys)).toEqual({
      ok: false,
      problem: "bad_supersedes",
      index: 3,
    });
  });
});

describe("chain rules a third party cannot leave to the instance", () => {
  const signWithFixtureKey = async (st: AttestationStatement) => {
    const { importAttestationSigningKey, sign } = await import("@commonair/tokens/attestation");
    return sign(await importAttestationSigningKey(V.privateKeyPkcs8), st);
  };
  const last = () => decode(envelopes[2]!.payload);
  const next = { seq: 4, prevHash: () => bundle.entries[2]!.entryHash };

  test("a second broadcast entry for one broadcast is refused", async () => {
    const again = await signWithFixtureKey({
      ...last(),
      kind: "broadcast",
      supersedes: null,
      seq: next.seq,
      prevHash: next.prevHash(),
    });
    expect(await verifyAttestationBundle([...envelopes, again], bundle.keys)).toEqual({
      ok: false,
      problem: "bad_supersedes",
      index: 3,
    });
  });

  test("a supersede that skips its broadcast's latest entry in the window is refused", async () => {
    // Entry 3 already replaced entry 1 of this broadcast; naming entry 1 again forks the history.
    const fork = await signWithFixtureKey({
      ...last(),
      seq: next.seq,
      prevHash: next.prevHash(),
      supersedes: bundle.entries[0]!.entryHash,
    });
    expect(await verifyAttestationBundle([...envelopes, fork], bundle.keys)).toEqual({
      ok: false,
      problem: "bad_supersedes",
      index: 3,
    });
  });
});

describe("after a key compromise", () => {
  /** The fixture's key marked compromised, a fresh good key, and a re-issue of each broadcast. */
  async function reissued() {
    const { generateKeyPairSync } = await import("node:crypto");
    const { importAttestationSigningKey, sign, entryHash } = await import("@commonair/tokens/attestation");
    const good = await importAttestationSigningKey(
      generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    );
    const keys: AttestationKeyHistory = {
      ...bundle.keys,
      keys: [
        ...bundle.keys.keys.map((k) => ({
          ...k,
          retiredAt: "2030-01-01T00:00:00.000Z",
          compromisedAt: "2030-01-02T00:00:00.000Z",
        })),
        {
          kid: good.kid,
          algorithm: "Ed25519",
          publicKey: good.publicKey,
          firstUsedAt: "2030-01-01T00:00:00.000Z",
          retiredAt: null,
          compromisedAt: null,
        },
      ],
    };
    const out = [...envelopes];
    // Broadcast 2's latest is entry 2, broadcast 1's is entry 3.
    for (const target of [1, 2]) {
      const orig = decode(envelopes[target]!.payload);
      const prev = out.at(-1)!;
      const env = await sign(good, {
        ...orig,
        kind: "reissue",
        kid: good.kid,
        seq: out.length + 1,
        prevHash: await entryHash(prev),
        supersedes: bundle.entries[target]!.entryHash,
      });
      out.push(env);
    }
    return { keys, out };
  }

  test("a single statement signed by the compromised key fails", async () => {
    const { keys } = await reissued();
    expect((await verifyAttestation(envelopes[1]!, keys.keys)).ok).toBe(false);
  });

  test("a window through the compromised era verifies once every broadcast is re-issued", async () => {
    const { keys, out } = await reissued();
    const r = await verifyAttestationBundle(out, keys);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries.map((e) => [e.statement.seq, e.compromised, e.superseded])).toEqual([
      [1, true, true],
      [2, true, true],
      [3, true, true],
      [4, false, false],
      [5, false, false],
    ]);
    expect(r.latest.map((e) => e.statement.seq)).toEqual([4, 5]);
  });

  test("a compromised entry that is still its broadcast's latest fails", async () => {
    const { keys, out } = await reissued();
    // Only broadcast 2 re-issued: broadcast 1's latest (entry 3) is still the compromised one.
    expect(await verifyAttestationBundle(out.slice(0, 4), keys)).toEqual({
      ok: false,
      problem: "compromised_kid",
      index: 2,
    });
  });

  test("a compromised entry with no good-key entry after it fails", async () => {
    const { keys } = await reissued();
    expect(await verifyAttestationBundle(envelopes, keys)).toEqual({ ok: false, problem: "compromised_kid", index: 0 });
  });

  test("a forged entry under the compromised key is still refused by its signature", async () => {
    const { keys, out } = await reissued();
    const forged = forge(out[1]!, (s) => ({ ...s, verifiedViewerSeconds: s.verifiedViewerSeconds + 1 }));
    expect(await verifyAttestationBundle([out[0]!, forged, ...out.slice(2)], keys)).toEqual({
      ok: false,
      problem: "bad_signature",
      index: 1,
    });
  });
});

describe("the re-exported single-statement verifier", () => {
  test.each(V.cases)("vectors.json: $name", async (c) => {
    const keys = (c as { keys?: AttestationKey[] }).keys ?? (V.keys as AttestationKey[]);
    const r = await verifyAttestation(c.signed, keys);
    expect(r.ok ? null : r.error).toBe(c.error);
  });
});

describe("verifyReasons", () => {
  test("the vectors' breakdown opens the vectors' commitment; anything else does not", async () => {
    const s = { reasonsCommitment: V.reasons.commitment };
    expect(await verifyReasons(s, V.reasons.salt, V.reasons.breakdown)).toBe(true);
    expect(await verifyReasons(s, V.reasons.salt, { ...V.reasons.breakdown, datacenter: 5401 })).toBe(false);
    expect(await verifyReasons(s, V.reasons.salt, { ...V.reasons.breakdown, other: 0 })).toBe(false);
    expect(await verifyReasons(s, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", V.reasons.breakdown)).toBe(false);
    expect(await verifyReasons(s, "not base64url!", V.reasons.breakdown)).toBe(false);
  });
});
