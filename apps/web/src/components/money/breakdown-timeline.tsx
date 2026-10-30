// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MoneyAmount, RelativeTime, formatDateTime, formatNumber, useLocale } from "@commonair/ui";
import { Timeline } from "@commonair/ui/blocks/data";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t, type MessageKey } from "../../i18n/index.ts";
import type { PaymentBreakdownDto } from "./breakdown-table.tsx";

type EventKind = PaymentBreakdownDto["timeline"][number]["kind"];

const EVENT_LABEL: Record<EventKind, MessageKey> = {
  paid: "breakdown.event.paid",
  hold_released: "breakdown.event.holdReleased",
  refunded: "breakdown.event.refunded",
  charged_back: "breakdown.event.chargedBack",
  chargeback_won: "breakdown.event.chargebackWon",
};

/** One item per ledger transaction of the payment, oldest first. */
export function BreakdownTimeline({ breakdown }: { breakdown: PaymentBreakdownDto }): React.JSX.Element {
  const headingId = React.useId();
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2">
      <h3 id={headingId} className="text-sm font-medium">
        {t("breakdown.timeline")}
      </h3>
      <Timeline
        steps={breakdown.timeline.map((e) => ({
          id: e.transactionId,
          label: t(EVENT_LABEL[e.kind]),
          state: "done" as const,
          meta: (
            <span className="flex flex-wrap items-center gap-2">
              <RelativeTime date={e.at} />
              {e.amount && <MoneyAmount value={e.amount} colorNegative />}
            </span>
          ),
          attributes: { "data-testid": "breakdown-timeline-item", "data-kind": e.kind, "data-at": e.at },
        }))}
      />
    </section>
  );
}

/** When the creator's share leaves the chargeback hold (or left it, or that nothing is left on it). */
export function BreakdownHold({ breakdown }: { breakdown: PaymentBreakdownDto }): React.JSX.Element {
  const { locale, timeZone } = useLocale();
  const at = breakdown.holdReleasedAt ?? breakdown.holdReleasesAt;
  // Both null: refunds or chargebacks emptied the hold, so no release will ever come.
  if (!at) {
    return (
      <p data-testid="breakdown-hold" data-empty="" className="text-sm text-muted-foreground">
        {t("breakdown.hold.none")}
      </p>
    );
  }
  const date = formatDateTime(new Date(at), locale, timeZone);
  return (
    <p
      data-testid="breakdown-hold"
      data-releases-at={breakdown.holdReleasesAt ?? undefined}
      data-released-at={breakdown.holdReleasedAt ?? undefined}
      className="text-sm text-muted-foreground"
    >
      {breakdown.holdReleasedAt ? t("breakdown.hold.released", { date }) : t("breakdown.hold.pending", { date })}
    </p>
  );
}

/** The `platform.cut` that fixed the split, dated, with the way to the public fee schedule. */
export function BreakdownCutSource({ breakdown }: { breakdown: PaymentBreakdownDto }): React.JSX.Element {
  const { locale, timeZone } = useLocale();
  const cut = breakdown.cutSource;
  const percent = (share: number) => formatNumber(Math.round(share * 1000) / 10, locale);
  return (
    <div
      data-testid="breakdown-cut-source"
      data-history-id={cut.historyId ?? ""}
      className="flex flex-col gap-1 text-sm text-muted-foreground"
    >
      <p>{t("breakdown.cut.label", { creator: percent(cut.streamerShare), coop: percent(cut.coopShare) })}</p>
      <p>
        {cut.historyId && cut.changedAt
          ? t("breakdown.cut.changed", { date: formatDateTime(new Date(cut.changedAt), locale, timeZone) })
          : t("breakdown.cut.seed")}{" "}
        <Link to="/transparency" hash="fee-schedule" className="underline underline-offset-4">
          {t("breakdown.cut.schedule")}
        </Link>
      </p>
    </div>
  );
}
