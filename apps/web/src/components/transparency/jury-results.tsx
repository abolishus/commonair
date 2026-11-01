// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState, NO_VALUE, Skeleton, SkeletonGroup, formatInteger, useLocale, useRequestNow } from "@commonair/ui";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Label } from "@commonair/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@commonair/ui/components/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@commonair/ui/components/tooltip";
import { JusticeScale01Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { monthOptions } from "../../lib/money.ts";
import { countAttr, previousPeriod, type JuryResultsDto } from "../jury/model.ts";
import { FormError } from "../form-error.tsx";
import { useLoad } from "../money/use-load.ts";

/**
 * The advisory jury's published results on `/transparency` (`jury.results`, ADR 0038 §7):
 * agreement per clause and tier with cells under k = 10 suppressed (shown as `—` with a "fewer
 * than 10" tooltip), the period, the panel size and the revealed seed with its commitment. Before
 * the 15th the current month's panel is usually still sitting, so the section opens on the latest
 * closed one. A list that reads as a table from `sm` up and as stacked rows at 320 px.
 */

type Count = JuryResultsDto["rows"][number]["agree"];
type Row = JuryResultsDto["rows"][number];
export type LoadJuryResults = (period: string) => Promise<JuryResultsDto>;
const defaultLoad: LoadJuryResults = (period) => api().jury.results({ period });

function Suppressed(): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger
        data-testid="jury-results-suppressed"
        aria-label={t("jury.results.suppressedHint")}
        className="cursor-help tabular-nums focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {NO_VALUE}
      </TooltipTrigger>
      <TooltipContent>{t("jury.results.suppressedHint")}</TooltipContent>
    </Tooltip>
  );
}

function Value({ count }: { count: Count }): React.JSX.Element {
  const { locale } = useLocale();
  if (count.suppressed) return <Suppressed />;
  return <span className="tabular-nums">{formatInteger(count.value, locale)}</span>;
}

function tierLabel(row: Row): string {
  if (row.tier === "t1") return t("jury.case.tier.t1");
  if (row.tier === "t2") return t("jury.case.tier.t2");
  return t("jury.results.reports");
}

function ResultRow({ row }: { row: Row }): React.JSX.Element {
  const hidden = row.agree.suppressed && row.disagree.suppressed && row.unsure.suppressed;
  const cells: { key: "agree" | "disagree" | "unsure"; label: string }[] = [
    { key: "agree", label: t("jury.results.column.agree") },
    { key: "disagree", label: t("jury.results.column.disagree") },
    { key: "unsure", label: t("jury.results.column.unsure") },
  ];
  return (
    <li
      data-testid="jury-results-row"
      data-rule-ref={row.clauseId}
      data-tier={row.tier ?? "none"}
      {...(hidden
        ? { "data-suppressed": "true" }
        : {
            "data-agree": countAttr(row.agree),
            "data-disagree": countAttr(row.disagree),
            "data-unsure": countAttr(row.unsure),
          })}
      className="border-b border-border py-3 last:border-b-0"
    >
      <dl className="grid grid-cols-3 gap-2 sm:grid-cols-12 sm:items-baseline sm:gap-4">
        <div className="col-span-3 sm:col-span-6">
          <dt className="text-xs text-muted-foreground sm:sr-only">{t("jury.results.column.rule")}</dt>
          <dd className="flex flex-col text-sm">
            <span className="font-medium">{row.clauseTitle}</span>
            <span className="text-xs text-muted-foreground">{tierLabel(row)}</span>
          </dd>
        </div>
        {cells.map((c) => (
          <div key={c.key} className="sm:col-span-2 sm:text-end">
            <dt className="text-xs text-muted-foreground sm:sr-only">{c.label}</dt>
            <dd className="text-sm">
              <Value count={row[c.key]} />
            </dd>
          </div>
        ))}
      </dl>
    </li>
  );
}

/** One loaded period (exported for tests). */
export function JuryResultsFigures({ results }: { results: JuryResultsDto }): React.JSX.Element {
  if (results.seed === null)
    return (
      <EmptyState
        data-testid="jury-results-empty"
        icon={JusticeScale01Icon}
        headingLevel={3}
        title={t("jury.results.empty")}
        description={
          results.seedCommitment
            ? t("jury.results.sitting", { commitment: results.seedCommitment })
            : t("jury.results.emptyHint")
        }
      />
    );
  return (
    <div className="flex flex-col gap-4">
      <Card data-testid="jury-results-seed" data-period={results.period}>
        <CardHeader>
          <CardTitle>{t("jury.panel.summary", { period: results.period, seats: results.panelSize })}</CardTitle>
          <CardDescription>{t("jury.results.seedHint")}</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="flex flex-col gap-2 text-sm">
            <div className="flex min-w-0 flex-col gap-1">
              <dt className="text-xs text-muted-foreground">{t("jury.results.seed")}</dt>
              <dd className="font-mono text-xs break-all">{results.seed}</dd>
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <dt className="text-xs text-muted-foreground">{t("jury.results.commitment")}</dt>
              <dd className="font-mono text-xs break-all">{results.seedCommitment}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
      {results.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("jury.results.noVotes")}</p>
      ) : (
        <Card>
          <CardContent>
            <div
              aria-hidden
              className="hidden border-b border-border pb-2 text-xs text-muted-foreground sm:grid sm:grid-cols-12 sm:gap-4"
            >
              <span className="sm:col-span-6">{t("jury.results.column.rule")}</span>
              <span className="sm:col-span-2 sm:text-end">{t("jury.results.column.agree")}</span>
              <span className="sm:col-span-2 sm:text-end">{t("jury.results.column.disagree")}</span>
              <span className="sm:col-span-2 sm:text-end">{t("jury.results.column.unsure")}</span>
            </div>
            <ul aria-label={t("jury.results.title")}>
              {results.rows.map((row) => (
                <ResultRow key={`${row.clauseId}|${row.tier ?? ""}`} row={row} />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export function JuryResults({ load = defaultLoad }: { load?: LoadJuryResults } = {}): React.JSX.Element {
  const requestNow = useRequestNow();
  // From the request time, so the server render and hydration agree on the month list.
  const [now] = React.useState(() => requestNow ?? Date.now());
  const options = React.useMemo(() => monthOptions(now, 12), [now]);
  const current = options[0]?.value ?? new Date(now).toISOString().slice(0, 7);
  const [chosen, setChosen] = React.useState<string | null>(null);
  const currentResults = useLoad(`current|${current}`, () => load(current));
  // Until someone picks a month: a current month with no closed panel falls back to the last one.
  const fallback = chosen === null && currentResults.data?.seed === null ? previousPeriod(current) : null;
  const period = chosen ?? fallback ?? current;
  const otherResults = useLoad(period === current ? "-" : period, () =>
    period === current ? Promise.resolve(null) : load(period),
  );
  const results = period === current ? currentResults : otherResults;
  const titleId = React.useId();
  const selectId = React.useId();
  return (
    <section data-testid="jury-results" aria-labelledby={titleId} className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h2 id={titleId} className="text-lg font-medium">
            {t("jury.results.title")}
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">{t("jury.results.intro")}</p>
        </div>
        <div className="flex min-w-48 flex-col gap-1">
          <Label htmlFor={selectId} className="text-xs text-muted-foreground">
            {t("jury.results.period")}
          </Label>
          <Select
            items={options}
            value={period}
            onValueChange={(value) => {
              if (value !== null) setChosen(value);
            }}
          >
            <SelectTrigger id={selectId} data-value={period}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {results.failed && <FormError>{t("jury.results.loadFailed")}</FormError>}
      {results.data ? (
        <JuryResultsFigures results={results.data} />
      ) : (
        !results.failed && (
          <SkeletonGroup label={t("jury.results.loading")}>
            <Skeleton className="h-32 w-full" />
          </SkeletonGroup>
        )
      )}
    </section>
  );
}
