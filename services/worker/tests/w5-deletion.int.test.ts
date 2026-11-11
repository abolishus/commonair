// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overhaul wave 5 (ADR 0042) at completion: subscriptions whose renewal the request already
 * stopped (`renewal_stopped_by_deletion_id`) still end now, as F0 does, with no automatic refund;
 * a provider subscription already ending at period end is not called again; the rest ends as
 * before. A held share left `refund_pending` is named by reference in the completed notice, so
 * the person can still claim it after the account is gone. Runs as the app role.
 */
import { schema, uuidv7 } from "@commonair/db";
import { MemoryMailer } from "@commonair/email";
import { post, sharePurchase } from "@commonair/ledger";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { runAccountDeletions } from "../src/deletion/account-deletion.ts";
import { type RenewalPort, shareReferenceOf } from "../src/deletion/money.ts";
import { siteAt } from "./e6-fixtures.ts";
import { makeUser, setup, type TestEnv } from "./fixtures.ts";

const s = schema;
const site = siteAt("http://localhost:3000");
const mailer = new MemoryMailer({ site });
let env: TestEnv;

beforeAll(async () => {
  env = await setup({ jobs: [], outbox: false, segments: false, mailer, site });
  env.worker.ctx.db = env.t.app.db;
  env.worker.ctx.sql = env.t.app.sql;
});
afterAll(() => env?.close());

const db = () => env.t.db;
const DAY = 86_400_000;
const run = (port: RenewalPort | null = null) => runAccountDeletions(env.worker.ctx, 20, port, 0);
let refN = 0;
const ref = (p: string) => `${p}${Date.now().toString(36)}${String(++refN).padStart(5, "0")}`;

function stripePort(): RenewalPort & { calls: string[] } {
  const calls: string[] = [];
  return { provider: "stripe", calls, cancelSubscription: async (r) => void calls.push(r) };
}

async function subscription(over: Partial<typeof s.subscriptions.$inferInsert> & { subscriberId: string }) {
  const channel = over.channelId ?? (await makeUser(db())).channel.id;
  const [row] = await db()
    .insert(s.subscriptions)
    .values({
      id: uuidv7(),
      tier: 1,
      provider: "manual",
      priceCents: 500,
      currency: "usd",
      status: "active",
      currentPeriodEnd: new Date(Date.now() + 10 * DAY),
      ...over,
      channelId: channel,
    })
    .returning();
  return row!;
}
const subRow = async (id: string) => (await db().select().from(s.subscriptions).where(eq(s.subscriptions.id, id)))[0]!;

/** A deletion requested 30 days ago and due now, as `me.deletion.request` would have left it. */
async function dueDeletion(userId: string) {
  const [d] = await env.t.app.db
    .insert(s.accountDeletions)
    .values({ userId, requestedAt: new Date(Date.now() - 30 * DAY), scheduledFor: new Date(Date.now() - 1000) })
    .returning();
  return d!;
}

describe("completion after renewal stopped (ADR 0042)", () => {
  test("marked subscriptions still end now; a provider one already ending is not called", async () => {
    const { user, channel } = await makeUser(db());
    const d = await dueDeletion(user.id);
    const marked = { cancelAtPeriodEnd: true, renewalStoppedByDeletionId: d.id };
    const manual = await subscription({ subscriberId: user.id, ...marked });
    const card = await subscription({ subscriberId: user.id, provider: "stripe", providerRef: ref("sub_"), ...marked });
    const fan = (await makeUser(db())).user;
    const onChannel = await subscription({ subscriberId: fan.id, channelId: channel.id, ...marked });
    // Created after the request (the race the request leaves): still renewing, still ended.
    const late = await subscription({ subscriberId: user.id, provider: "stripe", providerRef: ref("sub_") });

    const port = stripePort();
    expect(await run(port)).toMatchObject({ completed: 1, failed: 0, blocked: 0 });
    expect(port.calls).toEqual([late.providerRef]);
    for (const sub of [manual, card, onChannel, late])
      // Ended now; renewal flag off, so the 0060 trigger dropped the marker.
      expect(await subRow(sub.id)).toMatchObject({
        status: "canceled",
        cancelAtPeriodEnd: false,
        renewalStoppedByDeletionId: null,
      });
  });

  test("the completed notice names the share still owed by its bank-transfer reference", async () => {
    const { user } = await makeUser(db());
    const now = new Date();
    await db()
      .insert(s.memberships)
      .values({ id: uuidv7(), userId: user.id, class: "viewer", basis: "share", joinedAt: now });
    const bankRef = ref("CA-W");
    const [pay] = await db()
      .insert(s.payments)
      .values({
        id: uuidv7(),
        provider: "manual",
        providerRef: bankRef,
        kind: "membership_share",
        userId: user.id,
        amountCents: 500,
        currency: "usd",
        status: "succeeded",
        succeededAt: now,
      })
      .returning();
    const [share] = await db()
      .insert(s.membershipShares)
      .values({ userId: user.id, amountCents: 500, currency: "usd", paymentId: pay!.id })
      .returning();
    await post(
      db(),
      sharePurchase({
        shareId: share!.id,
        userId: user.id,
        provider: "manual",
        settlement: "cash",
        amountCents: 500,
        currency: "usd",
        occurredAt: now,
      }),
    );
    await db()
      .update(s.membershipShares)
      .set({ status: "held", purchasedAt: now })
      .where(eq(s.membershipShares.id, share!.id));

    await dueDeletion(user.id);
    expect(await run()).toMatchObject({ completed: 1, failed: 0 });
    const [sh] = await db().select().from(s.membershipShares).where(eq(s.membershipShares.id, share!.id));
    expect(sh!.status).toBe("refund_pending");
    const sent = mailer.to(user.email);
    expect(sent.map((m) => m.template)).toEqual(["accountDeletionCompleted"]);
    expect(sent[0]!.text).toContain(bankRef);
    expect(sent[0]!.text).toContain("$5.00");
  });
});

describe("shareReferenceOf", () => {
  test("the manual payment's reference, else the share id", () => {
    const share = { id: "0195f0c2-6a4b-7c3d-8e9f-0a1b2c3d4e5f" };
    expect(shareReferenceOf(share, { provider: "manual", providerRef: "CA-123" })).toBe("CA-123");
    expect(shareReferenceOf(share, { provider: "stripe", providerRef: "pi_1" })).toBe(share.id);
    expect(shareReferenceOf(share, { provider: "manual", providerRef: null })).toBe(share.id);
    expect(shareReferenceOf(share, undefined)).toBe(share.id);
  });
});
