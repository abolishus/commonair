// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Group exclusion appeals (W2b-group-appeals, ADR 0014 decision 4, batch 6 decision (m)): subject
 * `exclusion_group` = one `EXCLUSION_CATEGORIES` category within one broadcast (`subject_id` is the
 * broadcast, `appeals.exclusion_category` the category). `../routes/appeals.ts` calls these two
 * functions and nothing else for that subject. Contract-step stubs until the unit implements them:
 * creating one answers HTTP 501, so none can exist to resolve yet.
 */
import type { APPEAL_STATUSES, ExclusionCategory } from "@commonair/contracts/enums";
import type { Executor, schema } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { notImplemented } from "../lib/errors.ts";

type AppealRow = typeof schema.appeals.$inferSelect;

export interface GroupAppealInput {
  appellantId: string;
  broadcastId: string;
  category: ExclusionCategory;
  body: string;
}

/**
 * `appeals.create` for `exclusion_group`, in place of the generic subject check and insert:
 * ownership (NOT_FOUND otherwise), the broadcast's gates (live kind, ended, past the display
 * delay, rolled up, group shown), the rate limits and the insert. Returns the inserted row.
 */
export async function createGroupAppeal(_deps: Deps, _input: GroupAppealInput): Promise<AppealRow> {
  notImplemented();
}

export interface GroupAppealDecision {
  status: Exclude<(typeof APPEAL_STATUSES)[number], "open">;
  staffId: string;
  decidedAt: Date;
}

/**
 * `appeals.resolve` for `exclusion_group`, inside the resolve transaction after the appeal row is
 * updated: an overturn re-scores the covered sessions and writes the re-run event; an upheld
 * appeal changes nothing. Returns extra ids-and-enums details for the `appeal.resolve` audit row.
 */
export async function onGroupAppealResolved(
  _tx: Executor,
  _appeal: AppealRow,
  decision: GroupAppealDecision,
): Promise<Record<string, string | number | boolean | null>> {
  if (decision.status !== "overturned") return {};
  notImplemented();
}
