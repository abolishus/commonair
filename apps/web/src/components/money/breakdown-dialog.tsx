// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MoneyAmount, SkeletonGroup, SkeletonText } from "@commonair/ui";
import { KeyValueList } from "@commonair/ui/blocks/data";
import { Button } from "@commonair/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@commonair/ui/components/dialog";
import { ScrollArea } from "@commonair/ui/components/scroll-area";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { FormError } from "../form-error.tsx";
import { BreakdownTable, type PaymentBreakdownDto } from "./breakdown-table.tsx";
import { BreakdownCutSource, BreakdownHold, BreakdownTimeline } from "./breakdown-timeline.tsx";
import { useLoad } from "./use-load.ts";

/** Where a breakdown comes from (tests pass a stub). */
export interface BreakdownClient {
  paymentBreakdown(paymentId: string): Promise<PaymentBreakdownDto>;
}

const apiClient: BreakdownClient = {
  paymentBreakdown: (paymentId) => api().money.paymentBreakdown({ paymentId }),
};

/** One payment's breakdown: who paid what, the split table, the hold, the cut and the timeline. */
export function BreakdownView({ breakdown }: { breakdown: PaymentBreakdownDto }): React.JSX.Element {
  const payee = breakdown.viewerRole === "payee";
  return (
    <div className="flex min-w-0 flex-col gap-4" data-payment-id={breakdown.paymentId}>
      <KeyValueList
        rows={[
          {
            term: payee ? t("breakdown.grossPayee") : t("breakdown.gross"),
            value: (
              <span data-testid="breakdown-gross" data-cents={breakdown.gross.cents}>
                <MoneyAmount value={breakdown.gross} />
              </span>
            ),
          },
          {
            term: payee ? t("breakdown.from") : t("breakdown.channel"),
            value: payee ? (breakdown.payer?.displayName ?? t("breakdown.anonymous")) : breakdown.channel.displayName,
          },
          { term: t("breakdown.payments.kind"), value: t("breakdown.kind", { kind: breakdown.kind }) },
        ]}
      />
      <BreakdownTable breakdown={breakdown} />
      <BreakdownHold breakdown={breakdown} />
      <BreakdownCutSource breakdown={breakdown} />
      <BreakdownTimeline breakdown={breakdown} />
    </div>
  );
}

function BreakdownLoader({ paymentId, client }: { paymentId: string; client: BreakdownClient }): React.JSX.Element {
  const loaded = useLoad(paymentId, () => client.paymentBreakdown(paymentId));
  if (loaded.failed) return <FormError>{t("breakdown.loadFailed")}</FormError>;
  if (!loaded.data)
    return (
      <SkeletonGroup label={t("breakdown.loading")}>
        <SkeletonText lines={6} />
      </SkeletonGroup>
    );
  return <BreakdownView breakdown={loaded.data} />;
}

export interface BreakdownOpenButtonProps {
  paymentId: string;
  /** Already loaded (the "Your payments" list): shown as is, without another request. */
  breakdown?: PaymentBreakdownDto;
  client?: BreakdownClient;
}

/** The `breakdown-open` button and its dialog; the breakdown loads when the dialog opens. */
export function BreakdownOpenButton({
  paymentId,
  breakdown,
  client = apiClient,
}: BreakdownOpenButtonProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button data-testid="breakdown-open" data-payment-id={paymentId} variant="outline" size="sm" />}
      >
        {t("breakdown.open")}
      </DialogTrigger>
      <DialogContent data-testid="breakdown-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("breakdown.title")}</DialogTitle>
          <DialogDescription>{t("breakdown.description")}</DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-96">
          <div className="pe-3">
            {open &&
              (breakdown ? (
                <BreakdownView breakdown={breakdown} />
              ) : (
                <BreakdownLoader paymentId={paymentId} client={client} />
              ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
