// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overhaul wave 4 contract step: the 18+ confirmation's date and its withdrawal (D7.2), the
 * `payouts` feature flag (J2-h), and `Me.settingsSummary` (the settings shell's banner and badges).
 */
import { schema, uuidv7 } from "@commonair/db";
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

type Summary = { settingsSummary: { deletionScheduledFor: string | null; openAppeals: number; openCopyright: number } };

describe("me: settingsSummary", () => {
  test("counts open appeals and in-effect copyright notices, and dates a scheduled deletion", async () => {
    const s = await signUpAndSignIn(api);
    const other = await signUpAndSignIn(api);
    const me = async () => (await s.client.call<Summary>("GET", "/api/me")).body.settingsSummary;
    expect(await me()).toEqual({ deletionScheduledFor: null, openAppeals: 0, openCopyright: 0 });

    const db = api.db.db;
    const appeal = (appellantId: string, status: "open" | "upheld") =>
      db.insert(schema.appeals).values({
        appellantId,
        kind: "moderation",
        subjectType: "mod_action",
        subjectId: uuidv7(),
        body: "please",
        status,
      });
    await appeal(s.userId, "open");
    await appeal(s.userId, "upheld");
    await appeal(other.userId, "open");
    const notice = async (status: "received" | "actioned" | "countered" | "restored", ownerId: string, items = 1) => {
      const id = uuidv7();
      await db.insert(schema.dmcaNotices).values({
        id,
        claimantName: "C",
        claimantEmail: "c@example.test",
        claimantAddress: "A",
        copyrightedWork: "W",
        infringingUrls: ["https://example.test/x"],
        goodFaithStatement: true,
        accuracyStatement: true,
        signature: "C",
        status,
      });
      for (let i = 0; i < items; i++)
        await db.insert(schema.dmcaNoticeItems).values({ noticeId: id, url: `https://example.test/${i}`, ownerId });
    };
    // Two items on one actioned notice count once; received (undecided) and restored do not count.
    await notice("actioned", s.userId, 2);
    await notice("countered", s.userId);
    await notice("received", s.userId);
    await notice("restored", s.userId);
    await notice("actioned", other.userId);
    expect(await me()).toEqual({ deletionScheduledFor: null, openAppeals: 1, openCopyright: 2 });

    const res = await s.client.call<{ scheduledFor: string }>("POST", "/api/me/deletion", {
      confirmUsername: s.username,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await me()).deletionScheduledFor).toBe(res.body.scheduledFor);
    expect((await s.client.call("DELETE", "/api/me/deletion")).status).toBe(200);
    expect((await me()).deletionScheduledFor).toBeNull();
  });
});
