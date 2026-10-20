// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth.ts";
import { channels } from "./channels.ts";
import {
  cents,
  createdAt,
  disputeKind,
  disputeStatus,
  id,
  paymentKind,
  paymentProvider,
  paymentStatus,
  payoutStatus,
  subscriptionStatus,
  ts,
  updatedAt,
} from "./_shared.ts";

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: id(),
    subscriberId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "restrict" }),
    tier: smallint().notNull(),
    status: subscriptionStatus().notNull().default("incomplete"),
    provider: paymentProvider().notNull(),
    providerRef: text(),
    priceCents: cents().notNull(),
    currency: text().notNull(),
    currentPeriodStart: ts(),
    currentPeriodEnd: ts(),
    cancelAtPeriodEnd: boolean().notNull().default(false),
    giftedById: uuid().references(() => users.id, { onDelete: "set null" }),
    /** The gift payment that paid for this subscription (one payment can buy many gift subs). */
    giftPaymentId: uuid().references((): AnyPgColumn => payments.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("subscriptions_channel_idx").on(t.channelId, t.status),
    uniqueIndex("subscriptions_active_uq")
      .on(t.subscriberId, t.channelId)
      .where(sql`${t.status} in ('active', 'past_due', 'incomplete')`),
    uniqueIndex("subscriptions_provider_ref_uq").on(t.provider, t.providerRef),
    index("subscriptions_gift_payment_idx").on(t.giftPaymentId),
    /** The worker's renewal scan (`money-renew`). */
    index("subscriptions_period_end_active_idx")
      .on(t.currentPeriodEnd)
      .where(sql`${t.status} = 'active'`),
    check("subscriptions_tier_range", sql`${t.tier} between 1 and 3`),
  ],
);

export const tips = pgTable(
  "tips",
  {
    id: id(),
    fromUserId: uuid().references(() => users.id, { onDelete: "set null" }),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "restrict" }),
    amountCents: cents().notNull(),
    currency: text().notNull(),
    message: text().notNull().default(""),
    anonymous: boolean().notNull().default(false),
    paymentId: uuid(),
    status: paymentStatus().notNull().default("pending"),
    createdAt: createdAt(),
  },
  (t) => [index("tips_channel_idx").on(t.channelId, t.createdAt)],
);

/** One row per money movement attempt with a provider. */
export const payments = pgTable(
  "payments",
  {
    id: id(),
    provider: paymentProvider().notNull(),
    providerRef: text().notNull(),
    kind: paymentKind().notNull(),
    status: paymentStatus().notNull().default("pending"),
    userId: uuid().references(() => users.id, { onDelete: "set null" }),
    channelId: uuid().references(() => channels.id, { onDelete: "set null" }),
    subscriptionId: uuid().references(() => subscriptions.id, { onDelete: "set null" }),
    tipId: uuid().references(() => tips.id, { onDelete: "set null" }),
    amountCents: cents().notNull(),
    taxCents: cents().notNull().default(0),
    feeCents: cents().notNull().default(0),
    currency: text().notNull(),
    refundedCents: cents().notNull().default(0),
    /** Subscription tier paid for (subscriptions and gifts); null for tips and shares. */
    tier: smallint(),
    /** Gift subs bought by this payment; 1 otherwise. `amountCents` is the total. */
    quantity: smallint().notNull().default(1),
    /** A pending payment not confirmed by then expires as failed (manual adapter). */
    expiresAt: ts(),
    succeededAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("payments_provider_ref_uq").on(t.provider, t.providerRef),
    index("payments_channel_idx").on(t.channelId),
    index("payments_status_idx").on(t.status, t.createdAt),
    index("payments_user_idx").on(t.userId, t.createdAt),
    /** The worker's expiry scan (`money-expire-pending`). */
    index("payments_expires_pending_idx")
      .on(t.expiresAt)
      .where(sql`${t.status} = 'pending'`),
    check("payments_quantity_range", sql`${t.quantity} between 1 and 100`),
    check("payments_tier_range", sql`${t.tier} is null or ${t.tier} between 1 and 3`),
    check("payments_amount_positive", sql`${t.amountCents} > 0`),
    check("payments_currency_format", sql`${t.currency} ~ '^[a-z]{3}$'`),
    check("payments_refund_bounds", sql`${t.refundedCents} >= 0 and ${t.refundedCents} <= ${t.amountCents}`),
  ],
);

/** Inbound provider webhooks, stored before processing for idempotency and replay. */
export const paymentEvents = pgTable(
  "payment_events",
  {
    id: id(),
    provider: paymentProvider().notNull(),
    providerEventId: text().notNull(),
    type: text().notNull(),
    payload: jsonb().$type<unknown>().notNull(),
    receivedAt: ts().notNull().defaultNow(),
    processedAt: ts(),
    error: text(),
    attempts: smallint().notNull().default(0),
  },
  (t) => [uniqueIndex("payment_events_uq").on(t.provider, t.providerEventId)],
);

export const disputes = pgTable(
  "disputes",
  {
    id: id(),
    paymentId: uuid()
      .notNull()
      .references(() => payments.id, { onDelete: "restrict" }),
    kind: disputeKind().notNull(),
    status: disputeStatus().notNull().default("open"),
    amountCents: cents().notNull(),
    providerRef: text(),
    reason: text(),
    createdAt: createdAt(),
    resolvedAt: ts(),
  },
  (t) => [index("disputes_payment_idx").on(t.paymentId)],
);

export const payoutAccounts = pgTable("payout_accounts", {
  id: id(),
  userId: uuid()
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  provider: paymentProvider().notNull(),
  /** Provider account id (e.g. a Connect Express account) or, for `manual`, the treasurer's reference. */
  providerAccountId: text(),
  /** Onboarding complete and able to receive payouts. */
  payoutsEnabled: boolean().notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const payouts = pgTable(
  "payouts",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    periodStart: ts().notNull(),
    periodEnd: ts().notNull(),
    amountCents: cents().notNull(),
    currency: text().notNull(),
    status: payoutStatus().notNull().default("pending"),
    provider: paymentProvider().notNull(),
    providerRef: text(),
    holdReason: text(),
    ledgerTransactionId: uuid(),
    createdAt: createdAt(),
    paidAt: ts(),
  },
  (t) => [
    index("payouts_user_idx").on(t.userId, t.periodStart),
    uniqueIndex("payouts_period_uq").on(t.userId, t.periodStart),
  ],
);

/** Infrastructure costs recorded by the treasurer; feed the transparency page and surplus. */
export const infraCosts = pgTable(
  "infra_costs",
  {
    id: id(),
    periodStart: ts().notNull(),
    periodEnd: ts().notNull(),
    category: text().notNull(),
    description: text().notNull(),
    amountCents: cents().notNull(),
    currency: text().notNull(),
    recordedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    ledgerTransactionId: uuid(),
    createdAt: createdAt(),
  },
  (t) => [index("infra_costs_period_idx").on(t.periodStart)],
);
