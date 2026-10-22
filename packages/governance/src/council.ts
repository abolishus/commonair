// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Creator council seating. The council is the top `size` streamers by contribution
 * over the eligibility window, among those with at least `minStreamingHours`
 * eligible hours. Contribution blends the same four components as patronage, with
 * the patronage weights: each component is normalized to the member's share of that
 * component's total among eligible candidates, so a score is a weighted sum of shares
 * in [0, 1].
 */
import { and, desc, eq, gt, lte, sql } from "drizzle-orm";
import { schema, uuidv7, type Database, type Executor } from "@commonair/db";
import { contributionInputs, type ContributionInput } from "./inputs.ts";
import { emitEvent, systemAudit } from "./outbox.ts";
import {
  contributionWeightsOf,
  councilConfigOf,
  loadSettings,
  type ContributionWeights,
  type CouncilConfig,
} from "./settings.ts";

export const COUNCIL_METHOD_VERSION = "council-2026.1";

export interface CouncilSeat {
  userId: string;
  rank: number;
  contributionScore: number;
}

export interface CouncilMethod {
  version: string;
  size: number;
  eligibilityWindowDays: number;
  minStreamingHours: number;
  weights: { revenue: number; streamingHours: number; relayBandwidth: number; viewerHours: number };
  normalization: "share_of_eligible_total";
  tieBreak: ["score desc", "eligibleHours desc", "userId asc"];
  candidates: number;
  eligible: number;
  totals: { revenueCents: number; eligibleHours: number; relayBytes: number; viewerHours: number };
  windowStart?: string;
  windowEnd?: string;
}

export interface CouncilSeating {
  seats: CouncilSeat[];
  method: CouncilMethod;
}

type Component = "revenueCents" | "eligibleHours" | "relayBytes" | "viewerHours";
const COMPONENTS: [Component, keyof CouncilMethod["weights"]][] = [
  ["revenueCents", "revenue"],
  ["eligibleHours", "streamingHours"],
  ["relayBytes", "relayBandwidth"],
  ["viewerHours", "viewerHours"],
];

const clean = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);

/** Pure seating: deterministic for the same inputs regardless of input order. */
export function seatCouncil(
  candidates: readonly ContributionInput[],
  config: Pick<CouncilConfig, "size" | "eligibilityWindowDays" | "minStreamingHours">,
  weights: Pick<ContributionWeights, "revenue" | "streamingHours" | "relayBandwidth" | "viewerHours">,
): CouncilSeating {
  // Sorted first so floating-point sums do not depend on input order.
  const eligible = candidates
    .filter((c) => clean(c.eligibleHours) >= config.minStreamingHours)
    .toSorted((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  const totals = { revenueCents: 0, eligibleHours: 0, relayBytes: 0, viewerHours: 0 };
  for (const c of eligible) for (const [k] of COMPONENTS) totals[k] += clean(c[k]);

  const scored = eligible.map((c) => {
    let score = 0;
    for (const [k, w] of COMPONENTS) if (totals[k] > 0) score += weights[w] * (clean(c[k]) / totals[k]);
    return { c, score };
  });
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      clean(b.c.eligibleHours) - clean(a.c.eligibleHours) ||
      (a.c.userId < b.c.userId ? -1 : a.c.userId > b.c.userId ? 1 : 0),
  );
  return {
    seats: scored
      .slice(0, config.size)
      .map((s, i) => ({ userId: s.c.userId, rank: i + 1, contributionScore: s.score })),
    method: {
      version: COUNCIL_METHOD_VERSION,
      size: config.size,
      eligibilityWindowDays: config.eligibilityWindowDays,
      minStreamingHours: config.minStreamingHours,
      weights: {
        revenue: weights.revenue,
        streamingHours: weights.streamingHours,
        relayBandwidth: weights.relayBandwidth,
        viewerHours: weights.viewerHours,
      },
      normalization: "share_of_eligible_total",
      tieBreak: ["score desc", "eligibleHours desc", "userId asc"],
      candidates: candidates.length,
      eligible: eligible.length,
      totals,
    },
  };
}

/** The UTC calendar month containing `now`. */
export function termWindow(now: Date): { startsAt: Date; endsAt: Date } {
  const startsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const endsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { startsAt, endsAt };
}

/** A term seated at `now` starts now and ends at the end of the UTC month. */
export function newTermWindow(now: Date): { startsAt: Date; endsAt: Date } {
  return { startsAt: new Date(now.getTime()), endsAt: termWindow(now).endsAt };
}

export type ReseatReason = "no_term" | "month_changed" | "vacancy" | "unfilled";

/** Seated members who are no longer active streamer members (their seats are vacant). */
export function councilVacancies(seated: readonly string[], activeStreamers: ReadonlySet<string>): string[] {
  return seated.filter((userId) => !activeStreamers.has(userId));
}

/**
 * Why a new term must be seated at `now`, or null when the current term stands: there is no
 * current term, the UTC month changed since it started, a seat fell vacant, or the term has
 * fewer than `size` seats while an active streamer member is not seated (`unfilled`: a term
 * seated before anyone qualified must not stay empty for the rest of the month).
 * `unfilled` is only a candidate: `recomputeCouncil` seats a new term only when the new
 * seating would fill more seats than the current one, so ineligible streamers cause no churn.
 */
export function reseatReason(
  current: { startsAt: Date; seated: readonly string[] } | null,
  now: Date,
  activeStreamers: ReadonlySet<string>,
  size: number,
): ReseatReason | null {
  if (!current) return "no_term";
  if (
    current.startsAt.getUTCFullYear() !== now.getUTCFullYear() ||
    current.startsAt.getUTCMonth() !== now.getUTCMonth()
  )
    return "month_changed";
  if (councilVacancies(current.seated, activeStreamers).length > 0) return "vacancy";
  if (current.seated.length < size) {
    const seated = new Set(current.seated);
    for (const userId of activeStreamers) if (!seated.has(userId)) return "unfilled";
  }
  return null;
}

export interface RecomputeResult {
  termId: string;
  created: boolean;
  /** Why a new term was seated; null when the current term stands. */
  reason: ReseatReason | null;
  seats: CouncilSeat[];
}

/** Active streamer-class members whose accounts are in good standing: the council candidates. */
async function activeStreamers(tx: Executor): Promise<Set<string>> {
  const rows = await tx
    .selectDistinct({ userId: schema.memberships.userId })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(
      and(
        eq(schema.memberships.class, "streamer"),
        eq(schema.memberships.status, "active"),
        sql`${schema.users.deletedAt} is null`,
        eq(schema.users.banned, false),
      ),
    );
  return new Set(rows.map((r) => r.userId));
}

/**
 * Seat a new council term when one is due (`reseatReason`), otherwise return the current term.
 * The current term is the latest by `computed_at` whose window contains `now`, as the council
 * response trigger reads it. Terms and seats are append-only; the seats go in the term's own
 * transaction (trigger), with the `council.recompute` audit row and the `coop.council.recomputed`
 * event. Concurrent calls are serialized by an advisory lock, so one due reseat makes one term.
 */
export async function recomputeCouncil(db: Database, now: Date): Promise<RecomputeResult> {
  return db.transaction(async (tx) => {
    // council_terms has no unique key on the window: serialize recomputes instead.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('commonair:council-recompute'))`);
    const [current] = await tx
      .select({ id: schema.councilTerms.id, startsAt: schema.councilTerms.startsAt })
      .from(schema.councilTerms)
      .where(and(lte(schema.councilTerms.startsAt, now), gt(schema.councilTerms.endsAt, now)))
      .orderBy(desc(schema.councilTerms.computedAt), desc(schema.councilTerms.id))
      .limit(1);
    const currentSeats = current
      ? await tx
          .select({
            userId: schema.councilMembers.userId,
            rank: schema.councilMembers.rank,
            contributionScore: schema.councilMembers.contributionScore,
          })
          .from(schema.councilMembers)
          .where(eq(schema.councilMembers.termId, current.id))
          .orderBy(schema.councilMembers.rank)
      : [];
    const streamers = await activeStreamers(tx);
    const seated = currentSeats.map((s) => s.userId);
    const settings = await loadSettings(tx);
    const config = councilConfigOf(settings);
    const reason = reseatReason(current ? { startsAt: current.startsAt, seated } : null, now, streamers, config.size);
    const stand = (termId: string): RecomputeResult => ({ termId, created: false, reason: null, seats: currentSeats });
    if (current && reason === null) return stand(current.id);

    const weights = contributionWeightsOf(settings);
    const windowStart = new Date(now.getTime() - config.eligibilityWindowDays * 86_400_000);
    const inputs = await contributionInputs(tx, windowStart, now, weights.dailyStreamingHourCap);
    const candidates = [...streamers].map(
      (userId) => inputs.get(userId) ?? { userId, revenueCents: 0, eligibleHours: 0, relayBytes: 0, viewerHours: 0 },
    );
    const seating = seatCouncil(candidates, config, weights);
    const method = { ...seating.method, windowStart: windowStart.toISOString(), windowEnd: now.toISOString() };
    // An unfilled term is re-seated only when more seats would be filled (no daily churn while
    // the unseated streamers are not eligible).
    if (current && reason === "unfilled" && seating.seats.length <= seated.length) return stand(current.id);
    const { startsAt, endsAt } = newTermWindow(now);

    // The trigger stamps computed_at and txid; seats are accepted only in this transaction.
    const termId = uuidv7(now.getTime());
    await tx
      .insert(schema.councilTerms)
      .values({ id: termId, startsAt, endsAt, method: method as unknown as Record<string, unknown> });
    if (seating.seats.length > 0) {
      await tx.insert(schema.councilMembers).values(seating.seats.map((s) => ({ termId, ...s })));
    }
    await systemAudit(
      tx,
      {
        action: "council.recompute",
        subjectType: "council_term",
        subjectId: termId,
        reason: "scheduled creator council recompute",
        details: {
          trigger: reason ?? "no_term",
          previousTermId: current?.id ?? null,
          vacated: councilVacancies(seated, streamers),
          seats: seating.seats.map((s) => s.userId),
          method: method as unknown as Record<string, unknown>,
        },
      },
      now,
    );
    await emitEvent(tx, "coop.council.recomputed", { term_id: termId, seats: seating.seats.length }, now);
    return { termId, created: true, reason: reason ?? "no_term", seats: seating.seats };
  });
}
