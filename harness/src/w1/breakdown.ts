// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `e4b-money` extensions `breakdown` and `reconciliation` (docs/testing/w1-selectors.md,
 * "Scenarios"), owned by W1-breakdown.
 *
 * - `breakdown`: for the tip, a gift and a subscription, `money.paymentBreakdown` lines sum (gross
 *   side) to gross exactly, fee lines sit outside it, the refund's and chargeback's reversal lines
 *   sum to their amounts, the payer sees each and a stranger gets NOT_FOUND, the anonymous tip hides
 *   the payer from the creator; `via=web` reads the same numbers from the dialog (the creator's
 *   `/revenue` rows and the payer's `/settings/subscriptions`) and the fee schedule on `/transparency`.
 * - `reconciliation`: the `money-reconcile` ops tick reports 0 mismatches after the refund and the
 *   chargeback; with `provider=stripe` a fresh payer's tip is charged back and the dispute won
 *   (dispute fee returned), and the tick still reports 0.
 */
import type { Page } from "playwright";
import type { ApiClient } from "../api/client.ts";
import { isNotFound } from "../safety.ts";
import { stripeEvent, stripeId } from "../stripe.ts";
import type { SignedInUser } from "../users.ts";
import { waitFor } from "../wait.ts";
import { signInViaUi } from "../web/flows.ts";
import { ROUTES, TEST_IDS as T } from "../web/selectors.ts";
import { WebSession, byTestId } from "../web/session.ts";
import type { MoneyExtension } from "./kit.ts";
import { W1_ROUTES, W1_TEST_IDS as W, byW1Id } from "./selectors.ts";

const UI_TIMEOUT_MS = 30_000;
/** The won-dispute tip (above `MONEY_LIMITS.tipMinCents`). */
const WON_TIP_CENTS = 700;
const DISPUTE_FEE_CENTS = 1500;

type Breakdown = Awaited<ReturnType<ApiClient["money"]["paymentBreakdown"]>>;
type Line = Breakdown["lines"][number];

// ------------------------------------------------------------ pure checks (unit-tested)

const GROSS_SIDE: ReadonlySet<Line["kind"]> = new Set(["tax", "creator", "coop_share"]);
const FEES: ReadonlySet<Line["kind"]> = new Set(["processor_fee", "dispute_fee"]);

/** Gross-side lines (tax, creator shares, co-op share). */
export const grossSide = (lines: readonly Pick<Line, "kind" | "amount">[]): number =>
  lines.filter((l) => GROSS_SIDE.has(l.kind)).reduce((s, l) => s + l.amount.cents, 0);

/** What the breakdown says moved through settlement: gross side + reversals − fees. */
export const settledByBreakdown = (lines: readonly Pick<Line, "kind" | "amount">[]): number =>
  lines.reduce(
    (s, l) =>
      GROSS_SIDE.has(l.kind) || l.kind === "reversal" ? s + l.amount.cents : FEES.has(l.kind) ? s - l.amount.cents : s,
    0,
  );

/** Co-op share − its reversals − fees (dispute fees net of returns): the definition `coop_net` must meet. */
export const expectedCoopNet = (lines: readonly Pick<Line, "kind" | "amount" | "component">[]): number =>
  lines.reduce((s, l) => {
    if (l.kind === "coop_share" || (l.kind === "reversal" && l.component === "coop_share")) return s + l.amount.cents;
    if (FEES.has(l.kind)) return s - l.amount.cents;
    return s;
  }, 0);

/** Every problem with a breakdown's arithmetic; empty when it is consistent. */
export function breakdownProblems(b: Pick<Breakdown, "gross" | "lines" | "timeline">): string[] {
  const problems: string[] = [];
  const side = grossSide(b.lines);
  if (side !== b.gross.cents) problems.push(`gross-side lines sum to ${side}, not gross ${b.gross.cents}`);
  for (const l of b.lines) {
    if (l.kind === "processor_fee" && l.amount.cents < 0) problems.push(`negative processor fee ${l.amount.cents}`);
    if (GROSS_SIDE.has(l.kind) && l.amount.cents < 0) problems.push(`negative ${l.kind} line ${l.amount.cents}`);
    if (l.kind === "reversal" && l.component === null) problems.push("a reversal line without its component");
  }
  for (const e of b.timeline) {
    if (e.kind === "paid" || e.kind === "hold_released") continue;
    const sum = b.lines
      .filter((l) => l.kind === "reversal" && l.transactionId === e.transactionId)
      .reduce((s, l) => s + l.amount.cents, 0);
    if (sum !== (e.amount?.cents ?? 0))
      problems.push(`${e.kind} ${e.transactionId}: reversal lines sum to ${sum}, not ${e.amount?.cents ?? "null"}`);
  }
  const nets = b.lines.filter((l) => l.kind === "coop_net");
  const want = expectedCoopNet(b.lines);
  if (nets.length !== 1) problems.push(`${nets.length} coop_net lines`);
  else if (nets[0]?.amount.cents !== want) problems.push(`coop_net ${nets[0]?.amount.cents}, by definition ${want}`);
  return problems;
}

/** The dialog's numbers as the harness reads them from `data-*`. */
export interface DialogView {
  grossCents: number;
  lines: { kind: string; component: string; cents: number }[];
}

/** The API breakdown in the dialog's terms, for comparing the two. */
export function dialogViewOf(b: Pick<Breakdown, "gross" | "lines">): DialogView {
  return {
    grossCents: b.gross.cents,
    lines: b.lines.map((l) => ({ kind: l.kind, component: l.component ?? "", cents: l.amount.cents })),
  };
}

// ------------------------------------------------------------ browser

async function readDialog(page: Page, paymentId: string): Promise<DialogView> {
  const ui = { timeout: UI_TIMEOUT_MS };
  await byW1Id(page, W.breakdownOpen, { "payment-id": paymentId }).first().click(ui);
  const dialog = byW1Id(page, W.breakdownDialog);
  await dialog.waitFor(ui);
  const gross = byW1Id(dialog, W.breakdownGross);
  await gross.waitFor(ui);
  await byW1Id(dialog, W.breakdownLine).first().waitFor(ui);
  const grossCents = Number(await gross.getAttribute("data-cents"));
  const lines = await byW1Id(dialog, W.breakdownLine).evaluateAll((els) =>
    els.map((el) => ({
      kind: el.getAttribute("data-kind") ?? "",
      component: el.getAttribute("data-component") ?? "",
      cents: Number(el.getAttribute("data-cents")),
    })),
  );
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden", timeout: UI_TIMEOUT_MS });
  return { grossCents, lines };
}

async function openSession(ext: MoneyExtension, who: string, user: SignedInUser): Promise<WebSession> {
  const { ctx } = ext;
  const session = await WebSession.open({
    fleet: ctx.platform.fleet,
    engine: "chromium",
    webUrl: ctx.env.HARNESS_WEB_URL,
    probeScript: "",
    label: `w1-breakdown-${who}`,
    log: ctx.log,
  });
  ctx.defer(() => session.close());
  await ctx.step(`${who}: sign in through the web UI`, async () => {
    const page = await session.goto(ROUTES.signin);
    await signInViaUi(page, user, UI_TIMEOUT_MS, ctx.signal);
    // Land before the next navigation.
    await byTestId(page, T.navUser, { username: user.username }).waitFor({ timeout: UI_TIMEOUT_MS });
  });
  return session;
}

// ------------------------------------------------------------ steps

export async function stepBreakdown(ext: MoneyExtension): Promise<void> {
  const { ctx, payers, streamer, payments } = ext;
  const payer = payers.a.api.client;
  const ids = { sub: payments.sub.paymentId, gift: payments.gift.paymentId, tip: payments.tip.paymentId };
  const seen = new Map<string, Breakdown>();

  for (const [name, paymentId] of Object.entries(ids)) {
    const b = await ctx.step(`payer A: money.paymentBreakdown (${name})`, () =>
      payer.money.paymentBreakdown({ paymentId }),
    );
    seen.set(paymentId, b);
    ctx.data(`w1.breakdown.${name}`, b);
    const problems = breakdownProblems(b);
    ctx.check(`${name}: lines sum to gross, fees outside it, reversals sum to their amounts`, problems.length === 0, {
      problems,
    });
    ctx.check(`${name}: the payer sees it as the payer`, b.viewerRole === "payer" && b.payer?.id === payers.a.id, {
      viewerRole: b.viewerRole,
      payer: b.payer,
    });
    ctx.check(
      `${name}: one processor_fee line, outside gross`,
      b.lines.filter((l) => l.kind === "processor_fee").length === 1,
      { lines: b.lines },
    );
  }
  const refunded = seen.get(ext.refunded.paymentId);
  ctx.check(
    "the refunded tip's timeline has its refund",
    refunded?.timeline.some((e) => e.kind === "refunded") === true,
    refunded?.timeline,
  );
  const chargedBack = seen.get(ext.chargedBack.paymentId);
  ctx.check(
    "the charged-back subscription's timeline has its chargeback",
    chargedBack?.timeline.some((e) => e.kind === "charged_back") === true,
    chargedBack?.timeline,
  );

  await ctx.step("a stranger (payer B) gets NOT_FOUND", async () => {
    const err = await payers.b.api.client.money.paymentBreakdown({ paymentId: ids.sub }).then(
      () => null,
      (e: unknown) => e,
    );
    ctx.assert("money.paymentBreakdown by a stranger is NOT_FOUND", isNotFound(err), { err: String(err) });
  });
  const creatorTip = await ctx.step("creator: the anonymous tip's breakdown", () =>
    streamer.api.client.money.paymentBreakdown({ paymentId: ids.tip }),
  );
  ctx.check(
    "the anonymous tip hides the payer from the creator",
    creatorTip.viewerRole === "payee" && creatorTip.payer === null,
    {
      viewerRole: creatorTip.viewerRole,
      payer: creatorTip.payer,
    },
  );
  const page = await ctx.step("payer A: money.paymentBreakdowns lists all three", () =>
    payer.money.paymentBreakdowns({ role: "payer", limit: 100 }),
  );
  ctx.check(
    "paymentBreakdowns (payer) has the sub, the gift and the tip",
    Object.values(ids).every((id) => page.items.some((i) => i.paymentId === id)),
    { listed: page.items.map((i) => i.paymentId) },
  );

  if (ext.via !== "web") return;

  const creatorSession = await openSession(ext, "creator", streamer);
  await ctx.step("creator: /revenue breakdown dialogs show the API's numbers", async () => {
    const p = await creatorSession.goto(W1_ROUTES.revenue);
    await byW1Id(p, W.breakdownOpen).first().waitFor({ timeout: UI_TIMEOUT_MS });
    for (const [name, paymentId] of Object.entries(ids)) {
      const shown = await readDialog(p, paymentId);
      const api = await streamer.api.client.money.paymentBreakdown({ paymentId });
      ctx.check(`${name}: the creator's dialog matches money.paymentBreakdown`, sameView(shown, dialogViewOf(api)), {
        shown,
        api: dialogViewOf(api),
      });
    }
  });
  await ctx.step("creator: /transparency shows the fee schedule", async () => {
    const p = await creatorSession.goto(W1_ROUTES.transparency);
    const rows = byW1Id(p, W.feeScheduleRow);
    await rows.first().waitFor({ timeout: UI_TIMEOUT_MS });
    const keys = await rows.evaluateAll((els) => els.map((el) => el.getAttribute("data-key")));
    ctx.check("fee-schedule-row for both keys", keys.includes("platform.cut") && keys.includes("payout.rules"), {
      keys,
    });
  });

  const payerSession = await openSession(ext, "payer A", payers.a);
  await ctx.step("payer A: /settings/subscriptions breakdown dialogs show the API's numbers", async () => {
    const p = await payerSession.goto(W1_ROUTES.subscriptions);
    await waitFor(
      "breakdown-open on Your payments",
      async () => (await byW1Id(p, W.breakdownOpen).count()) > 0 || null,
      {
        timeoutMs: UI_TIMEOUT_MS,
        intervalMs: 250,
        signal: ctx.signal,
      },
    );
    for (const [name, paymentId] of Object.entries(ids)) {
      const shown = await readDialog(p, paymentId);
      const api = seen.get(paymentId);
      ctx.check(
        `${name}: the payer's dialog matches money.paymentBreakdown`,
        api !== undefined && sameView(shown, dialogViewOf(api)),
        { shown, api: api && dialogViewOf(api) },
      );
    }
  });
}

/** Same gross and the same lines in the same order. */
export function sameView(a: DialogView, b: DialogView): boolean {
  return a.grossCents === b.grossCents && JSON.stringify(a.lines) === JSON.stringify(b.lines);
}

export async function stepReconciliation(ext: MoneyExtension): Promise<void> {
  const { ctx } = ext;
  const first = await ctx.step("money-reconcile tick after the refund and the chargeback", () =>
    ext.hooks.client.tickRan("money-reconcile"),
  );
  ctx.data("w1.reconcile.first", first);
  ctx.assert(
    "money-reconcile reports 0 mismatches (a mismatch on an old stack can be pre-W1 v1 postings: reset the stack)",
    first.mismatches === 0,
    first,
  );
  ctx.check("money-reconcile checked the scenario's payments", (first.payments ?? 0) >= 1, first);

  if (ext.provider !== "stripe" || !ext.stripe) return;
  const hook = ext.stripe;
  // Own actor: the won dispute is a payment of its own, not one of the scenario's.
  const tipper = await ctx.step("sign up a payer for the won dispute", () =>
    ctx.platform.signUp({ prefix: "w1bdwon" }),
  );
  const checkout = await ctx.step("tipper: Stripe checkout for a tip", () =>
    tipper.api.client.money.tip({
      channel: ext.channel,
      amountCents: WON_TIP_CENTS,
      message: "",
      anonymous: false,
      returnPath: `/${ext.channel}`,
    }),
  );
  ctx.assert("the tip is a Stripe redirect", checkout.kind === "redirect", checkout);
  const paymentIntent = stripeId("pi");
  const base = { currency: ext.currency, amount: WON_TIP_CENTS, payment_intent: paymentIntent };
  const send = async (label: string, type: string, object: Record<string, unknown>, outcome: string) => {
    const d = await ctx.step(`Stripe: ${label}`, () => hook.deliver(stripeEvent(type, object)));
    ctx.assert(`${label} answers ${outcome}`, d.body.outcome === outcome, d);
  };
  await send(
    "checkout.session.completed for the tip",
    "checkout.session.completed",
    {
      id: stripeId("cs_test"),
      object: "checkout.session",
      mode: "payment",
      payment_status: "paid",
      status: "complete",
      client_reference_id: checkout.paymentId,
      metadata: { payment_id: checkout.paymentId },
      payment_intent: paymentIntent,
      subscription: null,
      amount_total: WON_TIP_CENTS,
      currency: ext.currency,
      total_details: { amount_tax: 0, amount_discount: 0, amount_shipping: 0 },
    },
    "confirmed",
  );
  const disputeId = stripeId("dp");
  const dispute = (status: string, fees: number[]) => ({
    id: disputeId,
    object: "dispute",
    charge: stripeId("ch"),
    ...base,
    status,
    reason: "general",
    balance_transactions: fees.map((fee) => ({ fee })),
  });
  await send(
    "charge.dispute.created",
    "charge.dispute.created",
    dispute("needs_response", [DISPUTE_FEE_CENTS]),
    "charged_back",
  );
  await send(
    "charge.dispute.closed (won)",
    "charge.dispute.closed",
    dispute("won", [DISPUTE_FEE_CENTS, -DISPUTE_FEE_CENTS]),
    "won",
  );

  const won = await ctx.step("tipper: the won tip's breakdown", () =>
    tipper.api.client.money.paymentBreakdown({ paymentId: checkout.paymentId }),
  );
  ctx.data("w1.breakdown.won", won);
  const problems = breakdownProblems(won);
  ctx.check("won: the breakdown is consistent", problems.length === 0, { problems });
  ctx.check(
    "won: paid, charged back, chargeback won",
    JSON.stringify(won.timeline.map((e) => e.kind)) === JSON.stringify(["paid", "charged_back", "chargeback_won"]),
    won.timeline,
  );
  ctx.check(
    "won: the dispute fee was paid and returned",
    JSON.stringify(won.lines.filter((l) => l.kind === "dispute_fee").map((l) => l.amount.cents)) ===
      JSON.stringify([DISPUTE_FEE_CENTS, -DISPUTE_FEE_CENTS]),
    won.lines,
  );
  const second = await ctx.step("money-reconcile tick after the won chargeback", () =>
    ext.hooks.client.tickRan("money-reconcile"),
  );
  ctx.data("w1.reconcile.second", second);
  ctx.assert("money-reconcile reports 0 mismatches after the won chargeback", second.mismatches === 0, second);
  ctx.check("money-reconcile checked the won tip", (second.payments ?? 0) >= 1, second);
}
