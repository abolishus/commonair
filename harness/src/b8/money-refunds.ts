// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `e4b-money` B8 extensions of M1-gifts-refunds (docs/testing/b8-selectors.md, "Scenarios"; ADR
 * 0007 Amendment 1). Each step uses its own payers, so it never depends on the scenario's own
 * payments, and checks that every ledger transaction of its payments balances.
 *
 * - `gift-window`: a gift's payment expires after `GIFT_PAYMENT_HOURS` (24 h by default); a second
 *   unpaid gift by the same gifter to the channel is refused with CONFLICT `gift_pending`.
 * - `auto-refund` (`provider=stripe`): a signed `invoice.paid` for a subscription that already
 *   ended books the money (`paid_after_end`) and produces one automatic refund request; a signed
 *   `charge.refunded` of that amount posts it and settles the request; the subscription stays ended.
 * - `refund-unknown` (`provider=stripe`, OPS_TEST_HOOKS): the API's fault hook makes the treasurer's
 *   refund call time out; the request shows as "unknown" to the treasurer and a second refund is
 *   refused; a signed `charge.refunded` of that amount reconciles it.
 * - `receipt-email`: a confirmed tip (the treasurer's confirm, or a signed checkout with Stripe)
 *   sends one receipt to the payer, with the breakdown lines, which lands in Mailpit.
 *
 * Stripe is played by signed local webhook events and an injected fault (decision (b)): no live key.
 */
import { RedisClient } from "bun";
import { createDb } from "@commonair/db";
import { ledgerSums } from "../money-db.ts";
import { unbalancedTransactions } from "../money.ts";
import { valkeyUrl } from "../multi/replicas.ts";
import { apiError, errorOf } from "../safety.ts";
import { firstInvoicePaid, paymentCompleted, stripeEvent, stripeId } from "../stripe.ts";
import type { SignedInUser } from "../users.ts";
import { tsParam, toDate } from "../w2/sql-time.ts";
import type { MoneyB8Extension } from "./kit.ts";

const HOUR_MS = 3_600_000;
/** `GIFT_PAYMENT_HOURS`' seeded default (the harness stack does not override it). */
export const GIFT_WINDOW_HOURS = 24;
/** The API's fault hook key (`services/api/src/money/stripe-refunds.ts` `refundFaultKey`). */
export const refundFaultKey = (paymentId: string) => `test:fault:refund-unknown:${paymentId}`;
const TIP_CENTS = 650;
const MAIL_TIMEOUT_MS = 30_000;
const DUPLICATE_GRACE_MS = 2_000;

type Ext = MoneyB8Extension;
type RefundRequestPage = Awaited<
  ReturnType<SignedInUser["api"]["client"]["money"]["treasurer"]["refundRequests"]["list"]>
>;

// ------------------------------------------------------------ pure checks (unit-tested)

/** Whether `expiresAt` is `hours` after `createdAt`, within `slackMs`. */
export function expiresAfterHours(createdAt: Date, expiresAt: Date, hours: number, slackMs = 60_000): boolean {
  return Math.abs(expiresAt.getTime() - createdAt.getTime() - hours * HOUR_MS) <= slackMs;
}

/** The request of `paymentId` in a list page, or null. */
export function requestOf(page: RefundRequestPage, paymentId: string): RefundRequestPage["items"][number] | null {
  return page.items.find((r) => r.paymentId === paymentId) ?? null;
}

/** The breakdown labels an English receipt must show for a channel payment. */
export const RECEIPT_LINE_LABELS = ["To the creator", "To the co-op"] as const;

/** Problems with a receipt's text: the amount, the breakdown lines and the payments link. */
export function receiptProblems(text: string, o: { amount: string; reference: string }): string[] {
  const problems: string[] = [];
  if (!text.includes(o.amount)) problems.push(`amount ${o.amount} missing`);
  if (!text.includes(o.reference)) problems.push(`reference ${o.reference} missing`);
  for (const label of RECEIPT_LINE_LABELS) if (!text.includes(label)) problems.push(`line "${label}" missing`);
  if (!text.includes("/settings/subscriptions")) problems.push("payments link missing");
  return problems;
}

// ------------------------------------------------------------ shared helpers

async function withDb<T>(ext: Ext, fn: (sql: ReturnType<typeof createDb>["sql"]) => Promise<T>): Promise<T> {
  const handle = createDb({ url: ext.databaseUrl, max: 1, applicationName: "commonair-harness-b8" });
  try {
    return await fn(handle.sql);
  } finally {
    await handle.close();
  }
}

async function assertBalanced(ext: Ext, label: string, paymentIds: readonly string[]) {
  const ledger = await ledgerSums(ext.databaseUrl, paymentIds);
  const unbalanced = unbalancedTransactions(ledger.rows);
  ext.ctx.assert(`${label}: every ledger transaction balances`, unbalanced.length === 0, { unbalanced });
}

async function paymentByRef(ext: Ext, providerRef: string) {
  return withDb(ext, async (sql) => {
    const rows = await sql<{ id: string; status: string; refunded_cents: number; subscription_id: string | null }[]>`
      select id::text as id, status::text as status, refunded_cents::int as refunded_cents,
             subscription_id::text as subscription_id
        from payments where provider = 'stripe' and provider_ref = ${providerRef}`;
    return rows[0] ?? null;
  });
}

function needsStripe(ext: Ext, step: string): ext is Ext & { stripe: NonNullable<Ext["stripe"]> } {
  if (ext.provider === "stripe" && ext.stripe) return true;
  ext.ctx.skipStep(step, "needs --set provider=stripe --set via=api (signed Stripe events; decision (b))");
  return false;
}

async function deliver(
  ext: Ext & { stripe: NonNullable<Ext["stripe"]> },
  label: string,
  event: unknown,
  outcome: string,
) {
  const d = await ext.ctx.step(`Stripe: ${label}`, () => ext.stripe.deliver(event as never));
  ext.ctx.assert(`${label} answers ${outcome}`, d.body.outcome === outcome, d);
  return d;
}

/** A signed tip checkout, confirmed. */
async function paidStripeTip(ext: Ext & { stripe: NonNullable<Ext["stripe"]> }, payer: SignedInUser, cents: number) {
  const checkout = await ext.ctx.step("payer: Stripe checkout for a tip", () =>
    payer.api.client.money.tip({
      channel: ext.channel,
      amountCents: cents,
      message: "",
      anonymous: false,
      returnPath: `/${ext.channel}`,
    }),
  );
  const paymentIntent = stripeId("pi");
  await deliver(
    ext,
    "checkout.session.completed for the tip",
    paymentCompleted({ paymentId: checkout.paymentId, paymentIntent, amountCents: cents, currency: ext.currency }),
    "confirmed",
  );
  return { paymentId: checkout.paymentId, paymentIntent };
}

/** A `charge.refunded` naming a refund of `cents` the request did not name (the cumulative-safe path). */
const refunded = (paymentIntent: string, cents: number, total: number, currency: string) =>
  stripeEvent("charge.refunded", {
    id: stripeId("ch"),
    object: "charge",
    payment_intent: paymentIntent,
    amount: total,
    amount_refunded: cents,
    refunded: cents >= total,
    currency,
    refunds: { object: "list", data: [{ id: stripeId("re"), amount: cents, status: "succeeded" }] },
  });

// ------------------------------------------------------------ steps

export async function stepGiftWindow(ext: Ext): Promise<void> {
  const { ctx } = ext;
  const [gifter, first, second] = await ctx.step("sign up a gifter and two recipients", () =>
    Promise.all([
      ctx.platform.signUp({ prefix: "b8gwg" }),
      ctx.platform.signUp({ prefix: "b8gwa" }),
      ctx.platform.signUp({ prefix: "b8gwb" }),
    ]),
  );
  const gift = (to: SignedInUser) =>
    gifter.api.client.money.subscribe({
      channel: ext.channel,
      tier: 1,
      gift: { count: 1, to: to.username },
      returnPath: `/${ext.channel}`,
    });
  const checkout = await ctx.step("gifter: a gift to the first recipient", () => gift(first));
  const row = await withDb(ext, async (sql) => {
    const rows = await sql<{ gift: boolean; status: string; created_at: string; expires_at: string | null }[]>`
      select gift, status::text as status, created_at, expires_at from payments where id = ${checkout.paymentId}::uuid`;
    return rows[0] ?? null;
  });
  ctx.data("b8.giftWindow.payment", row);
  ctx.assert("the gift's payment is a pending gift", row?.gift === true && row.status === "pending", row);
  const created = toDate(row?.created_at ?? null);
  const expires = toDate(row?.expires_at ?? null);
  ctx.assert(
    `the gift expires ${GIFT_WINDOW_HOURS} h after checkout (GIFT_PAYMENT_HOURS), not after PAYMENT_PENDING_DAYS`,
    created !== null && expires !== null && expiresAfterHours(created, expires, GIFT_WINDOW_HOURS),
    { created, expires },
  );
  const err = await ctx.step("gifter: a second gift inside the window", () => errorOf(() => gift(second)));
  const e = apiError(err);
  ctx.assert(
    "the second gift is refused with CONFLICT gift_pending",
    e.code === "CONFLICT" && e.reason === "gift_pending",
    e,
  );
  const held = await withDb(ext, async (sql) => {
    const rows = await sql<{ n: string }[]>`
      select count(*)::text as n from subscriptions s join users u on u.id = s.subscriber_id
       where u.username = ${second.username} and s.status in ('active', 'past_due', 'incomplete')`;
    return Number(rows[0]?.n ?? "0");
  });
  ctx.assert("the refused gift held no slot for its recipient", held === 0, { held });
  // Free the first recipient's slot now rather than in 24 h (as money-expire-pending would).
  await withDb(ext, async (sql) => {
    const now = tsParam(new Date());
    await sql`update payments set status = 'failed', updated_at = ${now}::timestamptz
               where id = ${checkout.paymentId}::uuid and status = 'pending'`;
    await sql`update subscriptions set status = 'expired', updated_at = ${now}::timestamptz
               where gift_payment_id = ${checkout.paymentId}::uuid and status = 'incomplete'`;
  });
}

export async function stepAutoRefund(ext: Ext): Promise<void> {
  const { ctx } = ext;
  if (!needsStripe(ext, "auto-refund: an ended subscription's late charge is refunded")) return;
  const payer = await ctx.step("sign up a subscriber", () => ctx.platform.signUp({ prefix: "b8ar" }));
  const checkout = await ctx.step("subscriber: Stripe checkout for tier 1", () =>
    payer.api.client.money.subscribe({ channel: ext.channel, tier: 1, returnPath: `/${ext.channel}` }),
  );
  const price = (await payer.api.client.money.tiers({ channel: ext.channel })).find((t) => t.tier === 1)?.price.cents;
  ctx.assert("tier 1 has a price", typeof price === "number", { price });
  const cents = price ?? 0;
  const subscription = stripeId("sub");
  const firstPi = stripeId("pi");
  await deliver(
    ext,
    "invoice.paid (first)",
    firstInvoicePaid({
      paymentId: checkout.paymentId,
      invoice: stripeId("in"),
      subscription,
      paymentIntent: firstPi,
      amountCents: cents,
      currency: ext.currency,
    }),
    "confirmed",
  );
  // End it: a full refund ends the subscription.
  await deliver(
    ext,
    "charge.refunded (ends the subscription)",
    refunded(firstPi, cents, cents, ext.currency),
    "refunded",
  );
  const latePi = stripeId("pi");
  const now = Math.floor(Date.now() / 1000);
  await deliver(
    ext,
    "invoice.paid for the ended subscription",
    stripeEvent("invoice.paid", {
      id: stripeId("in"),
      object: "invoice",
      billing_reason: "subscription_cycle",
      status: "paid",
      subscription,
      subscription_details: { metadata: { payment_id: checkout.paymentId } },
      payment_intent: latePi,
      amount_paid: cents,
      tax: null,
      currency: ext.currency,
      status_transitions: { paid_at: now },
      lines: { object: "list", data: [{ period: { start: now, end: now + 30 * 86_400 } }] },
    }),
    "paid_after_end",
  );
  const booked = await paymentByRef(ext, latePi);
  ctx.assert("the late charge is booked as a payment", booked !== null && booked.status === "succeeded", booked);
  const bookedId = booked?.id ?? "";
  const treasury = ext.treasurer.api.client.money.treasurer.refundRequests;
  const outstanding = await ctx.step("treasurer: outstanding refund requests", () =>
    treasury.list({ state: "outstanding", limit: 100 }),
  );
  const req = requestOf(outstanding, bookedId);
  ctx.data("b8.autoRefund.request", req);
  ctx.assert(
    "one automatic refund request for the full amount, by the system, reason paid_after_end",
    req !== null && req.reason === "paid_after_end" && req.requestedBy === null && req.requested.cents === cents,
    req,
  );
  const sub = await withDb(ext, async (sql) => {
    const rows = await sql<{ status: string }[]>`
      select status::text as status from subscriptions where provider = 'stripe' and provider_ref = ${subscription}`;
    return rows[0]?.status ?? null;
  });
  ctx.assert("the subscription stays ended", sub !== "active" && sub !== "past_due", { sub });
  await deliver(
    ext,
    "charge.refunded for the automatic refund",
    refunded(latePi, cents, cents, ext.currency),
    "refunded",
  );
  const after = await paymentByRef(ext, latePi);
  ctx.assert(
    "the late charge is refunded, not credited",
    after?.status === "refunded" && after.refunded_cents === cents,
    after,
  );
  const all = await ctx.step("treasurer: all refund requests", () => treasury.list({ state: "all", limit: 100 }));
  ctx.assert(
    "the automatic request is settled",
    requestOf(all, bookedId)?.state === "resolved",
    requestOf(all, bookedId),
  );
  await assertBalanced(ext, "auto-refund", [checkout.paymentId, bookedId]);
}

export async function stepRefundUnknown(ext: Ext): Promise<void> {
  const { ctx } = ext;
  if (!needsStripe(ext, "refund-unknown: a refund that times out shows as unknown and reconciles")) return;
  const payer = await ctx.step("sign up a tipper", () => ctx.platform.signUp({ prefix: "b8ru" }));
  const tip = await paidStripeTip(ext, payer, TIP_CENTS);
  const valkey = new RedisClient(valkeyUrl(process.env));
  try {
    await valkey.connect();
    await valkey.set(refundFaultKey(tip.paymentId), "1", "EX", 600);
  } finally {
    valkey.close();
  }
  const treasurer = ext.treasurer.api.client.money.treasurer;
  const refund = () =>
    treasurer.refund({ paymentId: tip.paymentId, amountCents: TIP_CENTS, reason: "b8 refund-unknown" });
  const first = apiError(await ctx.step("treasurer: refund (the provider times out)", () => errorOf(refund)));
  ctx.assert(
    "the timed-out refund answers PRECONDITION_FAILED (needs OPS_TEST_HOOKS=true on the api: harness/compose.e6.yaml)",
    first.code === "PRECONDITION_FAILED",
    first,
  );
  const unknown = await ctx.step("treasurer: refund requests with an unknown outcome", () =>
    treasurer.refundRequests.list({ state: "unknown", limit: 100 }),
  );
  const req = requestOf(unknown, tip.paymentId);
  ctx.data("b8.refundUnknown.request", req);
  ctx.assert(
    "the request shows as unknown, with its markers",
    req !== null && req.state === "unknown" && req.markers.some((m) => m.action === "payment.refund_outcome_unknown"),
    req,
  );
  const again = apiError(await ctx.step("treasurer: a second refund while unknown", () => errorOf(refund)));
  ctx.assert("a second refund is refused while the first may have gone through", again.code === "CONFLICT", again);
  await deliver(
    ext,
    "charge.refunded (Stripe did refund)",
    refunded(tip.paymentIntent, TIP_CENTS, TIP_CENTS, ext.currency),
    "refunded",
  );
  const settled = await ctx.step("treasurer: unknown requests after the refund event", () =>
    treasurer.refundRequests.list({ state: "unknown", limit: 100 }),
  );
  ctx.assert(
    "the unknown request is reconciled by the refund event",
    requestOf(settled, tip.paymentId) === null,
    settled,
  );
  await assertBalanced(ext, "refund-unknown", [tip.paymentId]);
}

export async function stepReceiptEmail(ext: Ext): Promise<void> {
  const { ctx } = ext;
  const payer = await ctx.step("sign up a tipper", () => ctx.platform.signUp({ prefix: "b8rc" }));
  let paymentId: string;
  let reference: string;
  if (ext.provider === "stripe" && ext.stripe) {
    const tip = await paidStripeTip(ext as Ext & { stripe: NonNullable<Ext["stripe"]> }, payer, TIP_CENTS);
    paymentId = tip.paymentId;
    reference = tip.paymentIntent;
  } else {
    const checkout = await ctx.step("payer: tip (manual instructions)", () =>
      payer.api.client.money.tip({
        channel: ext.channel,
        amountCents: TIP_CENTS,
        message: "",
        anonymous: false,
        returnPath: `/${ext.channel}`,
      }),
    );
    ctx.assert("the tip returns manual instructions", checkout.kind === "instructions", checkout);
    paymentId = checkout.paymentId;
    reference = checkout.kind === "instructions" ? checkout.reference : "";
    await ctx.step("treasurer: confirm the tip", () =>
      ext.treasurer.api.client.money.treasurer.confirm({ paymentId, receivedAt: new Date().toISOString(), note: "" }),
    );
  }
  const mail = await ctx.step("Mailpit: the payer's receipt", () =>
    ctx.platform.mailpit.waitForMessage(payer.email, (m) => m.subject.startsWith("Your receipt"), MAIL_TIMEOUT_MS),
  );
  const amount = new Intl.NumberFormat("en", { style: "currency", currency: ext.currency.toUpperCase() }).format(
    TIP_CENTS / 100,
  );
  const problems = receiptProblems(mail.text, { amount, reference });
  ctx.data("b8.receipt", { subject: mail.subject, problems });
  ctx.assert("the receipt shows the amount, the reference, the breakdown lines and the link", problems.length === 0, {
    problems,
  });
  // Once per payment: give a duplicate time to arrive, then count.
  await Bun.sleep(DUPLICATE_GRACE_MS);
  const receipts = (await ctx.platform.mailpit.search(`to:"${payer.email}"`)).filter((m) =>
    m.subject.startsWith("Your receipt"),
  );
  ctx.assert("exactly one receipt", receipts.length === 1, { count: receipts.length });
  await assertBalanced(ext, "receipt-email", [paymentId]);
}
