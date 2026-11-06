// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Ask Stripe again about a refund request whose outcome is unknown (follow-ups, unit money;
 * `money.treasurer.refundRequests.recheck`). Behind a `ConfirmDialog`, because a definite "not
 * refunded" releases the request in the treasurer's name. A refund Stripe has is booked by its
 * webhook, never by this button. The result is told in a toast (`recheckToast`).
 */
import type { RefundRecheckResult } from "@commonair/contracts/enums";
import { ConfirmDialog } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import * as React from "react";
import { t, type MessageKey } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";

export type RecheckTone = "success" | "info" | "warning" | "error";

const RESULT: Record<RefundRecheckResult, { key: MessageKey; tone: RecheckTone }> = {
  refunded: { key: "refundRecheck.result.refunded", tone: "info" },
  pending: { key: "refundRecheck.result.pending", tone: "info" },
  failed: { key: "refundRecheck.result.failed", tone: "success" },
  none: { key: "refundRecheck.result.none", tone: "success" },
  ambiguous: { key: "refundRecheck.result.ambiguous", tone: "warning" },
  unavailable: { key: "refundRecheck.result.unavailable", tone: "error" },
};

/** What a recheck result tells the treasurer, and how loudly (pure). */
export function recheckToast(result: RefundRecheckResult): { message: string; tone: RecheckTone } {
  const r = RESULT[result];
  return { message: t(r.key), tone: r.tone };
}

export interface RecheckRefundDialogProps {
  requestId: string;
  /** Why it cannot be asked now (the reconciler's 15 minutes), or null. */
  blockedReason: string | null;
  onRecheck: () => Promise<void>;
}

export function RecheckRefundDialog({
  requestId,
  blockedReason,
  onRecheck,
}: RecheckRefundDialogProps): React.JSX.Element {
  const id = React.useId();
  return (
    <div className="flex flex-col items-end gap-1">
      <ConfirmDialog
        trigger={
          <Button
            variant="outline"
            size="sm"
            data-testid="refund-request-recheck"
            data-request-id={requestId}
            disabled={blockedReason !== null}
            aria-describedby={blockedReason ? `${id}-blocked` : undefined}
          >
            {t("refundRecheck.button")}
          </Button>
        }
        title={t("refundRecheck.title")}
        description={t("refundRecheck.body")}
        confirmLabel={t("refundRecheck.confirm")}
        onConfirm={onRecheck}
        onError={(err) => toastActionError(err, t("refundRecheck.error"))}
        contentProps={{ "data-testid": "refund-request-recheck-dialog" }}
      />
      {/* The resolve button beside it shows the same reason; this copy is for screen readers. */}
      {blockedReason && (
        <p id={`${id}-blocked`} className="sr-only">
          {blockedReason}
        </p>
      )}
    </div>
  );
}
