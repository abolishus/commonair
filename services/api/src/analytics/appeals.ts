// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Group exclusion appeals (W2b-group-appeals, ADR 0014 decision 4, batch 6 decision (m)): subject
 * `exclusion_group` = one `EXCLUSION_CATEGORIES` category within one broadcast (`subject_id` is the
 * broadcast, `appeals.exclusion_category` the category). `../routes/appeals.ts` calls these two
 * functions and nothing else for that subject.
 *
 * Create: the caller owns the broadcast's channel (anything else is NOT_FOUND, like any subject
 * that does not concern the caller); the broadcast is a live one, ended, past the 24 h display
 * delay (or the harness bypass) and rolled up (`analytics_pending` otherwise); the group is shown
 * (at least `ANALYTICS_RULES.minGroupSessions` sessions; a hidden group is NOT_FOUND, so an appeal
 * cannot probe the size of a group analytics hides). Rate limit: one group appeal per broadcast,
 * any category and status, and `GROUP_APPEAL_RULES.perChannel` per channel in a rolling
 * `windowDays`, checked and inserted under a transaction-scoped advisory lock on the channel so two
 * concurrent creates cannot both pass. Refusals are `RATE_LIMITED` with `retryAfterSeconds`.
 *
 * Resolve: an overturn re-scores the covered sessions in the resolve transaction
 * (`rescoreExclusionGroup`, which writes the flags, audit rows and the rollup re-run event); an
 * upheld appeal changes nothing but still counts against the limits.
 */
import {
  ANALYTICS_RULES,
  type APPEAL_STATUSES,
  type ExclusionCategory,
  GROUP_APPEAL_RULES,
} from "@commonair/contracts/enums";
import { type Executor, schema } from "@commonair/db";
import { rescoreExclusionGroup } from "@commonair/integrity";
import { and, asc, count, eq, gt, sql } from "drizzle-orm";
import type { Deps } from "../deps.ts";
import { notFound, rateLimited } from "../lib/errors.ts";
import { analyticsDisplayBypassed } from "../ops/analytics-hooks.ts";
import { pending } from "./queries.ts";
import { displayable } from "./rules.ts";

type AppealRow = typeof schema.appeals.$inferSelect;
const { appeals, broadcasts, channels, broadcastAudienceTotals: totalsT } = schema;

const DAY_MS = 86_400_000;
export const GROUP_APPEAL_WINDOW_MS = GROUP_APPEAL_RULES.windowDays * DAY_MS;

export interface GroupAppealInput {
  appellantId: string;
  broadcastId: string;
  category: ExclusionCategory;
  body: string;
}

export type GroupAppealLimit = { ok: true } | { ok: false; limit: "broadcast" | "channel"; retryAfterSeconds: number };

/**
 * The rate-limit decision (decision (m)), pure. `broadcastAppeals` counts every group appeal on the
 * broadcast, any status; `channelWindow` holds the creation times of the channel's group appeals
 * in the window (`createdAt > now - windowDays`: one exactly `windowDays` old has left it).
 *
 * The per-broadcast limit never frees: its refusal carries the whole window, the soonest a client
 * should ask again about anything on that channel's appeals (the page says "already appealed"
 * from the appeal itself). The channel limit frees when the oldest appeal in the window leaves it.
 */
export function groupAppealLimit(q: {
  broadcastAppeals: number;
  channelWindow: readonly Date[];
  now: Date;
}): GroupAppealLimit {
  if (q.broadcastAppeals >= GROUP_APPEAL_RULES.perBroadcast)
    return { ok: false, limit: "broadcast", retryAfterSeconds: GROUP_APPEAL_WINDOW_MS / 1000 };
  const inWindow = q.channelWindow
    .map((d) => d.getTime())
    .filter((t) => t > q.now.getTime() - GROUP_APPEAL_WINDOW_MS)
    .sort((a, b) => a - b);
  if (inWindow.length < GROUP_APPEAL_RULES.perChannel) return { ok: true };
  // The appeal that must leave the window before one more fits.
  const freeing = inWindow[inWindow.length - GROUP_APPEAL_RULES.perChannel] as number;
  const ms = freeing + GROUP_APPEAL_WINDOW_MS - q.now.getTime();
  return { ok: false, limit: "channel", retryAfterSeconds: Math.max(1, Math.ceil(ms / 1000)) };
}

/** Whether analytics shows this group (the same threshold as `suppressGroups`). */
export const groupShown = (sessions: number | undefined): boolean =>
  (sessions ?? 0) >= ANALYTICS_RULES.minGroupSessions;

/**
 * `appeals.create` for `exclusion_group`, in place of the generic subject check and insert:
 * ownership (NOT_FOUND otherwise), the broadcast's gates (live kind, ended, past the display
 * delay, rolled up, group shown), the rate limits and the insert. Returns the inserted row.
 */
export async function createGroupAppeal(deps: Deps, input: GroupAppealInput): Promise<AppealRow> {
  const now = deps.now();
  const [b] = await deps.db
    .select({ id: broadcasts.id, channelId: broadcasts.channelId, endedAt: broadcasts.endedAt })
    .from(broadcasts)
    .innerJoin(channels, eq(channels.id, broadcasts.channelId))
    .where(
      and(eq(broadcasts.id, input.broadcastId), eq(broadcasts.kind, "live"), eq(channels.ownerId, input.appellantId)),
    );
  if (!b) throw notFound("Nothing to appeal was found");
  if (!b.endedAt) throw pending();
  if (!displayable(b.endedAt, now, await analyticsDisplayBypassed(deps, b.channelId))) throw pending();
  const [t] = await deps.db
    .select({ byCategory: totalsT.excludedSessionsByCategory })
    .from(totalsT)
    .where(eq(totalsT.broadcastId, b.id));
  if (!t) throw pending();
  if (!groupShown(t.byCategory[input.category])) throw notFound("Nothing to appeal was found");

  return deps.db.transaction(async (tx) => {
    // Serializes the count and the insert per channel: two creates cannot both see room.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`group-appeals:${b.channelId}`}, 0))`);
    const [onBroadcast] = await tx
      .select({ n: count() })
      .from(appeals)
      .where(and(eq(appeals.subjectType, "exclusion_group"), eq(appeals.subjectId, b.id)));
    const window = await tx
      .select({ createdAt: appeals.createdAt })
      .from(appeals)
      .innerJoin(broadcasts, eq(broadcasts.id, appeals.subjectId))
      .where(
        and(
          eq(appeals.subjectType, "exclusion_group"),
          eq(broadcasts.channelId, b.channelId),
          gt(appeals.createdAt, new Date(now.getTime() - GROUP_APPEAL_WINDOW_MS)),
        ),
      )
      .orderBy(asc(appeals.createdAt));
    const limit = groupAppealLimit({
      broadcastAppeals: onBroadcast?.n ?? 0,
      channelWindow: window.map((w) => w.createdAt),
      now,
    });
    if (!limit.ok) throw rateLimited(limit.retryAfterSeconds);
    const [row] = await tx
      .insert(appeals)
      .values({
        appellantId: input.appellantId,
        kind: "integrity",
        subjectType: "exclusion_group",
        subjectId: b.id,
        exclusionCategory: input.category,
        // The appellant's words stay on the (mutable) appeal row only.
        body: input.body,
        ruleRef: null,
        createdAt: now,
      })
      .returning();
    if (!row) throw new Error("group appeal insert returned no row");
    return row;
  });
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
  tx: Executor,
  appeal: AppealRow,
  decision: GroupAppealDecision,
): Promise<Record<string, string | number | boolean | null>> {
  const category = appeal.exclusionCategory;
  // The `appeals_exclusion_category` CHECK guarantees it for this subject.
  if (category === null) throw new Error("exclusion_group appeal without a category");
  if (decision.status !== "overturned") return { exclusionCategory: category };
  const r = await rescoreExclusionGroup(tx, {
    broadcastId: appeal.subjectId,
    category,
    decidedAt: decision.decidedAt,
    decidedById: decision.staffId,
    appealId: appeal.id,
  });
  return { exclusionCategory: category, rescored: r.rescored, restored: r.restored };
}
