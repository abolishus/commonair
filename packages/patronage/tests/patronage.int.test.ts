// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Patronage inputs and the period run against a real database, as the least-privilege
 * application role.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import type { ReceiptPayload } from "@commonair/contracts/shapes";
import { schema as s, uuidv7, type Database } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import {
  DEFAULT_PLATFORM_CUT,
  accounts,
  closePeriod,
  infrastructureCost,
  paymentSucceeded,
  post,
  postReversal,
  rawBalance,
  retainedSurplus,
} from "@commonair/ledger";
import {
  PatronagePeriodOverlapError,
  PatronagePeriodStateError,
  SecondApproverError,
  SurplusUnavailableError,
  approvePeriod,
  availableSurplusCents,
  computePeriod,
  eligibleMembers,
  eligibleStreamingHours,
  relayBytesVerified,
  revenueCents,
  viewerHours,
} from "../src/index.ts";

// Suites run in parallel with every other workspace: generous deadlines for tests, and for teardown,
// since Postgres runs DROP DATABASE one at a time.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;
let db: Database;

const DAY = 86_400_000;
const HOUR = 3_600_000;
const now = Date.now();
/** Midnight UTC, five days ago: inputs land on whole UTC days inside the period. */
const day1 = Math.floor((now - 5 * DAY) / DAY) * DAY;
const day2 = day1 + DAY;
const period = { start: new Date(day1 - 2 * DAY), end: new Date(now + DAY) };

const ids: Record<"a" | "b" | "c" | "v" | "n" | "x", string> = { a: "", b: "", c: "", v: "", n: "", x: "" };
/** Two treasurers: one computes, the other approves (ADR 0020). */
const finance = { runner: "", approver: "" };
const channels: Record<string, string> = {};

let seq = 0;
async function makeUser(): Promise<string> {
  const name = `pat${++seq}`;
  const [u] = await db
    .insert(s.users)
    .values({ name, email: `${name}@example.test`, username: name })
    .returning({ id: s.users.id });
  return u!.id;
}
async function makeChannel(owner: string): Promise<{ channel: string; broadcast: string }> {
  const [c] = await db
    .insert(s.channels)
    .values({ ownerId: owner, slug: `ch${++seq}`, displayName: `Channel ${seq}` })
    .returning({ id: s.channels.id });
  const [b] = await db
    .insert(s.broadcasts)
    .values({ channelId: c!.id, ingestProtocol: "rtmp", path: `live/ch${seq}`, startedAt: new Date(day1) })
    .returning({ id: s.broadcasts.id });
  return { channel: c!.id, broadcast: b!.id };
}
async function hours(
  ch: { channel: string; broadcast: string },
  rows: { at: number; seconds: number; eligible?: boolean; viewers?: number }[],
): Promise<void> {
  await db.insert(s.streamHours).values(
    rows.map((r) => ({
      broadcastId: ch.broadcast,
      channelId: ch.channel,
      hourStart: new Date(r.at),
      liveSeconds: r.seconds,
      eligible: r.eligible ?? true,
      verifiedOtherViewers: r.viewers ?? 1,
    })),
  );
}
async function session(
  channelId: string,
  userId: string | null,
  watchSeconds: number,
  verdict: "verified" | "excluded",
  opts: { scored?: boolean; reasons?: string[] } = {},
) {
  await db.insert(s.playbackSessions).values({
    channelId,
    userId,
    deviceHash: uuidv7(),
    ipHash: uuidv7(),
    watchSeconds,
    verdict,
    verdictReasons: opts.reasons ?? [],
    scoredAt: opts.scored === false ? null : new Date(day2 + 2 * HOUR),
    startedAt: new Date(day2 + HOUR),
  });
}
async function member(userId: string, cls: "streamer" | "viewer", basis: "streaming_hours" | "share") {
  const [m] = await db.insert(s.memberships).values({ userId, class: cls, basis }).returning({ id: s.memberships.id });
  return m!.id;
}

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.app.db;
  for (const k of Object.keys(ids) as (keyof typeof ids)[]) ids[k] = await makeUser();
  for (const k of ["runner", "approver"] as const) {
    finance[k] = await makeUser();
    // Roles are granted by the operator CLI, i.e. the owner.
    await t.db.update(s.users).set({ role: "treasurer" }).where(eq(s.users.id, finance[k]));
  }

  // Streamer A: 10 eligible hours on day 1 (capped at 8), 2 on day 2, plus rows that must not count.
  const a = await makeChannel(ids.a);
  channels.a = a.channel;
  await hours(a, [
    ...Array.from({ length: 10 }, (_, i) => ({ at: day1 + (8 + i) * HOUR, seconds: 3600 })),
    { at: day2 + HOUR, seconds: 3600 },
    { at: day2 + 2 * HOUR, seconds: 3600 },
    { at: day2 + 3 * HOUR, seconds: 3600, eligible: false, viewers: 0 },
    // Inconsistent row (flagged eligible without another verified viewer): still excluded.
    { at: day2 + 4 * HOUR, seconds: 3600, eligible: true, viewers: 0 },
    // Before the period.
    { at: period.start.getTime() - 5 * HOUR, seconds: 3600 },
  ]);
  // Streamer B: 3 × 30 minutes.
  const b = await makeChannel(ids.b);
  channels.b = b.channel;
  await hours(
    b,
    [0, 1, 2].map((i) => ({ at: day2 + i * HOUR, seconds: 1800 })),
  );
  // Non-member N streams too, but is not eligible.
  const n = await makeChannel(ids.n);
  await hours(n, [{ at: day2, seconds: 3600 }]);

  // Relay operator C.
  const [relay] = await db
    .insert(s.relayNodes)
    .values({
      ownerId: ids.c,
      name: "relay",
      publicUrl: "https://relay.invalid",
      declaredCapacityMbps: 100,
      publicKey: "k",
      tokenHash: uuidv7(),
    })
    .returning({ id: s.relayNodes.id });
  const receipt = (bytes: number, status: "verified" | "rejected" | "pending", at = day2) => ({
    relayId: relay!.id,
    nonce: uuidv7(),
    periodStart: new Date(at),
    periodEnd: new Date(at + 60_000),
    bytesReported: bytes,
    segmentsReported: 1,
    tokensReported: 1,
    payload: {} as ReceiptPayload,
    signature: "sig",
    status,
    bytesVerified: status === "verified" ? bytes : 0,
  });
  await db
    .insert(s.relayReceipts)
    .values([
      receipt(5e9, "verified"),
      receipt(3e9, "verified"),
      receipt(1e10, "rejected"),
      receipt(1e9, "pending"),
      receipt(7e9, "verified", period.end.getTime() + HOUR),
    ]);

  // Viewer-hours: on A, V watches 2 h, an anonymous viewer 1 h, 30 min excluded, A's self-view ignored; on B, 1 h.
  await session(channels.a, ids.v, 7200, "verified");
  await session(channels.a, null, 3600, "verified");
  await session(channels.a, null, 1800, "excluded");
  await session(channels.a, ids.a, 3600, "verified");
  await session(channels.b, ids.v, 3600, "verified");
  // Not gate-eligible, so they earn nothing: verified by the API but never scored, and a CDN
  // session the origin never fetch-judged.
  await session(channels.a, null, 3600, "verified", { scored: false });
  await session(channels.a, null, 3600, "verified", { reasons: ["fetch_unjudged"] });

  // Revenue: A $100 then a $20 refund; B $50.
  const pa = paymentSucceeded({
    paymentId: uuidv7(),
    paymentKind: "subscription",
    provider: "stripe",
    creatorUserId: ids.a,
    grossCents: 10_000,
    taxCents: 0,
    feeCents: 0,
    currency: "usd",
    cut: DEFAULT_PLATFORM_CUT,
    occurredAt: new Date(day1 + HOUR),
  });
  await post(db, pa);
  await postReversal(db, {
    kind: "refund",
    disputeId: uuidv7(),
    paymentId: pa.refId!,
    amountCents: 2000,
    occurredAt: new Date(day2),
  });
  await post(
    db,
    paymentSucceeded({
      paymentId: uuidv7(),
      paymentKind: "tip",
      provider: "stripe",
      creatorUserId: ids.b,
      grossCents: 5000,
      taxCents: 0,
      feeCents: 0,
      currency: "usd",
      cut: DEFAULT_PLATFORM_CUT,
      occurredAt: new Date(day2),
    }),
  );

  // Surplus the co-op actually holds: an old, closed period of a non-member's revenue.
  for (const [currency, gross] of [
    ["usd", 2_000_000],
    ["eur", 100_000],
  ] as const) {
    await post(
      db,
      paymentSucceeded({
        paymentId: uuidv7(),
        paymentKind: "tip",
        provider: "stripe",
        creatorUserId: ids.n,
        grossCents: gross,
        taxCents: 0,
        feeCents: 0,
        currency,
        cut: DEFAULT_PLATFORM_CUT,
        occurredAt: new Date("2020-01-15T00:00:00Z"),
      }),
    );
    await closePeriod(db, {
      periodStart: new Date("2020-01-01T00:00:00Z"),
      periodEnd: new Date("2020-02-01T00:00:00Z"),
      currency,
    });
  }

  await member(ids.a, "streamer", "streaming_hours");
  await member(ids.b, "streamer", "streaming_hours");
  await member(ids.c, "viewer", "share");
  await member(ids.v, "viewer", "share");
  const exited = await member(ids.x, "viewer", "share");
  await db.update(s.memberships).set({ status: "exited", exitedAt: new Date() }).where(eq(s.memberships.id, exited));
});
afterAll(async () => {
  await t?.drop();
});

describe("inputs", () => {
  test("eligible streaming hours apply the daily cap and the other-viewer rule", async () => {
    expect(await eligibleStreamingHours(db, ids.a, period)).toBe(10);
    expect(await eligibleStreamingHours(db, ids.b, period)).toBe(1.5);
    expect(await eligibleStreamingHours(db, ids.a, period, 4)).toBe(4 + 2);
    expect(await eligibleStreamingHours(db, ids.v, period)).toBe(0);
  });

  test("relay bytes count only verified receipts in the period", async () => {
    expect(await relayBytesVerified(db, ids.c, period)).toBe(8e9);
    expect(await relayBytesVerified(db, ids.a, period)).toBe(0);
  });

  test("viewer-hours count gate-eligible verified sessions except self-views; excluded hours are reported", async () => {
    expect(await viewerHours(db, ids.a, period)).toEqual({ verified: 3, excluded: 0.5 });
    expect(await viewerHours(db, ids.b, period)).toEqual({ verified: 1, excluded: 0 });
  });

  test("revenue is gross net of refunds, per channel owner", async () => {
    expect(await revenueCents(db, ids.a, period, "usd")).toBe(8000);
    expect(await revenueCents(db, ids.b, period, "usd")).toBe(5000);
    expect(await revenueCents(db, ids.a, period, "eur")).toBe(0);
  });

  test("eligibility is an active membership at the period end", async () => {
    const members = await eligibleMembers(db, period.end);
    expect(members.sort()).toEqual([ids.a, ids.b, ids.c, ids.v].sort());
    expect(await eligibleMembers(db, period.start)).toEqual([]);
  });
});

describe("period run", () => {
  let periodId = "";
  const surplusCents = 100_000;

  test("computePeriod writes the period, inputs and allocations", async () => {
    const r = await computePeriod(db, {
      computedById: finance.runner,
      periodStart: period.start,
      periodEnd: period.end,
      surplusCents,
      currency: "usd",
    });
    periodId = r.periodId;
    expect(r.members).toBe(4);
    expect(r.totalCents + r.retainedCents).toBe(surplusCents);

    const [p] = await db.select().from(s.patronagePeriods).where(eq(s.patronagePeriods.id, periodId));
    expect(p).toMatchObject({ status: "computed", formulaVersion: "2026.1", surplusCents, currency: "usd" });
    expect(p!.weights).toMatchObject({ revenue: 0.5, viewerHoursChannelCap: 0.1 });

    const inputs = await db.select().from(s.patronageInputs).where(eq(s.patronageInputs.periodId, periodId));
    const inA = inputs.find((i) => i.userId === ids.a)!;
    expect(inA).toMatchObject({
      revenueCents: 8000,
      eligibleStreamingHours: 10,
      viewerHoursVerified: 3,
      viewerHoursExcluded: 0.5,
    });
    expect(inputs.find((i) => i.userId === ids.c)!.relayBytesVerified).toBe(8e9);

    const allocs = await db.select().from(s.patronageAllocations).where(eq(s.patronageAllocations.periodId, periodId));
    expect(allocs).toHaveLength(4);
    expect(allocs.reduce((sum, a) => sum + a.amountCents, 0)).toBe(r.totalCents);
    for (const a of allocs) {
      expect(a.lines).toHaveLength(4);
      expect(a.lines.reduce((sum, l) => sum + l.amountCents, 0)).toBe(a.amountCents);
    }
    // Relay pool (20%) goes entirely to C; revenue pool splits 8000:5000 between A and B.
    const c = allocs.find((a) => a.userId === ids.c)!;
    expect(c.amountCents).toBe(20_000);
    const a = allocs.find((x) => x.userId === ids.a)!;
    expect(a.lines[0]!.amountCents).toBe(Math.round((50_000 * 8000) / 13_000));
    // Two channels share viewer-hours, each capped at 10% of the 10,000 pool; the rest is retained.
    expect(r.retainedCents).toBe(8000);
  });

  test("recomputing a computed period replaces it in place", async () => {
    const again = await computePeriod(db, {
      computedById: finance.runner,
      periodStart: period.start,
      periodEnd: period.end,
      surplusCents,
      currency: "usd",
    });
    expect(again.periodId).toBe(periodId);
    const inputs = await db.select().from(s.patronageInputs).where(eq(s.patronageInputs.periodId, periodId));
    expect(inputs).toHaveLength(4);
  });

  test("available surplus counts the same period's own computed surplus as available", async () => {
    const held = await retainedSurplus(db, "usd");
    expect(await availableSurplusCents(db, { periodStart: period.start, periodEnd: period.end, currency: "usd" })).toBe(
      held,
    );
    // Any other period sees the computed run's surplus as spoken for.
    const otherStart = new Date(period.end.getTime() + 40 * DAY);
    expect(
      await availableSurplusCents(db, {
        periodStart: otherStart,
        periodEnd: new Date(otherStart.getTime() + DAY),
        currency: "usd",
      }),
    ).toBe(Math.max(0, held - surplusCents));
  });

  test("the person who ran a period cannot approve it, and nothing is posted", async () => {
    await expect(approvePeriod(db, { periodId, approvedById: finance.runner })).rejects.toThrow(SecondApproverError);
    const [p] = await db.select().from(s.patronagePeriods).where(eq(s.patronagePeriods.id, periodId));
    expect(p).toMatchObject({ status: "computed", approvedById: null, ledgerTransactionId: null });
  });

  test("approvePeriod posts allocations to the ledger, exactly once", async () => {
    const approver = finance.approver;
    const before = await rawBalance(db, accounts.retainedSurplus(), "usd");
    const r = await approvePeriod(db, { periodId, approvedById: approver });
    expect(r.approvedNow).toBe(true);
    expect(r.ledgerTransactionId).not.toBeNull();

    const rows = await db.execute<{ code: string; amount: string }>(sql`
      select a.code, e.amount_cents::text as amount from ledger_entries e
      join ledger_accounts a on a.id = e.account_id where e.transaction_id = ${r.ledgerTransactionId}`);
    const entries = [...rows].map((x) => ({ code: x.code, amount: Number(x.amount) }));
    const credits = entries.filter((e) => e.amount < 0).reduce((sum, e) => sum - e.amount, 0);
    const debit = entries.find((e) => e.code.startsWith("equity:retained-surplus"))!.amount;
    expect(credits).toBe(r.totalCents);
    expect(debit).toBe(r.totalCents);
    // What was allocated plus what the formula retained is the whole surplus.
    expect(credits + 8000).toBe(surplusCents);
    expect((await rawBalance(db, accounts.retainedSurplus(), "usd")) - before).toBe(r.totalCents);
    expect(await rawBalance(db, accounts.patronagePayable(ids.c), "usd")).toBe(-20_000);

    const [p] = await db.select().from(s.patronagePeriods).where(eq(s.patronagePeriods.id, periodId));
    expect(p).toMatchObject({ status: "approved", approvedById: approver, ledgerTransactionId: r.ledgerTransactionId });

    const again = await approvePeriod(db, { periodId, approvedById: approver });
    expect(again).toEqual({ ledgerTransactionId: r.ledgerTransactionId, totalCents: r.totalCents, approvedNow: false });
    const count = await db
      .select()
      .from(s.ledgerTransactions)
      .where(eq(s.ledgerTransactions.idempotencyKey, `patronage-allocation:${periodId}`));
    expect(count).toHaveLength(1);
  });

  test("an approved period cannot be recomputed", async () => {
    await expect(
      computePeriod(db, {
        computedById: finance.runner,
        periodStart: period.start,
        periodEnd: period.end,
        surplusCents: 1,
        currency: "usd",
      }),
    ).rejects.toThrow(PatronagePeriodStateError);
  });

  test("a period with nothing to allocate approves without a ledger posting", async () => {
    const start = new Date(period.end.getTime() + DAY);
    const end = new Date(start.getTime() + DAY);
    const r = await computePeriod(db, {
      computedById: finance.runner,
      periodStart: start,
      periodEnd: end,
      surplusCents: 0,
      currency: "usd",
    });
    // Memberships exist at that end, but there is nothing to share.
    expect(r.totalCents).toBe(0);
    const a = await approvePeriod(db, { periodId: r.periodId, approvedById: finance.approver });
    expect(a).toEqual({ ledgerTransactionId: null, totalCents: 0, approvedNow: true });
  });

  test("an overlapping period in the same currency is refused", async () => {
    await expect(
      computePeriod(db, {
        computedById: finance.runner,
        periodStart: new Date(period.start.getTime() + DAY),
        periodEnd: new Date(period.end.getTime() + DAY),
        surplusCents: 1,
        currency: "usd",
      }),
    ).rejects.toThrow(PatronagePeriodOverlapError);
  });

  test("a surplus the ledger does not hold is refused", async () => {
    const start = new Date(period.end.getTime() + 10 * DAY);
    await expect(
      computePeriod(db, {
        computedById: finance.runner,
        periodStart: start,
        periodEnd: new Date(start.getTime() + DAY),
        surplusCents: 1_000_000_000,
        currency: "usd",
      }),
    ).rejects.toThrow(SurplusUnavailableError);
  });

  test("computed periods reserve surplus, and approval re-checks the ledger", async () => {
    // Overlaps the approved usd period, but in another currency: allowed, with its own surplus.
    const held = await retainedSurplus(db, "eur");
    expect(held).toBe(10_000);
    const r = await computePeriod(db, {
      computedById: finance.runner,
      periodStart: new Date(period.start.getTime() - DAY),
      periodEnd: period.end,
      surplusCents: held,
      currency: "eur",
    });
    expect(r.totalCents).toBeGreaterThan(0);
    // The whole eur surplus is spoken for by the computed period.
    const later = new Date(period.end.getTime() + 20 * DAY);
    await expect(
      computePeriod(db, {
        computedById: finance.runner,
        periodStart: later,
        periodEnd: new Date(later.getTime() + DAY),
        surplusCents: 1,
        currency: "eur",
      }),
    ).rejects.toThrow(SurplusUnavailableError);
    // A loss closed into retained surplus before approval leaves too little to allocate.
    await post(
      db,
      infrastructureCost({
        infraCostId: uuidv7(),
        category: "hosting",
        provider: "stripe",
        amountCents: 9000,
        currency: "eur",
        occurredAt: new Date("2021-01-10T00:00:00Z"),
      }),
    );
    await closePeriod(db, {
      periodStart: new Date("2021-01-01T00:00:00Z"),
      periodEnd: new Date("2021-02-01T00:00:00Z"),
      currency: "eur",
    });
    await expect(approvePeriod(db, { periodId: r.periodId, approvedById: finance.approver })).rejects.toThrow(
      SurplusUnavailableError,
    );
  });

  test("approving an unknown period fails", async () => {
    await expect(approvePeriod(db, { periodId: uuidv7(), approvedById: finance.approver })).rejects.toThrow(
      PatronagePeriodStateError,
    );
  });
});
