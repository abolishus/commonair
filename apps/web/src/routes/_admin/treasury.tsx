// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { toast } from "@commonair/ui/toast";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { FormError } from "../../components/form-error.tsx";
import {
  CostForm,
  PaymentsPanel,
  PayoutAccountForm,
  PayoutsPanel,
  type PayoutRunResult,
} from "../../components/money/treasury.tsx";
import { CoopPatronageTab, CoopSharesTab } from "../../components/coop/treasury-tabs.tsx";
import { TreasuryCoopTabs, type TreasuryCoopTab } from "../../components/coop/treasury.tsx";
import { usePaged } from "../../components/money/use-load.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { api } from "../../lib/api.ts";
import { currentMonthPeriod, normalizeReference } from "../../lib/money.ts";

/** Treasurers only: the `_admin` layout's `beforeLoad` already answered everyone else with not-found. */
export const Route = createFileRoute("/_admin/treasury")({ component: TreasuryPage });

const PAGE = 50;
const SEARCH_DEBOUNCE_MS = 300;

function TreasuryPage(): React.JSX.Element {
  const [tab, setTab] = React.useState<TreasuryCoopTab>("payments");
  const [search, setSearch] = React.useState("");
  const reference = useDebounced(normalizeReference(search), SEARCH_DEBOUNCE_MS);

  const { config, me } = useBootstrap();
  const moreFailed = (err: unknown) => toastActionError(err, t("treasury.loadMoreFailed"));
  const payments = usePaged(
    `payments|${reference}`,
    (cursor) =>
      api().money.treasurer.payments(
        reference ? { reference, limit: PAGE, cursor } : { status: "pending", limit: PAGE, cursor },
      ),
    moreFailed,
  );
  const payouts = usePaged("payouts", (cursor) => api().money.treasurer.payouts({ limit: PAGE, cursor }), moreFailed);
  const [result, setResult] = React.useState<PayoutRunResult | null>(null);
  const [running, setRunning] = React.useState(false);

  const runPayouts = async () => {
    if (running) return;
    setRunning(true);
    try {
      setResult(await api().money.treasurer.runPayouts({ periodEnd: new Date().toISOString() }));
      toast.success(t("treasury.payouts.ran"));
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
      <TreasuryCoopTabs
        value={tab}
        onValueChange={setTab}
        panels={{
          payments: (
            <>
              {payments.failed && <FormError>{t("treasury.payments.loadFailed")}</FormError>}
              <PaymentsPanel
                payments={
                  reference !== normalizeReference(search) ? null : (payments.items ?? (payments.failed ? [] : null))
                }
                hasMore={payments.hasMore}
                loadingMore={payments.loadingMore}
                onLoadMore={payments.loadMore}
                search={search}
                onSearchChange={setSearch}
                onConfirm={async (p) => {
                  await api().money.treasurer.confirm({
                    paymentId: p.paymentId,
                    receivedAt: new Date().toISOString(),
                    note: "",
                  });
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
          ),
          payouts: (
            <>
              {payouts.failed && <FormError>{t("treasury.payouts.loadFailed")}</FormError>}
              <PayoutsPanel
                payouts={payouts.items ?? (payouts.failed ? [] : null)}
                hasMore={payouts.hasMore}
                loadingMore={payouts.loadingMore}
                onLoadMore={payouts.loadMore}
                result={result}
                running={running}
                onRun={() => void runPayouts()}
                onMarkPaid={async (p, ref) => {
                  await api().money.treasurer.markPaid({ id: p.id, reference: ref });
                  payouts.reload();
                }}
              />
            </>
          ),
          accounts: (
            <PayoutAccountForm
              onSubmit={async (input) => {
                await api().money.treasurer.setPayoutAccount(input);
                payouts.reload();
              }}
            />
          ),
          costs: (
            <CostForm
              // recordCost takes cents in the instance currency.
              currency={config.currency}
              onSubmit={async (input) => {
                await api().money.treasurer.recordCost({ ...currentMonthPeriod(Date.now()), ...input });
              }}
            />
          ),
          // E5: member shares (refunds to send) and patronage (run, approve, periods).
          shares: <CoopSharesTab />,
          patronage: <CoopPatronageTab meId={me?.id ?? ""} currency={config.currency} />,
        }}
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
