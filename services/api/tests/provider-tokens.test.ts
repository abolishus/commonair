// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { withoutProviderTokens } from "../src/auth/index.ts";

describe("withoutProviderTokens", () => {
  test("nulls every provider token and keeps the rest", () => {
    const at = new Date();
    expect(
      withoutProviderTokens({
        providerId: "twitch",
        accountId: "1",
        accessToken: "a",
        refreshToken: "r",
        idToken: "i",
        accessTokenExpiresAt: at,
        scope: "user:read:email",
      }),
    ).toEqual({
      providerId: "twitch",
      accountId: "1",
      accessToken: null,
      refreshToken: null,
      idToken: null,
      accessTokenExpiresAt: at,
      scope: "user:read:email",
    });
  });

  test("adds no token keys to writes that never had them (credential accounts, partial updates)", () => {
    expect(withoutProviderTokens({ providerId: "credential", password: "hash" })).toEqual({
      providerId: "credential",
      password: "hash",
    });
    expect(withoutProviderTokens({})).toEqual({});
  });

  test("does not mutate its input", () => {
    const input = { accessToken: "a" };
    withoutProviderTokens(input);
    expect(input.accessToken).toBe("a");
  });
});
