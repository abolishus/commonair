// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Signed audience attestations (W2b-attestations, ADR 0014; batch 6 decisions (l), (r)): append a
 * `broadcast`, `supersede` or `reissue` entry to the channel's chain, signed with
 * `INTEGRITY_SIGNING_KEY` (worker only). Enqueued by the outbox relay on `analytics.rollup.ready`
 * (`reason` `rollup` / `recheck` / `test`), by the daily `attestation-reconcile` pass below
 * (`reconcile`), by `integrity.keys.compromise` (`recheck`) and by the API test hook (`test`).
 *
 * The figures come from the broadcast's rollup (`broadcast_audience_totals`) only, never from the
 * sessions, so a statement cannot disagree with the creator's analytics. Each append runs in one
 * transaction under `pg_advisory_xact_lock(hashtext('integrity:attestation:<channelId>'))` (the
 * 0043 trigger takes the same lock and re-checks the chain): read the head, build the statement
 * through `@commonair/tokens/attestation` only, sign, verify the signature, insert, emit
 * `integrity.attestation.appended`.
 *
 * - No entry yet: `broadcast`. Different figures than the broadcast's latest entry: `supersede`.
 *   The same figures: nothing (the per-entry salt makes every commitment new, so the comparison is
 *   on the figures and the revealed breakdown, never on hashes).
 * - The latest entry was signed by a compromised `kid` (ADR 0014 decision 1): `reissue`, carrying
 *   the original's figures, period, thresholds and commitment, signed by the current key.
 * - Rehearsals are never attested; a broadcast whose per-minute rollup is gone (90 days) is final:
 *   no supersede, though a compromised entry is still re-issued.
 *
 * Statements carry ids and counts only, never user ids or personal data (ADR 0004).
 */
import type { InstanceSite } from "@commonair/config/site";
import { attestationEnv, loadEnv } from "@commonair/config";
import type { ExclusionCategory } from "@commonair/contracts/enums";
import {
  ANALYTICS_JOBS,
  type AnalyticsJobResult,
  AttestationReconcileJob,
  IntegrityAttestationJob,
  QUEUES,
  analyticsJobId,
} from "@commonair/contracts/internal";
import { type Executor, schema, uuidv7 } from "@commonair/db";
import { RULESET_VERSION, loadThresholds } from "@commonair/integrity";
import {
  ATTESTATION_VERSION,
  type AttestationKind,
  AttestationStatement,
  type AttestationSigningKey,
  EXCLUSION_CATEGORIES,
  type SignedAttestation,
  entryHash,
  fromB64url,
  importAttestationSigningKey,
  newReasonsSalt,
  reasonsCommitment,
  sign,
  thresholdsHash,
  verify,
} from "@commonair/tokens/attestation";
import { and, asc, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import { audit, emit } from "../moderation/records.ts";
import { defineJob } from "../runtime/registry.ts";

type ByCategory = Partial<Record<ExclusionCategory, number>>;
const { broadcasts, broadcastAudienceTotals, integrityAttestations, integritySigningKeys, playbackSessions } = schema;

const DAY_MS = 86_400_000;
/** Broadcasts one reconcile pass re-checks at most, per kind of check. */
const RECONCILE_BATCH = 500;
/** How far back a reconcile pass looks for re-rolled broadcasts (two daily runs, with margin). */
const RECONCILE_LOOKBACK_MS = 2 * DAY_MS;

// ------------------------------------------------------------------------------- pure helpers

/** What a statement says about a broadcast, plus the breakdown its commitment hides. */
export interface AttestationFigures {
  peakVerifiedConcurrent: number;
  verifiedViewerSeconds: number;
  durationSeconds: number;
  unverifiedViewerSeconds: number;
  excludedViewerSeconds: number;
  deliveryBytes: { origin: number; relay: number; cdn: number };
  /** Excluded viewer-seconds by category, only the categories above 0 (the committed map). */
  breakdown: ByCategory;
}

/** The rollup row's columns the statement reads. */
export interface RollupTotalsRow {
  durationSeconds: number;
  peakVerifiedConcurrent: number;
  verifiedViewerSeconds: number;
  unverifiedViewerSeconds: number;
  excludedViewerSeconds: number;
  excludedSecondsByCategory: ByCategory;
  bytesBySource: Partial<Record<"origin" | "relay" | "p2p" | "cdn", number>>;
}

const int = (n: number | undefined): number => {
  const v = n ?? 0;
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`attestation figure is not a non-negative integer: ${v}`);
  return v;
};

/**
 * The committed breakdown: `EXCLUSION_CATEGORIES` keys in that order, values above 0 only
 * (`reasonsCommitment` refuses anything else).
 */
export function committedBreakdown(by: ByCategory): ByCategory {
  const out: ByCategory = {};
  for (const c of EXCLUSION_CATEGORIES) {
    const v = int(by[c]);
    if (v > 0) out[c] = v;
  }
  return out;
}

/**
 * The statement's figures from the rollup, integers only. Delivery bytes are the instance's own
 * sources (origin, relay, CDN); peer-to-peer bytes are not the instance's delivery and the
 * statement schema has no field for them.
 */
export function figuresFromRollup(t: RollupTotalsRow): AttestationFigures {
  return {
    peakVerifiedConcurrent: int(t.peakVerifiedConcurrent),
    verifiedViewerSeconds: int(t.verifiedViewerSeconds),
    durationSeconds: int(t.durationSeconds),
    unverifiedViewerSeconds: int(t.unverifiedViewerSeconds),
    excludedViewerSeconds: int(t.excludedViewerSeconds),
    deliveryBytes: {
      origin: int(t.bytesBySource.origin),
      relay: int(t.bytesBySource.relay),
      cdn: int(t.bytesBySource.cdn),
    },
    breakdown: committedBreakdown(t.excludedSecondsByCategory),
  };
}

/** A signed statement's figures, with the breakdown stored beside it. */
export function figuresOfStatement(s: AttestationStatement, breakdown: ByCategory): AttestationFigures {
  return {
    peakVerifiedConcurrent: s.peakVerifiedConcurrent,
    verifiedViewerSeconds: s.verifiedViewerSeconds,
    durationSeconds: s.durationSeconds,
    unverifiedViewerSeconds: s.unverifiedViewerSeconds,
    excludedViewerSeconds: s.excludedViewerSeconds,
    deliveryBytes: { ...s.deliveryBytes },
    breakdown: committedBreakdown(breakdown),
  };
}

export function sameFigures(a: AttestationFigures, b: AttestationFigures): boolean {
  if (
    a.peakVerifiedConcurrent !== b.peakVerifiedConcurrent ||
    a.verifiedViewerSeconds !== b.verifiedViewerSeconds ||
    a.durationSeconds !== b.durationSeconds ||
    a.unverifiedViewerSeconds !== b.unverifiedViewerSeconds ||
    a.excludedViewerSeconds !== b.excludedViewerSeconds ||
    a.deliveryBytes.origin !== b.deliveryBytes.origin ||
    a.deliveryBytes.relay !== b.deliveryBytes.relay ||
    a.deliveryBytes.cdn !== b.deliveryBytes.cdn
  )
    return false;
  return EXCLUSION_CATEGORIES.every((c) => (a.breakdown[c] ?? 0) === (b.breakdown[c] ?? 0));
}

/** What to append for a broadcast (ADR 0014 decision 4). Null: nothing. */
export function chooseKind(
  latest: { figures: AttestationFigures } | null,
  current: AttestationFigures | null,
): Extract<AttestationKind, "broadcast" | "supersede"> | null {
  if (current === null) return null;
  if (latest === null) return "broadcast";
  return sameFigures(latest.figures, current) ? null : "supersede";
}

export interface StatementInput {
  kind: AttestationKind;
  origin: string;
  kid: string;
  channelId: string;
  broadcastId: string;
  seq: number;
  prevHash: string | null;
  supersedes: string | null;
  periodStart: Date;
  periodEnd: Date;
  signedAt: Date;
  rulesetVersion: number;
  thresholdsHash: string;
  reasonsCommitment: string;
  figures: AttestationFigures;
}

/** The statement, in schema key order (the payload's byte order), parsed so it is valid or throws. */
export function buildStatement(i: StatementInput): AttestationStatement {
  const f = i.figures;
  return AttestationStatement.parse({
    v: ATTESTATION_VERSION,
    kind: i.kind,
    origin: i.origin,
    kid: i.kid,
    channelId: i.channelId,
    broadcastId: i.broadcastId,
    seq: i.seq,
    prevHash: i.prevHash,
    supersedes: i.supersedes,
    periodStart: i.periodStart.toISOString(),
    periodEnd: i.periodEnd.toISOString(),
    signedAt: i.signedAt.toISOString(),
    rulesetVersion: i.rulesetVersion,
    thresholdsHash: i.thresholdsHash,
    peakVerifiedConcurrent: f.peakVerifiedConcurrent,
    verifiedViewerSeconds: f.verifiedViewerSeconds,
    durationSeconds: f.durationSeconds,
    unverifiedViewerSeconds: f.unverifiedViewerSeconds,
    excludedViewerSeconds: f.excludedViewerSeconds,
    reasonsCommitment: i.reasonsCommitment,
    deliveryBytes: { origin: f.deliveryBytes.origin, relay: f.deliveryBytes.relay, cdn: f.deliveryBytes.cdn },
  });
}

/** The instance origin a statement names: scheme, host and port of `PUBLIC_URL`, lowercase. */
export const statementOrigin = (publicUrl: string): string => new URL(publicUrl).origin;

/** Decode a stored payload (only ever our own, already verified at insert). */
export function decodeStatement(payload: string): AttestationStatement {
  return AttestationStatement.parse(JSON.parse(new TextDecoder().decode(fromB64url(payload))));
}

/**
 * Sign, then verify the signature against the key's own public half before anything is stored:
 * a statement that does not verify is never inserted.
 */
export async function signAndCheck(
  key: AttestationSigningKey,
  statement: AttestationStatement,
): Promise<{ signed: SignedAttestation; entryHash: string }> {
  const signed = await sign(key, statement);
  const check = await verify(signed, key.publicKey);
  if (!check.ok) throw new Error(`attestation failed its own verification (${check.error})`);
  if (JSON.stringify(check.statement) !== JSON.stringify(statement))
    throw new Error("attestation verified to a different statement");
  const hash = await entryHash(signed);
  if (hash !== check.entryHash) throw new Error("attestation entry hash mismatch");
  return { signed, entryHash: hash };
}

// ------------------------------------------------------------------------------- the job

export class SigningKeyRetiredError extends Error {
  constructor(kid: string, state: "retired" | "compromised") {
    super(`attestation signing key ${kid} is ${state}; restart the worker with the current INTEGRITY_SIGNING_KEY`);
    this.name = "SigningKeyRetiredError";
  }
}

export interface AttestationOptions {
  key: AttestationSigningKey;
  /** The instance origin (`statementOrigin(instanceSite().publicUrl)`). */
  origin: string;
}

/** The channel's chain lock (ADR 0014 decision 5; the 0043 trigger takes the same one). */
export async function lockChain(tx: Executor, channelId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`integrity:attestation:${channelId}`}))`);
}

/**
 * The signing key's row, inserted on first use, which retires every other active key in the same
 * transaction (rotation, ADR 0014 decision 1). A retired or compromised key throws: its appends
 * would be refused by the trigger anyway, and the job fails until the worker restarts with the
 * current key.
 */
export async function ensureSigningKey(tx: Executor, key: AttestationSigningKey, now: Date): Promise<void> {
  const k = integritySigningKeys;
  const [row] = await tx
    .select({ retiredAt: k.retiredAt, compromisedAt: k.compromisedAt })
    .from(k)
    .where(eq(k.kid, key.kid));
  if (row) {
    if (row.compromisedAt) throw new SigningKeyRetiredError(key.kid, "compromised");
    if (row.retiredAt) throw new SigningKeyRetiredError(key.kid, "retired");
    return;
  }
  const inserted = await tx
    .insert(k)
    .values({ kid: key.kid, publicKey: key.publicKey, firstUsedAt: now })
    .onConflictDoNothing()
    .returning({ kid: k.kid });
  if (inserted.length === 0) return ensureSigningKey(tx, key, now);
  const retired = await tx
    .update(k)
    .set({ retiredAt: now })
    .where(and(ne(k.kid, key.kid), isNull(k.retiredAt)))
    .returning({ kid: k.kid });
  await audit(
    tx,
    {
      action: "integrity.key.rotate",
      subjectType: "integrity_signing_key",
      subjectId: key.kid,
      details: { kid: key.kid, retired: retired.map((r) => r.kid) },
    },
    now,
  );
}

interface EntryRow {
  id: string;
  seq: number;
  kind: AttestationKind;
  kid: string;
  payload: string;
  entryHash: string;
  breakdown: ByCategory;
  salt: string;
}

/** Append one entry under the chain lock the caller holds; returns its id. */
async function appendEntry(
  tx: Executor,
  opts: AttestationOptions,
  now: Date,
  b: { id: string; channelId: string },
  build: (chain: { seq: number; prevHash: string | null }) => Promise<{
    statement: AttestationStatement;
    breakdown: ByCategory;
    salt: string;
  }>,
): Promise<{ id: string; seq: number; kind: AttestationKind }> {
  const [head] = await tx
    .select({ seq: integrityAttestations.seq, entryHash: integrityAttestations.entryHash })
    .from(integrityAttestations)
    .where(eq(integrityAttestations.channelId, b.channelId))
    .orderBy(desc(integrityAttestations.seq))
    .limit(1);
  const chain = { seq: (head?.seq ?? 0) + 1, prevHash: head?.entryHash ?? null };
  const { statement, breakdown, salt } = await build(chain);
  await ensureSigningKey(tx, opts.key, now);
  const { signed, entryHash: hash } = await signAndCheck(opts.key, statement);
  const id = uuidv7(now.getTime());
  await tx.insert(integrityAttestations).values({
    id,
    channelId: b.channelId,
    broadcastId: b.id,
    seq: statement.seq,
    kind: statement.kind,
    kid: statement.kid,
    payload: signed.payload,
    signature: signed.signature,
    entryHash: hash,
    prevHash: statement.prevHash,
    supersedes: statement.supersedes,
    signedAt: now,
    breakdown,
    salt,
    createdAt: now,
  });
  await emit(
    tx,
    "integrity.attestation.appended",
    b.channelId,
    {
      attestation_id: id,
      channel_id: b.channelId,
      broadcast_id: b.id,
      seq: statement.seq,
      kind: statement.kind,
      kid: statement.kid,
    },
    now,
  );
  return { id, seq: statement.seq, kind: statement.kind };
}

/** Attest one broadcast (see the module comment). Exported for tests, which pass their own key. */
export async function attestBroadcast(
  ctx: Pick<WorkerContext, "db" | "logger" | "now">,
  data: IntegrityAttestationJob,
  opts: AttestationOptions,
): Promise<AnalyticsJobResult> {
  const [b] = await ctx.db
    .select({
      id: broadcasts.id,
      channelId: broadcasts.channelId,
      kind: broadcasts.kind,
      startedAt: broadcasts.startedAt,
      endedAt: broadcasts.endedAt,
    })
    .from(broadcasts)
    .where(eq(broadcasts.id, data.broadcastId));
  if (!b) return { missing: 1 };
  if (b.kind === "rehearsal") return { rehearsal: 1 };
  if (!b.endedAt) return { live: 1 };
  const period = { start: b.startedAt, end: b.endedAt };

  return ctx.db.transaction(async (tx): Promise<AnalyticsJobResult> => {
    await lockChain(tx, b.channelId);
    const now = ctx.now();
    const result: AnalyticsJobResult = {};
    const latestOf = async (): Promise<(EntryRow & { compromised: boolean }) | null> => {
      const [row] = await tx
        .select({
          id: integrityAttestations.id,
          seq: integrityAttestations.seq,
          kind: integrityAttestations.kind,
          kid: integrityAttestations.kid,
          payload: integrityAttestations.payload,
          entryHash: integrityAttestations.entryHash,
          breakdown: integrityAttestations.breakdown,
          salt: integrityAttestations.salt,
          compromisedAt: integritySigningKeys.compromisedAt,
        })
        .from(integrityAttestations)
        .innerJoin(integritySigningKeys, eq(integritySigningKeys.kid, integrityAttestations.kid))
        .where(eq(integrityAttestations.broadcastId, b.id))
        .orderBy(desc(integrityAttestations.seq))
        .limit(1);
      if (!row) return null;
      const { compromisedAt, ...rest } = row;
      return { ...rest, compromised: compromisedAt !== null };
    };

    let latest = await latestOf();
    if (latest?.compromised) {
      // Re-issue the original's statement as it was signed, under the current key and chain head.
      const original = decodeStatement(latest.payload);
      const replaced = latest;
      const out = await appendEntry(tx, opts, now, b, async (chain) => ({
        statement: AttestationStatement.parse({
          ...original,
          kind: "reissue",
          origin: opts.origin,
          kid: opts.key.kid,
          seq: chain.seq,
          prevHash: chain.prevHash,
          supersedes: replaced.entryHash,
          signedAt: now.toISOString(),
        }),
        breakdown: replaced.breakdown,
        salt: replaced.salt,
      }));
      result.reissued = 1;
      result.seq = out.seq;
      latest = await latestOf();
    }

    const [totals] = await tx
      .select()
      .from(broadcastAudienceTotals)
      .where(eq(broadcastAudienceTotals.broadcastId, b.id));
    if (!totals) return { ...result, notRolledUp: 1 };
    if (totals.minutesPurgedAt) return { ...result, final: 1 };
    const current = figuresFromRollup(totals);
    const kind = chooseKind(
      latest ? { figures: figuresOfStatement(decodeStatement(latest.payload), latest.breakdown) } : null,
      current,
    );
    if (kind === null) return { ...result, unchanged: 1 };

    const thresholds = await loadThresholds(tx);
    const tHash = await thresholdsHash(RULESET_VERSION, thresholds);
    const replaced = latest;
    const out = await appendEntry(tx, opts, now, b, async (chain) => {
      const salt = newReasonsSalt();
      return {
        statement: buildStatement({
          kind,
          origin: opts.origin,
          kid: opts.key.kid,
          channelId: b.channelId,
          broadcastId: b.id,
          seq: chain.seq,
          prevHash: chain.prevHash,
          supersedes: kind === "supersede" && replaced ? replaced.entryHash : null,
          periodStart: period.start,
          periodEnd: period.end,
          signedAt: now,
          rulesetVersion: RULESET_VERSION,
          thresholdsHash: tHash,
          reasonsCommitment: await reasonsCommitment(salt, current.breakdown),
          figures: current,
        }),
        breakdown: current.breakdown,
        salt,
      };
    });
    return { ...result, [kind === "broadcast" ? "attested" : "superseded"]: 1, seq: out.seq };
  });
}

/**
 * The daily pass (ADR 0014 decision 4). It enqueues, never signs itself:
 *
 * - a re-roll (reason `rescore`) for broadcasts with a session scored after their rollup ran;
 * - an attestation re-check for broadcasts never attested (whenever they were rolled up: a lost
 *   `analytics.rollup.ready`, jobs that ran out of attempts while the worker was down), for
 *   broadcasts re-rolled in the last two days and not attested since, and for broadcasts whose
 *   current entry is signed by a compromised key (a re-issue).
 *
 * Final broadcasts (per-minute rows gone) are only re-checked for a compromised key.
 */
export async function reconcileAttestations(
  ctx: Pick<WorkerContext, "db" | "enqueue" | "now">,
  batch = RECONCILE_BATCH,
): Promise<AnalyticsJobResult> {
  const now = ctx.now();
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  const t = broadcastAudienceTotals;
  const rescored = await ctx.db
    .select({ broadcastId: t.broadcastId })
    .from(t)
    .innerJoin(broadcasts, eq(broadcasts.id, t.broadcastId))
    .where(
      and(
        eq(broadcasts.kind, "live"),
        isNull(t.minutesPurgedAt),
        sql`exists (select 1 from ${playbackSessions} ps
                     where ps.broadcast_id = ${t.broadcastId} and ps.scored_at > ${t.rolledUpAt})`,
      ),
    )
    .limit(batch);
  const cutoff = new Date(now.getTime() - RECONCILE_LOOKBACK_MS);
  const unattested = await ctx.db
    .select({ broadcastId: t.broadcastId })
    .from(t)
    .innerJoin(broadcasts, eq(broadcasts.id, t.broadcastId))
    .where(
      and(
        eq(broadcasts.kind, "live"),
        isNull(t.minutesPurgedAt),
        // Never attested at all: no lookback, so a worker that was down (or had a retired key)
        // for longer than the window still signs those broadcasts. Signed before the latest
        // re-roll: only recent ones, since a re-roll that found the same figures appends nothing.
        or(
          sql`not exists (select 1 from ${integrityAttestations} a where a.broadcast_id = ${t.broadcastId})`,
          and(
            sql`${t.rolledUpAt} >= ${cutoff.toISOString()}::timestamptz`,
            sql`not exists (select 1 from ${integrityAttestations} a
                             where a.broadcast_id = ${t.broadcastId} and a.signed_at >= ${t.rolledUpAt})`,
          ),
        ),
      ),
    )
    .orderBy(asc(t.rolledUpAt))
    .limit(batch);
  const a = integrityAttestations;
  const compromised = await ctx.db
    .select({ broadcastId: a.broadcastId })
    .from(a)
    .innerJoin(integritySigningKeys, eq(integritySigningKeys.kid, a.kid))
    .where(
      and(
        sql`${integritySigningKeys.compromisedAt} is not null`,
        sql`${a.seq} = (select max(x.seq) from ${integrityAttestations} x where x.broadcast_id = ${a.broadcastId})`,
      ),
    )
    .limit(batch);

  for (const r of rescored)
    await ctx.enqueue(
      QUEUES.analytics,
      ANALYTICS_JOBS.broadcastRollup,
      { broadcastId: r.broadcastId, reason: "rescore" },
      { jobId: analyticsJobId(ANALYTICS_JOBS.broadcastRollup, r.broadcastId, `reconcile-${day}`) },
    );
  const recheck = new Set([...unattested, ...compromised].map((r) => r.broadcastId));
  for (const broadcastId of recheck)
    await ctx.enqueue(
      QUEUES.analytics,
      ANALYTICS_JOBS.integrityAttestation,
      { broadcastId, reason: "reconcile" },
      { jobId: analyticsJobId(ANALYTICS_JOBS.integrityAttestation, broadcastId, `reconcile-${day}`) },
    );
  return { rerolled: rescored.length, rechecked: recheck.size, compromised: compromised.length };
}

let envKey: Promise<AttestationSigningKey> | null = null;
/** `INTEGRITY_SIGNING_KEY` from the worker's env (validated at startup by `workerEnv`), imported once. */
export function envSigningKey(
  source: Record<string, string | undefined> = process.env,
): Promise<AttestationSigningKey> {
  envKey ??= importAttestationSigningKey(loadEnv(attestationEnv, source).INTEGRITY_SIGNING_KEY);
  return envKey;
}

function siteOrigin(site: InstanceSite | undefined): string {
  if (!site) throw new Error("integrity-attestation needs the instance site (WorkerContext.site)");
  return statementOrigin(site.publicUrl);
}

export const job = defineJob({
  queue: QUEUES.analytics,
  name: ANALYTICS_JOBS.integrityAttestation,
  description: "Append a signed attestation for a rolled-up broadcast when its figures are new or changed",
  data: IntegrityAttestationJob,
  attempts: 3,
  handler: async (data, ctx): Promise<AnalyticsJobResult> => {
    try {
      const out = await attestBroadcast(ctx, data, { key: await envSigningKey(), origin: siteOrigin(ctx.site) });
      ctx.logger.info("integrity attestation", { broadcastId: data.broadcastId, reason: data.reason, ...out });
      return out;
    } catch (err) {
      if (err instanceof SigningKeyRetiredError)
        ctx.logger.error("attestation refused: the signing key is no longer active", {
          broadcastId: data.broadcastId,
          alert: "attestation_key_retired",
        });
      throw err;
    }
  },
});

/** Daily: re-check broadcasts re-scored or re-rolled after their latest attestation entry. */
export const reconcileJob = defineJob({
  queue: QUEUES.analytics,
  name: ANALYTICS_JOBS.attestationReconcile,
  description: "Re-check broadcasts whose rollup changed after their latest attestation entry",
  data: AttestationReconcileJob,
  schedule: { pattern: "41 4 * * *" },
  handler: async (_data, ctx): Promise<AnalyticsJobResult> => {
    const out = await reconcileAttestations(ctx);
    ctx.logger.info("attestation reconcile", out);
    return out;
  },
});
