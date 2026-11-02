// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** seed-safety: reports, moderation cases, appeals, enforcement, DMCA, NCII, legal holds, incidents and privacy requests. Brief: `.claude/briefs/seed-full/seed-safety.md`. */
import type { DbHandle } from "@commonair/db";
import { internalSecret } from "../safety-io.ts";
import { countDelta, mediaInputs, ncmecRefusal, planSafety } from "./safety/plan.ts";
import { runSafety } from "./safety/run.ts";
import type { SeedUnit } from "./types.ts";

const TABLES = [
  "reports",
  "mod_actions",
  "moderation_cases",
  "moderation_flags",
  "content_labels",
  "evidence_objects",
  "evidence_audit_runs",
  "hash_match_results",
  "local_hash_list",
  "ncmec_reports",
  "ncii_requests",
  "ncii_request_items",
  "appeals",
  "account_actions",
  "enforcement_statements",
  "enforcement_statement_deliveries",
  "dmca_notices",
  "dmca_notice_items",
  "dmca_counter_notices",
  "integrity_flags",
  // W2b-attestations (ADR 0014).
  "integrity_signing_keys",
  "integrity_attestations",
  "attestation_share_links",
  "legal_holds",
  "incidents",
  "data_exports",
  "account_deletions",
] as const;

/**
 * Written by seed-media's swarm recording, which this unit only reads (its brief): not counted as
 * this unit's rows.
 */
const READ_ONLY: ReadonlySet<string> = new Set(["integrity_flags"]);

/** Every table is seeded: `evidence_audit_runs` comes from the evidence-audit ops tick. */
const PENDING = [] as const;

/**
 * Rows in each owned table now. The unit reports the change across its run, since earlier units
 * write some of these tables too (seed-social inserts mod_actions).
 */
export async function tableCounts(h: DbHandle): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES) {
    if (READ_ONLY.has(t)) continue;
    const [row] = await h.sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${t}`);
    out[t] = Number(row?.n ?? 0);
  }
  return out;
}

export const unit: SeedUnit = {
  name: "safety",
  // media: clips, VODs and recordings are the subjects of DMCA notices and attestations.
  after: ["social", "media"],
  tables: TABLES,
  pending: PENDING,
  async run(ctx) {
    const refusal = ncmecRefusal(process.env);
    if (refusal) throw new Error(refusal);
    const secret = internalSecret(ctx.env);
    if (!secret)
      throw new Error(
        "seed-safety: INTERNAL_API_SECRET is not set (HARNESS_INTERNAL_API_SECRET or the repo .env): the test hooks need it",
      );
    const before = await tableCounts(ctx.db);
    const s1 = ctx.store.channels.find((c) => c.ownerHandle === "streamer1");
    const media = mediaInputs(ctx.store.extra.media, s1?.id ?? null);
    const plan = planSafety(ctx.rng, ctx.scale, { store: ctx.store, ...media });
    const result = await runSafety(ctx, plan, secret);
    ctx.store.extra.safety = { ...result.extra };
    return { rows: countDelta(before, await tableCounts(ctx.db)), notes: result.notes };
  },
};
