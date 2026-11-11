// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The treasurer's public note on a transparency month (overhaul D6.1, `transparency_notes`): what
 * pays a deficit, a one-off cost explained. One row per month, replaced in place; an empty note
 * removes it. Every set and removal writes an `audit_log` row naming the treasurer and the month.
 * The note body is free text, so the audit row keeps only its length (ADR 0004: no free text in
 * append-only columns); the current text lives in the mutable table alone.
 */
import { eq, inArray } from "drizzle-orm";
import { type Executor, schema } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";

const { transparencyNotes } = schema;

export interface MonthNote {
  body: string;
  updatedAt: string;
}

export type NoteChange = "set" | "removed" | "unchanged";

/**
 * Set (trimmed) or remove (blank) the note on `month`, audited in the same transaction. Removing a
 * note that does not exist changes nothing and writes no audit row.
 */
export async function setTransparencyNote(
  deps: Pick<Deps, "db" | "now">,
  actorId: string,
  input: { month: string; body: string },
): Promise<NoteChange> {
  const body = input.body.trim();
  const now = deps.now();
  return deps.db.transaction(async (tx) => {
    if (body === "") {
      const removed = await tx
        .delete(transparencyNotes)
        .where(eq(transparencyNotes.month, input.month))
        .returning({ month: transparencyNotes.month });
      if (removed.length === 0) return "unchanged";
      await auditNote(tx, actorId, "transparency.note.remove", input.month, { length: 0 });
      return "removed";
    }
    await tx
      .insert(transparencyNotes)
      .values({ month: input.month, body, updatedBy: actorId, updatedAt: now })
      .onConflictDoUpdate({ target: transparencyNotes.month, set: { body, updatedBy: actorId, updatedAt: now } });
    await auditNote(tx, actorId, "transparency.note.set", input.month, { length: body.length });
    return "set";
  });
}

function auditNote(tx: Executor, actorId: string, action: string, month: string, details: { length: number }) {
  // A treasurer is staff; `admin` is the actor type every treasury action uses (cost.record).
  return audit(tx, {
    actorType: "admin",
    actorId,
    action,
    subjectType: "transparency_month",
    subjectId: month,
    details,
  });
}

/** The notes on `months` in one query, by month (months without one are absent). */
export async function monthNotes(db: Executor, months: readonly string[]): Promise<Map<string, MonthNote>> {
  const out = new Map<string, MonthNote>();
  if (months.length === 0) return out;
  const rows = await db
    .select({ month: transparencyNotes.month, body: transparencyNotes.body, updatedAt: transparencyNotes.updatedAt })
    .from(transparencyNotes)
    .where(inArray(transparencyNotes.month, [...months]));
  for (const r of rows) out.set(r.month, { body: r.body, updatedAt: r.updatedAt.toISOString() });
  return out;
}
