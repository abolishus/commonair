// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One Stripe payout's Connect transfer (batch 8, M1-connect; ADR 0007 Amendment 1, decision (f)),
 * run by the `payout-transfers` job the payout run enqueues (one per payout, a stable job id):
 *
 * 1. open the `pending` transfer row, in its own transaction (`openPayoutTransfer`);
 * 2. after commit, check the payee: their Stripe account can receive payouts and they are not under
 *    fraud review (ADR 0036; `payouts_fraud_guard` and 0049 are the backstop). If not, the transfer
 *    fails (`account_not_ready` / `held`) and the payout is cancelled back to the payable, and
 *    Stripe is never called;
 * 3. call Stripe outside any transaction, under the payout's idempotency key;
 * 4. record the answer: created → payout paid (`payoutSent`), then the payout-sent mail; a definite
 *    4xx → failed, payout cancelled (`payoutCancel`); an unknown outcome → still pending, and the job
 *    throws so BullMQ retries with the same key (Stripe answers with the same transfer). After the
 *    last attempt the row says `outcome_unknown` for the treasurer.
 *
 * Readiness is the stored `payout_accounts.payouts_enabled`, kept in step by `account.updated` and by
 * every visit to the payout card (`stripe-connect.ts` in the API), not a live account read here: a
 * refused transfer is a definite 4xx that cancels the payout anyway, and marks the account not ready.
 * The manual adapter has no `transfer`: nothing moves. Logs carry ids and codes only.
 */
import { eq } from "drizzle-orm";
import { loadEnv, paymentsEnv } from "@commonair/config";
import { schema } from "@commonair/db";
import {
  PAYOUT_TRANSFER_CODES,
  PAYOUT_TRANSFER_KEY_WINDOW_MS,
  PayoutStateError,
  cancelPayout,
  markPayoutTransferUnsettled,
  markStripeAccountNotReady,
  openPayoutTransfer,
  payeeHasHoldingFlag,
  recordPayoutTransferCreated,
  recordPayoutTransferFailed,
} from "@commonair/ledger";
import {
  type PaymentAdapter,
  StripeOutcomeUnknown,
  StripeRequestError,
  type TransferResult,
  createAdapter,
} from "@commonair/payments";
import type { WorkerContext } from "../context.ts";

type TransferRow = typeof schema.payoutTransfers.$inferSelect;

export interface PayoutTransferDeps {
  adapter: Pick<PaymentAdapter, "provider" | "transfer">;
}

export type PayoutTransferOutcome =
  | { outcome: "created"; transferId: string }
  | { outcome: "failed"; transferId: string; code: string }
  | { outcome: "unknown"; transferId: string }
  /** Stripe created it, but the payout left `scheduled` meanwhile: kept pending with Stripe's id. */
  | { outcome: "unrecorded"; transferId: string }
  /** No Stripe account to send to at all: the payout is cancelled back to the payable, no row. */
  | { outcome: "cancelled"; reason: "no_account" }
  | { outcome: "skipped"; reason: "manual" | "not_scheduled" | "settled" | "waiting" };

/** Stripe error codes that say the destination account cannot take transfers (deleted, restricted). */
const ACCOUNT_REFUSALS = new Set([
  "resource_missing",
  "account_invalid",
  "insufficient_capabilities_for_transfer",
  "transfers_not_allowed",
]);

/** The opaque `failure_code` of a definite refusal: Stripe's code when it is one, else the HTTP status. */
export function failureCodeOf(err: StripeRequestError): string {
  const code = err.code;
  if (code && /^[a-z0-9_]{1,56}$/.test(code)) return code;
  return `stripe_${err.status}`;
}

/** Whether a definite refusal is about the payee's account (so it is marked not ready, as `account.updated`). */
export const isAccountRefusal = (err: StripeRequestError): boolean => ACCOUNT_REFUSALS.has(err.code ?? "");

const adapterEnv = paymentsEnv.pick({
  PAYMENTS_PROVIDER: true,
  MANUAL_PAYMENT_INSTRUCTIONS: true,
  STRIPE_SECRET_KEY: true,
  STRIPE_API_BASE: true,
});
let cachedAdapter: PaymentAdapter | undefined;

/** The instance's adapter (`PAYMENTS_PROVIDER`), read once per process. A live key is refused here. */
export function transferAdapterFromEnv(source?: Record<string, string | undefined>): PaymentAdapter {
  if (!source && cachedAdapter) return cachedAdapter;
  const adapter = createAdapter(loadEnv(adapterEnv, source ?? process.env));
  if (!source) cachedAdapter = adapter;
  return adapter;
}

export async function runPayoutTransfer(
  ctx: WorkerContext,
  deps: PayoutTransferDeps,
  payoutId: string,
  opts: { lastAttempt: boolean },
): Promise<PayoutTransferOutcome> {
  const send = deps.adapter.transfer;
  if (!send) return { outcome: "skipped", reason: "manual" };
  const opened = await openPayoutTransfer(ctx.db, { payoutId, at: ctx.now() });
  if (!opened.transfer) {
    if (opened.reason === "not_scheduled") return { outcome: "skipped", reason: "not_scheduled" };
    // A scheduled Stripe payout whose payee has no Stripe account any more: nothing can be sent.
    await cancelPayout(ctx.db, { payoutId, at: ctx.now() });
    ctx.logger.warn("payout transfer: no Stripe account; payout cancelled", { payoutId });
    return { outcome: "cancelled", reason: "no_account" };
  }
  const t = opened.transfer;
  if (t.status !== "pending") return { outcome: "skipped", reason: "settled" };
  const [payout] = await ctx.db.select().from(schema.payouts).where(eq(schema.payouts.id, payoutId));
  if (!payout) return { outcome: "skipped", reason: "not_scheduled" };

  // Stripe answered with its id before, but the payout was not scheduled then: settle it now if it is.
  if (t.providerRef !== null) {
    if (payout.status !== "scheduled") return { outcome: "skipped", reason: "waiting" };
    return created(ctx, t, { providerRef: t.providerRef, amountCents: t.amountCents, currency: t.currency });
  }

  if (payout.status === "held") return fail(ctx, t, PAYOUT_TRANSFER_CODES.held);
  if (payout.status !== "scheduled") return { outcome: "skipped", reason: "waiting" };
  if (await payeeHasHoldingFlag(ctx.db, payout.userId)) return fail(ctx, t, PAYOUT_TRANSFER_CODES.held);
  const [acct] = await ctx.db
    .select()
    .from(schema.payoutAccounts)
    .where(eq(schema.payoutAccounts.userId, payout.userId));
  if (acct?.provider !== "stripe" || !acct.payoutsEnabled || acct.providerAccountId !== t.destinationRef)
    return fail(ctx, t, PAYOUT_TRANSFER_CODES.accountNotReady);

  // Past Stripe's idempotency window a repeat could create a second transfer: a person settles it.
  if (ctx.now().getTime() - t.createdAt.getTime() > PAYOUT_TRANSFER_KEY_WINDOW_MS) {
    await markPayoutTransferUnsettled(ctx.db, {
      transferId: t.id,
      code: PAYOUT_TRANSFER_CODES.outcomeUnknown,
      at: ctx.now(),
    });
    ctx.logger.warn("payout transfer: past the idempotency window, not sent again", { payoutId, transferId: t.id });
    return { outcome: "unknown", transferId: t.id };
  }

  let result: TransferResult;
  try {
    result = await send({
      payoutId,
      transferId: t.id,
      destination: t.destinationRef,
      amountCents: t.amountCents,
      currency: t.currency,
      group: payout.periodStart.toISOString(),
      idempotencyKey: t.idempotencyKey,
    });
  } catch (err) {
    if (err instanceof StripeRequestError) {
      if (isAccountRefusal(err)) await markStripeAccountNotReady(ctx.db, { userId: payout.userId, at: ctx.now() });
      return fail(ctx, t, failureCodeOf(err));
    }
    // A request the adapter refused to build never reached Stripe.
    if (err instanceof RangeError) return fail(ctx, t, "invalid_request");
    if (err instanceof StripeOutcomeUnknown && opts.lastAttempt) {
      await markPayoutTransferUnsettled(ctx.db, {
        transferId: t.id,
        code: PAYOUT_TRANSFER_CODES.outcomeUnknown,
        at: ctx.now(),
      });
    }
    ctx.logger.warn("payout transfer: outcome unknown, retrying with the same key", {
      payoutId,
      transferId: t.id,
      errorName: err instanceof Error ? err.name : "UnknownError",
      lastAttempt: opts.lastAttempt,
    });
    throw err;
  }
  return created(ctx, t, result);
}

async function fail(ctx: WorkerContext, t: TransferRow, code: string): Promise<PayoutTransferOutcome> {
  await recordPayoutTransferFailed(ctx.db, { transferId: t.id, failureCode: code, at: ctx.now() });
  ctx.logger.info("payout transfer failed; payout cancelled back to the payable", {
    payoutId: t.payoutId,
    transferId: t.id,
    failureCode: code,
  });
  return { outcome: "failed", transferId: t.id, code };
}

async function created(ctx: WorkerContext, t: TransferRow, r: TransferResult): Promise<PayoutTransferOutcome> {
  try {
    const { created: changed } = await recordPayoutTransferCreated(ctx.db, {
      transferId: t.id,
      providerRef: r.providerRef,
      at: ctx.now(),
    });
    ctx.logger.info("payout transfer created", { payoutId: t.payoutId, transferId: t.id });
    if (changed) await payoutSentMail(ctx, t, r.providerRef);
    return { outcome: "created", transferId: t.id };
  } catch (err) {
    // The payout left `scheduled` (a fraud hold) while Stripe created the transfer. Keep Stripe's id
    // on the pending row: it is never cancelled, and the next run settles it once the payout is back.
    if (!(err instanceof PayoutStateError) && !isCheckViolation(err)) throw err;
    await markPayoutTransferUnsettled(ctx.db, {
      transferId: t.id,
      code: PAYOUT_TRANSFER_CODES.sentUnrecorded,
      providerRef: r.providerRef,
      at: ctx.now(),
    });
    ctx.logger.warn("payout transfer created at Stripe but the payout is no longer scheduled", {
      payoutId: t.payoutId,
      transferId: t.id,
    });
    return { outcome: "unrecorded", transferId: t.id };
  }
}

function isCheckViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === "object" && depth < 5; depth++) {
    if ((e as { code?: unknown }).code === "23514") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** The existing payout-sent notice, best effort after commit (the payout stands without it). */
async function payoutSentMail(ctx: WorkerContext, t: TransferRow, reference: string): Promise<void> {
  if (!ctx.mailer || !ctx.site) return;
  const [row] = await ctx.db
    .select({ email: schema.users.email, locale: schema.users.locale, accountType: schema.users.accountType })
    .from(schema.payouts)
    .innerJoin(schema.users, eq(schema.users.id, schema.payouts.userId))
    .where(eq(schema.payouts.id, t.payoutId));
  if (!row || row.accountType !== "human") return;
  try {
    await ctx.mailer.send(
      "payoutSent",
      {
        amountCents: t.amountCents,
        currency: t.currency,
        sentAt: ctx.now(),
        reference,
        earningsUrl: `${ctx.site.publicUrl.replace(/\/+$/, "")}/revenue`,
        locale: row.locale,
      },
      row.email,
    );
  } catch (err) {
    // Never log the address.
    ctx.logger.warn("payout-sent mail failed", {
      payoutId: t.payoutId,
      errorName: err instanceof Error ? err.name : "UnknownError",
    });
  }
}
