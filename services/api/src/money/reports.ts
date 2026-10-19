// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Revenue dashboard, statements, payouts, costs and transparency (E4b api-reports unit).
 * Placeholders until that unit lands; see docs/testing/e4b-selectors.md.
 */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const reportHandlers = {
  revenue: os.money.revenue.handler(notImplemented),
  revenueLedger: os.money.revenueLedger.handler(notImplemented),
  payouts: os.money.payouts.handler(notImplemented),
  payoutAccount: os.money.payoutAccount.handler(notImplemented),
  statement: os.money.statement.handler(notImplemented),
};

export const treasurerReportHandlers = {
  runPayouts: os.money.treasurer.runPayouts.handler(notImplemented),
  payouts: os.money.treasurer.payouts.handler(notImplemented),
  markPaid: os.money.treasurer.markPaid.handler(notImplemented),
  recordCost: os.money.treasurer.recordCost.handler(notImplemented),
};

export const transparencyHandler = os.coop.transparency.handler(notImplemented);
