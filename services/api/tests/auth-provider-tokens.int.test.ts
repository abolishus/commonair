// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Social sign-in never stores the provider's tokens, and the endpoints that would use them are closed. */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema } from "@commonair/db";
import { createAuth, PROVIDER_TOKEN_PATHS } from "../src/auth/index.ts";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
}, 60_000);
afterAll(async () => {
  await api?.stop();
});

const tokens = { accessToken: "gho_access", refreshToken: "ghr_refresh", idToken: "eyJ.id.token" };
const tokenColumns = (userId: string) =>
  api.db.db
    .select({
      providerId: schema.accounts.providerId,
      accessToken: schema.accounts.accessToken,
      refreshToken: schema.accounts.refreshToken,
      idToken: schema.accounts.idToken,
    })
    .from(schema.accounts)
    .where(eq(schema.accounts.userId, userId));

describe("provider tokens", () => {
  test("linking and re-linking a provider stores none of its tokens", async () => {
    const { userId } = await signUpAndSignIn(api);
    const ctx = await createAuth(api.deps).$context;
    // The same adapter calls better-auth's OAuth callback makes (link, then update on re-link).
    const linked = await ctx.internalAdapter.linkAccount({
      userId,
      providerId: "github",
      accountId: `gh-${userId}`,
      scope: "read:user,user:email",
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      ...tokens,
    });
    expect(linked).toMatchObject({ accessToken: null, refreshToken: null, idToken: null });
    await ctx.internalAdapter.updateAccount(linked.id, tokens);
    const rows = await tokenColumns(userId);
    expect(rows).toContainEqual({ providerId: "github", accessToken: null, refreshToken: null, idToken: null });
    expect(rows.every((r) => r.accessToken === null && r.refreshToken === null && r.idToken === null)).toBe(true);
  });

  test("the account hooks strip tokens before the database sees them", async () => {
    const hooks = createAuth(api.deps).options.databaseHooks?.account;
    const updated = await hooks?.update?.before?.({ ...tokens, scope: "s" });
    expect(updated).toEqual({ data: { accessToken: null, refreshToken: null, idToken: null, scope: "s" } });
  });

  test("endpoints that return or refresh provider tokens are not found", async () => {
    const { client } = await signUpAndSignIn(api);
    for (const path of PROVIDER_TOKEN_PATHS) {
      const method = path === "/account-info" ? "GET" : "POST";
      const res = await client.call(
        method,
        `/api/auth${path}`,
        method === "POST" ? { providerId: "github" } : undefined,
      );
      expect(res.status, path).toBe(404);
    }
  });
});
