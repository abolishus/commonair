// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `money.*`: checkout and payment actions in `money/checkout.ts`, reporting in `money/reports.ts`,
 * revenue splits in `money/splits.ts` (W2-splits).
 */
import { breakdownHandlers } from "../money/breakdown.ts";
import { checkoutHandlers, treasurerCheckoutHandlers } from "../money/checkout.ts";
import { treasurerFraudHandlers } from "../money/fraud.ts";
import { refundRecheckHandler, treasurerOutcomeHandlers } from "../money/outcome-unknown.ts";
import { treasurerRefundRequestHandlers } from "../money/refund-requests.ts";
import { reportHandlers, treasurerReportHandlers } from "../money/reports.ts";
import { splitHandlers, treasurerSplitHandlers } from "../money/splits.ts";
import { treasurerTransferHandlers } from "../money/transfers.ts";

export const money = {
  ...checkoutHandlers,
  ...reportHandlers,
  ...breakdownHandlers,
  splits: splitHandlers,
  treasurer: {
    ...treasurerCheckoutHandlers,
    ...treasurerReportHandlers,
    ...treasurerTransferHandlers,
    ...treasurerOutcomeHandlers,
    fraudFlags: treasurerFraudHandlers,
    splits: treasurerSplitHandlers,
    refundRequests: { ...treasurerRefundRequestHandlers, recheck: refundRecheckHandler },
  },
};
