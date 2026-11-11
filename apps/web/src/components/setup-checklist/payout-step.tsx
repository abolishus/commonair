// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * "Get paid: add payout details" (overhaul wave 4, D6.4; ux-journeys J2-h), listed after the first
 * stream on an instance that pays creators out (the API returns the step as not applying
 * otherwise). Its hint is the payout minimum and schedule in one line, from `payout.rules`. Its
 * action follows the payout account (`money.payoutAccount`, the same state as the revenue page's
 * payout card): with Stripe, the Connect onboarding link; with the manual adapter, the treasurer's
 * instructions and "I've contacted the treasurer", which marks the step. Until the account
 * answers (or if it fails) the action is the revenue page, where the payout card lives.
 */
import { useLocale } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { toast } from "@commonair/ui/toast";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import type { PayoutAccountDto } from "../../lib/money.ts";
import { useRetryingLoad } from "../../lib/retrying-load.ts";
import { trackUi } from "../../lib/ui-metrics.ts";
import type { SettingLike } from "../creators/facts.ts";
import { payoutView, type PayoutView } from "../studio-money/payout.ts";
import type { SetupClient } from "./client.ts";
import { payoutRuleLine, payoutRules } from "./payout-rules.ts";

/** What the step reads; the real API by default, a fake in tests. */
export interface PayoutStepClient {
  account(): Promise<PayoutAccountDto>;
  settings(): Promise<readonly SettingLike[]>;
}

export const apiPayoutStepClient: PayoutStepClient = {
  account: () => api().money.payoutAccount(),
  settings: () => api().coop.settings(),
};

export interface PayoutStepData {
  /** The one line from `payout.rules`, or null until (or unless) it reads. */
  ruleLine: string | null;
  /** The payout account's one state, or null until it answers. */
  view: PayoutView | null;
}

/**
 * Loads the account and the rules only while the step is listed and open: a Stripe instance
 * creates the Connect account on the first `money.payoutAccount` read, so the dashboard does not
 * call it for streamers who have not reached this step.
 */
export function usePayoutStep(active: boolean, client: PayoutStepClient): PayoutStepData {
  const { locale } = useLocale();
  const on = active ? 1 : 0;
  const account = useRetryingLoad(`payout-account|${on}`, () => (active ? client.account() : Promise.resolve(null)));
  const settings = useRetryingLoad(`payout-rules|${on}`, () => (active ? client.settings() : Promise.resolve(null)));
  const rules = payoutRules(settings.data);
  return {
    ruleLine: rules ? payoutRuleLine(rules, locale) : null,
    view: account.data ? payoutView(account.data) : null,
  };
}

const click = () => trackUi("studio.checklist", "click", "get_paid");

/** The step's action next to its title. */
export function PayoutStepAction({
  view,
  current,
}: {
  view: PayoutView | null;
  current: boolean;
}): React.JSX.Element | null {
  if (view?.state === "ready") return null;
  if (current && view?.state === "connect" && view.onboardingUrl)
    return (
      <Button
        data-testid="setup-step-get_paid-action"
        variant="outline"
        size="sm"
        nativeButton={false}
        render={
          <a href={view.onboardingUrl} rel="noopener" aria-label={t("d6Studio.getPaid.action")} onClick={click} />
        }
      >
        {t("d6Studio.getPaid.action")}
      </Button>
    );
  // The manual step's instructions and its mark live in the expanded detail while it is current.
  if (current && (view?.state === "manual" || view?.state === "waiting")) return null;
  return (
    <Button
      data-testid="setup-step-get_paid-revenue"
      variant="outline"
      size="sm"
      nativeButton={false}
      render={<Link to="/revenue" onClick={click} />}
    >
      {t("d6Studio.getPaid.action")}
    </Button>
  );
}

/** The expanded step for the manual adapter: the treasurer's instructions and the mark. */
export function PayoutStepDetail({
  channel,
  view,
  client,
  onMarked,
}: {
  channel: string;
  view: PayoutView | null;
  client: Pick<SetupClient, "mark">;
  onMarked: () => void;
}): React.JSX.Element | null {
  const [marking, setMarking] = React.useState(false);
  if (view?.state !== "manual" && view?.state !== "waiting") return null;
  const mark = async () => {
    click();
    setMarking(true);
    try {
      await client.mark(channel, "get_paid");
      onMarked();
    } catch {
      toast.error(t("d6Studio.getPaid.markFailed"));
    } finally {
      setMarking(false);
    }
  };
  return (
    <div data-testid="setup-get-paid" data-state={view.state} className="flex min-w-0 flex-col gap-3">
      {view.instructions ? (
        <p data-testid="setup-get-paid-instructions" className="text-sm whitespace-pre-line">
          {view.instructions}
        </p>
      ) : (
        <p className="text-sm">{t("d6Studio.getPaid.waiting")}</p>
      )}
      <div>
        <Button
          data-testid="setup-step-get_paid-mark"
          variant="outline"
          disabled={marking}
          aria-busy={marking || undefined}
          onClick={() => void mark()}
        >
          {t("d6Studio.getPaid.contacted")}
        </Button>
      </div>
    </div>
  );
}
