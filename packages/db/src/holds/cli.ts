#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `bun run --filter @commonair/db hold -- list | release <hold id> --reason <text>`
 *
 * Legal holds (ADR 0006) can be released only by the database owner: the trigger refuses the
 * application role, so this CLI must run with the owner's DATABASE_URL (the one migrations use).
 * Releasing ends the preservation duty the platform took on; do it only on counsel's advice,
 * normally after `eligible_for_release_at` (one year after the NCMEC filing). It never deletes
 * evidence: purging released evidence is a separate, deliberate operator procedure. Writes an
 * `audit_log` row as the `system` actor in the same transaction.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { createDb, type Executor } from "../client.ts";
import { uuidv7 } from "../ids.ts";
import { auditLog, legalHolds } from "../schema/safety.ts";

export const HOLD_USAGE = `Usage:
  bun packages/db/src/holds/cli.ts list                               active holds
  bun packages/db/src/holds/cli.ts release <hold id> --reason <text>  release one hold (owner only)

Environment:
  DATABASE_URL   the database OWNER's connection string (required)
`;

export class HoldUsageError extends Error {}

export type HoldCommand = { kind: "list" } | { kind: "release"; id: string; reason: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseHoldArgs(argv: readonly string[]): HoldCommand | null {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") return null;
  if (cmd === "list") {
    if (rest.length > 0) throw new HoldUsageError("list takes no arguments");
    return { kind: "list" };
  }
  if (cmd !== "release") throw new HoldUsageError(`unknown command "${cmd}"`);
  const [id, flag, ...reasonWords] = rest;
  if (id === undefined || !UUID.test(id)) throw new HoldUsageError("release needs a hold id (uuid)");
  const reason = reasonWords.join(" ").trim();
  if (flag !== "--reason" || reason.length === 0) throw new HoldUsageError("release needs --reason <text>");
  if (reason.length > 2000) throw new HoldUsageError("the reason is limited to 2000 characters");
  return { kind: "release", id: id.toLowerCase(), reason };
}

export interface HoldRow {
  id: string;
  userId: string;
  reasonCode: string;
  createdAt: Date;
  filedAt: Date | null;
  eligibleForReleaseAt: Date | null;
}

export async function listActiveHolds(db: Executor): Promise<HoldRow[]> {
  return db
    .select({
      id: legalHolds.id,
      userId: legalHolds.userId,
      reasonCode: legalHolds.reasonCode,
      createdAt: legalHolds.createdAt,
      filedAt: legalHolds.filedAt,
      eligibleForReleaseAt: legalHolds.eligibleForReleaseAt,
    })
    .from(legalHolds)
    .where(isNull(legalHolds.releasedAt))
    .orderBy(desc(legalHolds.createdAt));
}

/** Release one hold with its audit row. The database refuses anyone but the owner. */
export async function releaseHold(
  db: Executor,
  id: string,
  reason: string,
  now = new Date(),
): Promise<{ eligible: boolean }> {
  return db.transaction(async (tx) => {
    const [hold] = await tx.select().from(legalHolds).where(eq(legalHolds.id, id)).for("update");
    if (!hold) throw new HoldUsageError(`no hold ${id}`);
    if (hold.releasedAt) throw new HoldUsageError(`hold ${id} was already released`);
    const eligible = hold.eligibleForReleaseAt !== null && hold.eligibleForReleaseAt <= now;
    await tx
      .update(legalHolds)
      .set({ releasedAt: now, releaseReason: reason })
      .where(and(eq(legalHolds.id, id), isNull(legalHolds.releasedAt)));
    await tx.insert(auditLog).values({
      id: uuidv7(),
      actorType: "system",
      actorId: null,
      action: "legal_hold.release",
      subjectType: "legal_hold",
      subjectId: id,
      reason: "operator CLI",
      details: { reasonCode: hold.reasonCode, caseId: hold.caseId, eligible },
    });
    return { eligible };
  });
}

if (import.meta.main) {
  let exitCode = 0;
  try {
    const cmd = parseHoldArgs(Bun.argv.slice(2));
    if (!cmd) {
      process.stdout.write(HOLD_USAGE);
    } else {
      const url = process.env.DATABASE_URL;
      if (!url) throw new HoldUsageError("DATABASE_URL is not set");
      const handle = createDb({ url, max: 1, applicationName: "commonair-hold-cli" });
      try {
        if (cmd.kind === "list") {
          for (const h of await listActiveHolds(handle.db))
            process.stdout.write(
              `${h.id}  user=${h.userId}  ${h.reasonCode}  created=${h.createdAt.toISOString()}  filed=${h.filedAt?.toISOString() ?? "-"}  eligible=${h.eligibleForReleaseAt?.toISOString() ?? "-"}\n`,
            );
        } else {
          const { eligible } = await releaseHold(handle.db, cmd.id, cmd.reason);
          process.stdout.write(
            `released ${cmd.id}${eligible ? "" : " (WARNING: before its eligible date; make sure counsel approved this)"}\n`,
          );
        }
      } finally {
        await handle.close();
      }
    }
  } catch (err) {
    if (!(err instanceof HoldUsageError)) throw err;
    process.stderr.write(`${err.message}\n\n${HOLD_USAGE}`);
    exitCode = 2;
  }
  process.exit(exitCode);
}
