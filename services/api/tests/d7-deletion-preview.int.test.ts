// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `me.deletion.preview` (overhaul wave 4, D7.4): every field from the caller's own rows, and only
 * theirs. The worker's deletion (services/worker/src/deletion/money.ts) is what the fields promise:
 * paid non-gift subscriptions end, unpaid earnings stay owed, memberships exit and a held share is
 * refunded only when the bylaws say so.
 */
import { and, count, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import { paymentSucceeded, post } from "@commonair/ledger";
import { unpaidCents } from "../src/deletion/preview.ts";
import { client, signUpAndSignIn, startApi, uniqueName, type TestApi } from "./harness.ts";

type Person = Awaited<ReturnType<typeof signUpAndSignIn>>;
interface Money {
  cents: number;
  currency: string;
}
interface Preview {
  graceDays: number;
  activeSubscriptions: number;
  channelSubscriptions: number;
  pendingPayout: Money | null;
  memberships: { class: string; shareRefund: Money | null }[];
  legalHold: boolean;
  scheduled: { id: string; status: string; scheduledFor: string } | null;
}

let api: TestApi;
const db = () => api.db.db;
const PATH = "/api/me/deletion/preview";

async function preview(who: Person): Promise<Preview> {
  const r = await who.client.call<Preview>("GET", PATH);
  expect(r.status).toBe(200);
  return r.body;
}

async function channelOf(who: Person): Promise<string> {
  const [c] = await db()
    .select({ id: schema.channels.id })
    .from(schema.channels)
    .where(eq(schema.channels.ownerId, who.userId));
  if (!c) throw new Error("no channel");
  return c.id;
}

async function subscribe(
  subscriber: Person,
  channel: Person,
  over: Partial<typeof schema.subscriptions.$inferInsert> = {},
): Promise<void> {
  await db()
    .insert(schema.subscriptions)
    .values({
      subscriberId: subscriber.userId,
      channelId: await channelOf(channel),
      tier: 1,
      status: "active",
      provider: "manual",
      providerRef: uniqueName("ref"),
      priceCents: 500,
      currency: "usd",
      ...over,
    });
}

beforeAll(async () => {
  api = await startApi();
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

describe("unpaidCents", () => {
  test("adds released, held and reserved earnings", () => {
    expect(unpaidCents({ availableCents: 100, holdCents: 20, reservedCents: 3 })).toBe(123);
  });
  test("a receivable larger than released earnings counts as nothing owed, not a debt", () => {
    expect(unpaidCents({ availableCents: -500, holdCents: 50, reservedCents: 0 })).toBe(50);
  });
  test("nothing is zero", () => {
    expect(unpaidCents({ availableCents: 0, holdCents: 0, reservedCents: 0 })).toBe(0);
  });
});

describe("me.deletion.preview", () => {
  test("signed out is refused", async () => {
    const r = await client(api).call("GET", PATH);
    expect(r.status).toBe(401);
  });

  test("a new account: the grace period and nothing else", async () => {
    const fresh = await signUpAndSignIn(api);
    expect(await preview(fresh)).toMatchObject({
      graceDays: 30,
      activeSubscriptions: 0,
      channelSubscriptions: 0,
      pendingPayout: null,
      memberships: [],
      legalHold: false,
      scheduled: null,
    });
  });

  test("subscriptions: paid ones the caller pays for and paid ones on the caller's channel; never gifts", async () => {
    const [me, a, b, c, d, fan] = await Promise.all([
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
    ]);
    await subscribe(me, a);
    await subscribe(me, b, { status: "past_due" });
    // Not counted: a gift the caller received, an unpaid start and an ended one.
    await subscribe(me, c, { giftedById: fan.userId });
    await subscribe(me, d, { status: "incomplete" });
    await subscribe(me, fan, { status: "canceled" });
    // On the caller's channel: one paid, one gift.
    await subscribe(fan, me);
    await subscribe(a, me, { giftedById: fan.userId });
    const p = await preview(me);
    expect(p.activeSubscriptions).toBe(2);
    expect(p.channelSubscriptions).toBe(1);
    // Other people's previews count their own rows only.
    const pa = await preview(a);
    expect([pa.activeSubscriptions, pa.channelSubscriptions]).toEqual([0, 1]);
    const pf = await preview(fan);
    expect([pf.activeSubscriptions, pf.channelSubscriptions]).toEqual([1, 0]);
  });

  test("pendingPayout: the creator's unpaid earnings in the instance currency, from the ledger", async () => {
    const [creator, payer] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)]);
    expect((await preview(creator)).pendingPayout).toBeNull();
    const occurredAt = new Date();
    const paymentId = uuidv7(occurredAt.getTime());
    await db()
      .insert(schema.payments)
      .values({
        id: paymentId,
        provider: "manual",
        providerRef: `CA-${uniqueName("r").toUpperCase()}`,
        kind: "tip",
        status: "succeeded",
        gift: false,
        userId: payer.userId,
        channelId: await channelOf(creator),
        amountCents: 1000,
        currency: "usd",
        quantity: 1,
        succeededAt: occurredAt,
      });
    await post(
      db(),
      paymentSucceeded({
        paymentId,
        paymentKind: "tip",
        provider: "manual",
        settlement: "cash",
        creatorUserId: creator.userId,
        grossCents: 1000,
        taxCents: 0,
        feeCents: 0,
        currency: "usd",
        cut: { streamerShare: 0.9, coopShare: 0.1 },
        cutHistoryId: null,
        occurredAt,
      }),
    );
    expect((await preview(creator)).pendingPayout).toEqual({ cents: 900, currency: "usd" });
    // The payer earned nothing.
    expect((await preview(payer)).pendingPayout).toBeNull();
  });

  test("memberships: each active class; a held viewer share is refunded only when the bylaws say so", async () => {
    const member = await signUpAndSignIn(api);
    await db()
      .insert(schema.memberships)
      .values([
        { userId: member.userId, class: "viewer", basis: "share" },
        { userId: member.userId, class: "streamer", basis: "streaming_hours" },
        { userId: member.userId, class: "worker", basis: "board_appointment", status: "exited", exitedAt: new Date() },
      ]);
    // No share yet: nothing to refund.
    // In class order (MEMBER_CLASSES); the exited worker membership is gone.
    expect((await preview(member)).memberships).toEqual([
      { class: "streamer", shareRefund: null },
      { class: "viewer", shareRefund: null },
    ]);

    // A held share (its purchase is out of scope here, so the guard is bypassed by the owner).
    await db().transaction(async (tx) => {
      await tx.execute(sql`alter table membership_shares disable trigger membership_shares_guard`);
      await tx.insert(schema.membershipShares).values({
        userId: member.userId,
        amountCents: 500,
        currency: "usd",
        status: "held",
        purchasedAt: new Date(),
      });
      await tx.execute(sql`alter table membership_shares enable trigger membership_shares_guard`);
    });
    expect((await preview(member)).memberships).toEqual([
      { class: "streamer", shareRefund: null },
      { class: "viewer", shareRefund: { cents: 500, currency: "usd" } },
    ]);

    // Bylaws without a refund on exit: the share stays with the co-op.
    const [setting] = await db()
      .select({ value: schema.governanceSettings.value })
      .from(schema.governanceSettings)
      .where(eq(schema.governanceSettings.key, "membership.classes"));
    const value = setting?.value as { viewer: Record<string, unknown> };
    const setRefundable = async (on: boolean) =>
      db().transaction(async (tx) => {
        await tx.execute(sql`alter table governance_settings disable trigger governance_settings_guard`);
        await tx
          .update(schema.governanceSettings)
          .set({ value: { ...value, viewer: { ...value.viewer, shareRefundableOnExit: on } } })
          .where(eq(schema.governanceSettings.key, "membership.classes"));
        await tx.execute(sql`alter table governance_settings enable trigger governance_settings_guard`);
      });
    await setRefundable(false);
    try {
      expect((await preview(member)).memberships[1]).toEqual({ class: "viewer", shareRefund: null });
    } finally {
      await setRefundable(true);
    }
  });

  test("legalHold: only an active litigation hold is shown; other holds are never disclosed", async () => {
    const held = await signUpAndSignIn(api);
    await db()
      .insert(schema.legalHolds)
      .values({ userId: held.userId, reason: "preservation request", reasonCode: "law_enforcement" });
    expect((await preview(held)).legalHold).toBe(false);
    const [h] = await db()
      .insert(schema.legalHolds)
      .values({ userId: held.userId, reason: "litigation", reasonCode: "litigation" })
      .returning({ id: schema.legalHolds.id });
    expect((await preview(held)).legalHold).toBe(true);
    await db()
      .update(schema.legalHolds)
      .set({ releasedAt: new Date(), releaseReason: "settled" })
      .where(eq(schema.legalHolds.id, h?.id ?? ""));
    expect((await preview(held)).legalHold).toBe(false);
  });

  test("scheduled: the scheduled request, and the preview writes nothing", async () => {
    const leaving = await signUpAndSignIn(api);
    const r = await leaving.client.call<{ id: string; scheduledFor: string }>("POST", "/api/me/deletion", {
      confirmUsername: leaving.username,
    });
    expect(r.status).toBe(200);
    const rows = async () =>
      (
        await db()
          .select({ n: count() })
          .from(schema.accountDeletions)
          .where(eq(schema.accountDeletions.userId, leaving.userId))
      )[0]?.n;
    const before = await rows();
    const p = await preview(leaving);
    expect(p.scheduled).toMatchObject({ id: r.body.id, status: "scheduled", scheduledFor: r.body.scheduledFor });
    expect(await rows()).toBe(before);
    // Canceled reads as none.
    expect((await leaving.client.call("DELETE", "/api/me/deletion")).status).toBe(200);
    expect((await preview(leaving)).scheduled).toBeNull();
    const audits = await db()
      .select({ n: count() })
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.subjectId, leaving.userId), eq(schema.auditLog.action, "account.deletion.preview")),
      );
    expect(audits[0]?.n).toBe(0);
  });
});
