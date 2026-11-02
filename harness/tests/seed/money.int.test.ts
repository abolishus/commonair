// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-money's direct database work against a migrated database, as the app role: the reads
 * (account ages, live bans, the ledger report and row counts) and the two plain-table timestamp
 * shifts that hand a checkout and a subscription to the worker. The fixture is a minimal social
 * set (users, channels) plus the money rows a checkout and the ledger package would write. The API
 * steps (checkouts, confirmations, webhooks, splits, flags, costs) are exercised by `seed full` live.
 */
import { schema, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { DEFAULT_PLATFORM_CUT, infrastructureCost, paymentSucceeded, post, postReversal } from "@commonair/ledger";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { disputeReachedLedger, unbalancedTransactions } from "../../src/money.ts";
import {
  accountAges,
  activeBans,
  expireCheckout,
  lapseSubscription,
  ledgerReport,
  paymentSideCounts,
  splitCounts,
} from "../../src/seed/money/db.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

const DAY = 86_400_000;
const NOW = new Date();
let t: TestDatabase;
const ids = {
  owner: uuidv7(),
  viewer: uuidv7(),
  other: uuidv7(),
  treasurer: uuidv7(),
  channel: uuidv7(),
};

async function insertUser(id: string, handle: string, role: "user" | "treasurer", createdAt: Date) {
  const username = `demo_${handle}`;
  await t.app.db.insert(schema.users).values({
    id,
    name: handle,
    email: `${username}@demo-seed.invalid`,
    emailVerified: true,
    username,
    displayUsername: username,
    role,
    createdAt,
    updatedAt: createdAt,
  });
}

/** A checkout as the API writes it: a pending payment, and a subscription or tip hanging off it. */
async function checkout(kind: "subscription" | "tip", payer: string, status: "pending" | "succeeded" = "pending") {
  const paymentId = uuidv7();
  const subscriptionId = kind === "subscription" ? uuidv7() : null;
  const tipId = kind === "tip" ? uuidv7() : null;
  if (subscriptionId)
    await t.app.db.insert(schema.subscriptions).values({
      id: subscriptionId,
      subscriberId: payer,
      channelId: ids.channel,
      tier: 1,
      status: status === "succeeded" ? "active" : "incomplete",
      provider: "manual",
      priceCents: 500,
      currency: "usd",
      currentPeriodStart: status === "succeeded" ? NOW : null,
      currentPeriodEnd: status === "succeeded" ? new Date(NOW.getTime() + 30 * DAY) : null,
    });
  if (tipId)
    await t.app.db.insert(schema.tips).values({
      id: tipId,
      fromUserId: payer,
      channelId: ids.channel,
      amountCents: 500,
      currency: "usd",
      paymentId,
      status,
    });
  await t.app.db.insert(schema.payments).values({
    id: paymentId,
    provider: "manual",
    providerRef: `CA-${paymentId
      .slice(-8)
      .toUpperCase()
      .replace(/[ILOU]/g, "0")}`,
    kind,
    status,
    userId: payer,
    channelId: ids.channel,
    subscriptionId,
    tipId,
    amountCents: 500,
    currency: "usd",
    tier: kind === "subscription" ? 1 : null,
    expiresAt: new Date(NOW.getTime() + 7 * DAY),
    succeededAt: status === "succeeded" ? NOW : null,
  });
  return { paymentId, subscriptionId, tipId };
}

const count = async (table: string) =>
  Number((await t.sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${table}`))[0]?.n ?? 0);

beforeAll(async () => {
  t = await createTestDatabase();
  await insertUser(ids.owner, "streamer1", "user", new Date(NOW.getTime() - 90 * DAY));
  await insertUser(ids.viewer, "viewer1", "user", new Date(NOW.getTime() - 60 * DAY));
  await insertUser(ids.other, "v00001", "user", new Date(NOW.getTime() - 3 * DAY));
  await insertUser(ids.treasurer, "treasurer", "treasurer", new Date(NOW.getTime() - 90 * DAY));
  await t.app.db.insert(schema.channels).values({
    id: ids.channel,
    ownerId: ids.owner,
    slug: "demo_streamer1",
    displayName: "Aurora Pixel",
  });
});

afterAll(async () => {
  await t?.drop();
});

describe("reads", () => {
  test("accountAges returns each account's created_at, in chunks", async () => {
    const ages = await accountAges(t.app, [ids.owner, ids.other, uuidv7()]);
    expect(ages.size).toBe(2);
    expect(Math.round((NOW.getTime() - (ages.get(ids.other)?.getTime() ?? 0)) / DAY)).toBe(3);
  });

  test("activeBans lists live bans and timeouts, not lifted or expired ones", async () => {
    const base = { channelId: ids.channel, moderatorId: ids.owner, reason: "" };
    await t.app.db.insert(schema.chatBans).values([
      { ...base, userId: ids.other, expiresAt: null },
      { ...base, userId: ids.viewer, expiresAt: new Date(NOW.getTime() - DAY) },
    ]);
    const bans = await activeBans(t.app, NOW);
    expect(bans).toEqual([{ channelId: ids.channel, userId: ids.other }]);
  });
});

describe("timestamp shifts for the worker (manual adapter)", () => {
  test("expireCheckout moves only a pending payment's expiry, writing no events or audit rows", async () => {
    const before = { events: await count("events"), audit: await count("audit_log") };
    const pending = await checkout("tip", ids.viewer);
    const at = new Date(NOW.getTime() - 60_000);
    expect(await expireCheckout(t.app, pending.paymentId, at)).toBe(1);
    const [row] = await t.sql<{ expires_at: string; status: string }[]>`
      select expires_at, status::text as status from payments where id = ${pending.paymentId}::uuid`;
    expect(new Date(row?.expires_at ?? 0).getTime()).toBe(at.getTime());
    expect(row?.status).toBe("pending");
    // What money-expire-pending selects: pending and past its expiry.
    const [due] = await t.sql<{ n: number }[]>`
      select count(*)::int as n from payments where status = 'pending' and expires_at <= now()`;
    expect(due?.n).toBeGreaterThanOrEqual(1);
    const paid = await checkout("tip", ids.viewer, "succeeded");
    expect(await expireCheckout(t.app, paid.paymentId, at)).toBe(0);
    expect({ events: await count("events"), audit: await count("audit_log") }).toEqual(before);
  });

  test("lapseSubscription ends an active manual subscription's period a month back", async () => {
    const before = { events: await count("events"), audit: await count("audit_log") };
    const sub = await checkout("subscription", ids.viewer, "succeeded");
    const at = new Date(NOW.getTime() - 60_000);
    expect(await lapseSubscription(t.app, sub.paymentId, at)).toBe(1);
    const [row] = await t.sql<{ start: string; end: string; status: string }[]>`
      select current_period_start as start, current_period_end as end, status::text as status
        from subscriptions where id = ${sub.subscriptionId}::uuid`;
    expect(row?.status).toBe("active");
    expect(new Date(row?.end ?? 0).getTime()).toBe(at.getTime());
    const monthBack = new Date(at);
    monthBack.setUTCMonth(monthBack.getUTCMonth() - 1);
    expect(new Date(row?.start ?? 0).getTime()).toBe(monthBack.getTime());
    // What money-renew selects: active with the period over.
    const [due] = await t.sql<{ n: number }[]>`
      select count(*)::int as n from subscriptions where status = 'active' and current_period_end <= now()`;
    expect(due?.n).toBe(1);
    // Not active (an incomplete checkout) or no subscription (a tip): nothing moves.
    const open = await checkout("subscription", ids.other);
    expect(await lapseSubscription(t.app, open.paymentId, at)).toBe(0);
    const tip = await checkout("tip", ids.viewer, "succeeded");
    expect(await lapseSubscription(t.app, tip.paymentId, at)).toBe(0);
    expect({ events: await count("events"), audit: await count("audit_log") }).toEqual(before);
  });
});

describe("ledger report and counts", () => {
  test("every posting and reversal of the payments and every recorded cost balances and is found", async () => {
    const pay = await checkout("tip", ids.viewer, "succeeded");
    await post(
      t.app.db,
      paymentSucceeded({
        paymentId: pay.paymentId,
        paymentKind: "tip",
        provider: "manual",
        creatorUserId: ids.owner,
        grossCents: 500,
        taxCents: 0,
        feeCents: 0,
        currency: "usd",
        cut: DEFAULT_PLATFORM_CUT,
        cutHistoryId: null,
        occurredAt: NOW,
      }),
    );
    const disputeId = uuidv7();
    await t.app.db
      .insert(schema.disputes)
      .values({ id: disputeId, paymentId: pay.paymentId, kind: "refund", status: "closed", amountCents: 200 });
    await postReversal(t.app.db, {
      kind: "refund",
      disputeId,
      paymentId: pay.paymentId,
      amountCents: 200,
      occurredAt: NOW,
    });
    const costId = uuidv7();
    const cost = await post(
      t.app.db,
      infrastructureCost({
        infraCostId: costId,
        category: "hosting",
        provider: "manual",
        amountCents: 42_000,
        currency: "usd",
        occurredAt: new Date(NOW.getTime() - 40 * DAY),
      }),
    );
    await t.app.db.insert(schema.infraCosts).values({
      id: costId,
      periodStart: new Date(NOW.getTime() - 40 * DAY),
      periodEnd: new Date(NOW.getTime() - 10 * DAY),
      category: "hosting",
      description: "Application servers",
      amountCents: 42_000,
      currency: "usd",
      recordedBy: ids.treasurer,
      ledgerTransactionId: cost.transactionId,
    });

    const report = await ledgerReport(t.app, [pay.paymentId], ids.treasurer);
    expect(report.counts.ledger_transactions).toBe(3);
    expect(report.counts.ledger_entries).toBeGreaterThanOrEqual(6);
    expect(report.counts.ledger_accounts).toBeGreaterThanOrEqual(3);
    expect(unbalancedTransactions(report.rows)).toEqual([]);
    expect(report.disputes).toEqual([{ id: disputeId, paymentId: pay.paymentId, kind: "refund", status: "closed" }]);
    for (const d of report.disputes) expect(disputeReachedLedger(report.rows, d)).toBe(true);
    // Nothing personal in the append-only ledger: no username, email or display name.
    const text = JSON.stringify(
      await t.sql`select description, metadata, idempotency_key from ledger_transactions`,
    ).toLowerCase();
    for (const s of ["demo_viewer1", "demo-seed.invalid", "aurora pixel"]) expect(text).not.toContain(s);
    const memos = JSON.stringify(await t.sql`select memo from ledger_entries`).toLowerCase();
    expect(memos).not.toContain("demo_");
  });

  test("an empty payment list reports nothing", async () => {
    const report = await ledgerReport(t.app, [], null);
    expect(report).toEqual({
      rows: [],
      disputes: [],
      counts: { ledger_transactions: 0, ledger_entries: 0, ledger_accounts: 0 },
    });
  });

  test("paymentSideCounts counts the subscriptions and tips the payments created", async () => {
    const sub = await checkout("subscription", ids.treasurer);
    const tip = await checkout("tip", ids.viewer);
    expect(await paymentSideCounts(t.app, [sub.paymentId, tip.paymentId])).toEqual({ subscriptions: 1, tips: 1 });
    expect(await paymentSideCounts(t.app, [])).toEqual({ subscriptions: 0, tips: 0 });
  });

  test("splitCounts is zero for a channel without splits", async () => {
    expect(await splitCounts(t.app, [ids.channel])).toEqual({
      revenue_splits: 0,
      revenue_split_shares: 0,
      revenue_split_acceptances: 0,
      revenue_split_postings: 0,
    });
    expect(await splitCounts(t.app, [])).toEqual({});
  });
});
