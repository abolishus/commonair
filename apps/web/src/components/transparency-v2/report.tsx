// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MoneyAmount, Skeleton, SkeletonGroup, useLocale } from "@commonair/ui";
import { MetricPanel, StatCard, StatGrid } from "@commonair/ui/blocks/data";
import { ResponsiveGrid } from "@commonair/ui/layouts";
import { Radio02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { egressShare, transparencyTotals, type TransparencyMonthDto } from "../../lib/money.ts";
import { formatBytes } from "../../lib/relays.ts";
import type { RetryStatus } from "../../lib/retrying-load.ts";
import { SectionLoadError } from "../../lib/section-load-error.tsx";
import { CoopTransparency } from "../coop/transparency.tsx";
import { SplitBarCard, SplitLines, TransparencyEmpty } from "../money/transparency.tsx";
import { revenueSegments, revenueSplit, spendingSegments } from "../money/transparency-split.ts";
import { MonthNoteEditor } from "../treasury/month-note-editor.tsx";
import { Commitments } from "./commitments.tsx";
import { DeficitNote, TreasurerNote } from "./deficit-note.tsx";
import { FeePromise } from "./fee-promise.tsx";
import { type CutShares, type FeeChange, deficitOf, latestNote } from "./model.ts";
import { MonthTable } from "./month-table.tsx";
import { NumbersStrip } from "./numbers-strip.tsx";

/** A load as this page reads it (`useLoad`): the data, or how it is failing and retrying. */
export type SectionLoad<T> = Pick<RetryStatus, "failed" | "reload"> &
  Partial<Pick<RetryStatus, "retryInMs" | "gaveUp">> & { data: T | null };

/** How a load is failing, for a section that shows a figure derived from it. */
export type LoadStatus = Omit<SectionLoad<unknown>, "data">;

export interface TransparencyV2Props {
  books: SectionLoad<TransparencyMonthDto[]>;
  /** From `coop.settings` (`cutShares`); null while loading or when it failed. */
  cut: CutShares | null;
  /** `feeLastChanged(coop.feeSchedule)`. */
  feeChanged: FeeChange | null;
  /** The `coop.settings` load behind `cut`: when it failed, the strip and the fee promise offer Retry (F3). */
  settingsLoad?: LoadStatus;
  /** The `coop.feeSchedule` load behind `feeChanged`: when it failed, the strip offers Retry (F3). */
  scheduleLoad?: LoadStatus;
  /** The instance currency, for figures before the books load. */
  currency: string;
  site: string;
  /** Set for a treasurer: saves a month note (`transparency.setNote`), then reloads the books. */
  onSaveNote?: (month: string, body: string) => Promise<void>;
}

/**
 * `/transparency` v2 (overhaul D6.1, coop-trust P3), top to bottom: the numbers strip, the fee
 * promise with its dated comparison, the two bars (revenue split, then co-op spending, each with
 * its table: F4), the deficit note or the treasurer's note, the commitments, the stat cards, the
 * months, then the existing sections. The books failing only replaces the parts that need them
 * (F3): the strip and the fee promise still show what loaded, and a failed settings or fee
 * schedule load gets its own Retry where its figures would be.
 */
export function TransparencyV2({
  books,
  cut,
  feeChanged,
  settingsLoad,
  scheduleLoad,
  currency,
  site,
  onSaveNote,
}: TransparencyV2Props): React.JSX.Element {
  const months = books.data;
  const shown = months?.[0]?.revenue.currency ?? currency;
  return (
    <>
      <NumbersStrip
        months={months}
        cut={cut}
        feeChanged={feeChanged}
        currency={shown}
        failedLoads={[
          ...(cut === null && settingsLoad?.failed ? [settingsLoad] : []),
          ...(feeChanged === null && scheduleLoad?.failed ? [scheduleLoad] : []),
        ]}
      />
      <FeePromise cut={cut} site={site} failedLoad={cut === null && settingsLoad?.failed ? settingsLoad : undefined} />
      {months === null ? (
        books.failed ? (
          <SectionLoadError
            section={t("transparency.monthly")}
            load={books}
            headingLevel={2}
            data-testid="transparency-load-error"
          />
        ) : (
          <SkeletonGroup label={t("transparency.loading")}>
            <div className="flex flex-col gap-4">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          </SkeletonGroup>
        )
      ) : months.length === 0 ? (
        <>
          <TransparencyEmpty />
          <Commitments />
        </>
      ) : (
        <Books months={months} currency={shown} onSaveNote={onSaveNote} />
      )}
    </>
  );
}

function Books({
  months,
  currency,
  onSaveNote,
}: {
  months: TransparencyMonthDto[];
  currency: string;
  onSaveNote?: (month: string, body: string) => Promise<void>;
}): React.JSX.Element {
  const { locale } = useLocale();
  const totals = transparencyTotals(months, currency);
  const deficit = deficitOf(months);
  const note = latestNote(months);
  const egress = egressShare(months);
  const money = (cents: number) => <MoneyAmount value={{ cents, currency }} colorNegative />;
  const stats = [
    {
      id: "revenue",
      label: t("transparency.stat.revenue"),
      hint: t("transparency.stat.revenueHint"),
      cents: totals.revenue,
    },
    {
      id: "payouts",
      label: t("transparency.stat.payouts"),
      hint: t("transparency.stat.payoutsHint"),
      cents: totals.payouts,
    },
    { id: "costs", label: t("transparency.stat.costs"), hint: t("transparency.stat.costsHint"), cents: totals.costs },
    {
      id: "surplus",
      label: t("d6Transparency.months.net", { sign: totals.surplus < 0 ? "negative" : "other" }),
      hint: t("transparency.stat.surplusHint"),
      cents: totals.surplus,
    },
  ];
  return (
    <>
      <ResponsiveGrid cols={2}>
        <SplitBarCard
          data-testid="transparency-flow"
          title={t("d6Transparency.split.title")}
          description={t("d6Transparency.split.hint")}
          segments={revenueSegments(revenueSplit(months))}
          currency={currency}
          empty={t("fixWeb.transparency.split.empty")}
          note={t("fixWeb.transparency.split.feeNote")}
        />
        <SplitBarCard
          data-testid="transparency-spending"
          title={t("d6Transparency.spend.title")}
          description={t("d6Transparency.spend.hint")}
          segments={spendingSegments(months)}
          currency={currency}
          empty={t("fixWeb.transparency.spending.empty")}
        />
      </ResponsiveGrid>
      {deficit ? <DeficitNote deficit={deficit} note={note} /> : note && <TreasurerNote note={note} />}
      <Commitments />
      <StatGrid cols={4}>
        {stats.map((stat) => (
          <StatCard
            key={stat.id}
            data-testid="transparency-stat"
            data-stat={stat.id}
            data-cents={stat.cents}
            label={stat.label}
            value={money(stat.cents)}
            hint={stat.hint}
          />
        ))}
      </StatGrid>
      <MonthTable months={months} currency={currency} />
      {onSaveNote && (
        <MonthNoteEditor months={months.map((m) => ({ month: m.month, note: m.note }))} onSave={onSaveNote} />
      )}
      <SplitLines months={months} currency={currency} />
      <CoopTransparency months={months} />
      <ResponsiveGrid cols={3}>
        <MetricPanel
          icon={<HugeiconsIcon icon={Radio02Icon} strokeWidth={2} aria-hidden />}
          title={t("transparency.egress.title")}
          value={t("transparency.egress.share", { share: egress.relayPercent })}
          caption={t("transparency.egress.caption")}
          body={t("transparency.egress.body", {
            relay: formatBytes(egress.relayBytes, locale),
            total: formatBytes(egress.totalBytes, locale),
          })}
        />
      </ResponsiveGrid>
    </>
  );
}
