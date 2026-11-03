// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `coop.patronage.{payouts,pay}` (batch 8, M1-coop-money; ADR 0020): a period's payout rows for
 * treasurers, and paying an approved period out with two approvers. Stubs until that unit fills
 * them.
 */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const patronagePayoutHandlers = {
  payouts: os.coop.patronage.payouts.handler(() => notImplemented()),
  pay: os.coop.patronage.pay.handler(() => notImplemented()),
};
