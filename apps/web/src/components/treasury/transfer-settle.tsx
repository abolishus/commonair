// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Settle a payout transfer whose Stripe outcome is unknown (follow-ups, unit money;
 * `money.treasurer.settleTransfer`). The treasurer looks the transfer up in Stripe's dashboard and
 * records what it shows: sent, with its `tr_` id (the payout is paid), or not sent (the amount goes
 * back to the creator's earnings for the next run). Behind a `ConfirmDialog`; the server refuses
 * the treasurer's own payout and a transfer settled meanwhile.
 */
import type { TransferSettleOutcome } from "@commonair/contracts/enums";
import { ConfirmDialog } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { RadioGroup, RadioGroupItem } from "@commonair/ui/components/radio-group";
import { Textarea } from "@commonair/ui/components/textarea";
import * as React from "react";
import { t, type MessageKey } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";

/** The contract's note limit (`settleTransfer`). */
export const SETTLE_NOTE_MAX = 500;
/** A Stripe transfer id, the only reference a sent transfer takes (as the server checks). */
export const TRANSFER_REFERENCE = /^tr_[A-Za-z0-9]{1,60}$/;

const OUTCOMES: readonly TransferSettleOutcome[] = ["sent", "not_sent"];
const OUTCOME_LABEL: Record<TransferSettleOutcome, MessageKey> = {
  sent: "transferSettle.outcome.sent",
  not_sent: "transferSettle.outcome.notSent",
};
const isOutcome = (v: unknown): v is TransferSettleOutcome => v === "sent" || v === "not_sent";

/** Whether the dialog may be confirmed (pure). */
export function settleReady(outcome: TransferSettleOutcome | null, reference: string): boolean {
  if (outcome === "not_sent") return true;
  return outcome === "sent" && TRANSFER_REFERENCE.test(reference.trim());
}

export interface SettleTransferDialogProps {
  transferId: string;
  onSettle: (outcome: TransferSettleOutcome, reference: string | undefined, note: string) => Promise<void>;
}

export function SettleTransferDialog({ transferId, onSettle }: SettleTransferDialogProps): React.JSX.Element {
  const id = React.useId();
  const [open, setOpen] = React.useState(false);
  const [outcome, setOutcome] = React.useState<TransferSettleOutcome | null>(null);
  const [reference, setReference] = React.useState("");
  const [note, setNote] = React.useState("");
  const badReference = outcome === "sent" && reference.trim() !== "" && !TRANSFER_REFERENCE.test(reference.trim());
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setOutcome(null);
          setReference("");
          setNote("");
        }
      }}
      trigger={
        <Button variant="outline" size="sm" data-testid="payout-transfer-settle" data-transfer-id={transferId}>
          {t("transferSettle.button")}
        </Button>
      }
      title={t("transferSettle.title")}
      description={t("transferSettle.body")}
      confirmLabel={t("transferSettle.confirm")}
      confirmDisabled={!settleReady(outcome, reference)}
      onConfirm={async () => {
        if (!outcome || !settleReady(outcome, reference)) return;
        await onSettle(outcome, outcome === "sent" ? reference.trim() : undefined, note.trim());
      }}
      onError={(err) => toastActionError(err, t("transferSettle.error"))}
      contentProps={{ "data-testid": "payout-transfer-settle-dialog" }}
    >
      <FieldSet>
        <FieldLegend variant="label">{t("transferSettle.outcome")}</FieldLegend>
        <RadioGroup
          value={outcome ?? ""}
          onValueChange={(v) => {
            if (isOutcome(v)) setOutcome(v);
          }}
        >
          {OUTCOMES.map((o) => (
            <Field key={o} orientation="horizontal">
              <RadioGroupItem id={`${id}-${o}`} value={o} />
              <FieldLabel htmlFor={`${id}-${o}`} className="font-normal">
                {t(OUTCOME_LABEL[o])}
              </FieldLabel>
            </Field>
          ))}
        </RadioGroup>
      </FieldSet>
      {outcome === "sent" && (
        <Field data-invalid={badReference || undefined}>
          <FieldLabel htmlFor={`${id}-ref`}>{t("transferSettle.reference")}</FieldLabel>
          <Input
            id={`${id}-ref`}
            value={reference}
            autoComplete="off"
            spellCheck={false}
            maxLength={64}
            aria-invalid={badReference || undefined}
            aria-describedby={`${id}-ref-hint`}
            onChange={(e) => setReference(e.target.value)}
          />
          <FieldDescription id={`${id}-ref-hint`}>{t("transferSettle.referenceHint")}</FieldDescription>
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor={`${id}-note`}>{t("transferSettle.note")}</FieldLabel>
        <Textarea
          id={`${id}-note`}
          value={note}
          maxLength={SETTLE_NOTE_MAX}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
    </ConfirmDialog>
  );
}
