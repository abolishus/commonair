// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Append-only audit log. `details` must hold ids and enums only, never personal
 * data or user free text (ADR 0004): the row can never be rewritten on deletion.
 */
import type { ACTOR_TYPES } from "@commonair/contracts/enums";
import { schema, type Executor } from "@commonair/db";

type Scalar = string | number | boolean | null;
export interface AuditInput {
  actorType: (typeof ACTOR_TYPES)[number];
  actorId: string | null;
  action: string;
  subjectType: string;
  subjectId: string;
  channelId?: string | null;
  /**
   * Moderator-written reason. Stored because moderation transparency requires it; callers must
   * pass the moderator's own words only, never quoted user content.
   */
  reason?: string;
  details?: Record<string, Scalar | Scalar[]>;
}

const UUIDISH = /^[0-9a-f-]{36}$/i;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/** Guard against personal data slipping into append-only details. */
export function assertSafeDetails(details: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(details)) {
    const values = Array.isArray(v) ? v : [v];
    for (const x of values) {
      if (typeof x === "string" && !UUIDISH.test(x) && (EMAIL.test(x) || x.length > 64))
        throw new Error(`audit detail "${k}" looks like free text or personal data`);
    }
  }
}

export async function audit(tx: Executor, a: AuditInput): Promise<void> {
  const details = a.details ?? {};
  assertSafeDetails(details);
  await tx.insert(schema.auditLog).values({
    actorType: a.actorType,
    actorId: a.actorId,
    action: a.action,
    subjectType: a.subjectType,
    subjectId: a.subjectId,
    channelId: a.channelId ?? null,
    reason: a.reason ?? "",
    details,
  });
}
