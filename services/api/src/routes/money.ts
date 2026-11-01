// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `money.*`: checkout and payment actions in `money/checkout.ts`, reporting in `money/reports.ts`. */
import { notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";
import { breakdownHandlers } from "../money/breakdown.ts";
import { checkoutHandlers, treasurerCheckoutHandlers } from "../money/checkout.ts";
import { treasurerFraudHandlers } from "../money/fraud.ts";
import { reportHandlers, treasurerReportHandlers } from "../money/reports.ts";

/** W2 contract step: stubs the scaffolding moves to `money/splits.ts` (W2-splits implements them). */
const splitHandlers = {
  list: os.money.splits.list.handler(notImplemented),
  propose: os.money.splits.propose.handler(notImplemented),
  accept: os.money.splits.accept.handler(notImplemented),
  reject: os.money.splits.reject.handler(notImplemented),
  end: os.money.splits.end.handler(notImplemented),
};
const treasurerSplitHandlers = {
  writeOffs: os.money.treasurer.splits.writeOffs.handler(notImplemented),
  proposeWriteOff: os.money.treasurer.splits.proposeWriteOff.handler(notImplemented),
  approveWriteOff: os.money.treasurer.splits.approveWriteOff.handler(notImplemented),
  releaseSuspense: os.money.treasurer.splits.releaseSuspense.handler(notImplemented),
  forfeitSuspense: os.money.treasurer.splits.forfeitSuspense.handler(notImplemented),
};

export const money = {
  ...checkoutHandlers,
  ...reportHandlers,
  ...breakdownHandlers,
  splits: splitHandlers,
  treasurer: {
    ...treasurerCheckoutHandlers,
    ...treasurerReportHandlers,
    fraudFlags: treasurerFraudHandlers,
    splits: treasurerSplitHandlers,
  },
};
