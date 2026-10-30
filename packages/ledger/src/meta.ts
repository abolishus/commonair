// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `PaymentMeta` v2 (ADR 0013 decision 2): the metadata a payment and its reversals carry in
 * `ledger_transactions.metadata`. Frozen in the W1 contract step; W1-breakdown reads it and
 * nobody extends it (Ledger Splits, W2, fills `splitVersionId` and crew shares within this shape).
 * Ids and amounts only, never personal data (ADR 0004).
 */
import { z } from "zod";

const Settlement = z.enum(["cash", "receivable"]);
const ShareRole = z.enum(["owner", "crew"]);

/** One recipient's slice of the creator share. A payment with no split: the owner at 10,000 bps. */
export const ShareV2 = z.object({
  userId: z.uuid(),
  role: ShareRole,
  bps: z.number().int().min(0).max(10_000),
  creatorCents: z.number().int(),
});
export type ShareV2 = z.infer<typeof ShareV2>;

/** Written by `paymentSucceeded` from W1 on. No v1 reader exists (staging is reset, ADR 0013 decision 2). */
export const PaymentMetaV2 = z.object({
  v: z.literal(2),
  paymentKind: z.enum(["subscription", "tip"]),
  /** The channel owner, payee of record (patronage reads it, `packages/patronage/src/inputs.ts`). */
  creatorUserId: z.uuid(),
  provider: z.string(),
  settlement: Settlement,
  revenueGrossCents: z.number().int().positive(),
  taxCents: z.number().int().nonnegative(),
  creatorCents: z.number().int().nonnegative(),
  coopCents: z.number().int().nonnegative(),
  feeCents: z.number().int().nonnegative(),
  streamerShare: z.number(),
  coopShare: z.number(),
  /** `governance_settings_history.id` of the `platform.cut` in effect; null = the founding seed. */
  cutHistoryId: z.uuid().nullable(),
  splitVersionId: z.uuid().nullable(),
  /** Sorted by user id; `creatorCents` sums to the payment's `creatorCents`. */
  shares: z.array(ShareV2).min(1),
});
export type PaymentMetaV2 = z.infer<typeof PaymentMetaV2>;

/** One recipient's slice of a reversal: what came from their own lot for this payment, and what the owner's other sources covered (ADR 0013 decision 5). */
export const ReversalShareV2 = z.object({
  userId: z.uuid(),
  role: ShareRole,
  creatorCents: z.number().int(),
  fromOwnLotCents: z.number().int(),
  ownerCoveredCents: z.number().int(),
});
export type ReversalShareV2 = z.infer<typeof ReversalShareV2>;

/** Written by `refund`, `chargeback` and `chargebackReversal`. */
export const ReversalMetaV2 = z.object({
  v: z.literal(2),
  disputeId: z.uuid(),
  creatorUserId: z.uuid(),
  provider: z.string(),
  settlement: Settlement,
  revenueGrossCents: z.number().int(),
  taxCents: z.number().int(),
  creatorCents: z.number().int(),
  coopCents: z.number().int(),
  receivableCents: z.number().int().optional(),
  disputeFeeCents: z.number().int().optional(),
  feeRefundCents: z.number().int().optional(),
  shares: z.array(ReversalShareV2).min(1),
});
export type ReversalMetaV2 = z.infer<typeof ReversalMetaV2>;
