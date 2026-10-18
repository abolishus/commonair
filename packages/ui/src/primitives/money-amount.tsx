// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { formatMoney, type FormatMoneyOptions } from "../lib/format.ts";
import { useResolvedLocale } from "../lib/locale.tsx";
import { cn } from "../lib/utils.ts";

/** Same shape as the contracts `Money` DTO: integer minor units plus an ISO 4217 code. */
export interface MoneyValue {
  cents: number;
  currency: string;
}

export interface MoneyAmountProps extends Omit<React.ComponentProps<"data">, "children" | "value">, FormatMoneyOptions {
  value: MoneyValue;
  locale?: string;
  /** Colors negative amounts with the destructive token (ledger views). */
  colorNegative?: boolean;
}

/** Formatted currency amount. The raw minor-unit value is kept in `<data value>` for copy/paste and tests. */
export function MoneyAmount({
  value,
  locale,
  signDisplay,
  currencyDisplay,
  colorNegative = false,
  className,
  ...props
}: MoneyAmountProps): React.JSX.Element {
  const resolved = useResolvedLocale(locale);
  return (
    <data
      data-slot="money-amount"
      value={value.cents}
      className={cn("tabular-nums", colorNegative && value.cents < 0 && "text-destructive", className)}
      {...props}
    >
      {formatMoney(value.cents, value.currency, resolved, { signDisplay, currencyDisplay })}
    </data>
  );
}
