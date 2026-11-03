// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState } from "@commonair/ui";
import { MoneyReceive01Icon } from "@hugeicons/core-free-icons";
import type * as React from "react";
import { t } from "../../i18n/index.ts";

/**
 * Treasury `refunds` tab: outstanding refund requests (`money.treasurer.refundRequests`). Batch 8
 * contract step stub; M1-gifts-refunds fills it.
 */
export function RefundRequests(): React.JSX.Element {
  return (
    <EmptyState
      data-testid="refund-requests"
      icon={MoneyReceive01Icon}
      headingLevel={3}
      title={t("refundRequests.empty.title")}
      description={t("refundRequests.empty.body")}
    />
  );
}
