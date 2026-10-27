// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `audit_log.details` shapes the statements-of-reasons builder reads (ADR 0019 decision 5).
 * They are an internal contract with the action writers (`moderation/scan.ts`, `t0.ts`,
 * `ncii-clock.ts` here; `services/api/src/moderation/uploads.ts`, `routes/moderation.ts`,
 * `routes/ncii.ts` in the API): each schema names only the fields the builder needs, so a writer
 * adding fields changes nothing, and a writer dropping or renaming one makes the row fail to
 * parse loudly (skipped, `sor_build_failures_total{action}`, logged by audit id) instead of
 * producing a wrong statement. Fixtures copied from each writer's current shape are in
 * `tests/moderation-sor.test.ts`.
 */
import {
  ENFORCEMENT_SOURCE_ACTIONS,
  HASH_LIST_CATEGORIES,
  MODERATION_CATEGORIES,
  MODERATION_SUBJECTS,
  NCII_DECISIONS,
} from "@commonair/contracts/enums";
import { schema } from "@commonair/db";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

export type SourceAction = (typeof ENFORCEMENT_SOURCE_ACTIONS)[number];

const id = z.uuid();
const category = z.enum(MODERATION_CATEGORIES);

const t1Restrict = z.object({
  caseId: id,
  flagId: id,
  broadcastId: id,
  tier: z.literal("t1"),
  category,
});
const t2Label = z.object({
  caseId: id,
  flagId: id,
  labelId: id,
  broadcastId: id,
  tier: z.literal("t2"),
  category: z.literal("sexual"),
});
const uploadReject = z.object({
  caseId: id,
  flagId: id,
  subjectType: z.literal("upload"),
  subjectId: id,
  userId: id,
  tier: z.literal("t1"),
  category,
});
const caseWarn = z.object({ caseId: id, decision: z.literal("warn") });
// The writer ends a stream only for a broadcast case that is still live (`plan.endStream`).
const caseEndStream = z.object({ caseId: id, decision: z.literal("end_stream"), streamEnded: z.boolean() });
const caseSuspend = z.object({
  caseId: id,
  decision: z.literal("suspend"),
  suspendTarget: z.enum(["user", "channel", "both"]),
  durationSeconds: z.number().int().positive().nullable(),
  // Not written yet (contract request): false when the writer skipped that update (an account
  // under a T0 ban, a channel already suspended). Absent reads as applied.
  userSuspended: z.boolean().optional(),
  channelSuspended: z.boolean().optional(),
});
const nciiDecide = z.object({ requestId: id, decision: z.enum(NCII_DECISIONS) });
const nciiAutoHide = z.object({ requestId: id });
const t0Match = z.object({
  caseId: id,
  flagId: id,
  userId: id,
  subjectType: z.enum(MODERATION_SUBJECTS),
  subjectId: id,
  listCategory: z.enum(HASH_LIST_CATEGORIES),
});

export const SOR_DETAILS = {
  "moderation.t1.restrict": t1Restrict,
  "moderation.t2.label": t2Label,
  "moderation.t1.upload_reject": uploadReject,
  "moderation.case.warn": caseWarn,
  "moderation.case.end_stream": caseEndStream,
  "moderation.case.suspend": caseSuspend,
  "ncii.decide": nciiDecide,
  "ncii.auto_hide": nciiAutoHide,
  "moderation.t0.match": t0Match,
} as const satisfies Record<SourceAction, z.ZodType>;

export type SorDetails = { [A in SourceAction]: z.infer<(typeof SOR_DETAILS)[A]> };

export const isSourceAction = (action: string): action is SourceAction =>
  (ENFORCEMENT_SOURCE_ACTIONS as readonly string[]).includes(action);

/**
 * Allowlisted rows that ADR 0019 decision 3 says produce no statement whatever their recipient:
 * an NCII request decided `rejected`, an NCII action that restricted no content on this instance
 * (no URL resolved to a subject), and a T0 match on any list but an NCII list (CSAM: no
 * statement, accepted answer 1, counsel to confirm). Also decisions that restricted nothing: an
 * `end_stream` that ended no stream (a clip or chat case, or a stream already over) and a
 * suspension whose every target was skipped by the writer. The builder and the coverage sweep
 * share this predicate, so a "no" row is never selected and never counted as missing.
 */
export function expectsStatement(a = schema.auditLog): SQL {
  const i = schema.nciiRequestItems;
  // Compared as text: a malformed id in `details` must not make the whole query fail.
  return sql`not (
    (${a.action} = 'ncii.decide' and ${a.details} ->> 'decision' is distinct from 'removed')
    or (${a.action} = 'moderation.t0.match' and ${a.details} ->> 'listCategory' is distinct from 'ncii')
    or (${a.action} = 'moderation.case.end_stream' and ${a.details} ->> 'streamEnded' = 'false')
    or (${a.action} = 'moderation.case.suspend' and (
      (${a.details} ->> 'suspendTarget' = 'user' and ${a.details} ->> 'userSuspended' = 'false')
      or (${a.details} ->> 'suspendTarget' = 'channel' and ${a.details} ->> 'channelSuspended' = 'false')
      or (${a.details} ->> 'suspendTarget' = 'both' and ${a.details} ->> 'userSuspended' = 'false'
        and ${a.details} ->> 'channelSuspended' = 'false')
    ))
    or (${a.action} in ('ncii.decide', 'ncii.auto_hide') and not exists (
      select 1 from ${i} where ${i.requestId}::text = ${a.details} ->> 'requestId'
        and ${i.subjectType} is not null and ${i.subjectId} is not null
        and (case when ${a.action} = 'ncii.decide' then ${i.removedAt} else ${i.hiddenAt} end) is not null
    ))
  )`;
}

/** `action in (allowlist)`, so the planner can use `audit_log_action_idx`. */
export function allowlisted(a = schema.auditLog): SQL {
  return sql`${a.action} in (${sql.join(
    ENFORCEMENT_SOURCE_ACTIONS.map((x) => sql`${x}`),
    sql`, `,
  )})`;
}
