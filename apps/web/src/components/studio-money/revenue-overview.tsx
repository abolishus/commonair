// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * d5-money (overhaul D5.7, creator-studio P7): the parts of `/revenue` that make its tiles add
 * up. The share line (from the summary's `platform.cut` split), the month as an equation, and the
 * "Finish setting up" section that sits above the reports while tiers or payouts are missing.
 */
import { MoneyAmount, formatMoney, useLocale } from "@commonair/ui";
import { Section } from "@commonair/ui/blocks/headers";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import type { MessageKey } from "../../i18n/keys/index.gen.ts";
import type { RevenueSummaryDto } from "../../lib/money.ts";
import { type EquationTerm, revenueEquation, sharePercent } from "./reconcile.ts";

/** "Your share: 90%, set by member vote" and the fee history link. The percent is `platform.cut`'s. */
export function RevenueShareLine({ split }: { split: RevenueSummaryDto["split"] }): React.JSX.Element {
  const { locale } = useLocale();
  return (
    <p
      data-testid="revenue-share-line"
      data-share={split.streamerShare}
      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm"
    >
      <span>{t("d5Money.revenue.share", { share: sharePercent(split.streamerShare, locale) })}</span>
      <Link
        to="/transparency"
        hash="fee-schedule"
        data-testid="revenue-fee-history"
        className="text-muted-foreground underline underline-offset-4 hover:text-foreground"
      >
        {t("d5Money.revenue.feeHistory")}
      </Link>
    </p>
  );
}

const TERM_KEYS: Record<EquationTerm, MessageKey> = {
  gross: "d5Money.reconcile.gross",
  coopCut: "d5Money.reconcile.coopCut",
  refunds: "d5Money.reconcile.refunds",
  other: "d5Money.reconcile.other",
  net: "d5Money.reconcile.net",
};

/**
 * The month as an equation that closes: supporters paid, less the co-op share, refunds and
 * chargebacks (and tax or crew splits when there were any), is what was earned. Then what was
 * paid out and what is reserved, which are about payouts rather than this month's earnings.
 */
export function RevenueReconcile({ summary }: { summary: RevenueSummaryDto }): React.JSX.Element {
  const { locale } = useLocale();
  const { rows, currency } = revenueEquation(summary);
  const hasOther = rows.some((r) => r.term === "other");
  return (
    <Card data-testid="revenue-reconcile" size="sm">
      <CardHeader>
        <CardTitle>{t("d5Money.reconcile.title")}</CardTitle>
        <CardDescription>
          {hasOther ? t("d5Money.reconcile.captionOther") : t("d5Money.reconcile.caption")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <dl className="flex flex-col text-sm">
          {rows.map((row) => (
            <div
              key={row.term}
              data-testid="revenue-reconcile-row"
              data-term={row.term}
              data-cents={row.cents}
              className={
                row.term === "net"
                  ? "flex items-baseline justify-between gap-3 border-t pt-2 font-semibold"
                  : "flex items-baseline justify-between gap-3 py-1"
              }
            >
              <dt className="min-w-0">{t(TERM_KEYS[row.term])}</dt>
              <dd className="shrink-0 tabular-nums">
                <MoneyAmount
                  value={{ cents: row.cents, currency }}
                  // A deduction reads "−$2.34"; gross and the result carry no sign.
                  signDisplay={row.term === "gross" || row.term === "net" ? "auto" : "exceptZero"}
                />
              </dd>
            </div>
          ))}
        </dl>
        <p
          data-testid="revenue-reconcile-payouts"
          data-paid-out={summary.paidOut.cents}
          data-pending={summary.pendingPayout.cents}
          className="text-xs text-muted-foreground"
        >
          {t("d5Money.reconcile.payouts", {
            paidOut: formatMoney(summary.paidOut.cents, summary.paidOut.currency, locale),
            pending: formatMoney(summary.pendingPayout.cents, summary.pendingPayout.currency, locale),
          })}
        </p>
      </CardContent>
    </Card>
  );
}

/** The earning setup (payout account, tiers) as one section; the route places it above or below the reports. */
export function RevenueSetup({
  complete,
  children,
}: {
  complete: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  if (complete) return <div className="flex flex-col gap-6">{children}</div>;
  return (
    <Section
      data-testid="revenue-setup"
      heading={t("d5Money.setup.title")}
      description={t("d5Money.setup.hint")}
      headingLevel={2}
    >
      <div className="flex flex-col gap-6">{children}</div>
    </Section>
  );
}
