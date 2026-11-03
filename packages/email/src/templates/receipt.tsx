// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The payment receipt (batch 8, M1-gifts-refunds; the batch 4 `PaymentBreakdown` decision). Sent
 * once per payment that became `succeeded`, to the payer. Its data carries amounts, the breakdown
 * lines, the time, the reference and the channel name only: no email address and no username.
 * A stub until M1-gifts-refunds fills it (the lines, the link to the payment settings and the
 * copy); it renders the amount, the time and the reference.
 */
import type { BREAKDOWN_LINE_KINDS, PAYMENT_KINDS } from "@commonair/contracts/enums";
import type { DateInput } from "../format.ts";
import { defineTemplate, Facts, H1 } from "../template.tsx";

export interface PaymentReceiptLine {
  kind: (typeof BREAKDOWN_LINE_KINDS)[number];
  /** Signed integer minor units, as `PaymentBreakdown` lines. */
  amountCents: number;
}

export interface PaymentReceiptData {
  /** The amount paid, integer minor units. */
  amountCents: number;
  currency: string;
  /** The `PaymentBreakdown` lines of the payment. */
  lines: PaymentReceiptLine[];
  paidAt: DateInput;
  /** The payment's reference (`CA-…`) or provider reference. */
  reference: string;
  /** The channel paid; null for a co-op share. */
  channelName: string | null;
  kind: (typeof PAYMENT_KINDS)[number];
}

export const paymentReceipt = defineTemplate("paymentReceipt", {
  links: [],
  subject: (ctx, d: PaymentReceiptData) =>
    ctx.text(ctx.messages.subject, { amount: ctx.money(d.amountCents, d.currency) }),
  preview: (ctx) => ctx.text(ctx.messages.preview),
  body: (ctx, d: PaymentReceiptData) => {
    const m = ctx.messages;
    return (
      <>
        <H1>{ctx.t(m.heading)}</H1>
        <Facts
          items={[
            [m.amountLabel, ctx.money(d.amountCents, d.currency)],
            [m.paidLabel, ctx.dateTime(d.paidAt)],
            [m.referenceLabel, d.reference],
          ]}
        />
      </>
    );
  },
});
