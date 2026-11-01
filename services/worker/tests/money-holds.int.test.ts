// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `money-release-holds` with revenue splits (ADR 0013 decisions 1, 7; decision (i)): one run
 * releases every recipient's lot of a split payment, routes a suspended crew member's lot to split
 * suspense without touching anyone else's, and keeps a new crew recipient's first lot for the
 * governance-set extra days.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import {
  DEFAULT_PLATFORM_CUT,
  accounts,
  creatorBalances,
  loadMoneySettings,
  paymentSucceeded,
  post,
  rawBalance,
} from "@commonair/ledger";
import { releaseHolds } from "../src/money/holds.ts";
import { DAY_MS } from "../src/money/time.ts";
import { makeUser, setup, type TestEnv } from "./fixtures.ts";

let env: TestEnv;
const NOW = new Date("2026-10-19T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

beforeAll(async () => {
  env = await setup({ jobs: [], outbox: false, segments: false, now: () => NOW });
});
afterAll(() => env.close());

const ctx = () => env.worker.ctx;
const db = () => env.t.db;

function splitTip(ownerId: string, crew: { userId: string; bps: number }[], gross: number, at: Date) {
  const paymentId = uuidv7();
  return {
    paymentId,
    posting: paymentSucceeded({
      paymentId,
      paymentKind: "tip",
      provider: "manual",
      creatorUserId: ownerId,
      grossCents: gross,
      taxCents: 0,
      feeCents: 0,
      currency: "usd",
      cut: DEFAULT_PLATFORM_CUT,
      cutHistoryId: null,
      occurredAt: at,
      split: { versionId: uuidv7(), crew },
    }),
  };
}

describe("money-release-holds with splits", () => {
  test("releases every recipient and routes a suspended one to split suspense", async () => {
    await releaseHolds(ctx());
    const { payoutRules } = await loadMoneySettings(db());
    const owner = await makeUser(db());
    const [a, b] = [await makeUser(db()), await makeUser(db())];
    // Past the hold and the new-recipient extra days.
    const old = ago((payoutRules.holdDays + payoutRules.splitNewRecipientHoldDays + 1) * DAY_MS);
    const tip = splitTip(
      owner.user.id,
      [
        { userId: a.user.id, bps: 2000 },
        { userId: b.user.id, bps: 1000 },
      ],
      1000,
      old,
    );
    await post(db(), tip.posting);
    await db().update(schema.users).set({ banned: true }).where(eq(schema.users.id, a.user.id));

    const r = await releaseHolds(ctx());
    expect(r).toMatchObject({ released: 3, withheld: 1, totalCents: 900 });
    expect((await creatorBalances(db(), owner.user.id, "usd")).liabilityCents).toBe(630);
    expect((await creatorBalances(db(), b.user.id, "usd")).liabilityCents).toBe(90);
    expect(await creatorBalances(db(), a.user.id, "usd")).toMatchObject({ liabilityCents: 0, holdCents: 0 });
    expect(await rawBalance(db(), accounts.splitSuspense(a.user.id), "usd")).toBe(-180);
    const keys = await db().execute<{ key: string }>(sql`
      select idempotency_key as key from ledger_transactions
      where kind = 'hold_release' and ref_id = ${tip.paymentId} order by 1`);
    expect([...keys].map((k) => k.key).sort()).toEqual(
      [owner.user.id, a.user.id, b.user.id].map((u) => `hold-release:${tip.paymentId}:${u}`).sort(),
    );
    // Idempotent per recipient.
    expect(await releaseHolds(ctx())).toMatchObject({ released: 0, totalCents: 0 });
  });

  test("a new crew recipient's first lot waits splitNewRecipientHoldDays longer than the owner's", async () => {
    await releaseHolds(ctx());
    const { payoutRules } = await loadMoneySettings(db());
    expect(payoutRules.splitNewRecipientHoldDays).toBeGreaterThan(0);
    const owner = await makeUser(db());
    const c = await makeUser(db());
    const tip = splitTip(
      owner.user.id,
      [{ userId: c.user.id, bps: 5000 }],
      1000,
      ago((payoutRules.holdDays + 1) * DAY_MS),
    );
    await post(db(), tip.posting);
    expect(await releaseHolds(ctx())).toMatchObject({ released: 1, totalCents: 450 });
    expect((await creatorBalances(db(), c.user.id, "usd")).holdCents).toBe(450);
  });
});
