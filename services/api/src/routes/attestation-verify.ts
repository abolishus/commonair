// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The public side of signed audience attestations (W2b-attestations, ADR 0014): the verifier
 * (`integrity.attestations.verify`) and the key history at `/.well-known/commonair-attestation`
 * (`integrity.keys.list`, served by the OpenAPI handler as `/api/.well-known/commonair-attestation`;
 * Caddy rewrites the bare path to it), plus the reads `./integrity.ts` shares (the key history,
 * entry rows). The API verifies with `@commonair/tokens/attestation` and never signs:
 * `INTEGRITY_SIGNING_KEY` is the worker's alone (batch 6 decision (l)), so nothing here imports
 * `sign`, `importAttestationSigningKey` or the worker's env schema.
 */
import type { AttestationEntry, AttestationKey, AttestationVerifyResult } from "@commonair/contracts/dto";
import { type Executor, schema } from "@commonair/db";
import {
  type AttestationStatement,
  type AttestationKey as TokensKey,
  type SignedAttestation,
  verify,
} from "@commonair/tokens/attestation";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import type { Deps } from "../deps.ts";
import { os } from "../lib/orpc.ts";

const { integrityAttestations: entries, integritySigningKeys: keys } = schema;

/** The instance origin statements name (`statementOrigin` in the worker): scheme, host, port. */
export const instanceOrigin = (deps: Pick<Deps, "site">): string => new URL(deps.site.publicUrl).origin;

/** Every signing key the instance has used, oldest first (ADR 0014 decision 1). */
export async function loadKeyHistory(db: Executor): Promise<AttestationKey[]> {
  const rows = await db.select().from(keys).orderBy(asc(keys.firstUsedAt), asc(keys.kid));
  return rows.map((k) => ({
    kid: k.kid,
    algorithm: "Ed25519" as const,
    publicKey: k.publicKey,
    firstUsedAt: k.firstUsedAt.toISOString(),
    retiredAt: k.retiredAt?.toISOString() ?? null,
    compromisedAt: k.compromisedAt?.toISOString() ?? null,
  }));
}

export type EntryRow = typeof entries.$inferSelect;

/** An entry as served; the breakdown and salt only when `reveal` (owner, share link). */
export function toEntry(
  r: EntryRow,
  o: { channelSlug: string; superseded: boolean; reveal: boolean },
): AttestationEntry {
  return {
    id: r.id,
    channelSlug: o.channelSlug,
    broadcastId: r.broadcastId,
    seq: r.seq,
    kind: r.kind,
    kid: r.kid,
    entryHash: r.entryHash,
    prevHash: r.prevHash,
    supersedes: r.supersedes,
    signedAt: r.signedAt.toISOString(),
    envelope: { payload: r.payload, signature: r.signature },
    superseded: o.superseded,
    breakdown: o.reveal ? r.breakdown : null,
    salt: o.reveal ? r.salt : null,
  };
}

const result = (
  valid: boolean,
  problem: AttestationVerifyResult["problem"],
  statement: AttestationStatement | null,
): AttestationVerifyResult => ({
  valid,
  problem,
  origin: statement?.origin ?? null,
  statement: statement ? { ...statement } : null,
});

/**
 * Verify one envelope or a window bundle against this instance's key history. A bundle verifies
 * when every entry does and they chain (consecutive `seq`, each `prevHash` the previous
 * `entryHash`, one channel); the statement returned is its last entry's. Every entry must be one
 * this instance stored. A statement for another origin is `wrong_origin`; a single statement
 * replaced by a later entry of its broadcast is `superseded` (it still verified, so the statement
 * is returned). The chain of a window bundle is not judged by what follows it.
 *
 * A compromised key fails every statement it signed on its own. In a bundle its entries are
 * accepted as links (signature checked against its public half) when a later entry of the same
 * broadcast replaces them in the window and a good-key entry follows, the same rule as the SDK's
 * `verifyAttestationBundle`: otherwise a window through the compromised era could never verify,
 * since re-issues are appended at the head. A failing signature returns no statement, so a page
 * never shows the last good entry's figures next to another entry's failure.
 */
export async function verifyAttestations(
  deps: Pick<Deps, "db" | "site">,
  input: { envelope?: SignedAttestation | undefined; bundle?: readonly SignedAttestation[] | undefined },
): Promise<AttestationVerifyResult> {
  const history: TokensKey[] = await loadKeyHistory(deps.db);
  const relaxed = history.map((k) => (k.compromisedAt === null ? k : { ...k, compromisedAt: null }));
  const list = input.envelope ? [input.envelope] : (input.bundle ?? []);
  const origin = instanceOrigin(deps);
  let prev: { statement: AttestationStatement; entryHash: string } | null = null;
  const hashes: string[] = [];
  const latest = new Map<string, number>();
  const compromised: { index: number; broadcastId: string }[] = [];
  let lastGood = -1;
  for (const [i, env] of list.entries()) {
    let r = await verify(env, history);
    if (!r.ok && r.error === "compromised_kid" && input.bundle) {
      r = await verify(env, relaxed);
      if (r.ok) compromised.push({ index: i, broadcastId: r.statement.broadcastId });
    } else if (r.ok) lastGood = i;
    if (!r.ok) return result(false, r.error, null);
    if (r.statement.origin !== origin) return result(false, "wrong_origin", r.statement);
    if (
      prev &&
      (r.statement.channelId !== prev.statement.channelId ||
        r.statement.seq !== prev.statement.seq + 1 ||
        r.statement.prevHash !== prev.entryHash)
    )
      return result(false, "chain_break", r.statement);
    prev = r;
    hashes.push(r.entryHash);
    latest.set(r.statement.broadcastId, i);
  }
  for (const c of compromised)
    if (latest.get(c.broadcastId) === c.index || c.index > lastGood) return result(false, "compromised_kid", null);
  if (!prev) return result(false, "malformed", null);
  const last = prev;
  // Signed but never stored (a transaction that rolled back after signing) is not in the chain.
  const known = await deps.db
    .select({ entryHash: entries.entryHash })
    .from(entries)
    .where(inArray(entries.entryHash, hashes));
  if (known.length !== new Set(hashes).size) return result(false, "chain_break", last.statement);
  if (input.envelope) {
    const later = await deps.db
      .select({ seq: entries.seq })
      .from(entries)
      .where(
        and(
          eq(entries.channelId, last.statement.channelId),
          eq(entries.broadcastId, last.statement.broadcastId),
          gt(entries.seq, last.statement.seq),
        ),
      )
      .limit(1);
    if (later.length > 0) return result(false, "superseded", last.statement);
  }
  return result(true, null, last.statement);
}

export const attestationVerify = os.integrity.attestations.verify.handler(({ context, input }) =>
  verifyAttestations(context.deps, input),
);

export const attestationKeys = os.integrity.keys.list.handler(async ({ context }) => ({
  origin: instanceOrigin(context.deps),
  keys: await loadKeyHistory(context.deps.db),
}));
