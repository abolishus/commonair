// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The operator role CLI, as the least-privilege app role. */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import type { Database } from "../src/client.ts";
import { uuidv7 } from "../src/ids.ts";
import * as s from "../src/schema/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { RoleUsageError, parseRoleArgs, setPlatformRole } from "../src/roles/cli.ts";

vi.setConfig({ testTimeout: 60_000 });

let t: TestDatabase;
let app: Database;

beforeAll(async () => {
  t = await createTestDatabase();
  app = t.app.db;
});
afterAll(async () => {
  await t?.drop();
});

async function insertUser(username: string, extra: Partial<typeof s.users.$inferInsert> = {}) {
  const id = uuidv7();
  await app
    .insert(s.users)
    .values({ id, name: username, email: `${username}@example.test`, username, emailVerified: true, ...extra });
  return id;
}

describe("parseRoleArgs", () => {
  test("help without arguments", () => {
    expect(parseRoleArgs([])).toBeNull();
    expect(parseRoleArgs(["--help"])).toBeNull();
  });
  test("username is lowercased; role must be known", () => {
    expect(parseRoleArgs(["Treasury_Ann", "treasurer"])).toEqual({ username: "treasury_ann", role: "treasurer" });
    expect(() => parseRoleArgs(["ann", "owner"])).toThrow(RoleUsageError);
    expect(() => parseRoleArgs(["ann"])).toThrow(RoleUsageError);
    expect(() => parseRoleArgs(["ann", "admin", "extra"])).toThrow(RoleUsageError);
  });
});

describe("setPlatformRole", () => {
  test("sets the role and audits it as the system actor", async () => {
    const id = await insertUser("role_ann");
    const result = await setPlatformRole(app, "role_ann", "treasurer");
    expect(result).toEqual({ kind: "changed", userId: id, from: "user", to: "treasurer" });
    const [row] = await app.select({ role: s.users.role }).from(s.users).where(eq(s.users.id, id));
    expect(row?.role).toBe("treasurer");
    const audits = await app
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.subjectId, id), eq(s.auditLog.action, "user.set_role")));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: "system", actorId: null, details: { from: "user", to: "treasurer" } });
  });

  test("no-op when unchanged (no audit row)", async () => {
    const id = await insertUser("role_bo", { role: "moderator" });
    expect(await setPlatformRole(app, "role_bo", "moderator")).toEqual({
      kind: "unchanged",
      userId: id,
      role: "moderator",
    });
    const audits = await app.select().from(s.auditLog).where(eq(s.auditLog.subjectId, id));
    expect(audits).toHaveLength(0);
  });

  test("refuses unknown users, bots and removing the last admin", async () => {
    await expect(setPlatformRole(app, "nobody_here", "admin")).rejects.toThrow(RoleUsageError);
    await insertUser("role_bot", { accountType: "bot" });
    await expect(setPlatformRole(app, "role_bot", "moderator")).rejects.toThrow(/bots/);
    await insertUser("role_admin1", { role: "admin" });
    await expect(setPlatformRole(app, "role_admin1", "user")).rejects.toThrow(/last administrator/);
    await insertUser("role_admin2", { role: "admin" });
    expect((await setPlatformRole(app, "role_admin1", "user")).kind).toBe("changed");
  });
});
