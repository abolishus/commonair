// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState } from "@commonair/ui";
import { MoneySend01Icon } from "@hugeicons/core-free-icons";
import type * as React from "react";
import { t } from "../../i18n/index.ts";

/**
 * Treasury `transfers` tab: the Stripe Connect transfers of payout runs
 * (`money.treasurer.transfers`). Batch 8 contract step stub; M1-connect fills it.
 */
export function PayoutTransfers(): React.JSX.Element {
  return (
    <EmptyState
      data-testid="payout-transfers"
      icon={MoneySend01Icon}
      headingLevel={3}
      title={t("payoutTransfers.empty.title")}
      description={t("payoutTransfers.empty.body")}
    />
  );
}
