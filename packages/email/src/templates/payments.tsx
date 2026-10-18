// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Money notices for creators: payouts and reversals. Amounts are integer minor units. */
import type { DateInput } from "../format.ts";
import { Action, defineTemplate, Facts, H1, Muted, Notice, P } from "../template.tsx";

export interface PayoutSentData {
  amountCents: number;
  currency: string;
  sentAt: DateInput;
  reference: string;
  earningsUrl: string;
}

export const payoutSent = defineTemplate("payoutSent", {
  subject: (ctx, d: PayoutSentData) => ctx.text(ctx.messages.subject, { amount: ctx.money(d.amountCents, d.currency) }),
  body: (ctx, d: PayoutSentData) => {
    const m = ctx.messages;
    const amount = ctx.money(d.amountCents, d.currency);
    return (
      <>
        <H1>{ctx.t(m.heading)}</H1>
        <P>{ctx.t(m.body, { amount: <strong>{amount}</strong> })}</P>
        <Facts
          items={[
            [m.amountLabel, amount],
            [m.sentLabel, ctx.dateTime(d.sentAt)],
            [m.referenceLabel, d.reference],
          ]}
        />
        <Muted>{ctx.t(m.timing)}</Muted>
        <Action ctx={ctx} href={d.earningsUrl} label={m.action} />
      </>
    );
  },
});

export interface ChargebackNoticeData {
  kind: "chargeback" | "clawback";
  amountCents: number;
  currency: string;
  occurredAt: DateInput;
  reference: string;
  earningsUrl: string;
}

export const chargebackNotice = defineTemplate("chargebackNotice", {
  subject: (ctx, d: ChargebackNoticeData) =>
    ctx.text(d.kind === "chargeback" ? ctx.messages.subjectChargeback : ctx.messages.subjectClawback, {
      amount: ctx.money(d.amountCents, d.currency),
    }),
  body: (ctx, d: ChargebackNoticeData) => {
    const m = ctx.messages;
    const chargeback = d.kind === "chargeback";
    return (
      <>
        <H1>{ctx.t(chargeback ? m.headingChargeback : m.headingClawback)}</H1>
        <P>{ctx.t(chargeback ? m.bodyChargeback : m.bodyClawback)}</P>
        <Facts
          items={[
            [m.amountLabel, ctx.money(d.amountCents, d.currency)],
            [m.dateLabel, ctx.dateTime(d.occurredAt)],
            [m.referenceLabel, d.reference],
          ]}
        />
        <Notice>{ctx.t(m.balance)}</Notice>
        <Action ctx={ctx} href={d.earningsUrl} label={m.action} />
        <Muted>{ctx.t(m.question, { contact: ctx.contact("general") })}</Muted>
      </>
    );
  },
});
