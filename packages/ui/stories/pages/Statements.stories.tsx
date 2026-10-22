// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Invoice01Icon } from "@hugeicons/core-free-icons";
import { EmptyState, formatNumber } from "@commonair/ui";
import { PageContainer } from "@commonair/ui/layouts";
import { Breadcrumbs, PageHeader, PageTabs } from "@commonair/ui/blocks/headers";
import { StatementList, StatementView } from "@commonair/ui/blocks/coop";
import { coopTabs } from "./fixtures/CoopNav.ts";
import { statement, statements } from "./fixtures/Statements.ts";
import { CURRENCY, LOCALE, moneyText } from "./money.tsx";
import { ViewerPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Co-op/Statements", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

const usd = (cents: number) => ({ cents, currency: CURRENCY });

function StatementsPage({ empty = false }: { empty?: boolean }): React.JSX.Element {
  return (
    <ViewerPage current="coop" footer="coop">
      <PageContainer width="default" className="flex flex-col gap-6 py-6">
        <PageHeader
          title="Patronage"
          description="Your share of the co-op's surplus, period by period, explained line by line."
          tabs={<PageTabs variant="default" items={coopTabs("patronage")} aria-label="Co-op" />}
        />
        <StatementList
          data-testid="patronage"
          title="Your statements"
          description="Approved periods in which you had an allocation."
          locale={LOCALE}
          itemProps={{ "data-testid": "patronage-item" }}
          items={
            empty
              ? []
              : statements.map((item) => ({
                  ...item,
                  amount: usd(item.cents),
                  link: { href: `#coop/patronage/${item.periodId}` },
                }))
          }
          empty={
            <EmptyState
              data-testid="patronage-empty"
              icon={Invoice01Icon}
              headingLevel={3}
              title="No statements yet"
              description="Statements appear once a period with your activity has been approved."
            />
          }
        />
      </PageContainer>
    </ViewerPage>
  );
}

function StatementPage(): React.JSX.Element {
  const inputs = statement.inputs;
  return (
    <ViewerPage current="coop" footer="coop">
      <PageContainer width="default" className="flex flex-col gap-6 py-6">
        <PageHeader
          breadcrumbs={
            <Breadcrumbs
              label="Breadcrumb"
              items={[
                { label: "Co-op", href: "#coop" },
                { label: "Patronage", href: "#coop/patronage" },
                { label: statement.title },
              ]}
            />
          }
          title={`Statement · ${statement.title}`}
        />
        <StatementView
          data-testid="statement"
          data-period-id={statement.periodId}
          data-formula-version={statement.formulaVersion}
          title="Your allocation"
          period={statement.period}
          status={statement.status}
          statusLabel={statement.statusLabel}
          total={usd(statement.totalCents)}
          surplus={usd(statement.surplusCents)}
          formula={statement.formula}
          locale={LOCALE}
          labels={{
            total: "Your allocation",
            surplus: "Surplus shared",
            formula: "Formula",
            lines: "How it was computed",
            share: "Your share",
            amount: "Amount",
            capApplied: "Cap applied",
            inputs: "Your inputs this period",
          }}
          lineProps={{ "data-testid": "statement-line" }}
          explanationProps={{ "data-testid": "statement-line-explanation" }}
          inputsProps={{
            "data-testid": "statement-inputs",
            "data-revenue-cents": inputs.revenueCents,
            "data-hours": inputs.hours,
            "data-relay-bytes": inputs.relayBytes,
            "data-viewer-hours": inputs.viewerHours,
          }}
          inputs={[
            { term: "Revenue on your channel", value: moneyText({ cents: inputs.revenueCents }) },
            { term: "Eligible streaming hours", value: formatNumber(inputs.hours, LOCALE) },
            { term: "Verified relay bytes", value: formatNumber(inputs.relayBytes, LOCALE) },
            { term: "Verified viewer-hours", value: formatNumber(inputs.viewerHours, LOCALE) },
          ]}
          lines={statement.lines.map((line) => ({ ...line, amount: usd(line.cents) }))}
        />
      </PageContainer>
    </ViewerPage>
  );
}

/** The statements list. */
export const Default: Story = { render: () => <StatementsPage /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };

/** One statement, explained line by line. */
export const Statement: Story = { render: () => <StatementPage /> };
export const StatementLight: Story = { ...Statement, ...light };
export const StatementMobile320: Story = { ...Statement, ...mobile320 };

/** No approved statements yet. */
export const Empty: Story = { render: () => <StatementsPage empty /> };
