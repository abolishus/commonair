// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MoneyAmount, RelativeTime } from "@commonair/ui";
import { GovernanceOutcomeList, type GovernanceOutcomeItem } from "@commonair/ui/blocks/coop";
import { DataTable, type DataTableColumn } from "@commonair/ui/blocks/data";
import { Section } from "@commonair/ui/blocks/headers";
import { ResponsiveGrid } from "@commonair/ui/layouts";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import {
  governanceOutcomes,
  kindLabel,
  patronageMonths,
  proposalStatusLabel,
  tallyReasonText,
  type CoopMonthDto,
} from "../../lib/coop.ts";
import { monthLabel } from "../../lib/money.ts";

type Outcome = ReturnType<typeof governanceOutcomes>[number];

/** A decided proposal as a `GovernanceOutcomeList` item (transparency and /coop). */
export function outcomeItem(g: Outcome): GovernanceOutcomeItem {
  return {
    proposalId: g.proposalId,
    title: g.title,
    link: { render: <Link to="/coop/proposals/$id" params={{ id: g.proposalId }} /> },
    status: g.status,
    kind: g.kind,
    protectedLabel: g.kind === "protected" ? kindLabel("protected") : undefined,
    passed: g.passed,
    outcomeLabel: proposalStatusLabel(g.status),
    reason: g.reason ? tallyReasonText(g.reason) : undefined,
    month: g.month,
    decidedAt: g.decidedAt ? <RelativeTime date={g.decidedAt} /> : undefined,
  };
}

type PatronageMonth = ReturnType<typeof patronageMonths>[number];

/** `/transparency` E5 rows: governance outcomes per month and the patronage distributed. */
export function CoopTransparency({ months }: { months: CoopMonthDto[] }): React.JSX.Element {
  const outcomes = governanceOutcomes(months);
  const patronage = patronageMonths(months);
  const columns: DataTableColumn<PatronageMonth>[] = [
    { id: "month", header: t("transparency.month"), cell: ({ row }) => monthLabel(row.original.month) },
    {
      id: "distributed",
      header: t("coop.transparency.distributed"),
      align: "numeric",
      cell: ({ row }) => <MoneyAmount value={{ cents: row.original.cents, currency: row.original.currency }} />,
    },
  ];
  return (
    <ResponsiveGrid cols={2}>
      <Section heading={t("coop.transparency.governance")} description={t("coop.transparency.governanceHint")}>
        <GovernanceOutcomeList
          label={t("coop.transparency.governance")}
          itemProps={{ "data-testid": "transparency-governance" }}
          items={outcomes.map(outcomeItem)}
          empty={<p>{t("coop.transparency.governanceEmpty")}</p>}
        />
      </Section>
      <Section heading={t("coop.transparency.patronage")} description={t("coop.transparency.patronageHint")}>
        <DataTable
          caption={t("coop.transparency.patronage")}
          columns={columns}
          rows={patronage}
          getRowId={(row) => row.month}
          empty={<p>{t("coop.transparency.patronageEmpty")}</p>}
          rowProps={(row) => ({
            "data-testid": "transparency-patronage",
            "data-month": row.month,
            "data-cents": row.cents,
          })}
        />
      </Section>
    </ResponsiveGrid>
  );
}
