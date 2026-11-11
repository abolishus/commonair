// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MoneyAmount, RelativeTime, formatNumber, formatPercent, useLocale } from "@commonair/ui";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import type { TransparencyMonthDto } from "../../lib/money.ts";
import { SectionLoadError } from "../../lib/section-load-error.tsx";
import { lastDecision, latestMemberCount } from "../money/transparency-split.ts";
import { type CutShares, type FeeChange, creatorsPaidCents } from "./model.ts";
import type { LoadStatus } from "./report.tsx";

export interface NumbersStripProps {
  /** null while the books load or after they failed (those figures then read "Not available"). */
  months: readonly TransparencyMonthDto[] | null;
  /** From the `platform.cut` setting; null when the settings did not load. */
  cut: CutShares | null;
  /** `feeLastChanged`; null when the schedule did not load. */
  feeChanged: FeeChange | null;
  currency: string;
  /**
   * The settings and fee schedule loads that failed with nothing shown (F3): one Retry reloads
   * them all. The books have their own Retry further down, so they are not listed here.
   */
  failedLoads?: readonly LoadStatus[];
}

/**
 * "By the numbers" (coop-trust P3.1, after Open Collective): members, what creators were paid in
 * the period, the creator share from `platform.cut`, the last vote and the fee schedule's last
 * change. Each figure stands alone: a source that did not load reads "Not available".
 */
export function NumbersStrip({
  months,
  cut,
  feeChanged,
  currency,
  failedLoads = [],
}: NumbersStripProps): React.JSX.Element {
  const { locale } = useLocale();
  const unknown = t("d6Transparency.numbers.unknown");
  const decision = months ? lastDecision(months) : null;
  const items: { id: string; label: string; value: React.ReactNode; hint?: string }[] = [
    {
      id: "members",
      label: t("d6Transparency.numbers.members"),
      value: months ? formatNumber(latestMemberCount(months), locale) : unknown,
    },
    {
      id: "paid",
      label: t("d6Transparency.numbers.paid"),
      value: months ? <MoneyAmount value={{ cents: creatorsPaidCents(months), currency }} /> : unknown,
    },
    {
      id: "share",
      label: t("d6Transparency.numbers.share"),
      value: cut ? formatPercent(cut.creator, locale, { maximumFractionDigits: 1 }) : unknown,
      hint: cut ? t("d6Transparency.numbers.shareHint") : undefined,
    },
    {
      id: "vote",
      label: t("d6Transparency.numbers.lastVote"),
      value: !months ? (
        unknown
      ) : decision ? (
        <RelativeTime date={decision.decidedAt} />
      ) : (
        t("d6Transparency.numbers.noVote")
      ),
      hint: decision?.title,
    },
    {
      id: "fee",
      label: t("d6Transparency.numbers.feeChanged"),
      value:
        feeChanged === null ? (
          unknown
        ) : feeChanged.kind === "founding" ? (
          t("d6Transparency.numbers.feeFounding")
        ) : (
          <RelativeTime date={feeChanged.at} />
        ),
    },
  ];
  return (
    <section
      aria-label={t("d6Transparency.numbers.title")}
      data-testid="transparency-numbers"
      className="flex flex-col gap-3"
    >
      <dl className="grid grid-cols-2 gap-px bg-border ring-1 ring-border sm:grid-cols-3 lg:grid-cols-5">
        {items.map((item) => (
          <div
            key={item.id}
            data-stat={item.id}
            className="flex min-w-0 flex-col gap-1 bg-card p-4 last:col-span-2 sm:last:col-span-1"
          >
            <dt className="text-xs text-muted-foreground">{item.label}</dt>
            <dd className="text-lg font-semibold break-words tabular-nums">{item.value}</dd>
            {item.hint && <dd className="text-xs break-words text-muted-foreground">{item.hint}</dd>}
          </div>
        ))}
      </dl>
      {failedLoads.length > 0 && (
        <SectionLoadError
          section={t("d6Transparency.numbers.title")}
          load={combined(failedLoads)}
          headingLevel={2}
          data-testid="transparency-numbers-error"
        />
      )}
    </section>
  );
}

/** One Retry for several failed loads: it reloads each; the soonest automatic retry is the one shown. */
function combined(loads: readonly LoadStatus[]): LoadStatus {
  const waits = loads.flatMap((l) => (l.retryInMs === null || l.retryInMs === undefined ? [] : [l.retryInMs]));
  return {
    failed: true,
    reload: () => {
      for (const l of loads) l.reload();
    },
    retryInMs: waits.length > 0 ? Math.min(...waits) : null,
    gaveUp: loads.every((l) => l.gaveUp === true),
  };
}
