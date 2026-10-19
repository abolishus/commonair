// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Checkout, subscriptions, tips and the treasurer's payment actions (E4b api-checkout unit).
 * Placeholders until that unit lands; see docs/testing/e4b-selectors.md.
 */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const checkoutHandlers = {
  support: os.money.support.handler(notImplemented),
  tiers: os.money.tiers.handler(notImplemented),
  setTiers: os.money.setTiers.handler(notImplemented),
  subscribe: os.money.subscribe.handler(notImplemented),
  mySubscriptions: os.money.mySubscriptions.handler(notImplemented),
  cancelSubscription: os.money.cancelSubscription.handler(notImplemented),
  tip: os.money.tip.handler(notImplemented),
  subscribers: os.money.subscribers.handler(notImplemented),
  tips: os.money.tips.handler(notImplemented),
};

export const treasurerCheckoutHandlers = {
  payments: os.money.treasurer.payments.handler(notImplemented),
  confirm: os.money.treasurer.confirm.handler(notImplemented),
  refund: os.money.treasurer.refund.handler(notImplemented),
  chargeback: os.money.treasurer.chargeback.handler(notImplemented),
  setPayoutAccount: os.money.treasurer.setPayoutAccount.handler(notImplemented),
};
