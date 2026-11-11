// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overhaul wave 4 contract step: the 18+ confirmation's date and its withdrawal (D7.2), the
 * `payouts` feature flag (J2-h).
 */
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
}, 60_000);
afterAll(async () => {
  await api?.stop();
});

type MeBody = { matureConfirmed: boolean; matureConfirmedAt: string | null };

describe("me: 18+ confirmation", () => {
  test("confirming dates it; withdrawing clears it; true is refused", async () => {
    const s = await signUpAndSignIn(api);
    expect((await s.client.call<MeBody>("GET", "/api/me")).body).toMatchObject({
      matureConfirmed: false,
      matureConfirmedAt: null,
    });
    expect((await s.client.call("POST", "/api/me/mature-confirmation")).status).toBe(200);
    const confirmed = (await s.client.call<MeBody>("GET", "/api/me")).body;
    expect(confirmed.matureConfirmed).toBe(true);
    expect(Number.isNaN(Date.parse(confirmed.matureConfirmedAt ?? ""))).toBe(false);

    expect((await s.client.call("PATCH", "/api/me", { matureConfirmed: true })).status).toBe(400);
    const withdrawn = await s.client.call<MeBody>("PATCH", "/api/me", { matureConfirmed: false });
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body).toMatchObject({ matureConfirmed: false, matureConfirmedAt: null });
  });

  test("a minor never shows a confirmation date", async () => {
    const s = await signUpAndSignIn(api, { birthDate: "2011-01-01" });
    expect((await s.client.call<MeBody>("GET", "/api/me")).body.matureConfirmedAt).toBeNull();
  });
});

describe("instance features", () => {
  test("payouts is on: both adapters pay creators out", async () => {
    const s = await signUpAndSignIn(api);
    const info = await s.client.call<{ features: { payouts: boolean } }>("GET", "/api/instance");
    expect(info.body.features.payouts).toBe(true);
  });
});
