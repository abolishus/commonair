// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the treasurer must settle by hand (follow-ups, unit money; ADR 0007 decision 3): refund
 * requests, payout transfers and patronage payouts whose Stripe outcome is unknown
 * (`money.treasurer.outcomeUnknown`). Shown above the refunds and transfers tabs, only when
 * something is unknown. `OutcomeUnknownCallout` takes the summary as props for tests.
 */
import type { OutcomeUnknownSummary as OutcomeUnknownSummaryDto } from "@commonair/contracts/dto";
import { MoneyAmount } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import type * as React from "react";
import { t, type MessageKey } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { useLoad } from "../money/use-load.ts";

export type OutcomeUnknownDto = OutcomeUnknownSummaryDto;
type Kind = keyof OutcomeUnknownDto;

const KINDS: readonly Kind[] = ["refunds", "transfers", "patronagePayouts"];
const LINE: Record<Kind, MessageKey> = {
  refunds: "outcomeUnknown.refunds",
  transfers: "outcomeUnknown.transfers",
  patronagePayouts: "outcomeUnknown.patronagePayouts",
};

/** Whether anything is unknown (pure). */
export const anyOutcomeUnknown = (s: OutcomeUnknownDto | null): boolean =>
  s !== null && KINDS.some((k) => s[k].count > 0);

export function OutcomeUnknownCallout({ summary }: { summary: OutcomeUnknownDto | null }): React.JSX.Element | null {
  if (!summary || !anyOutcomeUnknown(summary)) return null;
  return (
    <AlertCallout
      tone="warning"
      data-testid="outcome-unknown-summary"
      title={t("outcomeUnknown.title")}
      description={t("outcomeUnknown.body")}
    >
      <ul className="mt-2 flex flex-col gap-1 text-sm">
        {KINDS.filter((k) => summary[k].count > 0).map((k) => (
          <li key={k} data-kind={k} data-count={summary[k].count} className="flex flex-wrap items-center gap-x-2">
            <span>{t(LINE[k], { count: summary[k].count })}</span>
            {summary[k].amounts.map((a) => (
              <MoneyAmount key={a.currency} value={a} />
            ))}
          </li>
        ))}
      </ul>
    </AlertCallout>
  );
}

/** The callout with its data; `version` reloads it after a settle. A failed load shows nothing. */
export function OutcomeUnknownSummary({ version = 0 }: { version?: number }): React.JSX.Element | null {
  const loaded = useLoad(`outcome-unknown|${version}`, () => api().money.treasurer.outcomeUnknown());
  return <OutcomeUnknownCallout summary={loaded.data} />;
}
