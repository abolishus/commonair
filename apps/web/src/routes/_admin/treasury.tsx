// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { FormError } from "../../components/form-error.tsx";
import {
  CostForm,
  PaymentsPanel,
  PayoutAccountForm,
  PayoutsPanel,
  TreasuryTabs,
  type PayoutRunResult,
  type TreasuryTab,
} from "../../components/money/treasury.tsx";
import { useLoad } from "../../components/money/use-load.ts";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { api } from "../../lib/api.ts";
import { currentMonthPeriod, normalizeReference } from "../../lib/money.ts";

/** Treasurers only: the `_admin` layout's `beforeLoad` already answered everyone else with not-found. */
export const Route = createFileRoute("/_admin/treasury")({ component: TreasuryPage });

const PAGE = 50;
const SEARCH_DEBOUNCE_MS = 300;

function TreasuryPage(): React.JSX.Element {
  const [tab, setTab] = React.useState<TreasuryTab>("payments");
  const [search, setSearch] = React.useState("");
  const reference = useDebounced(normalizeReference(search), SEARCH_DEBOUNCE_MS);

  const payments = useLoad(`payments|${reference}`, () =>
    api().money.treasurer.payments(reference ? { reference, limit: PAGE } : { status: "pending", limit: PAGE }),
  );
  const payouts = useLoad("payouts", () => api().money.treasurer.payouts({ limit: PAGE }));
  const [result, setResult] = React.useState<PayoutRunResult | null>(null);
  const [running, setRunning] = React.useState(false);
  // Only the amount field's display needs it (recordCost takes cents in the instance currency).
  // The lists carry the instance currency; the bootstrap does not yet (contract request).
  const currency = payments.data?.items[0]?.amount.currency ?? payouts.data?.items[0]?.amount.currency ?? "usd";

  const runPayouts = async () => {
    if (running) return;
    setRunning(true);
    try {
      setResult(await api().money.treasurer.runPayouts({ periodEnd: new Date().toISOString() }));
      payouts.reload();
    } catch (err) {
      toastActionError(err, t("treasury.payouts.runFailed"));
    } finally {
      setRunning(false);
    }
  };

  return (
    <PageContainer data-testid="treasury" className="flex flex-col gap-6 py-8">
      <PageHeader title={t("treasury.title")} description={t("treasury.intro")} />
      <TreasuryTabs
        value={tab}
        onValueChange={setTab}
        payments={
          <>
            {payments.failed && <FormError>{t("treasury.payments.loadFailed")}</FormError>}
            <PaymentsPanel
              payments={payments.data?.items ?? (payments.failed ? [] : null)}
              search={search}
              onSearchChange={setSearch}
              onConfirm={async (p) => {
                await api().money.treasurer.confirm({ paymentId: p.paymentId, receivedAt: new Date().toISOString(), note: "" });
                payments.reload();
              }}
              onDispute={async (p, kind, amountCents, reason) => {
                const input = { paymentId: p.paymentId, amountCents, reason };
                if (kind === "refund") await api().money.treasurer.refund(input);
                else await api().money.treasurer.chargeback(input);
                payments.reload();
              }}
            />
          </>
        }
        payouts={
          <>
            {payouts.failed && <FormError>{t("treasury.payouts.loadFailed")}</FormError>}
            <PayoutsPanel
              payouts={payouts.data?.items ?? (payouts.failed ? [] : null)}
              result={result}
              running={running}
              onRun={() => void runPayouts()}
              onMarkPaid={async (p, ref) => {
                await api().money.treasurer.markPaid({ id: p.id, reference: ref });
                payouts.reload();
              }}
            />
          </>
        }
        accounts={
          <PayoutAccountForm
            onSubmit={async (input) => {
              await api().money.treasurer.setPayoutAccount(input);
              payouts.reload();
            }}
          />
        }
        costs={
          <CostForm
            currency={currency}
            onSubmit={async (input) => {
              await api().money.treasurer.recordCost({ ...currentMonthPeriod(Date.now()), ...input });
            }}
          />
        }
      />
    </PageContainer>
  );
}

function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}
