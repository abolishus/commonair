// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Verify CommonAir signed audience attestations offline (ADR 0014): one statement, or a window
 * proof (a bundle of contiguous entries of one channel's chain plus the instance's key history).
 *
 * The byte-level work (strict base64url, the canonical payload, Ed25519, the derived `kid`,
 * `entryHash`, the reasons commitment) is `@commonair/tokens/attestation`, re-exported here
 * unchanged; this file only adds the chain rules on top. A bundle verifies when every signature
 * verifies against the key history (a compromised `kid` fails whatever its date), each entry's
 * `seq` is the previous one's plus one and its `prevHash` the previous `entryHash`, every entry is
 * of one channel and one origin, and every `supersede`/`reissue` inside the window names an earlier
 * entry of the same broadcast. The current statement for a broadcast is its latest entry; earlier
 * ones still verify and are reported as superseded.
 */
import {
  type AttestationError,
  type AttestationKey,
  type AttestationStatement,
  type ExclusionCategory,
  type SignedAttestation,
  reasonsCommitment,
  verify,
} from "@commonair/tokens/attestation";

export {
  ATTESTATION_ALGORITHM,
  ATTESTATION_KINDS,
  ATTESTATION_VERSION,
  AttestationDeliveryBytes,
  AttestationStatement,
  EXCLUSION_CATEGORIES,
  canonicalize,
  deriveKid,
  entryHash,
  fromB64url,
  reasonsCommitment,
  stableJson,
  thresholdsHash,
  toB64url,
  verify as verifyAttestation,
  type AttestationError,
  type AttestationKey,
  type AttestationKind,
  type AttestationVerifyResult,
  type ExclusionCategory,
  type SignedAttestation,
} from "@commonair/tokens/attestation";

/** The instance's key history as `/.well-known/commonair-attestation` serves it. */
export interface AttestationKeyHistory {
  origin: string;
  keys: readonly AttestationKey[];
}

export type BundleProblem =
  | AttestationError
  /** No entries. */
  | "empty"
  /** A `seq` that is not the previous plus one, or a `prevHash` that is not the previous `entryHash`. */
  | "chain_break"
  /** Entries of more than one channel. */
  | "wrong_channel"
  /** An entry signed for another origin than the history's (or the other entries'). */
  | "wrong_origin"
  /** A supersede or reissue inside the window naming a later entry, or one of another broadcast. */
  | "bad_supersedes"
  /** The listed `entryHash`/`seq`/`kind` of a served entry disagree with what was signed. */
  | "listing_mismatch";

export interface VerifiedEntry {
  statement: AttestationStatement;
  entryHash: string;
  /** A later entry in the window is for the same broadcast. */
  superseded: boolean;
}

export type BundleResult =
  | {
      ok: true;
      origin: string;
      channelId: string;
      /** Every entry, in chain order. */
      entries: VerifiedEntry[];
      /** The current (latest) entry of each broadcast in the window, in chain order. */
      latest: VerifiedEntry[];
    }
  | { ok: false; problem: BundleProblem; /** Index of the entry that failed, when one did. */ index: number | null };

const isKeyRows = (k: AttestationKeyHistory | readonly AttestationKey[]): k is readonly AttestationKey[] =>
  Array.isArray(k);

const fail = (problem: BundleProblem, index: number | null = null): BundleResult => ({ ok: false, problem, index });

/**
 * Verify a window of one channel's chain, oldest first. `keys` is the key history (or just its
 * rows, in which case the origin is not checked against it).
 */
export async function verifyAttestationBundle(
  envelopes: readonly SignedAttestation[],
  keys: AttestationKeyHistory | readonly AttestationKey[],
): Promise<BundleResult> {
  if (envelopes.length === 0) return fail("empty");
  // An array has a `keys` method, so test for the array, not for the property.
  const history = isKeyRows(keys) ? null : keys;
  const rows = isKeyRows(keys) ? keys : keys.keys;
  const out: VerifiedEntry[] = [];
  for (const [i, env] of envelopes.entries()) {
    const r = await verify(env, rows);
    if (!r.ok) return fail(r.error, i);
    const s = r.statement;
    const prev = out.at(-1);
    if (prev) {
      if (s.channelId !== prev.statement.channelId) return fail("wrong_channel", i);
      if (s.origin !== prev.statement.origin) return fail("wrong_origin", i);
      if (s.seq !== prev.statement.seq + 1 || s.prevHash !== prev.entryHash) return fail("chain_break", i);
    }
    if (history && s.origin !== history.origin) return fail("wrong_origin", i);
    out.push({ statement: s, entryHash: r.entryHash, superseded: false });
  }
  // A replaced entry is only checkable inside the window; before it, the chain vouches for it.
  const indexOf = new Map(out.map((e, i) => [e.entryHash, i]));
  for (const [i, e] of out.entries()) {
    if (e.statement.supersedes === null) continue;
    const target = indexOf.get(e.statement.supersedes);
    if (target === undefined) continue;
    if (target >= i || (out[target] as VerifiedEntry).statement.broadcastId !== e.statement.broadcastId)
      return fail("bad_supersedes", i);
  }
  const latestByBroadcast = new Map<string, VerifiedEntry>();
  for (const e of out) {
    const before = latestByBroadcast.get(e.statement.broadcastId);
    if (before) before.superseded = true;
    latestByBroadcast.set(e.statement.broadcastId, e);
  }
  const first = out[0] as VerifiedEntry;
  return {
    ok: true,
    origin: first.statement.origin,
    channelId: first.statement.channelId,
    entries: out,
    latest: out.filter((e) => !e.superseded),
  };
}

/** One entry as the API serves it (`AttestationEntry`): only what is checked here. */
export interface ServedAttestationEntry {
  seq: number;
  kind: string;
  entryHash: string;
  envelope: SignedAttestation;
}

/**
 * Verify a bundle as the API serves it (`integrity.attestations.bundle`): the signed envelopes
 * through `verifyAttestationBundle`, plus the served `seq`, `kind` and `entryHash` of every entry
 * against what was signed, so a listing cannot relabel an entry.
 */
export async function verifyServedBundle(bundle: {
  entries: readonly ServedAttestationEntry[];
  keys: AttestationKeyHistory;
}): Promise<BundleResult> {
  const r = await verifyAttestationBundle(
    bundle.entries.map((e) => e.envelope),
    bundle.keys,
  );
  if (!r.ok) return r;
  for (const [i, served] of bundle.entries.entries()) {
    const v = r.entries[i] as VerifiedEntry;
    if (served.seq !== v.statement.seq || served.kind !== v.statement.kind || served.entryHash !== v.entryHash)
      return fail("listing_mismatch", i);
  }
  return r;
}

/**
 * Check a revealed breakdown (owner view or share link) against the statement's
 * `reasonsCommitment`. False for a wrong salt, a changed figure, an unknown category or a zero.
 */
export async function verifyReasons(
  statement: Pick<AttestationStatement, "reasonsCommitment">,
  salt: string,
  breakdown: Readonly<Partial<Record<ExclusionCategory, number>>>,
): Promise<boolean> {
  try {
    return (await reasonsCommitment(salt, breakdown)) === statement.reasonsCommitment;
  } catch {
    return false;
  }
}
