// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The signed standing statement a bundle carries (ADR 0037 decision 4, batch 7 decision (n)): what
 * this instance says about the channel's moderation standing, bound to the bundle it travels in.
 *
 * - **Facts** (`standingFacts`): `channels.suspended_at`; an unreleased `legal_holds` row on the
 *   owner; upheld platform actions in the 12 months before `issuedAt`, by tier; DMCA strikes
 *   (`account_actions`, not reversed) in the same window. "Upheld" means:
 *   - a `moderation_cases` row of the channel (or its owner) resolved `actioned`, `confirmed` or
 *     still `labelled` (a T2 label not overturned), counted under its own tier;
 *   - a platform `mod_actions` row with a `rule_ref` against the channel or its owner that no case
 *     produced (report-driven actions) and no appeal overturned, counted as `t1` (a human platform
 *     decision, as the T1 review queue is).
 * - **Key** (`PORTABILITY_SIGNING_KEY`, worker only): published to `portability_signing_keys` on
 *   first use (and by `ensurePortabilityKeyPublished` on worker start), retiring any other active
 *   key in the same transaction, as attestation keys are (ADR 0014 decision 1).
 *
 * Counts and flags only: no names, no reasons, no user ids (ADR 0004).
 */
import { loadEnv, portabilityEnv } from "@commonair/config";
import type { PortabilityBundle } from "@commonair/contracts/portability";
import { type Database, type Executor, schema } from "@commonair/db";
import {
  type SignedStanding,
  type StandingSigningKey,
  StandingStatement,
  STANDING_VERSION,
  importStandingSigningKey,
  signStanding,
  standingBundleDigest,
  standingExpiry,
  verifyStanding,
} from "@commonair/tokens/standing";
import { and, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { audit } from "../moderation/records.ts";

const { channels, legalHolds, moderationCases, modActions, accountActions, appeals, portabilitySigningKeys } = schema;

export interface StandingFacts {
  activeSuspension: boolean;
  legalHold: boolean;
  upheldActions: { t0: number; t1: number; t2: number };
  dmcaStrikes: number;
}

/** The start of the counting window: 12 calendar months before `issuedAt`, UTC. */
export function standingWindowStart(issuedAt: Date): Date {
  const d = new Date(issuedAt.getTime());
  d.setUTCMonth(d.getUTCMonth() - 12);
  return d;
}

/** Case statuses that mean the platform's decision stood. */
export const UPHELD_CASE_STATUSES = ["actioned", "confirmed", "labelled"] as const;

/** Platform actions that restrict (their reversals, `unban`, `restore_content`, …, are not counted). */
export const RESTRICTIVE_PLATFORM_ACTIONS = [
  "ban",
  "timeout",
  "delete_message",
  "suspend_channel",
  "suspend_user",
  "remove_content",
  "end_stream",
  "warn",
] as const;

/** Read the facts about one channel (and its owner) as of `issuedAt`. */
export async function standingFacts(db: Executor, channelId: string, issuedAt: Date): Promise<StandingFacts> {
  const [c] = await db
    .select({ ownerId: channels.ownerId, suspendedAt: channels.suspendedAt })
    .from(channels)
    .where(eq(channels.id, channelId));
  if (!c) throw new Error("standing for a channel that does not exist");
  const since = standingWindowStart(issuedAt);
  const [hold] = await db
    .select({ id: legalHolds.id })
    .from(legalHolds)
    .where(and(eq(legalHolds.userId, c.ownerId), isNull(legalHolds.releasedAt)))
    .limit(1);
  const cases = await db
    .select({ tier: moderationCases.tier, n: sql<number>`count(*)::int` })
    .from(moderationCases)
    .where(
      and(
        or(eq(moderationCases.channelId, channelId), eq(moderationCases.userId, c.ownerId)),
        inArray(moderationCases.status, [...UPHELD_CASE_STATUSES]),
        // A raw expression: the bound must be a string (postgres.js does not map a Date here).
        sql`coalesce(${moderationCases.resolvedAt}, ${moderationCases.createdAt}) >= ${since.toISOString()}::timestamptz`,
      ),
    )
    .groupBy(moderationCases.tier);
  const upheld = { t0: 0, t1: 0, t2: 0 };
  for (const r of cases) upheld[r.tier] += Number(r.n);
  const [actions] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(modActions)
    .where(
      and(
        eq(modActions.scope, "platform"),
        inArray(modActions.action, [...RESTRICTIVE_PLATFORM_ACTIONS]),
        sql`${modActions.ruleRef} is not null`,
        or(eq(modActions.channelId, channelId), eq(modActions.targetUserId, c.ownerId)),
        gte(modActions.createdAt, since),
        or(isNull(modActions.subjectType), ne(modActions.subjectType, "moderation_case")),
        sql`not exists (select 1 from ${appeals} where ${appeals.subjectType} = 'mod_action'
          and ${appeals.subjectId} = ${modActions.id} and ${appeals.status} = 'overturned')`,
      ),
    );
  upheld.t1 += Number(actions?.n ?? 0);
  const [strikes] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(accountActions)
    .where(
      and(
        eq(accountActions.userId, c.ownerId),
        eq(accountActions.action, "dmca_strike"),
        isNull(accountActions.reversedAt),
        gte(accountActions.createdAt, since),
      ),
    );
  return {
    activeSuspension: c.suspendedAt !== null,
    legalHold: hold !== undefined,
    upheldActions: upheld,
    dmcaStrikes: Number(strikes?.n ?? 0),
  };
}

/** Build the statement for a bundle (its `standing` is ignored: the digest is over it set to null). */
export async function buildStatement(input: {
  key: Pick<StandingSigningKey, "kid">;
  issuer: string;
  channelId: string;
  bundle: PortabilityBundle;
  facts: StandingFacts;
  issuedAt: Date;
}): Promise<StandingStatement> {
  const issuedAt = new Date(Math.floor(input.issuedAt.getTime())).toISOString();
  return StandingStatement.parse({
    v: STANDING_VERSION,
    issuer: input.issuer,
    kid: input.key.kid,
    channelId: input.channelId,
    bundleSha256: await standingBundleDigest(input.bundle),
    issuedAt,
    expiresAt: standingExpiry(issuedAt),
    activeSuspension: input.facts.activeSuspension,
    legalHold: input.facts.legalHold,
    upheldActions: input.facts.upheldActions,
    dmcaStrikes: input.facts.dmcaStrikes,
  });
}

/** Sign and check the signature against the key's own public half before it leaves the worker. */
export async function signStatement(key: StandingSigningKey, statement: StandingStatement): Promise<SignedStanding> {
  const signed = await signStanding(key, statement);
  const check = await verifyStanding(signed, key.publicKey, new Date(Date.parse(statement.issuedAt)));
  if (!check.ok) throw new Error(`standing statement failed its own verification: ${check.error}`);
  return signed;
}

export class PortabilityKeyRetiredError extends Error {
  constructor(kid: string, state: "retired" | "compromised") {
    super(`portability signing key ${kid} is ${state}; restart the worker with the current PORTABILITY_SIGNING_KEY`);
    this.name = "PortabilityKeyRetiredError";
  }
}

/**
 * The signing key's row, inserted on first use; inserting it retires every other active key (an
 * `audit_log` row records the rotation). A retired or compromised key throws: nothing it signs
 * would verify anywhere.
 */
export async function ensurePortabilityKey(tx: Executor, key: StandingSigningKey, now: Date): Promise<void> {
  const k = portabilitySigningKeys;
  const [row] = await tx
    .select({ retiredAt: k.retiredAt, compromisedAt: k.compromisedAt })
    .from(k)
    .where(eq(k.kid, key.kid));
  if (row) {
    if (row.compromisedAt) throw new PortabilityKeyRetiredError(key.kid, "compromised");
    if (row.retiredAt) throw new PortabilityKeyRetiredError(key.kid, "retired");
    return;
  }
  const inserted = await tx
    .insert(k)
    .values({ kid: key.kid, publicKey: key.publicKey, firstUsedAt: now })
    .onConflictDoNothing()
    .returning({ kid: k.kid });
  if (inserted.length === 0) return ensurePortabilityKey(tx, key, now);
  const retired = await tx
    .update(k)
    .set({ retiredAt: now })
    .where(and(ne(k.kid, key.kid), isNull(k.retiredAt)))
    .returning({ kid: k.kid });
  await audit(
    tx,
    {
      action: "portability.key.rotate",
      subjectType: "portability_signing_key",
      subjectId: key.kid,
      details: { kid: key.kid, retired: retired.map((r) => r.kid) },
    },
    now,
  );
}

let envKey: Promise<StandingSigningKey> | null = null;
/** `PORTABILITY_SIGNING_KEY` from the worker's env (validated at start-up by `workerEnv`), imported once. */
export function envPortabilityKey(
  source: Record<string, string | undefined> = process.env,
): Promise<StandingSigningKey> {
  envKey ??= importStandingSigningKey(loadEnv(portabilityEnv, source).PORTABILITY_SIGNING_KEY);
  return envKey;
}

/**
 * For worker start (the attestation-key pattern): publish the current key so
 * `/.well-known/commonair-portability` lists it before the first bundle is signed.
 */
export async function ensurePortabilityKeyPublished(db: Database, now: Date): Promise<void> {
  const key = await envPortabilityKey();
  await db.transaction((tx) => ensurePortabilityKey(tx, key, now));
}

/** The issuer origin a statement names: the instance's public origin. */
export const issuerOrigin = (publicUrl: string): string => new URL(publicUrl).origin;
