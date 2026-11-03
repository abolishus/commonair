// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `money.treasurer.refundRequests.{list,resolve}` (batch 8, M1-gifts-refunds; ADR 0007 decision 3):
 * provider refund requests with their audit markers, and the audited resolve for a request whose
 * outcome Stripe never told us. Stubs until that unit fills them.
 */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const treasurerRefundRequestHandlers = {
  list: os.money.treasurer.refundRequests.list.handler(() => notImplemented()),
  resolve: os.money.treasurer.refundRequests.resolve.handler(() => notImplemented()),
};
