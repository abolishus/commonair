// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The payment receipt email (template `paymentReceipt`; the batch 4 `PaymentBreakdown` decision).
 * Called after commit wherever a payment becomes `succeeded`: the Stripe `checkout.completed` and
 * `invoice.paid` paths (`stripe-webhook.ts`) and the treasurer's manual confirm
 * (`checkout-treasurer.ts`).
 *
 * - The lines are the payer's view of the payment's `PaymentBreakdown`, built from its ledger
 *   postings with the same builder `money.paymentBreakdown` uses (`buildBreakdown`, `payerLines`).
 * - It sends at most once per payment: a `payment.receipt_sent` audit marker is claimed under the
 *   payment's row lock before the mail goes out, so a redelivery or a race finds it and stops. A
 *   send that fails after the claim is logged and not repeated (a missing receipt is better than two).
 * - It skips payments without a payer, deleted payers and payers without a verified address.
 * - Logs carry the payment id only: no address, no username.
 */
import { and, eq, inArray } from "drizzle-orm";
import { schema } from "@commonair/db";
import {
  BreakdownError,
  type BreakdownTransaction,
  buildBreakdown,
  loadMoneySettings,
  payerLines,
} from "@commonair/ledger";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { errorName } from "./stripe-refunds.ts";

const { payments, users, channels, auditLog, ledgerTransactions, ledgerEntries, ledgerAccounts } = schema;

export const RECEIPT_SENT = "payment.receipt_sent";
/**
 * The marker's subject type: its own, with the payment id as subject, so the receipt stays out of
 * the payment's refund and dispute history (which reads `subject_type = 'payment'`).
 */
export const RECEIPT_SUBJECT = "payment_receipt";

export type ReceiptOutcome =
  | "sent"
  | "already_sent"
  | "not_succeeded"
  | "no_payer"
  | "payer_deleted"
  | "email_unverified"
  | "send_failed";

async function postingsOf(deps: Deps, paymentId: string): Promise<BreakdownTransaction[]> {
  const rows = await deps.db
    .select({
      id: ledgerTransactions.id,
      kind: ledgerTransactions.kind,
      occurredAt: ledgerTransactions.occurredAt,
      metadata: ledgerTransactions.metadata,
      code: ledgerAccounts.code,
      amountCents: ledgerEntries.amountCents,
      memo: ledgerEntries.memo,
    })
    .from(ledgerTransactions)
    .innerJoin(ledgerEntries, eq(ledgerEntries.transactionId, ledgerTransactions.id))
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .where(and(eq(ledgerTransactions.refType, "payment"), eq(ledgerTransactions.refId, paymentId)));
  const byTx = new Map<string, BreakdownTransaction & { entries: BreakdownTransaction["entries"][number][] }>();
  for (const r of rows) {
    let tx = byTx.get(r.id);
    if (!tx) {
      tx = { id: r.id, kind: r.kind, occurredAt: r.occurredAt, metadata: r.metadata, entries: [] };
      byTx.set(r.id, tx);
    }
    tx.entries.push({ code: r.code, amountCents: r.amountCents, memo: r.memo });
  }
  return [...byTx.values()];
}

export async function sendPaymentReceipt(deps: Deps, paymentId: string): Promise<ReceiptOutcome> {
  const [row] = await deps.db
    .select({
      p: payments,
      email: users.email,
      emailVerified: users.emailVerified,
      deletedAt: users.deletedAt,
      locale: users.locale,
      channelName: channels.displayName,
      ownerId: channels.ownerId,
    })
    .from(payments)
    .leftJoin(users, eq(users.id, payments.userId))
    .leftJoin(channels, eq(channels.id, payments.channelId))
    .where(eq(payments.id, paymentId));
  if (!row || !["succeeded", "partially_refunded", "refunded"].includes(row.p.status)) return "not_succeeded";
  const p = row.p;
  const paidAt = p.succeededAt;
  if (paidAt === null) return "not_succeeded";
  if (!p.userId || row.email === null) return "no_payer";
  if (row.deletedAt !== null) return "payer_deleted";
  if (!row.emailVerified) return "email_unverified";

  let lines: { kind: ReturnType<typeof payerLines>[number]["kind"]; amountCents: number }[] = [];
  try {
    const { payoutRules } = await loadMoneySettings(deps.db);
    const built = buildBreakdown(
      { id: p.id, kind: p.kind, currency: p.currency, succeededAt: paidAt },
      await postingsOf(deps, p.id),
      payoutRules.holdDays,
    );
    const shown = row.ownerId ? payerLines(built.lines, row.ownerId) : built.lines;
    lines = shown.map((l) => ({ kind: l.kind, amountCents: l.amount.cents }));
  } catch (err) {
    // The receipt still carries the amount; the breakdown page shows the lines once readable.
    if (!(err instanceof BreakdownError)) throw err;
    deps.logger.warn("receipt without breakdown lines", { paymentId: p.id, error: errorName(err) });
  }

  // Claim the receipt under the payment's row lock: one send per payment, whoever calls.
  const claimed = await deps.db.transaction(async (tx) => {
    await tx.select({ id: payments.id }).from(payments).where(eq(payments.id, p.id)).for("update");
    const [sent] = await tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.subjectType, RECEIPT_SUBJECT),
          eq(auditLog.subjectId, p.id),
          inArray(auditLog.action, [RECEIPT_SENT]),
        ),
      )
      .limit(1);
    if (sent) return false;
    await audit(tx, {
      actorType: "system",
      actorId: null,
      action: RECEIPT_SENT,
      subjectType: RECEIPT_SUBJECT,
      subjectId: p.id,
      channelId: p.channelId,
      details: { paymentId: p.id, kind: p.kind },
    });
    return true;
  });
  if (!claimed) return "already_sent";

  try {
    await deps.mailer.send(
      "paymentReceipt",
      {
        amountCents: p.amountCents,
        currency: p.currency,
        lines,
        paidAt,
        reference: p.providerRef,
        channelName: p.kind === "membership_share" ? null : (row.channelName ?? null),
        kind: p.kind,
        locale: row.locale,
      },
      row.email,
    );
  } catch (err) {
    deps.logger.warn("payment receipt not sent", { paymentId: p.id, error: errorName(err) });
    return "send_failed";
  }
  deps.logger.info("payment receipt sent", { paymentId: p.id });
  return "sent";
}
