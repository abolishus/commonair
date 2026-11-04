// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { toast } from "@commonair/ui/toast";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { CoopLoadGate } from "../../components/coop/load-error.tsx";
import {
  MemberPayoutStatus,
  PatronagePayoutsPanel,
  type PatronagePayoutDto,
} from "../../components/coop/patronage-payouts.tsx";
import { StatementPage } from "../../components/coop/statements.tsx";
import { coopLoads, isNotFound, toastCoopError, useCoopLoad } from "../../components/coop/use-coop.ts";
import { NotFoundState } from "../../components/money/not-found.tsx";
import { t } from "../../i18n/index.ts";
import { api, errorCode } from "../../lib/api.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { errorReason } from "../../lib/coop.ts";
import { requireSession } from "../../lib/guard.ts";
import { isTreasurer } from "../../lib/money.ts";
import { titleHead } from "../../lib/page-title.ts";

/** Signed in: one of your statements, explained line by line; treasurers also pay the period out. */
export const Route = createFileRoute("/_app/coop/patronage/$periodId")({
  head: () => titleHead(t("pageTitle.coopPatronageStatement")),
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: StatementRoute,
});

/**
 * The member's own payout, once the statement carries it (`PatronageStatement.payout`, a contract
 * request of M1-coop-money); until then the status line is not shown.
 */
function ownPayout(statement: object | null): Pick<PatronagePayoutDto, "status" | "amount"> | null | undefined {
  if (!statement || !("payout" in statement)) return undefined;
  const p = statement.payout;
  if (p === null) return null;
  if (typeof p !== "object" || !("status" in p) || !("amount" in p)) return undefined;
  return p as Pick<PatronagePayoutDto, "status" | "amount">;
}

function toastPayError(err: unknown): void {
  if (errorCode(err) === "FORBIDDEN" && errorReason(err) === "second_approver")
    toast.error(t("coopMoney.pay.secondApprover"));
  else if (errorCode(err) === "CONFLICT") toast.error(t("coopMoney.pay.notApproved"));
  else toastCoopError(err);
}

function PayoutSection({ periodId }: { periodId: string }): React.JSX.Element {
  const payouts = useCoopLoad(`payouts:${periodId}`, () => api().coop.patronage.payouts({ periodId }));
  const pay = async () => {
    const r = await api().coop.patronage.pay({ periodId });
    if (r.state === "awaiting_second_approver") toast.success(t("coopMoney.pay.requested"));
    else toast.success(t("coopMoney.pay.approved", { count: String(r.created) }));
    payouts.reload();
  };
  return (
    <PatronagePayoutsPanel
      periodId={periodId}
      rows={payouts.data}
      failed={payouts.failed}
      onRetry={payouts.reload}
      onPay={pay}
      onPayError={toastPayError}
      onMarkPaid={async (payoutId, reference) => {
        await api().coop.patronage.markPaid({ payoutId, reference, paidAt: new Date().toISOString() });
        payouts.reload();
      }}
      onMarkPaidError={toastCoopError}
    />
  );
}

function StatementRoute(): React.JSX.Element {
  const { periodId } = Route.useParams();
  const { me } = useBootstrap();
  const statement = useCoopLoad(periodId, () => api().coop.patronage.statement({ periodId }));
  if (!me) return <Navigate to="/signin" replace />;
  const treasurer = isTreasurer(me);
  // Not yours, not approved, or no such period: the API answers NOT_FOUND alike. A treasurer who
  // is not in the period still pays it out.
  if (isNotFound(statement)) return treasurer ? <PayoutSection periodId={periodId} /> : <NotFoundState />;
  const mine = ownPayout(statement.data);
  return (
    <CoopLoadGate status={coopLoads([statement])} tab="patronage">
      <StatementPage statement={statement.data} />
      {mine !== undefined && <MemberPayoutStatus payout={mine} />}
      {treasurer && <PayoutSection periodId={periodId} />}
    </CoopLoadGate>
  );
}
