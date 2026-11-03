// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Connect transfer webhooks (batch 8, M1-connect; ADR 0007 Amendment 1, decision (f)). Stubs until
 * that unit fills them: a reversal above the recorded `reversed_cents` will post
 * `payoutTransferReversed` for the difference, raise `reversed_cents`, and write the
 * `money.payout_transfer.reversed` event and an audit row, in the webhook's transaction.
 */
import type { Executor } from "@commonair/db";
import type { StripeAction } from "@commonair/payments";
import type { AppliedAction } from "../stripe-events.ts";

type TransferAction = Extract<StripeAction, { type: "transfer.reversed" | "transfer.updated" }>;

export async function transferReversed(_tx: Executor, _a: TransferAction, _now: Date): Promise<AppliedAction> {
  return { outcome: "ignored", invalidate: [], cancelProviderSubscriptions: [] };
}

export async function transferUpdated(_tx: Executor, _a: TransferAction, _now: Date): Promise<AppliedAction> {
  return { outcome: "ignored", invalidate: [], cancelProviderSubscriptions: [] };
}
