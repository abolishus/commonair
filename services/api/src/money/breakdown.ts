// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `money.paymentBreakdown(s)` (feature-wins §4.1): where a payment's money went. HTTP 501 until W1-breakdown implements them. */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";

export const breakdownHandlers = {
  paymentBreakdown: os.money.paymentBreakdown.handler(notImplemented),
  paymentBreakdowns: os.money.paymentBreakdowns.handler(notImplemented),
};
