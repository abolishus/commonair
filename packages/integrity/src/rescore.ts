// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Re-scoring an overturned exclusion group (ADR 0014 decision 4, batch 6 decision (m)). Stub from
 * the W2 contract step; W2b-group-appeals implements it. Evidence in Valkey is gone by then, so it
 * re-scores from stored data: for each ended session of the broadcast whose category
 * (`exclusionCategoryOf`) is the appealed one and that started before `decidedAt`, drop that
 * category's signal codes from `verdict_reasons`; verified (or pending) when no exclusion signal
 * remains, with `allowed_on_appeal`; still excluded, in its next category, when one does. It
 * writes `integrity_flags` and `audit_log` rows like the existing overturn path, and the
 * `integrity.sessions.rescored` outbox event in the same transaction (the worker then re-runs the
 * rollup, whose `analytics.rollup.ready` drives the attestation re-check).
 */
import type { ExclusionCategory } from "@commonair/contracts/enums";
import type { Executor } from "@commonair/db";

export interface RescoreExclusionGroupInput {
  broadcastId: string;
  category: ExclusionCategory;
  /** The overturn's decision time; sessions started after it are never touched. */
  decidedAt: Date;
}

export interface RescoreExclusionGroupResult {
  /** Sessions whose verdict or reasons changed. */
  rescored: number;
  /** Of those, now verified or pending (no exclusion signal left). */
  restored: number;
}

/** Runs inside the caller's transaction (`appeals.resolve`). */
export async function rescoreExclusionGroup(
  _tx: Executor,
  _input: RescoreExclusionGroupInput,
): Promise<RescoreExclusionGroupResult> {
  throw new Error("rescoreExclusionGroup is not implemented yet (W2b-group-appeals)");
}
