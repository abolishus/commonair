// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The payment receipt (batch 8, M1-gifts-refunds; the batch 4 `PaymentBreakdown` decision). Sent
 * once per payment that became `succeeded`, to the payer. Its data carries amounts, the breakdown
 * lines, the time, the reference and the channel name only: no email address and no username.
 * It shows the amount, where the money went (one row per breakdown line, as the payer sees it on
 * the web), when, the reference, who was paid (the channel, or the co-op for a share), and a link
 * to the payer's payments page. Not a tax invoice.
 */
import type { BREAKDOWN_LINE_KINDS, PAYMENT_KINDS } from "@commonair/contracts/enums";
import type { DateInput } from "../format.ts";
import { Action, defineTemplate, Facts, H1, Muted, P } from "../template.tsx";

type LineKind = (typeof BREAKDOWN_LINE_KINDS)[number];

export interface PaymentReceiptLine {
  kind: LineKind;
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

/** Where the payer reviews their payments and each one's breakdown (`/settings/subscriptions`). */
export const RECEIPT_PAYMENTS_PATH = "/settings/subscriptions";

type ReceiptMessages = {
  [
    K in
      | "subject"
      | "preview"
      | "heading"
      | "bodyChannel"
      | "bodyCoop"
      | "amountLabel"
      | "paidLabel"
      | "referenceLabel"
      | "paidToLabel"
      | "kindLabel"
      | "kindSubscription"
      | "kindTip"
      | "kindShare"
      | "coop"
      | "linesHeading"
      | "lineTax"
      | "lineCreator"
      | "lineCoopShare"
      | "lineProcessorFee"
      | "lineCoopNet"
      | "lineReversal"
      | "lineDisputeFee"
      | "notInvoice"
      | "action"
  ]: string;
};

const LINE_LABEL: Record<LineKind, keyof ReceiptMessages> = {
  tax: "lineTax",
  creator: "lineCreator",
  coop_share: "lineCoopShare",
  processor_fee: "lineProcessorFee",
  coop_net: "lineCoopNet",
  reversal: "lineReversal",
  dispute_fee: "lineDisputeFee",
};

const KIND_LABEL: Record<PaymentReceiptData["kind"], keyof ReceiptMessages> = {
  subscription: "kindSubscription",
  tip: "kindTip",
  membership_share: "kindShare",
};

export const paymentReceipt = defineTemplate("paymentReceipt", {
  links: [],
  subject: (ctx, d: PaymentReceiptData) =>
    ctx.text(ctx.messages.subject, { amount: ctx.money(d.amountCents, d.currency) }),
  preview: (ctx) => ctx.text(ctx.messages.preview),
  body: (ctx, d: PaymentReceiptData) => {
    const m: ReceiptMessages = ctx.messages;
    const amount = ctx.money(d.amountCents, d.currency);
    const payee = d.channelName ?? ctx.text(m.coop);
    const lines: [string, string][] = d.lines.map((l) => [
      ctx.text(m[LINE_LABEL[l.kind]]),
      ctx.money(l.amountCents, d.currency),
    ]);
    return (
      <>
        <H1>{ctx.t(m.heading)}</H1>
        <P>
          {d.channelName === null
            ? ctx.t(m.bodyCoop, { amount: <strong>{amount}</strong> })
            : ctx.t(m.bodyChannel, { amount: <strong>{amount}</strong>, channel: <strong>{d.channelName}</strong> })}
        </P>
        <Facts
          items={[
            [m.amountLabel, amount],
            [m.paidToLabel, payee],
            [m.kindLabel, ctx.text(m[KIND_LABEL[d.kind]])],
            [m.paidLabel, ctx.dateTime(d.paidAt)],
            [m.referenceLabel, d.reference],
          ]}
        />
        {lines.length > 0 && (
          <>
            <P>
              <strong>{ctx.t(m.linesHeading)}</strong>
            </P>
            <Facts items={lines} />
          </>
        )}
        <Action ctx={ctx} href={new URL(RECEIPT_PAYMENTS_PATH, `${ctx.site.publicUrl}/`).toString()} label={m.action} />
        <Muted>{ctx.t(m.notInvoice)}</Muted>
      </>
    );
  },
});
