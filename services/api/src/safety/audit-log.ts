// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `safety.auditLog`: the platform audit log, newest first, keyset-paged. Filters by subject,
 * actor and (overhaul wave 5) a time range: `from` inclusive, `to` exclusive, so consecutive
 * ranges never count an entry twice.
 */
import { schema, type Executor } from "@commonair/db";
import { and, desc, eq, gte, lt, or, type SQL } from "drizzle-orm";
import { decodeCursor, encodeCursor, isKeyCursor, pageOf } from "../lib/cursor.ts";
import { iso } from "../lib/dto.ts";
import { badRequest } from "../lib/errors.ts";

const { auditLog } = schema;

export interface AuditLogQuery {
  limit: number;
  cursor?: string;
  subjectType?: string;
  subjectId?: string;
  actorId?: string;
  from?: string;
  to?: string;
}

/** The range's bounds as dates; an empty or reversed range is the caller's mistake (400). */
export function auditRange(from?: string, to?: string): { from: Date | null; to: Date | null } {
  const f = from === undefined ? null : new Date(from);
  const t = to === undefined ? null : new Date(to);
  if (f !== null && t !== null && f.getTime() >= t.getTime()) throw badRequest("`from` must be before `to`");
  return { from: f, to: t };
}

export async function listAuditLog(db: Executor, input: AuditLogQuery) {
  const range = auditRange(input.from, input.to);
  const cur = decodeCursor(input.cursor, isKeyCursor);
  const where: (SQL | undefined)[] = [
    input.subjectType ? eq(auditLog.subjectType, input.subjectType) : undefined,
    input.subjectId ? eq(auditLog.subjectId, input.subjectId) : undefined,
    input.actorId ? eq(auditLog.actorId, input.actorId) : undefined,
    range.from ? gte(auditLog.createdAt, range.from) : undefined,
    range.to ? lt(auditLog.createdAt, range.to) : undefined,
    cur
      ? or(
          lt(auditLog.createdAt, new Date(cur.t)),
          and(eq(auditLog.createdAt, new Date(cur.t)), lt(auditLog.id, cur.id)),
        )
      : undefined,
  ];
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(...where))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(input.limit + 1);
  return pageOf(
    rows,
    input.limit,
    (a) => ({
      id: a.id,
      actorType: a.actorType,
      actorId: a.actorId,
      action: a.action,
      subjectType: a.subjectType,
      subjectId: a.subjectId,
      reason: a.reason,
      details: a.details,
      createdAt: iso(a.createdAt),
    }),
    (last) => encodeCursor({ t: iso(last.createdAt), id: last.id }),
  );
}
