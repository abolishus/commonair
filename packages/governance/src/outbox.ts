// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Audit and outbox rows for governance steps. Every step writes both in the transaction that
 * makes the change (AGENTS.md). Event payloads are validated against the catalog here, so a
 * malformed payload fails the step instead of being relayed and rejected later. Audit `details`
 * and payloads carry ids, enums and numbers only: never a vote choice, a comment or a name.
 */
import { EVENTS, type EventType } from "@commonair/contracts/events";
import { schema, uuidv7, type Executor } from "@commonair/db";

/** Insert one outbox row after validating `payload` against the event's schema. */
export async function emitEvent(tx: Executor, type: EventType, payload: Record<string, unknown>, at: Date) {
  const def = EVENTS[type];
  const parsed = def.payload.parse(payload) as Record<string, unknown>;
  await tx.insert(schema.events).values({
    id: uuidv7(at.getTime()),
    type,
    version: def.version,
    channelId: null,
    payload: parsed,
    occurredAt: at,
  });
}

/** One `audit_log` row written by the system (scheduled jobs). */
export async function systemAudit(
  tx: Executor,
  row: { action: string; subjectType: string; subjectId: string; reason: string; details: Record<string, unknown> },
  at: Date,
) {
  await tx.insert(schema.auditLog).values({ id: uuidv7(at.getTime()), actorType: "system", createdAt: at, ...row });
}

/** The SQLSTATE of a Postgres error, looking through drizzle's wrapper. */
export function pgCode(err: unknown): string | undefined {
  for (let e: unknown = err, depth = 0; e && typeof e === "object" && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}
