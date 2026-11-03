// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Batch 8 reversal postings against the real database, as the least-privilege app role: they
 * balance under the ledger triggers and a redelivery posts nothing (contract step §2.2-§2.3).
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { type Database, schema as s, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { accounts, patronagePayoutReversed, payoutTransferReversed, post, rawBalance } from "../src/index.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;
let app: Database;

beforeAll(async () => {
  t = await createTestDatabase();
  app = t.app.db;
});
afterAll(async () => {
  await t?.drop();
});

const AT = new Date("2026-11-03T12:00:00Z");

async function newUser(): Promise<string> {
  const name = `b8l_${uuidv7().replace(/-/g, "").slice(-12)}`;
  const [u] = await app
    .insert(s.users)
    .values({ name, email: `${name}@example.test`, username: name })
    .returning({ id: s.users.id });
  return u!.id;
}

describe("batch 8 reversal postings", () => {
  test("two partial transfer reversals post twice; a redelivery posts nothing", async () => {
    const userId = await newUser();
    const transferId = uuidv7();
    const payoutId = uuidv7();
    const base = { payoutId, transferId, userId, currency: "usd", occurredAt: AT };
    const first = await post(app, payoutTransferReversed({ ...base, amountCents: 1_000, cumulativeCents: 1_000 }));
    const second = await post(app, payoutTransferReversed({ ...base, amountCents: 500, cumulativeCents: 1_500 }));
    const again = await post(app, payoutTransferReversed({ ...base, amountCents: 1_000, cumulativeCents: 1_000 }));
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(again).toEqual({ transactionId: first.transactionId, created: false });
    expect(await rawBalance(app, accounts.creator(userId), "usd")).toBe(-1_500);
  });

  test("a patronage payout reversal posts once", async () => {
    const userId = await newUser();
    const periodId = uuidv7();
    const posting = patronagePayoutReversed({
      payoutId: uuidv7(),
      periodId,
      userId,
      provider: "manual",
      amountCents: 700,
      cumulativeCents: 700,
      currency: "usd",
      occurredAt: AT,
    });
    expect((await post(app, posting)).created).toBe(true);
    expect((await post(app, posting)).created).toBe(false);
    expect(await rawBalance(app, accounts.patronagePayable(userId), "usd")).toBe(-700);
  });
});
