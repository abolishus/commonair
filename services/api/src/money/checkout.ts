// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Checkout, subscriptions and tips for viewers and channel owners (E4b api-checkout unit). The
 * treasurer's actions are in `checkout-treasurer.ts`; the state machines are in README.md.
 */
import { and, desc, eq, inArray, lt, notInArray, sql } from "drizzle-orm";
import { MONEY_LIMITS } from "@commonair/contracts/currency";
import { type Executor, schema, uuidv7 } from "@commonair/db";
import { loadMoneySettings } from "@commonair/ledger";
import { type PaymentAdapter, createAdapter, manualInstructions } from "@commonair/payments";
import type { Deps } from "../deps.ts";
import { decodeCursor, encodeCursor, isKeyCursor, pageOf } from "../lib/cursor.ts";
import { channelBySlug, iso } from "../lib/dto.ts";
import { badRequest, conflict, forbidden, notFound, precondition } from "../lib/errors.ts";
import { os, requireCaller, requireChannel } from "../lib/orpc.ts";
import {
  GIFT_POOL_CHAT_DAYS,
  HOLDING_SUBSCRIPTION_STATUSES,
  cancelProblem,
  giftInputProblem,
  giftTotalCents,
  validateTiers,
} from "./checkout-rules.ts";
import {
  endSubscriptions,
  holdingSubscription,
  invalidateSubscribers,
  loadTiers,
  subscriptionDtos,
  toSubscriptionDto,
  violatesConstraint,
} from "./checkout-shared.ts";
import { treasurerCheckoutHandlers } from "./checkout-treasurer.ts";

export { treasurerCheckoutHandlers };

const { subscriptions, payments, tips, users, channels, channelSubTiers } = schema;
type ChannelRow = typeof schema.channels.$inferSelect;

type CheckoutResult =
  | { kind: "redirect"; url: string; paymentId: string }
  | {
      kind: "instructions";
      paymentId: string;
      reference: string;
      instructions: string;
      amount: { cents: number; currency: string };
    };

const DAY_MS = 86_400_000;

/**
 * Run a checkout transaction, again on the rare unique conflict: a reference collision
 * (`payments_provider_ref_uq`) mints a new one; a slot taken concurrently
 * (`subscriptions_active_uq`) re-reads the state (same pending checkout, or a fresh gift draw).
 */
async function withCheckoutRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (attempt < 3 && violatesConstraint(err, "payments_provider_ref_uq", "subscriptions_active_uq")) continue;
      if (violatesConstraint(err, "subscriptions_active_uq"))
        throw conflict("A recipient's subscription changed while checking out; try again");
      throw err;
    }
  }
}

function result(
  start: Awaited<ReturnType<PaymentAdapter["startCheckout"]>>,
  paymentId: string,
  amountCents: number,
  currency: string,
): CheckoutResult {
  if (start.kind === "redirect") return { kind: "redirect", url: start.url, paymentId };
  return {
    kind: "instructions",
    paymentId,
    reference: start.providerRef,
    instructions: start.instructions,
    amount: { cents: amountCents, currency },
  };
}

function payable(c: ChannelRow | null, callerId: string): ChannelRow {
  if (!c) throw notFound("Channel not found");
  if (c.ownerId === callerId) throw forbidden("You cannot pay your own channel");
  if (c.suspendedAt) throw precondition("channel_active", "This channel cannot take payments right now");
  return c;
}

function returnUrls(deps: Deps, returnPath: string | undefined, c: ChannelRow) {
  const base = deps.env.PUBLIC_URL.replace(/\/+$/, "");
  const url = `${base}${returnPath ?? `/${c.slug}`}`;
  return { successUrl: url, cancelUrl: url };
}

/**
 * Users who may receive a gift sub to the channel: not the gifter or owner, not a bot, deleted or
 * suspended account, not banned or timed out in the channel, and holding no subscription to it.
 */
function eligibleRecipient(channel: ChannelRow, gifterId: string, now: Date) {
  const at = now.toISOString();
  return sql`u.id <> ${gifterId} and u.id <> ${channel.ownerId}
    and u.account_type <> 'bot' and u.deleted_at is null
    and not (u.banned and (u.ban_expires is null or u.ban_expires > ${at}::timestamptz))
    and not exists (select 1 from chat_bans b where b.channel_id = ${channel.id} and b.user_id = u.id
      and b.lifted_at is null and (b.expires_at is null or b.expires_at > ${at}::timestamptz))
    and not exists (select 1 from subscriptions s where s.channel_id = ${channel.id} and s.subscriber_id = u.id
      and s.status in ('active', 'past_due', 'incomplete'))`;
}

async function drawGiftRecipients(
  tx: Executor,
  channel: ChannelRow,
  gifterId: string,
  count: number,
  now: Date,
): Promise<string[]> {
  const since = new Date(now.getTime() - GIFT_POOL_CHAT_DAYS * DAY_MS).toISOString();
  const rows = await tx.execute<{ id: string }>(sql`
    select u.id from users u
    where u.id in (
      select m.user_id from chat_messages m where m.channel_id = ${channel.id} and m.created_at > ${since}::timestamptz
      union
      select f.follower_id from follows f where f.channel_id = ${channel.id} and f.excluded_at is null
    ) and ${eligibleRecipient(channel, gifterId, now)}
    order by random()
    limit ${count}`);
  return rows.map((r) => r.id);
}

async function isEligibleRecipient(tx: Executor, channel: ChannelRow, gifterId: string, userId: string, now: Date) {
  const rows = await tx.execute<{ id: string }>(
    sql`select u.id from users u where u.id = ${userId} and ${eligibleRecipient(channel, gifterId, now)}`,
  );
  return rows.length === 1;
}

export const checkoutHandlers = {
  support: os.money.support.handler(async ({ context, input }) => {
    const { deps } = context;
    const c = await channelBySlug(deps, input.channel);
    if (!c) throw notFound("Channel not found");
    const { cut } = await loadMoneySettings(deps.db);
    const caller = context.caller;
    return {
      provider: deps.env.PAYMENTS_PROVIDER,
      currency: deps.env.CURRENCY,
      tiers: await loadTiers(deps.db, c.id, deps.env.CURRENCY),
      split: { streamerShare: cut.streamerShare, coopShare: cut.coopShare },
      tip: {
        minCents: MONEY_LIMITS.tipMinCents,
        maxCents: MONEY_LIMITS.tipMaxCents,
        messageMaxLength: MONEY_LIMITS.tipMessageMaxLength,
      },
      gift: { maxCount: MONEY_LIMITS.giftMaxCount },
      viewer: caller
        ? {
            subscription: await holdingSubscription(deps.db, caller.user.id, c.id),
            isOwner: c.ownerId === caller.user.id,
          }
        : null,
    };
  }),

  tiers: os.money.tiers.handler(async ({ context, input }) => {
    const { deps } = context;
    const c = await channelBySlug(deps, input.channel);
    if (!c) throw notFound("Channel not found");
    return loadTiers(deps.db, c.id, deps.env.CURRENCY);
  }),

  setTiers: os.money.setTiers.handler(async ({ context, input }) => {
    const { deps } = context;
    const c = requireChannel(context);
    const checked = validateTiers(input.tiers, deps.env.CURRENCY);
    if (!checked.ok) throw badRequest(checked.reason);
    const now = deps.now();
    // Existing subscriptions keep their price_cents until renewal; new checkouts read these rows.
    await deps.db.transaction(async (tx) => {
      for (const t of checked.rows)
        await tx
          .insert(channelSubTiers)
          .values({ channelId: c.id, tier: t.tier, name: t.name, priceCents: t.priceCents, benefits: t.benefits })
          .onConflictDoUpdate({
            target: [channelSubTiers.channelId, channelSubTiers.tier],
            set: { name: t.name, priceCents: t.priceCents, benefits: t.benefits, updatedAt: now },
          });
    });
    return loadTiers(deps.db, c.id, deps.env.CURRENCY);
  }),

  subscribe: os.money.subscribe.handler(async ({ context, input }): Promise<CheckoutResult> => {
    const { deps } = context;
    const caller = requireCaller(context);
    const c = payable(await channelBySlug(deps, input.channel), caller.user.id);
    if (input.gift) {
      const problem = giftInputProblem(input.gift, caller.user.username);
      if (problem) throw badRequest(problem);
    }
    const tiers = await loadTiers(deps.db, c.id, deps.env.CURRENCY);
    const tier = tiers.find((t) => t.tier === input.tier);
    if (!tier) throw precondition("tiers", "This channel has not set up subscriptions yet");
    const adapter = createAdapter(deps.env);
    const currency = deps.env.CURRENCY;
    const urls = returnUrls(deps, input.returnPath, c);
    const pendingDays = deps.env.PAYMENT_PENDING_DAYS;
    const gift = input.gift;

    if (!gift)
      return withCheckoutRetry(() =>
        deps.db.transaction(async (tx) => {
          const now = deps.now();
          const [held] = await tx
            .select()
            .from(subscriptions)
            .where(
              and(
                eq(subscriptions.subscriberId, caller.user.id),
                eq(subscriptions.channelId, c.id),
                inArray(subscriptions.status, [...HOLDING_SUBSCRIPTION_STATUSES]),
              ),
            )
            .for("update");
          if (held && held.status !== "incomplete") throw conflict("You already subscribe to this channel");
          if (held) {
            if (held.giftPaymentId) throw conflict("A gifted subscription to this channel is waiting for payment");
            // The same pending checkout again: same payment, same reference.
            const [p] = await tx
              .select()
              .from(payments)
              .where(and(eq(payments.subscriptionId, held.id), eq(payments.status, "pending")))
              .orderBy(desc(payments.createdAt))
              .limit(1);
            if (!p) throw conflict("Your subscription is being updated; try again shortly");
            if (p.provider !== "manual") throw conflict("Your checkout is still open with the payment provider");
            return {
              kind: "instructions" as const,
              paymentId: p.id,
              reference: p.providerRef,
              instructions: manualInstructions(
                deps.env.MANUAL_PAYMENT_INSTRUCTIONS,
                p.providerRef,
                p.amountCents,
                p.currency,
              ),
              amount: { cents: p.amountCents, currency: p.currency },
            };
          }
          const paymentId = uuidv7();
          const subscriptionId = uuidv7();
          const start = await adapter.startCheckout({
            paymentId,
            kind: "subscription",
            amountCents: tier.price.cents,
            currency,
            tier: tier.tier,
            quantity: 1,
            recurring: true,
            payerUserId: caller.user.id,
            creatorUserId: c.ownerId,
            ...urls,
          });
          await tx.insert(subscriptions).values({
            id: subscriptionId,
            subscriberId: caller.user.id,
            channelId: c.id,
            tier: tier.tier,
            status: "incomplete",
            provider: adapter.provider,
            priceCents: tier.price.cents,
            currency,
          });
          await tx.insert(payments).values({
            id: paymentId,
            provider: adapter.provider,
            providerRef: start.providerRef,
            kind: "subscription",
            status: "pending",
            userId: caller.user.id,
            channelId: c.id,
            subscriptionId,
            amountCents: tier.price.cents,
            currency,
            tier: tier.tier,
            quantity: 1,
            expiresAt: new Date(now.getTime() + pendingDays * DAY_MS),
          });
          return result(start, paymentId, tier.price.cents, currency);
        }),
      );

    return withCheckoutRetry(() =>
      deps.db.transaction(async (tx) => {
        const now = deps.now();
        let recipients: string[];
        if (gift.to !== undefined) {
          const [to] = await tx.select({ id: users.id }).from(users).where(eq(users.username, gift.to.toLowerCase()));
          if (!to) throw notFound("No user with that name");
          if (!(await isEligibleRecipient(tx, c, caller.user.id, to.id, now)))
            throw precondition("gift_recipient", "That viewer cannot receive a gift sub to this channel right now");
          recipients = [to.id];
        } else {
          recipients = await drawGiftRecipients(tx, c, caller.user.id, gift.count, now);
          if (recipients.length < gift.count)
            throw precondition(
              "gift_recipients",
              recipients.length === 0
                ? "No viewers can receive a gift sub to this channel right now"
                : `Only ${recipients.length} ${recipients.length === 1 ? "viewer" : "viewers"} can receive a gift sub to this channel right now`,
            );
        }
        const amountCents = giftTotalCents(tier.price.cents, recipients.length);
        const paymentId = uuidv7();
        const start = await adapter.startCheckout({
          paymentId,
          kind: "subscription",
          amountCents,
          currency,
          tier: tier.tier,
          quantity: recipients.length,
          recurring: false,
          payerUserId: caller.user.id,
          creatorUserId: c.ownerId,
          ...urls,
        });
        // Gift payments carry no subscription_id; their subscriptions point back via gift_payment_id.
        await tx.insert(payments).values({
          id: paymentId,
          provider: adapter.provider,
          providerRef: start.providerRef,
          kind: "subscription",
          status: "pending",
          userId: caller.user.id,
          channelId: c.id,
          amountCents,
          currency,
          tier: tier.tier,
          quantity: recipients.length,
          expiresAt: new Date(now.getTime() + pendingDays * DAY_MS),
        });
        await tx.insert(subscriptions).values(
          recipients.map((subscriberId) => ({
            subscriberId,
            channelId: c.id,
            tier: tier.tier,
            status: "incomplete" as const,
            provider: adapter.provider,
            priceCents: tier.price.cents,
            currency,
            giftedById: caller.user.id,
            giftPaymentId: paymentId,
          })),
        );
        return result(start, paymentId, amountCents, currency);
      }),
    );
  }),

  mySubscriptions: os.money.mySubscriptions.handler(async ({ context }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    return subscriptionDtos(deps.db, eq(subscriptions.subscriberId, caller.user.id), { limit: 200 });
  }),

  cancelSubscription: os.money.cancelSubscription.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const [current] = await subscriptionDtos(
      deps.db,
      and(eq(subscriptions.id, input.id), eq(subscriptions.subscriberId, caller.user.id)),
      { limit: 1 },
    );
    if (!current) throw notFound("Subscription not found");
    const problem = cancelProblem(current);
    if (problem)
      throw problem.code === "CONFLICT" ? conflict(problem.reason) : precondition("not_gift", problem.reason);
    if (current.status === "past_due") {
      // The period is already over: end it now and fail the open renewal so a late confirm cannot
      // revive it. Lock order: payment row before subscription row (as the worker's expiry job).
      const ended = await deps.db.transaction(async (tx) => {
        const now = deps.now();
        const renewals = await tx
          .select({ id: payments.id })
          .from(payments)
          .where(and(eq(payments.subscriptionId, current.id), eq(payments.status, "pending")))
          .for("update");
        if (renewals.length > 0)
          await tx
            .update(payments)
            .set({ status: "failed", updatedAt: now })
            .where(
              and(
                inArray(
                  payments.id,
                  renewals.map((r) => r.id),
                ),
                eq(payments.status, "pending"),
              ),
            );
        const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.id, current.id)).for("update");
        if (!sub || sub.status !== "past_due") throw conflict("This subscription changed; reload and try again");
        const [c] = await tx.select().from(channels).where(eq(channels.id, sub.channelId));
        if (!c) throw notFound("Channel not found");
        await endSubscriptions(tx, c, eq(subscriptions.id, sub.id), now);
        const [row] = await tx.select().from(subscriptions).where(eq(subscriptions.id, sub.id));
        if (!row) throw notFound("Subscription not found");
        return { row, channelId: c.id };
      });
      await invalidateSubscribers(deps, ended.channelId, [caller.user.id]);
      return toSubscriptionDto(ended.row, current.channelSlug, current.subscriber);
    }
    if (current.cancelAtPeriodEnd) return current;
    const [row] = await deps.db
      .update(subscriptions)
      .set({ cancelAtPeriodEnd: true, updatedAt: deps.now() })
      .where(
        and(
          eq(subscriptions.id, input.id),
          eq(subscriptions.subscriberId, caller.user.id),
          eq(subscriptions.status, "active"),
        ),
      )
      .returning();
    if (!row) throw conflict("This subscription changed; reload and try again");
    return toSubscriptionDto(row, current.channelSlug, current.subscriber);
  }),

  tip: os.money.tip.handler(async ({ context, input }): Promise<CheckoutResult> => {
    const { deps } = context;
    const caller = requireCaller(context);
    const c = payable(await channelBySlug(deps, input.channel), caller.user.id);
    const message = input.message.trim();
    if (message.length > MONEY_LIMITS.tipMessageMaxLength) throw badRequest("The tip message is too long");
    const adapter = createAdapter(deps.env);
    const currency = deps.env.CURRENCY;
    const urls = returnUrls(deps, input.returnPath, c);
    return withCheckoutRetry(() =>
      deps.db.transaction(async (tx) => {
        const now = deps.now();
        const paymentId = uuidv7();
        const tipId = uuidv7();
        const start = await adapter.startCheckout({
          paymentId,
          kind: "tip",
          amountCents: input.amountCents,
          currency,
          quantity: 1,
          recurring: false,
          payerUserId: caller.user.id,
          creatorUserId: c.ownerId,
          ...urls,
        });
        // Anonymous tips keep from_user_id (refunds need it); the channel never sees it.
        await tx.insert(tips).values({
          id: tipId,
          fromUserId: caller.user.id,
          channelId: c.id,
          amountCents: input.amountCents,
          currency,
          message,
          anonymous: input.anonymous,
          paymentId,
          status: "pending",
        });
        await tx.insert(payments).values({
          id: paymentId,
          provider: adapter.provider,
          providerRef: start.providerRef,
          kind: "tip",
          status: "pending",
          userId: caller.user.id,
          channelId: c.id,
          tipId,
          amountCents: input.amountCents,
          currency,
          quantity: 1,
          expiresAt: new Date(now.getTime() + deps.env.PAYMENT_PENDING_DAYS * DAY_MS),
        });
        return result(start, paymentId, input.amountCents, currency);
      }),
    );
  }),

  subscribers: os.money.subscribers.handler(async ({ context, input }) => {
    const { deps } = context;
    const c = requireChannel(context);
    const cur = decodeCursor(input.cursor, isKeyCursor);
    const rows = await subscriptionDtos(
      deps.db,
      and(
        eq(subscriptions.channelId, c.id),
        inArray(subscriptions.status, ["active", "past_due"]),
        cur ? lt(subscriptions.id, cur.id) : undefined,
      ),
      { limit: input.limit + 1 },
    );
    return pageOf(
      rows,
      input.limit,
      (r) => r,
      (last) => encodeCursor({ t: last.createdAt, id: last.id }),
    );
  }),

  tips: os.money.tips.handler(async ({ context, input }) => {
    const { deps } = context;
    const c = requireChannel(context);
    const cur = decodeCursor(input.cursor, isKeyCursor);
    // Confirmed tips only (and what became of them); pending and failed tips are not income.
    const rows = await deps.db
      .select({ t: tips, uid: users.id, username: users.username, name: users.name })
      .from(tips)
      .leftJoin(users, eq(users.id, tips.fromUserId))
      .where(
        and(
          eq(tips.channelId, c.id),
          notInArray(tips.status, ["pending", "failed"]),
          cur ? lt(tips.id, cur.id) : undefined,
        ),
      )
      .orderBy(desc(tips.id))
      .limit(input.limit + 1);
    return pageOf(
      rows,
      input.limit,
      (r) => ({
        id: r.t.id,
        channelSlug: c.slug,
        from:
          r.t.anonymous || r.uid === null || r.username === null || r.name === null
            ? null
            : { id: r.uid, username: r.username, displayName: r.name },
        amount: { cents: r.t.amountCents, currency: r.t.currency },
        message: r.t.message,
        status: r.t.status,
        createdAt: iso(r.t.createdAt),
      }),
      (last) => encodeCursor({ t: iso(last.t.createdAt), id: last.t.id }),
    );
  }),
};
