// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Social sign-in provider tokens are never stored (0030_drop_provider_tokens). */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import type { Database } from "../src/client.ts";
import { uuidv7 } from "../src/ids.ts";
import * as s from "../src/schema/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;
let app: Database;
let userId: string;

beforeAll(async () => {
  t = await createTestDatabase();
  app = t.app.db;
  userId = uuidv7();
  await t.db.insert(s.users).values({ id: userId, name: "Tok", email: "tok@example.test", username: "tok" });
});
afterAll(async () => {
  await t?.drop();
});

const tokens = { accessToken: "gho_access", refreshToken: "ghr_refresh", idToken: "eyJ.id.token" };

async function stored(id: string) {
  const [row] = await t.db
    .select({
      accessToken: s.accounts.accessToken,
      refreshToken: s.accounts.refreshToken,
      idToken: s.accounts.idToken,
      scope: s.accounts.scope,
    })
    .from(s.accounts)
    .where(eq(s.accounts.id, id));
  return row;
}

describe("accounts provider tokens", () => {
  test("are discarded on insert, keeping the link itself", async () => {
    const [a] = await app
      .insert(s.accounts)
      .values({ userId, providerId: "github", accountId: "gh-1", scope: "read:user", ...tokens })
      .returning({ id: s.accounts.id });
    expect(await stored(a!.id)).toEqual({ accessToken: null, refreshToken: null, idToken: null, scope: "read:user" });
  });

  test("are discarded on update, for the owner role too", async () => {
    const [a] = await app
      .insert(s.accounts)
      .values({ userId, providerId: "twitch", accountId: "tw-1" })
      .returning({ id: s.accounts.id });
    await app.update(s.accounts).set(tokens).where(eq(s.accounts.id, a!.id));
    expect(await stored(a!.id)).toMatchObject({ accessToken: null, refreshToken: null, idToken: null });
    await t.db.update(s.accounts).set(tokens).where(eq(s.accounts.id, a!.id));
    expect(await stored(a!.id)).toMatchObject({ accessToken: null, refreshToken: null, idToken: null });
  });

  test("password accounts are unaffected", async () => {
    const [a] = await app
      .insert(s.accounts)
      .values({ userId, providerId: "credential", accountId: userId, password: "hash" })
      .returning({ id: s.accounts.id, password: s.accounts.password });
    expect(a!.password).toBe("hash");
  });
});
