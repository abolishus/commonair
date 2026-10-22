// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  EmptyState,
  Skeleton,
  SkeletonGroup,
  formatDateTime,
  formatMoney,
  formatNumber,
  useLocale,
} from "@commonair/ui";
import { StatementList, StatementView } from "@commonair/ui/blocks/coop";
import { Breadcrumbs, PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { Invoice01Icon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { componentLabel, patronageStatusLabel, statementInputAttrs, type StatementDto } from "../../lib/coop.ts";
import { formatBytes } from "../../lib/relays.ts";
import { CoopTabs } from "./nav.tsx";

/** "1 October 2026 at 00:00 – 20 October 2026 at 23:59" (UTC). */
export function periodText(start: string, end: string, locale: string): string {
  return t("coop.period", {
    start: formatDateTime(new Date(start), locale, "UTC"),
    end: formatDateTime(new Date(end), locale, "UTC"),
  });
}

function Loading(): React.JSX.Element {
  return (
    <SkeletonGroup label={t("coop.loading")}>
      <Skeleton className="h-32 w-full" />
    </SkeletonGroup>
  );
}

/** `/coop/patronage`: the member's statements (approved periods with an allocation). */
export function StatementsPage({ statements }: { statements: StatementDto[] | null }): React.JSX.Element {
  const { locale } = useLocale();
  return (
    <PageContainer width="default" className="flex flex-col gap-6 py-8">
      <PageHeader
        title={t("coop.patronage.title")}
        description={t("coop.patronage.intro")}
        tabs={<CoopTabs current="patronage" />}
      />
      {statements === null ? (
        <Loading />
      ) : (
        <StatementList
          data-testid="patronage"
          title={t("coop.patronage.listTitle")}
          description={t("coop.patronage.listHint")}
          itemProps={{ "data-testid": "patronage-item" }}
          items={statements.map((s) => ({
            periodId: s.periodId,
            title: periodText(s.periodStart, s.periodEnd, locale),
            status: s.status,
            statusLabel: patronageStatusLabel(s.status),
            amount: s.total,
            link: { render: <Link to="/coop/patronage/$periodId" params={{ periodId: s.periodId }} /> },
          }))}
          empty={
            <EmptyState
              data-testid="patronage-empty"
              icon={Invoice01Icon}
              headingLevel={3}
              title={t("coop.patronage.empty")}
              description={t("coop.patronage.emptyHint")}
            />
          }
        />
      )}
    </PageContainer>
  );
}

/** `/coop/patronage/$periodId`: one statement, explained line by line. */
export function StatementPage({ statement: s }: { statement: StatementDto | null }): React.JSX.Element {
  const { locale } = useLocale();
  const currency = s?.total.currency ?? "";
  return (
    <PageContainer width="default" className="flex flex-col gap-6 py-8">
      <PageHeader
        breadcrumbs={
          <Breadcrumbs
            label={t("coop.breadcrumb")}
            items={[
              { label: t("coop.title"), render: <Link to="/coop" /> },
              { label: t("coop.patronage.title"), render: <Link to="/coop/patronage" /> },
              { label: t("coop.statement.title") },
            ]}
          />
        }
        title={t("coop.statement.title")}
      />
      {s === null ? (
        <Loading />
      ) : (
        <StatementView
          data-testid="statement"
          data-period-id={s.periodId}
          data-formula-version={s.formulaVersion}
          title={t("coop.statement.allocation")}
          period={periodText(s.periodStart, s.periodEnd, locale)}
          status={s.status}
          statusLabel={patronageStatusLabel(s.status)}
          total={s.total}
          surplus={s.surplus}
          formula={s.formulaVersion}
          labels={{
            total: t("coop.statement.total"),
            surplus: t("coop.statement.surplus"),
            formula: t("coop.statement.formula"),
            lines: t("coop.statement.lines"),
            share: t("coop.statement.share"),
            amount: t("coop.statement.amount"),
            capApplied: t("coop.statement.capApplied"),
            inputs: t("coop.statement.inputs"),
          }}
          lineProps={{ "data-testid": "statement-line" }}
          explanationProps={{ "data-testid": "statement-line-explanation" }}
          inputsProps={{ "data-testid": "statement-inputs", ...statementInputAttrs(s.inputs) }}
          inputs={[
            { term: t("coop.statement.inputRevenue"), value: formatMoney(s.inputs.revenueCents, currency, locale) },
            { term: t("coop.statement.inputHours"), value: formatNumber(s.inputs.eligibleStreamingHours, locale) },
            { term: t("coop.statement.inputRelay"), value: formatBytes(s.inputs.relayBytesVerified, locale) },
            { term: t("coop.statement.inputViewerHours"), value: formatNumber(s.inputs.viewerHoursVerified, locale) },
            {
              term: t("coop.statement.inputViewerHoursExcluded"),
              value: formatNumber(s.inputs.viewerHoursExcluded, locale),
            },
          ]}
          lines={s.lines.map((line) => ({
            component: line.component,
            label: componentLabel(line.component),
            explanation: line.explanation,
            basis: t("coop.statement.basis", {
              value: formatNumber(line.memberValue, locale),
              total: formatNumber(line.poolTotal, locale),
            }),
            pool: t("coop.statement.pool", { amount: formatMoney(line.poolCents, currency, locale) }),
            share: line.share,
            amount: { cents: line.amountCents, currency },
            capApplied: line.capApplied,
          }))}
        />
      )}
    </PageContainer>
  );
}
