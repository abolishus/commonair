#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `bun run --filter @commonair/db role -- <username> <role>`
 *
 * Operator bootstrap for platform roles (the first admin, a treasurer for the manual payments
 * adapter, the harness). After that, admins use `admin.setRole`. Connects with DATABASE_URL and
 * writes an `audit_log` row as the `system` actor. Sessions the user already holds may keep the
 * old role until they sign in again.
 */
import { PLATFORM_ROLES } from "@commonair/contracts/enums";
import { and, eq, ne } from "drizzle-orm";
import { createDb, type Executor } from "../client.ts";
import { uuidv7 } from "../ids.ts";
import { users } from "../schema/auth.ts";
import { auditLog } from "../schema/safety.ts";

export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const ROLE_USAGE = `Usage:
  bun packages/db/src/roles/cli.ts <username> <role>   set a platform role (${PLATFORM_ROLES.join(", ")})

Environment:
  DATABASE_URL   target database (required)
`;

export class RoleUsageError extends Error {}

export function parseRoleArgs(argv: readonly string[]): { username: string; role: PlatformRole } | null {
  const [username, role, ...rest] = argv;
  if (username === undefined || username === "help" || username === "--help" || username === "-h") return null;
  if (role === undefined || rest.length > 0) throw new RoleUsageError("expected exactly <username> <role>");
  if (!(PLATFORM_ROLES as readonly string[]).includes(role))
    throw new RoleUsageError(`unknown role "${role}" (one of ${PLATFORM_ROLES.join(", ")})`);
  return { username: username.toLowerCase(), role: role as PlatformRole };
}

export type SetRoleResult =
  | { kind: "changed"; userId: string; from: PlatformRole; to: PlatformRole }
  | { kind: "unchanged"; userId: string; role: PlatformRole };

/** Sets the role in one transaction with its audit row. Refuses bots and removing the last admin. */
export async function setPlatformRole(db: Executor, username: string, role: PlatformRole): Promise<SetRoleResult> {
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: users.id, role: users.role, accountType: users.accountType })
      .from(users)
      .where(eq(users.username, username))
      .for("update");
    if (!target) throw new RoleUsageError(`no user named "${username}"`);
    if (target.accountType === "bot" && role !== "user") throw new RoleUsageError("bots cannot hold platform roles");
    if (target.role === role) return { kind: "unchanged", userId: target.id, role };
    if (target.role === "admin") {
      const others = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, "admin"), ne(users.id, target.id)))
        .limit(1);
      if (others.length === 0) throw new RoleUsageError("cannot remove the last administrator");
    }
    await tx.update(users).set({ role }).where(eq(users.id, target.id));
    await tx.insert(auditLog).values({
      id: uuidv7(),
      actorType: "system",
      actorId: null,
      action: "user.set_role",
      subjectType: "user",
      subjectId: target.id,
      reason: "operator CLI",
      details: { from: target.role, to: role },
    });
    return { kind: "changed", userId: target.id, from: target.role, to: role };
  });
}

if (import.meta.main) {
  let exitCode = 0;
  try {
    const args = parseRoleArgs(Bun.argv.slice(2));
    if (!args) {
      process.stdout.write(ROLE_USAGE);
    } else {
      const url = process.env.DATABASE_URL;
      if (!url) throw new RoleUsageError("DATABASE_URL is not set");
      const handle = createDb({ url, max: 1, applicationName: "commonair-role-cli" });
      const { db } = handle;
      try {
        const result = await setPlatformRole(db, args.username, args.role);
        process.stdout.write(
          result.kind === "changed"
            ? `${args.username}: ${result.from} → ${result.to} (sign in again to pick it up)\n`
            : `${args.username} is already ${result.role}\n`,
        );
      } finally {
        await handle.close();
      }
    }
  } catch (err) {
    if (!(err instanceof RoleUsageError)) throw err;
    process.stderr.write(`${err.message}\n\n${ROLE_USAGE}`);
    exitCode = 2;
  }
  process.exit(exitCode);
}
