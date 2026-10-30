// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MoneyAmount, formatMoney, useLocale } from "@commonair/ui";
import { KeyValueList } from "@commonair/ui/blocks/data";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { type SupportInfo, splitCents } from "../../lib/support.ts";

export type FeeEstimate = NonNullable<SupportInfo["feeEstimate"]>;

/**
 * The "typical fee" range for `totalCents` (`PROCESSOR_FEE_ESTIMATE`): rate × total + the fixed
 * part, rounded to the cent, at the low and the high rate. Null for nothing to pay.
 */
export function estimateFeeRange(
  totalCents: number,
  estimate: FeeEstimate,
): { lowCents: number; highCents: number } | null {
  const total = Math.max(0, Math.trunc(totalCents));
  if (total === 0) return null;
  const at = (bps: number) => Math.round((total * bps) / 10_000) + estimate.fixedCents;
  return { lowCents: at(estimate.lowBps), highCents: at(estimate.highBps) };
}

export interface BreakdownEstimateProps {
  totalCents: number;
  currency: string;
  split: SupportInfo["split"];
  /** Null when the provider charges no fee (manual): only the fee row and its hint are left out. */
  feeEstimate: SupportInfo["feeEstimate"];
}

/** The Support dialog's "estimated split" for the chosen amount, labelled an estimate. */
export function BreakdownEstimate({
  totalCents,
  currency,
  split,
  feeEstimate,
}: BreakdownEstimateProps): React.JSX.Element | null {
  const { locale } = useLocale();
  const titleId = React.useId();
  if (Math.trunc(totalCents) <= 0) return null;
  const range = feeEstimate ? estimateFeeRange(totalCents, feeEstimate) : null;
  const parts = splitCents(totalCents, split);
  const money = (cents: number) => ({ cents, currency });
  return (
    <section
      data-testid="breakdown-estimate"
      data-low-cents={range?.lowCents}
      data-high-cents={range?.highCents}
      aria-labelledby={titleId}
      className="flex flex-col gap-2 text-sm"
    >
      <h3 id={titleId} className="font-medium">
        {t("breakdown.estimate.title", { total: formatMoney(totalCents, currency, locale) })}
      </h3>
      <KeyValueList
        dense
        rows={[
          { term: t("breakdown.estimate.creator"), value: <MoneyAmount value={money(parts.creator)} /> },
          { term: t("breakdown.estimate.coop"), value: <MoneyAmount value={money(parts.coop)} /> },
          ...(range
            ? [
                {
                  term: t("breakdown.estimate.fee"),
                  value: t("breakdown.estimate.feeRange", {
                    low: formatMoney(range.lowCents, currency, locale),
                    high: formatMoney(range.highCents, currency, locale),
                  }),
                },
              ]
            : []),
        ]}
      />
      <p className="text-xs text-muted-foreground">
        {range && <>{t("breakdown.estimate.hint")} </>}
        <Link to="/transparency" hash="fee-schedule" className="underline underline-offset-4">
          {t("breakdown.estimate.link")}
        </Link>
      </p>
    </section>
  );
}
