// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * T1 restriction (docs/testing/e4c-selectors.md "T1 live"): a restricted broadcast is left out of
 * every list, and wherever it is shown on its own it reads `restricted: "under_review"` with no
 * thumbnail. Set by the worker; lifted only together with the case that holds it.
 */
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { schema, type Executor } from "@commonair/db";
import { emit } from "../events/outbox.ts";
import type { BroadcastSummary } from "../lib/dto.ts";

const { broadcasts } = schema;

/** Lift the T1 restriction a case holds on its broadcast; emits `moderation.restriction` false. */
export async function liftRestrictionInTx(tx: Executor, caseId: string): Promise<boolean> {
  const lifted = await tx
    .update(broadcasts)
    .set({ restrictedAt: null, restrictedCaseId: null })
    .where(eq(broadcasts.restrictedCaseId, caseId))
    .returning({ id: broadcasts.id, channelId: broadcasts.channelId });
  for (const b of lifted)
    await emit(tx, "moderation.restriction", b.channelId, {
      broadcast_id: b.id,
      channel_id: b.channelId,
      case_id: caseId,
      restricted: false,
    });
  return lifted.length > 0;
}

/** Ids of the given broadcasts that are restricted right now. */
export async function restrictedIds(db: Executor, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: broadcasts.id })
    .from(broadcasts)
    .where(and(inArray(broadcasts.id, [...ids]), isNotNull(broadcasts.restrictedAt)));
  return new Set(rows.map((r) => r.id));
}

/** The summary as the public sees it: restricted → `under_review`, no thumbnail. */
export const withRestriction = (s: BroadcastSummary, restricted: boolean): BroadcastSummary =>
  restricted ? { ...s, restricted: "under_review", thumbnailUrl: null } : { ...s, restricted: null };
