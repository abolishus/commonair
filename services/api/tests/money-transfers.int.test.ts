// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * M1-connect on the API (ADR 0007 Amendment 1): a payout run's Stripe payouts are scheduled and
 * queued once each (nothing with the manual adapter), the treasurer lists the transfers, and signed
 * `transfer.reversed` / `transfer.updated` events return a reversal to the payable once (partial,
 * then full, then a redelivery), settle a transfer the worker had not recorded yet, and ignore a
 * transfer that is not ours. Audit and outbox rows follow every change.
 */
import { Queue } from "bullmq";
import { and, eq, inArray } from "drizzle-orm";
import { Valkey } from "iovalkey";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { B8_JOBS, QUEUES, payoutTransferJobId } from "@commonair/contracts/internal";
import { type Database, schema, uuidv7 } from "@commonair/db";
import {
  DEFAULT_PLATFORM_CUT,
  creatorBalances,
  openPayoutTransfer,
  paymentSucceeded,
  post,
  recordPayoutTransferCreated,
  recordPayoutTransferFailed,
  releaseDueHolds,
  runPayoutBatch,
} from "@commonair/ledger";
import { loadStripeSignature } from "@commonair/payments";
import {
  type PayoutTransferQueue,
  createPayoutTransferQueue,
  setPayoutTransferQueue,
  startPayoutTransfers,
} from "../src/money/transfers.ts";
import { matchesTransfer } from "../src/money/stripe-events/transfers.ts";
import { VALKEY_URL, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type Account = Awaited<ReturnType<typeof signUpAndSignIn>>;

const SECRET = "whsec_m1_connect";
const DAY = 86_400_000;
let api: TestApi;
let db: Database;
let treasurer: Account;
let viewer: Account;
const queued: string[][] = [];
const fakeQueue: PayoutTransferQueue = {
  enqueue: async (ids) => {
    queued.push([...ids]);
  },
  close: async () => {},
};

beforeAll(async () => {
  api = await startApi();
  db = api.db.db;
  [treasurer, viewer] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)]);
  await db.update(schema.users).set({ role: "treasurer" }).where(eq(schema.users.id, treasurer.userId));
  setPayoutTransferQueue(api.deps, fakeQueue);
}, 180_000);
afterAll(async () => {
  await api?.stop();
});

const stripeEnv = () =>
  Object.assign(api.deps.env, {
    PAYMENTS_PROVIDER: "stripe",
    STRIPE_SECRET_KEY: "sk_test_m1",
    STRIPE_WEBHOOK_SECRET: SECRET,
    STRIPE_API_BASE: "http://127.0.0.1:9",
  });
const manualEnv = () => Object.assign(api.deps.env, { PAYMENTS_PROVIDER: "manual" });

let periods = 0;
function period() {
  periods += 1;
  return {
    periodStart: new Date(Date.UTC(2091, periods, 1)),
    periodEnd: new Date(Date.UTC(2091, periods + 1, 1)),
  };
}

/** A payee with a ready Stripe account and released earnings. */
async function payee(): Promise<string> {
  const name = `m1c${uuidv7().replace(/-/g, "").slice(-10)}`;
  const [u] = await db
    .insert(schema.users)
    .values({ name, email: `${name}@example.test`, username: name })
    .returning({ id: schema.users.id });
  const id = u!.id;
  await db.insert(schema.payoutAccounts).values({
    userId: id,
    provider: "stripe",
    providerAccountId: `acct_${id.replace(/-/g, "").slice(-16)}`,
    payoutsEnabled: true,
  });
  await post(
    db,
    paymentSucceeded({
      paymentId: uuidv7(),
      paymentKind: "tip",
      provider: "stripe",
      creatorUserId: id,
      grossCents: 10_000,
      taxCents: 0,
      feeCents: 0,
      currency: "usd",
      cut: DEFAULT_PLATFORM_CUT,
      cutHistoryId: null,
      occurredAt: new Date(Date.now() - 30 * DAY),
    }),
  );
  await releaseDueHolds(db, { asOf: new Date(), holdDays: 7, currency: "usd" });
  return id;
}

async function payoutsOf(userIds: string[]) {
  return db.select().from(schema.payouts).where(inArray(schema.payouts.userId, userIds));
}

async function deliver(type: string, object: Record<string, unknown>) {
  const { signStripePayload } = await loadStripeSignature();
  const evt = {
    id: `evt_${crypto.randomUUID().replace(/-/g, "")}`,
    object: "event",
    type,
    api_version: "2024-06-20",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    data: { object },
  };
  const body = JSON.stringify(evt);
  const header = await signStripePayload(SECRET, body, Math.floor(Date.now() / 1000));
  const res = await fetch(`${api.url}/api/webhooks/stripe`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": header },
    body,
  });
  return { status: res.status, body: (await res.json()) as { outcome?: string } };
}

describe("starting a run's transfers", () => {
  test("the manual adapter schedules and queues nothing", async () => {
    manualEnv();
    const a = await payee();
    await runPayoutBatch(db, { ...period(), currency: "usd", minimumCents: 1_000 });
    const before = queued.length;
    expect(await startPayoutTransfers(api.deps)).toEqual({ scheduled: 0, enqueued: 0 });
    expect(queued.length).toBe(before);
    expect((await payoutsOf([a]))[0]?.status).toBe("pending");
  });

  test("with Stripe, two recipients' payouts are scheduled and queued once each", async () => {
    stripeEnv();
    const [a, b] = [await payee(), await payee()];
    await runPayoutBatch(db, { ...period(), currency: "usd", minimumCents: 1_000 });
    const r = await startPayoutTransfers(api.deps);
    expect(r.scheduled).toBeGreaterThanOrEqual(2);
    const ids = (await payoutsOf([a, b])).map((p) => p.id);
    const last = queued.at(-1) ?? [];
    for (const id of ids) expect(last).toContain(id);
    expect(new Set(last).size).toBe(last.length);
    expect((await payoutsOf([a, b])).every((p) => p.status === "scheduled")).toBe(true);
    manualEnv();
  });

  test("the producer queues one job per payout under its stable id, however often a run repeats", async () => {
    const prefix = `test-bull-m1c-${crypto.randomUUID()}`;
    const q = createPayoutTransferQueue(VALKEY_URL, prefix);
    const conn = new Valkey(VALKEY_URL, { maxRetriesPerRequest: null });
    const reader = new Queue(QUEUES.payments, { connection: conn, prefix });
    try {
      const id = uuidv7();
      await q.enqueue([id]);
      await q.enqueue([id]);
      const jobs = await reader.getJobs(["waiting", "delayed", "prioritized"]);
      expect(jobs.map((j) => j.id)).toEqual([payoutTransferJobId(id)]);
      expect(jobs[0]?.name).toBe(B8_JOBS.payoutTransfers);
      expect(jobs[0]?.data).toEqual({ payoutId: id });
      expect(jobs[0]?.opts.attempts).toBeGreaterThan(1);
    } finally {
      await reader.obliterate({ force: true });
      await reader.close();
      conn.disconnect();
      await q.close();
    }
  });
});

/** A payee paid by a created transfer (the worker's part done through the ledger). */
async function paidTransfer() {
  stripeEnv();
  const user = await payee();
  await runPayoutBatch(db, { ...period(), currency: "usd", minimumCents: 1_000 });
  await startPayoutTransfers(api.deps);
  const [p] = await payoutsOf([user]);
  const opened = await openPayoutTransfer(db, { payoutId: p!.id, at: new Date() });
  const t = opened.transfer!;
  return { user, payout: p!, transfer: t };
}

const transferObject = (
  t: { id: string; payoutId: string; amountCents: number; destinationRef: string },
  ref: string,
  reversed: number,
) => ({
  id: ref,
  object: "transfer",
  amount: t.amountCents,
  amount_reversed: reversed,
  currency: "usd",
  destination: t.destinationRef,
  reversed: reversed === t.amountCents,
  metadata: { payout_id: t.payoutId, transfer_id: t.id },
});

describe("money.treasurer.transfers", () => {
  test("lists by run and status for a treasurer, and refuses anyone else", async () => {
    const { payout, transfer } = await paidTransfer();
    await recordPayoutTransferCreated(db, { transferId: transfer.id, providerRef: "tr_list1", at: new Date() });
    const all = await treasurer.client.call<{ items: { id: string; status: string }[]; nextCursor: string | null }>(
      "GET",
      "/api/treasurer/payout-transfers?limit=50",
    );
    expect(all.status).toBe(200);
    expect(all.body.items.some((i) => i.id === transfer.id)).toBe(true);
    const byRun = await treasurer.client.call<{ items: Record<string, unknown>[] }>(
      "GET",
      `/api/treasurer/payout-transfers?periodStart=${encodeURIComponent(payout.periodStart.toISOString())}`,
    );
    expect(byRun.body.items).toHaveLength(1);
    expect(byRun.body.items[0]).toMatchObject({
      id: transfer.id,
      payoutId: payout.id,
      periodStart: payout.periodStart.toISOString(),
      amount: { cents: payout.amountCents, currency: "usd" },
      reversed: { cents: 0, currency: "usd" },
      status: "created",
      failureCode: null,
      providerRef: "tr_list1",
    });
    const failed = await treasurer.client.call<{ items: unknown[] }>(
      "GET",
      `/api/treasurer/payout-transfers?status=failed&periodStart=${encodeURIComponent(payout.periodStart.toISOString())}`,
    );
    expect(failed.body.items).toHaveLength(0);
    // Paging: a second run's transfer makes a second page; one per page, newest first, no repeats.
    const second = await paidTransfer();
    const p1 = await treasurer.client.call<{ items: { id: string }[]; nextCursor: string | null }>(
      "GET",
      "/api/treasurer/payout-transfers?limit=1",
    );
    expect(p1.body.items.map((i) => i.id)).toEqual([second.transfer.id]);
    expect(p1.body.nextCursor).not.toBeNull();
    const p2 = await treasurer.client.call<{ items: { id: string }[]; nextCursor: string | null }>(
      "GET",
      `/api/treasurer/payout-transfers?limit=1&cursor=${p1.body.nextCursor ?? ""}`,
    );
    expect(p2.body.items.map((i) => i.id)).toEqual([transfer.id]);
    expect(p2.body.nextCursor).toBeNull();
    expect((await viewer.client.call("GET", "/api/treasurer/payout-transfers")).status).toBe(403);
    manualEnv();
  });
});

describe("transfer webhooks", () => {
  test("partial then full reversal post once each; a redelivery and an unknown transfer change nothing", async () => {
    const { user, payout, transfer } = await paidTransfer();
    await recordPayoutTransferCreated(db, { transferId: transfer.id, providerRef: "tr_rev1", at: new Date() });
    const owed = async () => (await creatorBalances(db, user, "usd")).availableCents;
    expect(await owed()).toBe(0);

    const partial = await deliver("transfer.reversed", transferObject(transfer, "tr_rev1", 1_000));
    expect(partial).toEqual({ status: 200, body: { received: true, outcome: "transfer_reversed" } });
    expect(await owed()).toBe(1_000);
    const again = await deliver("transfer.updated", transferObject(transfer, "tr_rev1", 1_000));
    expect(again.body.outcome).toBe("duplicate");
    expect(await owed()).toBe(1_000);

    const full = await deliver("transfer.reversed", transferObject(transfer, "tr_rev1", transfer.amountCents));
    expect(full.body.outcome).toBe("transfer_reversed");
    expect(await owed()).toBe(transfer.amountCents);
    const [row] = await db.select().from(schema.payoutTransfers).where(eq(schema.payoutTransfers.id, transfer.id));
    expect(row).toMatchObject({ status: "reversed", reversedCents: transfer.amountCents });
    expect(
      (await deliver("transfer.reversed", transferObject(transfer, "tr_rev1", transfer.amountCents))).body.outcome,
    ).toBe("duplicate");
    expect(await owed()).toBe(transfer.amountCents);

    const events = await db
      .select({ payload: schema.events.payload })
      .from(schema.events)
      .where(eq(schema.events.type, "money.payout_transfer.reversed"));
    const mine = events.filter((e) => (e.payload as { transfer_id: string }).transfer_id === transfer.id);
    expect(mine).toHaveLength(2);
    const audits = await db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectType, "payout_transfer"), eq(schema.auditLog.subjectId, transfer.id)));
    expect(audits.filter((a) => a.action === "payout_transfer.reversed")).toHaveLength(2);
    expect((await db.select().from(schema.payouts).where(eq(schema.payouts.id, payout.id)))[0]?.status).toBe("paid");

    // Not ours (a patronage transfer, another platform's): ignored.
    const unknown = await deliver("transfer.reversed", {
      ...transferObject(transfer, "tr_someone_else", 500),
      metadata: {},
    });
    expect(unknown.body.outcome).toBe("ignored");
    // Ours by metadata, but not the transfer we recorded: refused as a mismatch.
    const wrong = await deliver("transfer.reversed", transferObject(transfer, "tr_other_id", 500));
    expect(wrong.body.outcome).toBe("transfer_mismatch");
    manualEnv();
  });

  test("an event before the worker recorded the transfer settles it, then reverses", async () => {
    const { payout, transfer } = await paidTransfer();
    stripeEnv();
    const r = await deliver("transfer.reversed", transferObject(transfer, "tr_early1", 700));
    expect(r.body.outcome).toBe("transfer_reversed");
    const [row] = await db.select().from(schema.payoutTransfers).where(eq(schema.payoutTransfers.id, transfer.id));
    expect(row).toMatchObject({ status: "created", providerRef: "tr_early1", reversedCents: 700 });
    expect((await db.select().from(schema.payouts).where(eq(schema.payouts.id, payout.id)))[0]?.status).toBe("paid");
    manualEnv();
  });
});

describe("orphaned transfers", () => {
  test("a Stripe transfer on a failed row posts nothing and is audited once for the treasurer", async () => {
    const { user, payout, transfer } = await paidTransfer();
    await recordPayoutTransferFailed(db, { transferId: transfer.id, failureCode: "held", at: new Date() });
    const owed = async () => (await creatorBalances(db, user, "usd")).availableCents;
    const before = await owed();
    const r = await deliver("transfer.updated", transferObject(transfer, "tr_orphan1", 0));
    expect(r).toEqual({ status: 200, body: { received: true, outcome: "transfer_orphaned" } });
    const again = await deliver("transfer.reversed", transferObject(transfer, "tr_orphan1", 0));
    expect(again.body.outcome).toBe("transfer_orphaned");
    expect(await owed()).toBe(before);
    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectId, transfer.id), eq(schema.auditLog.action, "payout_transfer.orphaned")));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.details).toEqual({ payoutId: payout.id, payeeUserId: user, transferRef: "tr_orphan1" });
    const [row] = await db.select().from(schema.payoutTransfers).where(eq(schema.payoutTransfers.id, transfer.id));
    expect(row).toMatchObject({ status: "failed", providerRef: null });
    manualEnv();
  });
});

describe("matchesTransfer", () => {
  const row = { payoutId: "p", providerRef: "tr_1", amountCents: 500, currency: "usd", destinationRef: "acct_1" };
  const a = { transferRef: "tr_1", payoutId: "p", amountCents: 500, currency: "usd", destination: "acct_1" };
  test("the same transfer matches; any difference does not", () => {
    expect(matchesTransfer(row, a)).toBe(true);
    expect(matchesTransfer({ ...row, providerRef: null }, { ...a, transferRef: "tr_new" })).toBe(true);
    expect(matchesTransfer(row, { ...a, transferRef: "tr_2" })).toBe(false);
    expect(matchesTransfer(row, { ...a, payoutId: "q" })).toBe(false);
    expect(matchesTransfer(row, { ...a, amountCents: 501 })).toBe(false);
    expect(matchesTransfer(row, { ...a, currency: "eur" })).toBe(false);
    expect(matchesTransfer(row, { ...a, destination: "acct_2" })).toBe(false);
    expect(matchesTransfer(row, { ...a, payoutId: null, destination: null })).toBe(true);
  });
});
