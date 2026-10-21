// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The people in the `e4b-money` scenario (docs/testing/e4b-selectors.md), each with a web
 * implementation (Playwright, by test id only) and an API one (`--set via=api`): a supporter
 * (Support dialog, `/settings/subscriptions`), the treasurer (`/treasury`), the creator
 * (`/revenue`), the public (`/transparency`) and a chat observer for inline money events. The
 * scenario is written once against these interfaces, so both paths assert the same figures.
 */
import type { Locator, Page } from "playwright";
import type { ApiClient } from "./api/client.ts";
import type { ChatClient } from "./chat-client.ts";
import {
  type MoneyChatEvent,
  type ObservedLedgerRow,
  type Tier,
  centsToInput,
  chatEventFromAttributes,
  chatEventFromFrame,
  parseCents,
  parseTier,
  requireCents,
} from "./money.ts";
import type { WaitBudget } from "./social.ts";
import { waitFor } from "./wait.ts";
import { waitForOneOf } from "./web/flows.ts";
import { ROUTES, TEST_IDS as T, revenueTierInput, tid } from "./web/selectors.ts";
import { byTestId } from "./web/session.ts";

export type { WaitBudget };

export type CheckoutRequest =
  | { kind: "sub"; tier: Tier }
  | { kind: "gift"; tier: Tier; count: number }
  | { kind: "tip"; cents: number; message: string; anonymous: boolean };

export interface CheckoutView {
  paymentId: string;
  /** Manual: the `CA-…` reference. Stripe: empty until the payment succeeds (then its PaymentIntent). */
  reference: string;
  /** Stripe: the Checkout URL the web app would navigate to (never followed by the harness). */
  redirectUrl?: string;
  /** What the checkout says will be paid. */
  cents: number;
  /** Web only: what the dialog showed before submitting (`support-total`, `support-split`). */
  shown?: {
    totalCents: number | null;
    streamerShare: string | null;
    coopShare: string | null;
    provider: string | null;
  };
}

export interface SubscriptionView {
  id: string;
  channel: string;
  tier: number | null;
  status: string;
  gifted: boolean;
  cancelAtPeriodEnd: boolean;
}

export interface Supporter {
  readonly who: string;
  checkout(channel: string, req: CheckoutRequest, b: WaitBudget): Promise<CheckoutView>;
  subscriptions(b: WaitBudget): Promise<SubscriptionView[]>;
}

export interface TreasuryPaymentView {
  paymentId: string;
  reference: string;
  status: string;
  kind: string;
  cents: number;
  refunded: number;
}

export interface PayoutRunView {
  created: number;
  held: number;
  cents: number;
}

export interface PayoutView {
  id: string;
  username: string;
  status: string;
  cents: number;
  holdReason: string | null;
}

export interface Treasurer {
  /**
   * The payment with this reference (any status), or null while it is not listed. `reload` asks
   * a web treasurer to reload the page first (a retry after the list was fetched too early).
   */
  find(reference: string, b: WaitBudget, reload?: boolean): Promise<TreasuryPaymentView | null>;
  confirm(reference: string, b: WaitBudget): Promise<void>;
  refund(reference: string, cents: number, reason: string, b: WaitBudget): Promise<void>;
  chargeback(reference: string, cents: number, reason: string, b: WaitBudget): Promise<void>;
  /** Run this month's payout batch (`periodEnd` = now). */
  runPayouts(b: WaitBudget): Promise<PayoutRunView>;
  payouts(b: WaitBudget): Promise<PayoutView[]>;
}

export interface TierInput {
  name: string;
  cents: number;
  benefits: string;
}

export interface RevenueLedgerRowView extends ObservedLedgerRow {
  transactionId: string;
}

export interface RevenueView {
  available: number;
  minimum: number | null;
  held: number;
  owed: number;
  earned: number;
  previous: number | null;
  bySource: { subscriptions: number | null; gifts: number | null; tips: number | null };
  tiers: { tier: number | null; active: number; cents: number }[];
  ledger: RevenueLedgerRowView[];
}

export interface Creator {
  setTiers(channel: string, tiers: readonly TierInput[], currency: string, b: WaitBudget): Promise<void>;
  revenue(channel: string, b: WaitBudget): Promise<RevenueView>;
}

export interface TransparencyView {
  month: string;
  revenue: number;
  payouts: number;
  costs: number;
  surplus: number;
  patronage: number;
}

export interface PublicReader {
  /** This month's row, or null when the ledger has no row for it yet. */
  transparency(month: string, b: WaitBudget): Promise<TransparencyView | null>;
}

export interface ChatEventObserver {
  events(): Promise<MoneyChatEvent[]>;
  waitEvent(what: string, match: (e: MoneyChatEvent) => boolean, b: WaitBudget): Promise<MoneyChatEvent>;
}

const MAX_LEDGER_PAGES = 10;

// ---------------------------------------------------------------- web helpers

type Dataset = Record<string, string | undefined>;

/** `data-*` of every element the locator matches (dataset keys are camelCase). */
async function datasets(locator: Locator): Promise<Dataset[]> {
  return locator.evaluateAll((els) => els.map((e) => Object.fromEntries(Object.entries((e as HTMLElement).dataset))));
}

async function dataset(locator: Locator, timeoutMs: number): Promise<Dataset> {
  await locator.first().waitFor({ state: "attached", timeout: timeoutMs });
  return locator.first().evaluate((e) => Object.fromEntries(Object.entries((e as HTMLElement).dataset)));
}

const flag = (v: string | undefined) => v === "true";
const count = (v: string | undefined) => parseCents(v) ?? 0;

/** Check or uncheck a checkbox (native or `role=checkbox`) like a person: click only when needed. */
async function setChecked(box: Locator, checked: boolean, timeoutMs: number): Promise<void> {
  await box.waitFor({ timeout: timeoutMs });
  if ((await box.isChecked({ timeout: timeoutMs })) !== checked) await box.click({ timeout: timeoutMs });
}

// ---------------------------------------------------------------- web: supporter

export class WebSupporter implements Supporter {
  constructor(
    readonly who: string,
    private readonly open: (path: string) => Promise<Page>,
    private readonly currency: string,
  ) {}

  async checkout(channel: string, req: CheckoutRequest, b: WaitBudget): Promise<CheckoutView> {
    const ui = { timeout: b.timeoutMs };
    const page = await this.open(ROUTES.channel(channel));
    await byTestId(page, T.supportOpen).click(ui);
    const dialog = byTestId(page, T.supportDialog);
    await dialog.waitFor(ui);
    const inDialog = (id: Parameters<typeof tid>[0], data?: Record<string, string>) =>
      dialog.locator(tid(id, data)).first();

    if (req.kind === "sub" || req.kind === "gift") {
      await inDialog(req.kind === "sub" ? T.supportTabSub : T.supportTabGift).click(ui);
      const tier = inDialog(T.supportTier, { tier: String(req.tier) });
      await tier.click(ui);
      await dialog.locator(`${tid(T.supportTier, { tier: String(req.tier) })}[aria-checked="true"]`).waitFor(ui);
      if (req.kind === "gift") {
        await inDialog(T.supportGiftRecipientRandom).click(ui);
        await inDialog(T.supportGiftCount).fill(String(req.count), ui);
      }
    } else {
      await inDialog(T.supportTabTip).click(ui);
      const amount = inDialog(T.supportTipAmount);
      await amount.fill(centsToInput(req.cents, this.currency), ui);
      await waitFor(
        `support-tip-amount data-cents=${req.cents}`,
        async () => parseCents(await amount.getAttribute("data-cents", { timeout: 1_000 })) === req.cents || null,
        { timeoutMs: b.timeoutMs, intervalMs: 100, signal: b.signal },
      );
      await inDialog(T.supportTipMessage).fill(req.message, ui);
      await setChecked(inDialog(T.supportTipAnonymous), req.anonymous, b.timeoutMs);
    }

    const submit = inDialog(T.supportSubmit);
    await waitFor("support-submit enabled", async () => (await submit.isEnabled()) || null, {
      timeoutMs: b.timeoutMs,
      intervalMs: 100,
      signal: b.signal,
    });
    const split = inDialog(T.supportSplit);
    const shown = {
      provider: await dialog.getAttribute("data-provider", ui),
      totalCents: parseCents(await inDialog(T.supportTotal).getAttribute("data-cents", ui)),
      streamerShare: await split.getAttribute("data-streamer-share", ui),
      coopShare: await split.getAttribute("data-coop-share", ui),
    };
    await submit.click(ui);
    const seen = await waitForOneOf(page, [T.supportInstructions, T.supportError], b.timeoutMs, b.signal);
    if (seen === T.supportError) {
      const text = (await byTestId(page, T.supportError).first().textContent()) ?? "";
      throw new Error(`checkout refused: ${text.trim()}`);
    }
    const panel = byTestId(page, T.supportInstructions).first();
    const paymentId = (await panel.getAttribute("data-payment-id", ui)) ?? "";
    const reference = (await panel.locator(tid(T.supportReference)).first().getAttribute("data-reference", ui)) ?? "";
    const cents = requireCents(
      await panel.locator(tid(T.supportAmount)).first().getAttribute("data-cents", ui),
      "support-amount",
    );
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: b.timeoutMs }).catch(() => undefined);
    return { paymentId, reference, cents, shown };
  }

  async subscriptions(b: WaitBudget): Promise<SubscriptionView[]> {
    const page = await this.open(ROUTES.subscriptions);
    await byTestId(page, T.subscriptions).waitFor({ timeout: b.timeoutMs });
    // Rows or the empty state, whichever the page settles on.
    await waitForOneOf(page, [T.subscriptionRow, T.subscriptionsEmpty], b.timeoutMs, b.signal);
    return (await datasets(byTestId(page, T.subscriptionRow))).map((d) => ({
      id: d.subscriptionId ?? "",
      channel: d.channel ?? "",
      tier: parseTier(d.tier),
      status: d.status ?? "",
      gifted: flag(d.gifted),
      cancelAtPeriodEnd: flag(d.cancelAtPeriodEnd),
    }));
  }
}

// ---------------------------------------------------------------- web: treasurer

export class WebTreasurer implements Treasurer {
  private page: Page | null = null;

  constructor(
    private readonly open: (path: string) => Promise<Page>,
    private readonly currency: string,
  ) {}

  private async treasury(b: WaitBudget, reload = false): Promise<Page> {
    if (!this.page || reload || new URL(this.page.url()).pathname !== ROUTES.treasury) {
      this.page = await this.open(ROUTES.treasury);
    }
    await byTestId(this.page, T.treasury).waitFor({ timeout: b.timeoutMs });
    return this.page;
  }

  private async searchRow(reference: string, b: WaitBudget, reload: boolean): Promise<Locator> {
    const page = await this.treasury(b, reload);
    await byTestId(page, T.treasuryTabPayments).click({ timeout: b.timeoutMs });
    const search = byTestId(page, T.treasurySearch);
    await search.fill(reference, { timeout: b.timeoutMs });
    await search.press("Enter", { timeout: b.timeoutMs });
    return byTestId(page, T.treasuryPaymentRow, { reference }).first();
  }

  async find(reference: string, b: WaitBudget, reload = false): Promise<TreasuryPaymentView | null> {
    const row = await this.searchRow(reference, b, reload);
    const found = await row
      .waitFor({ timeout: b.timeoutMs })
      .then(() => true)
      .catch(() => false);
    return found ? paymentFromDataset(await dataset(row, b.timeoutMs)) : null;
  }

  /** Re-search (reloading the page) until the row shows `status`. */
  private async waitStatus(reference: string, status: string, b: WaitBudget): Promise<void> {
    let last: string | undefined;
    let reload = false;
    await waitFor(
      `treasury-payment-row[data-reference=${reference}] data-status=${status}`,
      async () => {
        const row = await this.searchRow(reference, { ...b, timeoutMs: Math.min(b.timeoutMs, 10_000) }, reload);
        reload = true;
        await row.waitFor({ timeout: 5_000 });
        last = (await row.getAttribute("data-status", { timeout: 1_000 })) ?? undefined;
        return last === status || null;
      },
      { timeoutMs: b.timeoutMs, intervalMs: 500, signal: b.signal },
    ).catch((err: Error) => {
      throw new Error(`${err.message}; last seen data-status=${last}`, { cause: err });
    });
  }

  async confirm(reference: string, b: WaitBudget): Promise<void> {
    const row = await this.searchRow(reference, b, false);
    await row.locator(tid(T.treasuryConfirm)).first().click({ timeout: b.timeoutMs });
    await byTestId(row.page(), T.confirmDialogConfirm).first().click({ timeout: b.timeoutMs });
    await this.waitStatus(reference, "succeeded", b);
  }

  private async dispute(
    which: typeof T.treasuryRefund | typeof T.treasuryChargeback,
    reference: string,
    cents: number,
    reason: string,
    currency: string,
    b: WaitBudget,
  ): Promise<void> {
    const ui = { timeout: b.timeoutMs };
    const row = await this.searchRow(reference, b, false);
    await row.locator(tid(which)).first().click(ui);
    const page = row.page();
    await byTestId(page, T.treasuryDisputeAmount).fill(centsToInput(cents, currency), ui);
    await byTestId(page, T.treasuryDisputeReason).fill(reason, ui);
    await byTestId(page, T.treasuryDisputeSubmit).click(ui);
  }

  async refund(reference: string, cents: number, reason: string, b: WaitBudget): Promise<void> {
    const before = await this.find(reference, b);
    await this.dispute(T.treasuryRefund, reference, cents, reason, this.currency, b);
    const full = before !== null && before.refunded + cents >= before.cents;
    await this.waitStatus(reference, full ? "refunded" : "partially_refunded", b);
  }

  async chargeback(reference: string, cents: number, reason: string, b: WaitBudget): Promise<void> {
    await this.dispute(T.treasuryChargeback, reference, cents, reason, this.currency, b);
    await this.waitStatus(reference, "charged_back", b);
  }

  async runPayouts(b: WaitBudget): Promise<PayoutRunView> {
    const page = await this.treasury(b);
    await byTestId(page, T.treasuryTabPayouts).click({ timeout: b.timeoutMs });
    await byTestId(page, T.treasuryRunPayouts).click({ timeout: b.timeoutMs });
    // The spec has no confirmation for a run; accept one if the page asks.
    const seen = await waitForOneOf(page, [T.treasuryPayoutsResult, T.confirmDialogConfirm], b.timeoutMs, b.signal);
    if (seen === T.confirmDialogConfirm) {
      await byTestId(page, T.confirmDialogConfirm).first().click({ timeout: b.timeoutMs });
      await byTestId(page, T.treasuryPayoutsResult).first().waitFor({ timeout: b.timeoutMs });
    }
    const d = await dataset(byTestId(page, T.treasuryPayoutsResult), b.timeoutMs);
    return {
      created: requireCents(d.created, "treasury-payouts-result data-created"),
      held: requireCents(d.held, "treasury-payouts-result data-held"),
      cents: requireCents(d.cents, "treasury-payouts-result data-cents"),
    };
  }

  async payouts(b: WaitBudget): Promise<PayoutView[]> {
    const page = await this.treasury(b, true);
    await byTestId(page, T.treasuryTabPayouts).click({ timeout: b.timeoutMs });
    await byTestId(page, T.treasuryRunPayouts).waitFor({ timeout: b.timeoutMs });
    // The list may still be loading when the tab renders: wait until two reads a second apart
    // agree on the row count before reading the rows.
    const rows = byTestId(page, T.treasuryPayoutRow);
    let previous = -1;
    await waitFor(
      "treasury-payout-row count to settle",
      async () => {
        const n = await rows.count();
        const stable = n === previous;
        previous = n;
        return stable || null;
      },
      { timeoutMs: b.timeoutMs, intervalMs: 1_000, signal: b.signal },
    );
    return (await datasets(rows)).map((d) => ({
      id: d.payoutId ?? "",
      username: d.username ?? "",
      status: d.status ?? "",
      cents: count(d.cents),
      holdReason: d.holdReason || null,
    }));
  }
}

function paymentFromDataset(d: Dataset): TreasuryPaymentView {
  return {
    paymentId: d.paymentId ?? "",
    reference: d.reference ?? "",
    status: d.status ?? "",
    kind: d.kind ?? "",
    cents: requireCents(d.cents, "treasury-payment-row data-cents"),
    refunded: count(d.refunded),
  };
}

// ---------------------------------------------------------------- web: creator, public, chat

export class WebCreator implements Creator {
  constructor(private readonly open: (path: string) => Promise<Page>) {}

  async setTiers(_channel: string, tiers: readonly TierInput[], currency: string, b: WaitBudget): Promise<void> {
    const ui = { timeout: b.timeoutMs };
    const page = await this.open(ROUTES.revenue);
    const form = byTestId(page, T.revenueTiers);
    await form.waitFor(ui);
    for (const [i, t] of tiers.entries()) {
      const n = (i + 1) as Tier;
      await byTestId(page, revenueTierInput("name", n)).fill(t.name, ui);
      await byTestId(page, revenueTierInput("price", n)).fill(centsToInput(t.cents, currency), ui);
      await byTestId(page, revenueTierInput("benefits", n)).fill(t.benefits, ui);
    }
    const save = byTestId(page, T.revenueTiersSave);
    await waitFor("revenue-tiers-save enabled", async () => (await save.isEnabled()) || null, {
      timeoutMs: b.timeoutMs,
      intervalMs: 100,
      signal: b.signal,
    });
    await save.click(ui);
  }

  async revenue(_channel: string, b: WaitBudget): Promise<RevenueView> {
    const ui = { timeout: b.timeoutMs };
    const page = await this.open(ROUTES.revenue);
    await byTestId(page, T.revenue).waitFor(ui);
    const available = await dataset(byTestId(page, T.revenueAvailable), b.timeoutMs);
    const held = await dataset(byTestId(page, T.revenueHeld), b.timeoutMs);
    const earned = await dataset(byTestId(page, T.revenueEarned), b.timeoutMs);
    const owedEl = byTestId(page, T.revenueOwed);
    const owed = (await owedEl.count()) > 0 ? count((await dataset(owedEl, 1_000)).cents) : 0;
    const more = byTestId(page, T.revenueLedgerMore);
    for (let i = 0; i < MAX_LEDGER_PAGES && (await more.isVisible()); i++) {
      const before = await byTestId(page, T.revenueLedgerRow).count();
      await more.click(ui);
      await waitFor(
        "more revenue-ledger-row",
        async () => (await byTestId(page, T.revenueLedgerRow).count()) > before || !(await more.isVisible()) || null,
        { timeoutMs: b.timeoutMs, intervalMs: 100, signal: b.signal },
      );
    }
    const sources = await datasets(byTestId(page, T.revenueSource));
    const source = (s: string) => {
      const d = sources.find((x) => x.source === s);
      return d ? parseCents(d.cents) : null;
    };
    return {
      available: requireCents(available.cents, "revenue-available"),
      minimum: parseCents(available.minimum),
      held: requireCents(held.cents, "revenue-held"),
      owed,
      earned: requireCents(earned.cents, "revenue-earned"),
      previous: parseCents(earned.previous),
      bySource: { subscriptions: source("subscriptions"), gifts: source("gifts"), tips: source("tips") },
      tiers: (await datasets(byTestId(page, T.revenueTierRow))).map((d) => ({
        tier: parseTier(d.tier),
        active: count(d.active),
        cents: count(d.cents),
      })),
      ledger: (await datasets(byTestId(page, T.revenueLedgerRow))).map((d) => ({
        transactionId: d.transactionId ?? "",
        type: d.type ?? "",
        tier: parseTier(d.tier),
        quantity: parseCents(d.quantity),
        gross: parseCents(d.gross),
        deductions: parseCents(d.deductions),
        net: requireCents(d.net, "revenue-ledger-row data-net"),
      })),
    };
  }
}

export class WebPublic implements PublicReader {
  constructor(private readonly open: (path: string) => Promise<Page>) {}

  async transparency(month: string, b: WaitBudget): Promise<TransparencyView | null> {
    const page = await this.open(ROUTES.transparency);
    await waitForOneOf(page, [T.transparencyMonthRow, T.transparencyEmpty], b.timeoutMs, b.signal);
    const row = (await datasets(byTestId(page, T.transparencyMonthRow))).find((d) => d.month === month);
    if (!row) return null;
    return {
      month,
      revenue: count(row.revenue),
      payouts: count(row.payouts),
      costs: count(row.costs),
      surplus: count(row.surplus),
      patronage: count(row.patronage),
    };
  }
}

/** `chat-event` rows on an open channel page. */
export class WebChatEvents implements ChatEventObserver {
  constructor(private readonly page: () => Page) {}

  async events(): Promise<MoneyChatEvent[]> {
    return (await datasets(byTestId(this.page(), T.chatEvent))).map((d) =>
      chatEventFromAttributes({
        type: d.type ?? null,
        user: d.user ?? null,
        tier: d.tier ?? null,
        cents: d.cents ?? null,
        total: d.total ?? null,
      }),
    );
  }

  async waitEvent(what: string, match: (e: MoneyChatEvent) => boolean, b: WaitBudget): Promise<MoneyChatEvent> {
    return waitFor(`chat-event ${what}`, async () => (await this.events()).find(match) ?? null, {
      timeoutMs: b.timeoutMs,
      intervalMs: 200,
      signal: b.signal,
    });
  }
}

// ---------------------------------------------------------------- API

export class ApiSupporter implements Supporter {
  constructor(
    readonly who: string,
    private readonly api: ApiClient,
  ) {}

  async checkout(channel: string, req: CheckoutRequest): Promise<CheckoutView> {
    const returnPath = ROUTES.channel(channel);
    const r =
      req.kind === "tip"
        ? await this.api.money.tip({
            channel,
            amountCents: req.cents,
            message: req.message,
            anonymous: req.anonymous,
            returnPath,
          })
        : await this.api.money.subscribe({
            channel,
            tier: req.tier,
            returnPath,
            ...(req.kind === "gift" ? { gift: { count: req.count } } : {}),
          });
    if (r.kind === "redirect") {
      // The amount a redirect will charge is the request's (tier price × count, or the tip).
      let cents: number;
      if (req.kind === "tip") cents = req.cents;
      else {
        const tiers = await this.api.money.tiers({ channel });
        const price = tiers.find((t) => t.tier === req.tier)?.price.cents ?? 0;
        cents = req.kind === "gift" ? price * req.count : price;
      }
      return { paymentId: r.paymentId, reference: "", redirectUrl: r.url, cents };
    }
    return { paymentId: r.paymentId, reference: r.reference, cents: r.amount.cents };
  }

  async subscriptions(): Promise<SubscriptionView[]> {
    return (await this.api.money.mySubscriptions()).map((s) => ({
      id: s.id,
      channel: s.channelSlug,
      tier: s.tier,
      status: s.status,
      gifted: s.gifted,
      cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    }));
  }
}

/** A moment safely in the past for `receivedAt` (the API refuses the future; clocks drift). */
function justNow(): string {
  return new Date(Date.now() - 5_000).toISOString();
}

export class ApiTreasurer implements Treasurer {
  constructor(private readonly api: ApiClient) {}

  private async payment(reference: string) {
    const r = await this.api.money.treasurer.payments({ reference, limit: 5 });
    return r.items.find((p) => p.reference === reference) ?? null;
  }

  private async require(reference: string) {
    const p = await this.payment(reference);
    if (!p) throw new Error(`treasurer.payments has no payment ${reference}`);
    return p;
  }

  async find(reference: string): Promise<TreasuryPaymentView | null> {
    const p = await this.payment(reference);
    return p
      ? {
          paymentId: p.paymentId,
          reference: p.reference,
          status: p.status,
          kind: p.kind,
          cents: p.amount.cents,
          refunded: p.refunded.cents,
        }
      : null;
  }

  /** A payment by id among the newest of a status (Stripe checkouts have no reference to search yet). */
  async findById(paymentId: string, status: "pending" | "succeeded" = "pending"): Promise<TreasuryPaymentView | null> {
    const r = await this.api.money.treasurer.payments({ status, limit: 100 });
    const p = r.items.find((x) => x.paymentId === paymentId);
    return p
      ? {
          paymentId: p.paymentId,
          reference: p.reference,
          status: p.status,
          kind: p.kind,
          cents: p.amount.cents,
          refunded: p.refunded.cents,
        }
      : null;
  }

  async confirm(reference: string): Promise<void> {
    const p = await this.require(reference);
    await this.api.money.treasurer.confirm({ paymentId: p.paymentId, receivedAt: justNow(), note: "" });
  }

  async refund(reference: string, cents: number, reason: string): Promise<void> {
    const p = await this.require(reference);
    await this.api.money.treasurer.refund({ paymentId: p.paymentId, amountCents: cents, reason });
  }

  async chargeback(reference: string, cents: number, reason: string): Promise<void> {
    const p = await this.require(reference);
    await this.api.money.treasurer.chargeback({ paymentId: p.paymentId, amountCents: cents, reason });
  }

  async runPayouts(): Promise<PayoutRunView> {
    const r = await this.api.money.treasurer.runPayouts({ periodEnd: justNow() });
    return { created: r.created, held: r.held, cents: r.total.cents };
  }

  async payouts(): Promise<PayoutView[]> {
    const out: PayoutView[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < MAX_LEDGER_PAGES; i++) {
      const r = await this.api.money.treasurer.payouts({ limit: 100, ...(cursor ? { cursor } : {}) });
      for (const p of r.items) {
        out.push({
          id: p.id,
          username: p.user.username,
          status: p.status,
          cents: p.amount.cents,
          holdReason: p.holdReason,
        });
      }
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    return out;
  }
}

export class ApiCreator implements Creator {
  constructor(private readonly api: ApiClient) {}

  async setTiers(channel: string, tiers: readonly TierInput[], currency: string): Promise<void> {
    await this.api.money.setTiers({
      channel,
      tiers: tiers.map((t, i) => ({
        tier: (i + 1) as Tier,
        name: t.name,
        benefits: t.benefits,
        price: { cents: t.cents, currency },
      })),
    });
  }

  async revenue(channel: string): Promise<RevenueView> {
    const r = await this.api.money.revenue({ channel });
    const ledger: RevenueLedgerRowView[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < MAX_LEDGER_PAGES; i++) {
      const page = await this.api.money.revenueLedger({ channel, limit: 100, ...(cursor ? { cursor } : {}) });
      for (const l of page.items) {
        ledger.push({
          transactionId: l.id,
          type: l.type,
          tier: l.tier,
          quantity: l.quantity,
          gross: l.gross?.cents ?? null,
          deductions: l.deductions?.cents ?? null,
          net: l.net.cents,
        });
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return {
      available: r.balance.available.cents,
      minimum: r.balance.minimumPayout.cents,
      held: r.balance.held.cents,
      owed: r.balance.owed.cents,
      earned: r.net.cents,
      previous: r.previousNet.cents,
      bySource: { ...r.bySource },
      tiers: r.tiers.map((t) => ({ tier: t.tier, active: t.active, cents: t.monthlyShare.cents })),
      ledger,
    };
  }
}

export class ApiPublic implements PublicReader {
  constructor(private readonly api: ApiClient) {}

  async transparency(month: string): Promise<TransparencyView | null> {
    const months = await this.api.coop.transparency({ months: 2 });
    const m = months.find((x) => x.month === month);
    if (!m) return null;
    return {
      month,
      revenue: m.revenue.cents,
      payouts: m.streamerPayouts.cents,
      costs: m.costs.reduce((s, c) => s + c.amount.cents, 0),
      surplus: m.surplus.cents,
      patronage: m.patronageDistributed.cents,
    };
  }
}

/** `op: "event"` frames on a chat socket joined to the channel. */
export class SocketChatEvents implements ChatEventObserver {
  constructor(
    private readonly socket: () => ChatClient,
    private readonly channel: string,
  ) {}

  async events(): Promise<MoneyChatEvent[]> {
    return this.socket()
      .frames.filter((f) => f.op === "event" && f.channel === this.channel)
      .map((f) => (f.op === "event" ? chatEventFromFrame(f.type, f.data) : null))
      .filter((e): e is MoneyChatEvent => e !== null);
  }

  async waitEvent(what: string, match: (e: MoneyChatEvent) => boolean, b: WaitBudget): Promise<MoneyChatEvent> {
    const f = await this.socket()
      .waitFor("event", (f) => f.channel === this.channel && match(chatEventFromFrame(f.type, f.data)), b.timeoutMs)
      .catch((err: Error) => {
        throw new Error(`chat event ${what}: ${err.message}`, { cause: err });
      });
    return chatEventFromFrame(f.type, f.data);
  }
}
