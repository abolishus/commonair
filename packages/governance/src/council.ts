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
import { and, eq, sql } from "drizzle-orm";
import { schema, type Database } from "@commonair/db";
import { contributionInputs, type ContributionInput } from "./inputs.ts";
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
  const eligible = candidates.filter((c) => clean(c.eligibleHours) >= config.minStreamingHours);
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

/** The council term containing `now`: the UTC calendar month (matches the monthly recompute schedule). */
export function termWindow(now: Date): { startsAt: Date; endsAt: Date } {
  const startsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const endsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { startsAt, endsAt };
}

export interface RecomputeResult {
  termId: string;
  created: boolean;
  seats: CouncilSeat[];
}

/**
 * Seat the council for the term containing `now`, once. A second call in the same
 * term returns the existing term unchanged (idempotent per term window), so retries
 * and duplicate schedules are harmless. Candidates are active streamer-class members.
 */
export async function recomputeCouncil(db: Database, now: Date): Promise<RecomputeResult> {
  return db.transaction(async (tx) => {
    // Serialize concurrent recomputes; council_terms has no unique key on the window.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('commonair:council-recompute'))`);
    const { startsAt, endsAt } = termWindow(now);
    const [existing] = await tx
      .select({ id: schema.councilTerms.id })
      .from(schema.councilTerms)
      .where(and(eq(schema.councilTerms.startsAt, startsAt), eq(schema.councilTerms.endsAt, endsAt)))
      .limit(1);
    if (existing) {
      const seats = await tx
        .select({
          userId: schema.councilMembers.userId,
          rank: schema.councilMembers.rank,
          contributionScore: schema.councilMembers.contributionScore,
        })
        .from(schema.councilMembers)
        .where(eq(schema.councilMembers.termId, existing.id))
        .orderBy(schema.councilMembers.rank);
      return { termId: existing.id, created: false, seats };
    }

    const settings = await loadSettings(tx);
    const config = councilConfigOf(settings);
    const weights = contributionWeightsOf(settings);
    const windowStart = new Date(now.getTime() - config.eligibilityWindowDays * 86_400_000);
    const inputs = await contributionInputs(tx, windowStart, now, weights.dailyStreamingHourCap);
    const streamers = await tx
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
    const candidates = streamers.map(
      (s) =>
        inputs.get(s.userId) ?? { userId: s.userId, revenueCents: 0, eligibleHours: 0, relayBytes: 0, viewerHours: 0 },
    );
    const seating = seatCouncil(candidates, config, weights);
    const method = { ...seating.method, windowStart: windowStart.toISOString(), windowEnd: now.toISOString() };

    const [term] = await tx
      .insert(schema.councilTerms)
      .values({ computedAt: now, startsAt, endsAt, method: method as unknown as Record<string, unknown> })
      .returning({ id: schema.councilTerms.id });
    if (!term) throw new Error("council term insert returned no row");
    if (seating.seats.length > 0) {
      await tx.insert(schema.councilMembers).values(seating.seats.map((s) => ({ termId: term.id, ...s })));
    }
    await tx.insert(schema.auditLog).values({
      actorType: "system",
      action: "council.recompute",
      subjectType: "council_term",
      subjectId: term.id,
      reason: "scheduled creator council recompute",
      details: { seats: seating.seats.map((s) => s.userId), method: method as unknown as Record<string, unknown> },
    });
    return { termId: term.id, created: true, seats: seating.seats };
  });
}
