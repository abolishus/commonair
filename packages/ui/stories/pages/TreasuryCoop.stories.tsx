// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Invoice01Icon } from "@hugeicons/core-free-icons";
import { EmptyState } from "@commonair/ui";
import { PageContainer } from "@commonair/ui/layouts";
import { PageHeader, PageTabs, Section } from "@commonair/ui/blocks/headers";
import { FilterBar } from "@commonair/ui/blocks/data";
import {
  PatronagePeriodsTable,
  PatronageRunForm,
  PatronageRunResult,
  ShareRefundsTable,
  type PatronageRunFormValues,
} from "@commonair/ui/blocks/coop";
import { me, periods, runResult, shareFilters, shares } from "./fixtures/TreasuryCoop.ts";
import { CURRENCY, LOCALE } from "./money.tsx";
import { AdminPage, light, mobile320, pageParameters } from "./shell.tsx";

const meta = { title: "Pages/Platform/TreasuryCoop", parameters: pageParameters } satisfies Meta;
export default meta;
type Story = StoryObj;

const usd = (cents: number) => ({ cents, currency: CURRENCY });

function SharesTab(): React.JSX.Element {
  const [status, setStatus] = React.useState("refund_pending");
  const rows = shares.filter((share) => share.status === status);
  return (
    <Section
      heading="Member shares"
      description="Refunds are sent by bank transfer, then recorded here with a note."
      action={
        <FilterBar
          filters={[
            { id: "share-status", label: "Status", value: status, options: shareFilters, onValueChange: setStatus },
          ]}
        />
      }
    >
      <ShareRefundsTable
        locale={LOCALE}
        labels={{
          caption: "Member shares",
          member: "Member",
          status: "Status",
          amount: "Amount",
          since: "Since",
          actions: "Actions",
        }}
        rowProps={{ "data-testid": "treasury-share-row" }}
        empty={
          <EmptyState
            icon={Invoice01Icon}
            headingLevel={3}
            title="Nothing to do"
            description="No share has this status."
          />
        }
        rows={rows.map((share) => ({
          ...share,
          amount: usd(share.cents),
          refund:
            share.status === "refund_pending"
              ? {
                  label: "Record refund",
                  title: `Refund ${share.user.name}'s share`,
                  description: "Record it once the transfer has been sent. It posts the refund to the ledger now.",
                  noteLabel: "Note for the audit log",
                  noteHint: "E.g. the bank reference. No personal details.",
                  submitLabel: "Refund sent",
                  errorText: "The refund could not be recorded. Nothing was posted.",
                  onSubmit: () => undefined,
                  triggerProps: { "data-testid": "treasury-share-refund" },
                  noteProps: { "data-testid": "treasury-share-refund-note" },
                  submitProps: { "data-testid": "treasury-share-refund-submit" },
                }
              : undefined,
        }))}
      />
    </Section>
  );
}

function PatronageTab({ showResult }: { showResult: boolean }): React.JSX.Element {
  const [values, setValues] = React.useState<PatronageRunFormValues>({
    start: "2026-10-01T00:00",
    end: "2026-10-20T23:59",
    surplus: "",
  });
  return (
    <div className="flex flex-col gap-6">
      <PatronageRunForm
        data-testid="patronage-run-form"
        title="Run patronage"
        description="Closes the ledger for the period and computes every member's allocation. Someone else approves it."
        currency={CURRENCY}
        locale={LOCALE}
        labels={{
          start: "Period start (UTC)",
          end: "Period end (UTC)",
          timesHint: "The end must be in the past. Closed periods cannot overlap.",
          surplus: "Surplus to allocate",
          surplusHint: "Leave empty to allocate all retained surplus.",
          surplusFormatError: "Enter an amount like 120.50.",
          submit: "Compute run",
        }}
        values={values}
        onValuesChange={setValues}
        onSubmit={() => undefined}
        startProps={{ "data-testid": "patronage-run-start" }}
        endProps={{ "data-testid": "patronage-run-end" }}
        surplusProps={{ "data-testid": "patronage-run-surplus" }}
        submitProps={{ "data-testid": "patronage-run-submit" }}
      />
      {showResult ? (
        <PatronageRunResult
          data-testid="patronage-run-result"
          data-period-id={runResult.periodId}
          title="Run computed"
          description="Waiting for a second treasurer or an admin to approve it."
          members={runResult.members}
          total={usd(runResult.totalCents)}
          surplus={usd(runResult.surplusCents)}
          retained={usd(runResult.retainedCents)}
          labels={{ members: "Members", total: "Allocated", surplus: "Surplus", retained: "Left in reserve" }}
          locale={LOCALE}
        />
      ) : null}
      <Section heading="Periods" description="Newest first.">
        <PatronagePeriodsTable
          locale={LOCALE}
          labels={{
            caption: "Patronage periods",
            period: "Period",
            status: "Status",
            members: "Members",
            total: "Allocated",
            computedBy: "Ran by",
            approvedBy: "Approved by",
            actions: "Actions",
          }}
          rowProps={{ "data-testid": "patronage-period-row" }}
          rows={periods.map((period) => ({
            ...period,
            total: usd(period.totalCents),
            approve:
              period.status === "computed"
                ? {
                    label: "Approve",
                    confirmTitle: `Approve ${period.period}?`,
                    confirmDescription:
                      "This posts every allocation to members' patronage payable. It cannot be undone.",
                    confirmLabel: "Approve and post",
                    onConfirm: () => undefined,
                    triggerProps: { "data-testid": "patronage-approve" },
                    disabledReason:
                      period.computedBy?.id === me.id
                        ? "You ran this period; someone else must approve it."
                        : undefined,
                  }
                : undefined,
          }))}
        />
      </Section>
    </div>
  );
}

function TreasuryCoopPage({ tab, showResult = true }: { tab: string; showResult?: boolean }): React.JSX.Element {
  const [current, setCurrent] = React.useState(tab);
  return (
    <AdminPage current="treasury">
      <PageContainer width="wide" className="flex flex-col gap-6 py-6">
        <PageHeader size="compact" title="Treasury" description="Manual payments, member shares and patronage." />
        <PageTabs
          aria-label="Treasury"
          value={current}
          onValueChange={setCurrent}
          items={[
            {
              id: "payments",
              label: "Payments",
              "data-testid": "treasury-tab-payments",
              content: <p className="py-4 text-muted-foreground">Pending manual payments (see the Finances board).</p>,
            },
            { id: "shares", label: "Shares", count: 2, "data-testid": "treasury-tab-shares", content: <SharesTab /> },
            {
              id: "patronage",
              label: "Patronage",
              "data-testid": "treasury-tab-patronage",
              content: <PatronageTab showResult={showResult} />,
            },
          ]}
        />
      </PageContainer>
    </AdminPage>
  );
}

/** The shares tab: refunds to send. */
export const Default: Story = { render: () => <TreasuryCoopPage tab="shares" /> };
export const Light: Story = { ...Default, ...light };
export const Mobile320: Story = { ...Default, ...mobile320 };

/** The patronage tab after a run: approve is disabled for the treasurer who ran it. */
export const Patronage: Story = { render: () => <TreasuryCoopPage tab="patronage" /> };
export const PatronageLight: Story = { ...Patronage, ...light };
export const PatronageMobile320: Story = { ...Patronage, ...mobile320 };
