// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `moderation.assign` (overhaul wave 4, D7.5): claim a T1/T2 case for yourself or release it, so
 * two moderators never decide the same case. Assigning (or taking over) someone else's case needs
 * the admin role. T0 cases are NOT_FOUND here, as in `moderation.case`. The 0058 trigger refuses a
 * non-staff assignee whatever this code does; every change writes one audit row (ids only).
 * Nothing outside the console reacts to a claim, so there is no outbox event.
 */
import { eq } from "drizzle-orm";
import { schema } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { badRequest, conflict, forbidden, notFound, pgCode } from "../lib/errors.ts";
import type { Caller } from "../lib/access.ts";
import { refsFor, toCase, type ModerationCaseDto } from "../moderation/cases.ts";
import { staffActorType } from "../moderation/review.ts";

const { moderationCases, users, channels } = schema;
const STAFF = new Set(["moderator", "admin", "legal"]);

export type AssignDecision =
  | { ok: true; change: boolean }
  | { ok: false; code: "FORBIDDEN" | "CONFLICT" | "BAD_REQUEST"; message: string };

/**
 * The rules, apart from the database: who may set `next` on a case currently claimed by `current`.
 * `open` is whether the case still waits for a decision (a decided case can only be released).
 */
export function planAssign(input: {
  callerId: string;
  callerRole: string;
  current: string | null;
  next: string | null;
  open: boolean;
}): AssignDecision {
  const { callerId, callerRole, current, next, open } = input;
  if (current === next) return { ok: true, change: false };
  const admin = callerRole === "admin";
  if (next !== null && !open) return { ok: false, code: "CONFLICT", message: "This case is already decided" };
  if (next !== null && next !== callerId && !admin)
    return { ok: false, code: "FORBIDDEN", message: "Only admins assign cases to someone else" };
  if (current !== null && current !== callerId && !admin)
    return { ok: false, code: "CONFLICT", message: "Someone else has claimed this case" };
  return { ok: true, change: true };
}

export async function assignCase(
  deps: Deps,
  caller: Caller,
  input: { id: string; assigneeId: string | null },
): Promise<ModerationCaseDto> {
  const now = deps.now();
  const row = await deps.db.transaction(async (tx) => {
    const [c] = await tx.select().from(moderationCases).where(eq(moderationCases.id, input.id)).for("update");
    if (!c || c.tier === "t0") throw notFound("Case not found");
    const plan = planAssign({
      callerId: caller.user.id,
      callerRole: caller.user.role,
      current: c.assigneeId,
      next: input.assigneeId,
      open: c.status === "open",
    });
    if (!plan.ok) throw plan.code === "FORBIDDEN" ? forbidden(plan.message) : conflict(plan.message);
    if (!plan.change) return c;
    if (input.assigneeId !== null) {
      const [who] = await tx.select({ role: users.role }).from(users).where(eq(users.id, input.assigneeId));
      if (!who || !STAFF.has(who.role)) throw badRequest("Cases are assigned to moderators, admins or legal only");
      // Nobody claims a case about their own account or channel (as `moderation.review` refuses).
      const owner = c.channelId
        ? (await tx.select({ ownerId: channels.ownerId }).from(channels).where(eq(channels.id, c.channelId)))[0]
            ?.ownerId
        : undefined;
      if (c.userId === input.assigneeId || owner === input.assigneeId)
        throw forbidden("Nobody can be assigned a case about themselves");
    }
    const [updated] = await tx
      .update(moderationCases)
      .set({ assigneeId: input.assigneeId, assignedAt: input.assigneeId ? now : null, updatedAt: now })
      .where(eq(moderationCases.id, c.id))
      .returning()
      .catch((err: unknown) => {
        // The 0058 trigger: the assignee lost the staff role between the check and the write.
        if (pgCode(err) === "23514") throw badRequest("Cases are assigned to moderators, admins or legal only");
        throw err;
      });
    if (!updated) throw notFound("Case not found");
    await audit(tx, {
      actorType: staffActorType(caller.user.role),
      actorId: caller.user.id,
      action: input.assigneeId === null ? "moderation.case.release" : "moderation.case.assign",
      subjectType: "moderation_case",
      subjectId: c.id,
      channelId: c.channelId,
      details: { assigneeId: input.assigneeId, previousAssigneeId: c.assigneeId },
    });
    return updated;
  });
  return toCase(row, await refsFor(deps.db, [row]));
}
