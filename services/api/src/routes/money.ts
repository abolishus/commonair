// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `money.*`: checkout and payment actions in `money/checkout.ts`, reporting in `money/reports.ts`. */
import { breakdownHandlers } from "../money/breakdown.ts";
import { checkoutHandlers, treasurerCheckoutHandlers } from "../money/checkout.ts";
import { treasurerFraudHandlers } from "../money/fraud.ts";
import { reportHandlers, treasurerReportHandlers } from "../money/reports.ts";

export const money = {
  ...checkoutHandlers,
  ...reportHandlers,
  ...breakdownHandlers,
  treasurer: { ...treasurerCheckoutHandlers, ...treasurerReportHandlers, fraudFlags: treasurerFraudHandlers },
};
