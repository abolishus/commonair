// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `money.treasurer.transfers` (batch 8, M1-connect; ADR 0007 Amendment 1): the Connect transfer
 * of each Stripe payout, by payout run. A stub until that unit fills it.
 */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const treasurerTransferHandlers = {
  transfers: os.money.treasurer.transfers.handler(() => notImplemented()),
};
