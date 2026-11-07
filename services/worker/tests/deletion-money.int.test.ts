// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Account deletion ends the subscriptions the user pays and the ones paid on their channel, and
 * takes the user out of the co-op (fix F0 of the 2026-11 design overhaul). Provider subscriptions
 * are cancelled at the provider first, and a failure blocks (and backs off) the deletion; in the
 * transaction pending payments fail, subscriptions end now, incomplete ones expire, memberships
 * exit and a held share waits for the treasurer's refund. Runs as the app role against the
 * stack's Postgres and Valkey.
 */
import { schema, uuidv7 } from "@commonair/db";
import { post, sharePurchase } from "@commonair/ledger";
import { StripeRequestError } from "@commonair/payments";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { runAccountDeletions } from "../src/deletion/account-deletion.ts";
import { type RenewalPort, renewalPortFromEnv } from "../src/deletion/money.ts";
import { makeUser, setup, type TestEnv } from "./fixtures.ts";

const s = schema;
let env: TestEnv;

beforeAll(async () => {
  env = await setup({ jobs: [], outbox: false, segments: false });
  env.worker.ctx.db = env.t.app.db;
  env.worker.ctx.sql = env.t.app.sql;
});
afterAll(() => env?.close());

const ctx = () => env.worker.ctx;
const db = () => env.t.db;
const DAY = 86_400_000;
let refN = 0;
const ref = (p = "CA-D") => `${p}${String(++refN).padStart(7, "0")}`;
/** Run due deletions with no backoff, so a blocked one is retried by the next call. */
const run = (port: RenewalPort | null = null) => runAccountDeletions(ctx(), 20, port, 0);

type Call = { ref: string; atPeriodEnd: boolean; idempotencyKey: string };
function stripePort(fail: (ref: string) => Error | null = () => null): RenewalPort & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    provider: "stripe",
    calls,
    cancelSubscription: async (r, o) => {
      calls.push({ ref: r, ...o });
      const err = fail(r);
      if (err) throw err;
    },
  };
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

async function pendingPayment(sub: {
  id: string;
  subscriberId: string;
  channelId: string;
  provider: "manual" | "stripe";
}) {
  const [row] = await db()
    .insert(s.payments)
    .values({
      id: uuidv7(),
      provider: sub.provider,
      providerRef: ref(sub.provider === "stripe" ? "cs_" : "CA-D"),
      kind: "subscription",
      userId: sub.subscriberId,
      channelId: sub.channelId,
      subscriptionId: sub.id,
      amountCents: 500,
      currency: "usd",
      tier: 1,
      expiresAt: new Date(Date.now() + 5 * DAY),
    })
    .returning();
  return row!;
}

async function schedule(userId: string) {
  const [d] = await env.t.app.db
    .insert(s.accountDeletions)
    .values({ userId, scheduledFor: new Date(Date.now() - 1000) })
    .returning();
  return d!;
}

const subRow = async (id: string) => (await db().select().from(s.subscriptions).where(eq(s.subscriptions.id, id)))[0]!;
const payStatus = async (id: string) => (await db().select().from(s.payments).where(eq(s.payments.id, id)))[0]!.status;
const deletionStatus = async (id: string) =>
  (await db().select().from(s.accountDeletions).where(eq(s.accountDeletions.id, id)))[0]!.status;

describe("account deletion and subscriptions", () => {
  test("manual: every subscription the user pays ends now and pending payments fail; gifts and others untouched", async () => {
    const { user } = await makeUser(db());
    const active = await subscription({ subscriberId: user.id });
    const pastDue = await subscription({ subscriberId: user.id, status: "past_due" });
    const renewal = await pendingPayment(pastDue);
    const incomplete = await subscription({ subscriberId: user.id, status: "incomplete", currentPeriodEnd: null });
    const first = await pendingPayment(incomplete);
    const gifter = (await makeUser(db())).user;
    const gift = await subscription({ subscriberId: user.id, giftedById: gifter.id });
    const someoneElse = await subscription({ subscriberId: gifter.id });

    const d = await schedule(user.id);
    expect(await run()).toMatchObject({ completed: 1, failed: 0, blocked: 0 });
    expect(await deletionStatus(d.id)).toBe("completed");

    expect(await subRow(active.id)).toMatchObject({ status: "canceled", cancelAtPeriodEnd: false });
    expect(await subRow(pastDue.id)).toMatchObject({ status: "canceled" });
    expect(await subRow(incomplete.id)).toMatchObject({ status: "expired" });
    expect(await payStatus(renewal.id)).toBe("failed");
    expect(await payStatus(first.id)).toBe("failed");
    expect(await subRow(gift.id)).toMatchObject({ status: "active", cancelAtPeriodEnd: false });
    expect(await subRow(someoneElse.id)).toMatchObject({ status: "active", cancelAtPeriodEnd: false });

    const [done] = await db()
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.action, "account.deletion.complete"), eq(s.auditLog.subjectId, user.id)));
    expect(done?.details).toMatchObject({
      deleted: { subscriptions_ended: 2, subscriptions_incomplete_expired: 1, subscription_payments_failed: 2 },
    });
  });

  test("a creator's deletion ends the subscriptions paid on their channel; gifts run out", async () => {
    const creator = await makeUser(db());
    const fan = (await makeUser(db())).user;
    const fanSub = await subscription({ subscriberId: fan.id, channelId: creator.channel.id });
    const fanRenewal = await pendingPayment(fanSub);
    const giftedFan = await subscription({
      subscriberId: (await makeUser(db())).user.id,
      channelId: creator.channel.id,
      giftedById: fan.id,
    });

    await schedule(creator.user.id);
    expect(await run()).toMatchObject({ completed: 1, failed: 0 });
    expect(await subRow(fanSub.id)).toMatchObject({ status: "canceled" });
    expect(await payStatus(fanRenewal.id)).toBe("failed");
    expect(await subRow(giftedFan.id)).toMatchObject({ status: "active" });

    // The end event names the (now pseudonymized) creator as broadcaster: the outbox scrub removes it.
    const ends = await db()
      .select()
      .from(s.events)
      .where(and(eq(s.events.type, "channel.subscription.end"), eq(s.events.channelId, creator.channel.id)));
    expect(ends).toHaveLength(0);
  });

  test("stripe: cancelled at the provider now, the user's and their channel's; a 404 counts as done", async () => {
    const creator = await makeUser(db());
    const stripeSub = (over: Partial<typeof s.subscriptions.$inferInsert> = {}) =>
      subscription({ subscriberId: creator.user.id, provider: "stripe", providerRef: ref("sub_"), ...over });
    const active = await stripeSub();
    const pastDue = await stripeSub({ status: "past_due" });
    const alreadyEnding = await stripeSub({ cancelAtPeriodEnd: true });
    const gone = await stripeSub();
    const fan = (await makeUser(db())).user;
    const fanSub = await stripeSub({ subscriberId: fan.id, channelId: creator.channel.id });
    const port = stripePort((r) =>
      r === gone.providerRef
        ? new StripeRequestError("No such subscription", 404, "invalid_request_error", "resource_missing")
        : null,
    );
    await schedule(creator.user.id);
    expect(await run(port)).toMatchObject({ completed: 1, failed: 0 });

    expect(port.calls).toEqual(
      expect.arrayContaining(
        [active, pastDue, fanSub, gone].map((x) => ({
          ref: x.providerRef,
          atPeriodEnd: false,
          idempotencyKey: `deletion-cancel-${x.id}-now`,
        })),
      ),
    );
    expect(port.calls).toHaveLength(4);
    for (const x of [active, pastDue, alreadyEnding, fanSub, gone])
      expect(await subRow(x.id)).toMatchObject({ status: "canceled" });
  });

  test("a provider failure blocks the deletion untouched, backs off, and a later run completes it", async () => {
    const { user } = await makeUser(db());
    const active = await subscription({ subscriberId: user.id, provider: "stripe", providerRef: ref("sub_") });
    const d = await schedule(user.id);
    const broken = stripePort(() => new Error("provider unavailable"));

    expect(await run(broken)).toMatchObject({ completed: 0, failed: 1, blocked: 1 });
    expect(await deletionStatus(d.id)).toBe("scheduled");
    expect(await subRow(active.id)).toMatchObject({ status: "active", cancelAtPeriodEnd: false });
    const [u] = await db().select().from(s.users).where(eq(s.users.id, user.id));
    expect(u!.deletedAt).toBeNull();

    // No provider at all, or one of another kind: still blocked.
    expect(await run(null)).toMatchObject({ completed: 0, blocked: 1 });
    expect(await run({ provider: "manual", cancelSubscription: async () => {} })).toMatchObject({ blocked: 1 });

    // With a backoff, a blocked deletion is skipped until it expires, and the others still run.
    expect(await runAccountDeletions(ctx(), 20, broken, 60_000)).toMatchObject({ blocked: 1 });
    const other = await schedule((await makeUser(db())).user.id);
    expect(await runAccountDeletions(ctx(), 20, stripePort(), 60_000)).toMatchObject({ completed: 1, blocked: 0 });
    expect(await deletionStatus(other.id)).toBe("completed");
    expect(await deletionStatus(d.id)).toBe("scheduled");
    await ctx().valkey.del(`worker:deletions:blocked:${d.id}`);

    const port = stripePort();
    expect(await run(port)).toMatchObject({ completed: 1, failed: 0 });
    expect(port.calls).toHaveLength(1);
    expect(await deletionStatus(d.id)).toBe("completed");
    expect(await subRow(active.id)).toMatchObject({ status: "canceled" });
  });
});

describe("account deletion and the co-op", () => {
  test("every active membership exits and a held share waits for the treasurer's refund", async () => {
    const { user } = await makeUser(db());
    const now = new Date();
    const [viewer] = await db()
      .insert(s.memberships)
      .values({ id: uuidv7(), userId: user.id, class: "viewer", basis: "share", joinedAt: now })
      .returning();
    const [streamer] = await db()
      .insert(s.memberships)
      .values({ id: uuidv7(), userId: user.id, class: "streamer", basis: "streaming_hours", joinedAt: now })
      .returning();
    // A held share: its payment succeeded and its purchase is posted (the share trigger checks both).
    const [pay] = await db()
      .insert(s.payments)
      .values({
        id: uuidv7(),
        provider: "manual",
        providerRef: ref(),
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

    await schedule(user.id);
    expect(await run()).toMatchObject({ completed: 1, failed: 0 });

    const ms = await db().select().from(s.memberships).where(eq(s.memberships.userId, user.id));
    expect(ms.map((m) => m.status)).toEqual(["exited", "exited"]);
    expect(ms.every((m) => m.exitedAt !== null)).toBe(true);
    const [sh] = await db().select().from(s.membershipShares).where(eq(s.membershipShares.id, share!.id));
    expect(sh!.status).toBe("refund_pending");

    const audits = await db()
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.actorType, "system"), eq(s.auditLog.reason, "account_deleted")));
    const mine = audits.filter((a) => [viewer!.id, streamer!.id, share!.id].includes(a.subjectId));
    expect(mine.map((a) => a.action).sort()).toEqual([
      "coop.share.refund_request",
      "membership.exit",
      "membership.exit",
    ]);
    expect(mine.find((a) => a.action === "coop.share.refund_request")!.details).toEqual({
      shareId: share!.id,
      amountCents: 500,
    });
  });

  test("an account with no money or co-op rows is deleted as before", async () => {
    const { user } = await makeUser(db());
    const d = await schedule(user.id);
    expect(await run()).toMatchObject({ completed: 1, failed: 0 });
    expect(await deletionStatus(d.id)).toBe("completed");
  });
});

describe("renewalPortFromEnv", () => {
  test("builds the configured provider, or none when it cannot", () => {
    expect(renewalPortFromEnv({ PAYMENTS_PROVIDER: "manual" })?.provider).toBe("manual");
    expect(renewalPortFromEnv({ PAYMENTS_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_x" })?.provider).toBe(
      "stripe",
    );
    expect(renewalPortFromEnv({ PAYMENTS_PROVIDER: "nonsense" })).toBeNull();
  });
});
