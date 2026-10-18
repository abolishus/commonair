// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `money.*`: not implemented in this unit (HTTP 501); a later unit replaces this file. */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const money = {
  tiers: os.money.tiers.handler(notImplemented),
  setTiers: os.money.setTiers.handler(notImplemented),
  subscribe: os.money.subscribe.handler(notImplemented),
  mySubscriptions: os.money.mySubscriptions.handler(notImplemented),
  cancelSubscription: os.money.cancelSubscription.handler(notImplemented),
  tip: os.money.tip.handler(notImplemented),
  subscribers: os.money.subscribers.handler(notImplemented),
  tips: os.money.tips.handler(notImplemented),
  revenue: os.money.revenue.handler(notImplemented),
  payouts: os.money.payouts.handler(notImplemented),
  payoutAccount: os.money.payoutAccount.handler(notImplemented),
  statement: os.money.statement.handler(notImplemented),
  treasurer: {
    pending: os.money.treasurer.pending.handler(notImplemented),
    confirm: os.money.treasurer.confirm.handler(notImplemented),
    refund: os.money.treasurer.refund.handler(notImplemented),
    chargeback: os.money.treasurer.chargeback.handler(notImplemented),
    runPayouts: os.money.treasurer.runPayouts.handler(notImplemented),
    markPaid: os.money.treasurer.markPaid.handler(notImplemented),
    recordCost: os.money.treasurer.recordCost.handler(notImplemented),
  },
};
