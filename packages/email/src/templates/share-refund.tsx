// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The co-op treasury asks a member how to refund their member share (overhaul wave 5, ADR 0042):
 * sent by `coop.shares.askRefundDetails`, so the treasurer never sees the address. The member
 * writes to the instance's general contact (the treasury has no address of its own), quoting the
 * share reference. No bank or card details are asked for in the email itself: the treasury replies
 * with the next step.
 */
import type { DateInput } from "../format.ts";
import { defineTemplate, Facts, H1, Muted, Notice, P } from "../template.tsx";

export interface ShareRefundDetailsData {
  amountCents: number;
  currency: string;
  /** The share's bank-transfer reference, or its id when it has none. */
  reference: string;
  /** When the member's account will be deleted; null when no deletion is scheduled. */
  deleteAt: DateInput | null;
}

export const shareRefundDetails = defineTemplate("shareRefundDetails", {
  links: [],
  subject: (ctx, d: ShareRefundDetailsData) =>
    ctx.text(ctx.messages.subject, { amount: ctx.money(d.amountCents, d.currency) }),
  body: (ctx, d: ShareRefundDetailsData) => {
    const m = ctx.messages;
    const amount = ctx.money(d.amountCents, d.currency);
    return (
      <>
        <H1>{ctx.t(m.heading)}</H1>
        <P>{ctx.t(m.body, { amount: <strong>{amount}</strong> })}</P>
        <Facts
          items={[
            [m.amountLabel, amount],
            [m.referenceLabel, d.reference],
            ...(d.deleteAt ? ([[m.deleteAtLabel, ctx.date(d.deleteAt)]] as [string, string][]) : []),
          ]}
        />
        <P>{ctx.t(m.reply, { contact: ctx.contact("general") })}</P>
        <Notice>{ctx.t(m.afterDeletion)}</Notice>
        <Muted>{ctx.t(m.safety)}</Muted>
      </>
    );
  },
});
