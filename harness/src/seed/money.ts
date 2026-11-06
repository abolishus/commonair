// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** seed-money: subscriptions, tips, payments, disputes, payouts, fraud holds, costs and the ledger. Brief: `.claude/briefs/seed-full/seed-money.md`. */
import { OpsHooks, OpsHooksOff } from "../e6/ops.ts";
import { ApiCreator, ApiSupporter, ApiTreasurer, type CheckoutRequest } from "../money-actors.ts";
import { disputeReachedLedger, inconsistentLedgerRows, parseProvider, unbalancedTransactions } from "../money.ts";
import { internalSecret } from "../safety-io.ts";
import { stripeWebhookSecret } from "../stripe.ts";
import { sleep } from "../wait.ts";
import { MoneySessions, ManualRail, type Paid, type Rail, StripeRail, call, pool } from "./money/api.ts";
import {
  FRAUD_DECISION_NOTE,
  FRAUD_NOTE,
  FRAUD_REVIEW_NOTE,
  PAYOUT_SENT_REFERENCE,
  WRITE_OFF_NOTE,
  payoutReference,
} from "./money/content.ts";
import { accountAges, activeBans, ledgerReport, paymentSideCounts, splitCounts } from "./money/db.ts";
import {
  FIXED_PAYEES,
  type MoneyPlan,
  type PaymentSpec,
  paidCreators,
  payoutRunWaitMs,
  planMoney,
  subscriptionsByUser,
} from "./money/plan.ts";
import type { SeedContext, SeedUnit, SeededUser } from "./types.ts";

const TABLES = [
  "subscriptions",
  "tips",
  "payments",
  "payment_events",
  "disputes",
  "payout_accounts",
  "payouts",
  "payment_fraud_flags",
  "infra_costs",
  "ledger_accounts",
  "ledger_transactions",
  "ledger_entries",
  // W2-splits (ADR 0013).
  "revenue_splits",
  "revenue_split_shares",
  "revenue_split_acceptances",
  "revenue_split_postings",
  "split_writeoff_proposals",
] as const;

/**
 * Every table is seeded. Payouts and the split write-off need the holds released in real time: the
 * `money-release-holds` ops tick with a test hold period (OPS_TEST_HOOKS) does that.
 */
const PENDING = [] as const;

/** Payers checked out at once (sign-ins are rate limited per address; payments per user). */
const PAYER_CONCURRENCY = 4;
const PROGRESS_MS = 10_000;
/** Longer than the `receivedAt` skew the rail dates confirmations back by. */
const SPLIT_SETTLE_MS = 6_000;
/** Creators whose /revenue ledger rows are checked after the run. */
const REVENUE_CHECKED = ["streamer1", "streamer2"] as const;

/** What seed-money publishes as `store.extra.money` (the keys its brief names). */
export interface MoneyExtra {
  provider: "manual" | "stripe";
  subscriptionsByUser: Record<string, { channelSlug: string; tier: number; status: string }[]>;
  /** UTC `YYYY-MM` holding the revenue. */
  revenuePeriod: string;
  /** Creator handles with confirmed payments. */
  paidCreators: string[];
}

export const unit: SeedUnit = {
  name: "money",
  // interact: its tip and subscription goals count the payments made after them, as on a real
  // channel; side by side the counts would depend on which came first.
  after: ["social", "interact"],
  tables: TABLES,
  pending: PENDING,
  run: runMoney,
};

async function runMoney(ctx: SeedContext) {
  const started = Date.now();
  const log = (line: string) => ctx.log.info(`seed-money: ${line}`);
  const users = new Map(ctx.store.users.map((u) => [u.handle, u]));
  const slugs = new Map(ctx.store.channels.map((c) => [c.ownerHandle, c.slug]));
  const slugOf = (h: string) => {
    const s = slugs.get(h);
    if (!s) throw new Error(`seed-money: ${h} has no seeded channel`);
    return s;
  };
  const user = (h: string): SeededUser => {
    const u = users.get(h);
    if (!u) throw new Error(`seed-money: no seeded user "${h}" (seed-social runs first)`);
    return u;
  };
  const first = FIXED_PAYEES.find((h) => slugs.has(h));
  if (!first) throw new Error("seed-money: no fixed streamer channel in the store (seed-social runs first)");

  // Flags first: the fraud scan runs through the ops test hook.
  const secret = internalSecret(ctx.env);
  if (!secret)
    throw new Error("seed-money: INTERNAL_API_SECRET is not set (HARNESS_INTERNAL_API_SECRET or the repo .env)");
  const ops = new OpsHooks(ctx.env.HARNESS_API_URL, secret, ctx.signal);
  try {
    await ops.tickRan("money-fraud-scan");
  } catch (err) {
    if (err instanceof OpsHooksOff)
      throw new Error("seed-money needs OPS_TEST_HOOKS=true on the api and the worker (the fraud scan tick)", {
        cause: err,
      });
    throw err;
  }
  const sessions = new MoneySessions(ctx.env, ctx.password, users, ctx.signal);
  const treasurer = await sessions.client("treasurer");
  const support = await call("money.support", () => treasurer.money.support({ channel: slugOf(first) }), ctx.signal);
  const provider = parseProvider(support.provider);
  let rail: Rail;
  if (provider === "stripe") {
    const hookSecret = stripeWebhookSecret(ctx.env);
    if (!hookSecret)
      throw new Error(
        "seed-money: the stack runs Stripe but no webhook secret is set (HARNESS_STRIPE_WEBHOOK_SECRET or STRIPE_WEBHOOK_SECRET in .env)",
      );
    rail = new StripeRail(ctx.env.HARNESS_API_URL, hookSecret, treasurer, ctx.signal);
  } else rail = new ManualRail(treasurer, ctx.db, ctx.signal);
  const prices = [1, 2, 3].map((t) => support.tiers.find((x) => x.tier === t)?.price.cents);
  if (prices.some((p) => p === undefined))
    throw new Error(`seed-money: ${first}'s channel has no three tiers (seed-social sets them)`);
  const tierPrices = prices as [number, number, number];

  // Account ages (the plan keeps new payers out) and live bans (never a gift recipient).
  const ages = await accountAges(
    ctx.db,
    ctx.store.users.map((u) => u.id),
    ctx.signal,
  );
  const byId = new Map(ctx.store.users.map((u) => [u.id, u.handle]));
  const ownerOfChannel = new Map(ctx.store.channels.map((c) => [c.id, c.ownerHandle]));
  const banned = new Set(
    (await activeBans(ctx.db, ctx.now)).flatMap((b) => {
      const owner = ownerOfChannel.get(b.channelId);
      const h = byId.get(b.userId);
      return owner && h ? [`${owner}\0${h}`] : [];
    }),
  );
  const plan = planMoney(ctx.rng, ctx.scale, ctx.now, {
    accounts: ctx.store.users.flatMap((u) => {
      const createdAt = ages.get(u.id);
      return createdAt ? [{ handle: u.handle, kind: u.kind, createdAt }] : [];
    }),
    streamers: ctx.store.channels.map((c) => c.ownerHandle),
    banned,
    tierPrices,
    currency: support.currency,
  });
  log(`plan: ${plan.payments.length} checkouts, ${plan.costs.length} costs, provider ${provider}`);

  const rows: Record<string, number> = {};
  const notes: string[] = [];

  // 1. Payout accounts (the split recipient needs one before the proposal).
  for (const a of plan.payoutAccounts)
    await call(
      `treasurer sets ${a.handle}'s payout account`,
      () =>
        treasurer.money.treasurer.setPayoutAccount({
          username: user(a.handle).username,
          payoutsEnabled: a.enabled,
          reference: payoutReference(a.handle),
        }),
      ctx.signal,
    );
  rows.payout_accounts = plan.payoutAccounts.length;

  // 2. Revenue splits, before any payment, so streamer1's payments post with the accepted split.
  for (const s of plan.splits) {
    const owner = await sessions.client(s.owner);
    const version = await call(
      `${s.owner} proposes a split`,
      () =>
        owner.money.splits.propose({
          channel: slugOf(s.owner),
          basis: s.basis,
          shares: s.crew.map((c) => ({ username: user(c.handle).username, bps: c.bps })),
        }),
      ctx.signal,
    );
    if (s.accept)
      for (const c of s.crew) {
        const crew = await sessions.client(c.handle);
        await call(
          `${c.handle} accepts ${s.owner}'s split`,
          () => crew.money.splits.accept({ id: version.id }),
          ctx.signal,
        );
      }
  }
  // A confirmation is dated a few seconds back (`receivedAt`); keep it inside the split's window.
  if (plan.splits.length > 0) await sleep(SPLIT_SETTLE_MS, ctx.signal);

  // 3. Checkouts, settlement and what follows, payer by payer.
  const paymentIds: string[] = [];
  const skipped: string[] = [];
  let writeOffPaid: { spec: PaymentSpec; paid: Paid } | null = null;
  let done = 0;
  let lastProgress = Date.now();
  const byPayer = new Map<string, PaymentSpec[]>();
  for (const p of plan.payments) byPayer.set(p.payer, [...(byPayer.get(p.payer) ?? []), p]);
  // The velocity payer goes last, so the scan below sees its burst together with everything else.
  const velocityPayer = plan.velocity?.payer;
  const groups = [...byPayer.entries()].filter(([h]) => h !== velocityPayer);
  const runGroup = async ([payer, specs]: [string, PaymentSpec[]]) => {
    const client = await sessions.client(payer);
    const supporter = new ApiSupporter(payer, client);
    for (const spec of specs) {
      ctx.signal.throwIfAborted();
      const paid = await settle(spec, supporter, client);
      if (paid) paymentIds.push(paid);
      done++;
      if (Date.now() - lastProgress > PROGRESS_MS) {
        lastProgress = Date.now();
        log(`${done}/${plan.payments.length} checkouts`);
      }
    }
  };
  const settle = async (
    spec: PaymentSpec,
    supporter: ApiSupporter,
    client: Awaited<ReturnType<typeof sessions.client>>,
  ): Promise<string> => {
    const channel = slugOf(spec.payee);
    const req: CheckoutRequest =
      spec.kind === "tip"
        ? { kind: "tip", cents: spec.cents, message: spec.message, anonymous: spec.anonymous }
        : { kind: "sub", tier: spec.tier ?? 1 };
    const checkout =
      spec.kind === "gift"
        ? await call(
            `${spec.payer} gifts ${spec.key}`,
            async () => {
              const to = spec.giftTo ? user(spec.giftTo).username : undefined;
              const r = await client.money.subscribe({
                channel,
                tier: spec.tier ?? 1,
                returnPath: `/${channel}`,
                gift: { count: 1, ...(to ? { to } : {}) },
              });
              return r.kind === "redirect"
                ? { paymentId: r.paymentId, reference: "", redirectUrl: r.url, cents: spec.cents }
                : { paymentId: r.paymentId, reference: r.reference, cents: r.amount.cents };
            },
            ctx.signal,
          )
        : await call(`${spec.payer} checks out ${spec.key}`, () => supporter.checkout(channel, req), ctx.signal);
    if (checkout.cents !== spec.cents)
      throw new Error(`seed-money: ${spec.key} checked out ${checkout.cents} cents, planned ${spec.cents}`);
    if (spec.settle === "pending") return checkout.paymentId;
    if (spec.settle === "abandoned") {
      await rail.abandon(spec, checkout.paymentId);
      return checkout.paymentId;
    }
    const paid: Paid = await rail.confirm(spec, checkout);
    if (spec.lifecycle === "cancel_at_period_end") {
      const mine = await call(`${spec.payer} lists subscriptions`, () => client.money.mySubscriptions(), ctx.signal);
      const s = mine.find((x) => x.channelSlug === channel && !x.gifted && x.status === "active");
      if (!s) throw new Error(`seed-money: ${spec.key}: no active subscription to cancel`);
      await call(`${spec.payer} cancels ${spec.key}`, () => client.money.cancelSubscription({ id: s.id }), ctx.signal);
    } else if (spec.lifecycle === "lapse") await rail.lapse(spec, paid);
    // Charged back only after the payout run (step 5).
    if (spec.key === plan.writeOff?.key) writeOffPaid = { spec, paid };
    else if (spec.reversal?.kind === "refund") await rail.refund(spec, paid, spec.reversal.cents, spec.reversal.reason);
    else if (spec.reversal?.kind === "chargeback") {
      const ran = await rail.chargeback(spec, paid, spec.reversal.outcome, spec.reversal.reason);
      if (!ran) skipped.push(spec.reversal.outcome);
    }
    return paid.paymentId;
  };
  await pool(groups, PAYER_CONCURRENCY, runGroup);
  if (velocityPayer) await runGroup([velocityPayer, byPayer.get(velocityPayer) ?? []]);
  // Every confirmation, refund and chargeback above is posted (and dated) by now.
  const settledAt = Date.now();
  rows.payments = paymentIds.length;
  log(`${paymentIds.length} checkouts in ${((Date.now() - started) / 1000).toFixed(1)} s`);

  // 4. Fraud: the scan flags the velocity payee; the treasurer raises and the admin decides the rest.
  rows.payment_fraud_flags = await seedFraud(ctx, plan, sessions, ops, users);

  // 5. Costs over the history, and a payout run.
  for (const c of plan.costs)
    await call(
      `treasurer records ${c.category} for ${c.periodStart.toISOString().slice(0, 7)}`,
      () =>
        treasurer.money.treasurer.recordCost({
          periodStart: c.periodStart.toISOString(),
          periodEnd: c.periodEnd.toISOString(),
          category: c.category,
          description: c.description,
          amountCents: c.cents,
        }),
      ctx.signal,
    );
  rows.infra_costs = plan.costs.length;
  // Every hold released now (a test hold period of 0 days; each release is dated at its payment),
  // so the run pays the ready payees and holds streamer2 (no payout account) and the new crew payee.
  const release = await ops.tickRan("money-release-holds", 10, 1_000, { holdDays: 0 });
  const treasury = new ApiTreasurer(treasurer);
  // The run counts postings dated up to its periodEnd (now − 5 s); Stripe dates them at the webhook,
  // so wait until the last checkout falls inside, or nothing is reserved and the write-off has no
  // shortfall to write off.
  const wait = payoutRunWaitMs(settledAt, Date.now());
  if (wait > 0) {
    log(`waiting ${(wait / 1000).toFixed(1)} s so the payout run's period covers the last checkout`);
    await sleep(wait, ctx.signal);
  }
  const payoutRun = await call("treasurer runs payouts", () => treasury.runPayouts(), ctx.signal);
  const writeOff = await seedWriteOff(ctx, plan, writeOffPaid, rail, sessions, users);
  const payouts = await call("treasurer lists payouts", () => treasury.payouts(), ctx.signal);
  const pending = payouts.filter((p) => p.status === "pending");
  // One paid, the rest left pending, so /treasury shows every state.
  const paid = pending.length >= 2 ? pending[0] : undefined;
  if (paid)
    await call(
      `treasurer marks ${paid.username}'s payout paid`,
      () => treasurer.money.treasurer.markPaid({ id: paid.id, reference: PAYOUT_SENT_REFERENCE }),
      ctx.signal,
    );
  rows.payouts = payouts.length;

  // 6. Checks: every transaction balances, every dispute reached the ledger, revenue rows add up.
  const ledger = await ledgerReport(ctx.db, paymentIds, user("treasurer").id, ctx.signal);
  const unbalanced = unbalancedTransactions(ledger.rows);
  if (unbalanced.length > 0)
    throw new Error(
      `seed-money: ${unbalanced.length} ledger transactions do not balance: ${JSON.stringify(unbalanced)}`,
    );
  const lost = ledger.disputes.filter((d) => !disputeReachedLedger(ledger.rows, d));
  if (lost.length > 0) throw new Error(`seed-money: disputes without a ledger posting: ${JSON.stringify(lost)}`);
  // The owners already signed in (sign-ins are rate limited); their ledgers carry splits and reversals.
  for (const h of REVENUE_CHECKED.filter((x) => slugs.has(x) && plan.payments.some((p) => p.payee === x))) {
    const view = await call(`${h} reads /revenue`, async () =>
      new ApiCreator(await sessions.client(h)).revenue(slugOf(h)),
    );
    const bad = inconsistentLedgerRows(view.ledger);
    if (bad.length > 0) throw new Error(`seed-money: ${h}'s revenue ledger rows do not add up: ${JSON.stringify(bad)}`);
  }
  Object.assign(rows, ledger.counts);
  rows.disputes = ledger.disputes.length;
  rows.payment_events = rail.webhooks;
  Object.assign(rows, await paymentSideCounts(ctx.db, paymentIds));
  const splitChannels = plan.splits.flatMap((s) => {
    const c = ctx.store.channels.find((x) => x.ownerHandle === s.owner);
    return c ? [c.id] : [];
  });
  Object.assign(rows, await splitCounts(ctx.db, splitChannels));
  rows.split_writeoff_proposals = writeOff ? 1 : 0;

  const extra: MoneyExtra = {
    provider,
    subscriptionsByUser: subscriptionsByUser(plan, slugOf),
    revenuePeriod: plan.revenuePeriod,
    paidCreators: paidCreators(plan),
  };
  ctx.store.extra.money = { ...extra };

  notes.push(
    `seed-money: provider ${provider}${provider === "manual" ? " (PAYMENTS_PROVIDER=manual; run with the stripe-mock profile and PAYMENTS_PROVIDER=stripe for payment_events and open/won disputes)" : " (stripe-mock; every payment settled by signed webhooks)"}`,
    "seed-money: every payment, posting, dispute and flag is real-time (the API stamps them now): /revenue, /transparency and the dashboard tiles show the current month's revenue only; infra_costs alone span the history (recordCost books each in its own period)",
    `seed-money: the money-release-holds ops tick ran with a 0-day test hold period (OPS_TEST_HOOKS; ${release.released ?? 0} lots released, each dated at its payment), so the payout run had money to pay: ${payoutRun.created} pending and ${payoutRun.held} held, ${paid ? `${paid.username}'s marked paid` : "none marked paid (fewer than two pending)"}`,
    writeOff
      ? `seed-money: ${writeOff.owner}'s tip ${writeOff.key} was charged back after the payout run reserved its earnings, so the crew's released slice became split shortfall; the treasurer proposed writing off ${writeOff.cents} cents (OPS_TEST_HOOKS waives the quiet window), left for a second finance person on /treasury`
      : "seed-money: no split write-off: the plan has no accepted all-revenue split with a paid tip",
  );
  if (provider === "manual")
    notes.push(
      "seed-money: past_due and expired arrive within 5 minutes of the seed, when the worker's money-renew and money-expire-pending jobs run: the seed moved those subscriptions' periods and those checkouts' expires_at into the past (plain tables); store.extra.money.subscriptionsByUser already gives the final status",
    );
  if (skipped.length > 0)
    notes.push(
      `seed-money: ${skipped.length} chargebacks planned as ${[...new Set(skipped)].join("/")} were skipped: the manual adapter records chargebacks as lost only (open and won disputes come from Stripe)`,
    );
  notes.push(
    `seed-money: ${plan.payments.filter((p) => p.settle === "pending").length} checkouts stay pending in the treasurer's queue; ${sessions.signedIn} accounts signed in (each adds a session row)`,
  );
  log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return { rows, notes };
}

async function seedFraud(
  ctx: SeedContext,
  plan: MoneyPlan,
  sessions: MoneySessions,
  ops: OpsHooks,
  users: ReadonlyMap<string, SeededUser>,
): Promise<number> {
  const treasurer = await sessions.client("treasurer");
  const admin = await sessions.client("admin");
  const name = (h: string) => {
    const u = users.get(h);
    if (!u) throw new Error(`seed-money: no seeded user "${h}"`);
    return u;
  };
  for (const f of plan.flags) {
    const flag = await call(
      `treasurer raises a fraud flag on ${f.payee}`,
      () => treasurer.money.treasurer.fraudFlags.raise({ username: name(f.payee).username, note: FRAUD_NOTE }),
      ctx.signal,
    );
    const decision = f.decision;
    if (!decision) continue;
    await call(
      `treasurer reviews the flag on ${f.payee}`,
      () =>
        treasurer.money.treasurer.fraudFlags.review({ id: flag.id, recommendation: decision, note: FRAUD_REVIEW_NOTE }),
      ctx.signal,
    );
    await call(
      `admin decides the flag on ${f.payee}`,
      () => admin.money.treasurer.fraudFlags.decide({ id: flag.id, decision, note: FRAUD_DECISION_NOTE }),
      ctx.signal,
    );
  }
  await ops.tickRan("money-fraud-scan");
  const listed: { payee: string; kind: string }[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await call(
      "treasurer lists fraud flags",
      () => treasurer.money.treasurer.fraudFlags.list({ limit: 100, ...(cursor ? { cursor } : {}) }),
      ctx.signal,
    );
    for (const f of page.items) listed.push({ payee: f.payee.id, kind: f.kind });
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  const expected = new Set(plan.flags.map((f) => name(f.payee).id));
  if (plan.velocity) {
    const payee = name(plan.velocity.payee).id;
    if (!listed.some((f) => f.payee === payee && f.kind === "payer_velocity"))
      throw new Error(`seed-money: the fraud scan did not flag ${plan.velocity.payee} for payer velocity`);
    expected.add(payee);
  }
  const stray = listed.filter((f) => !expected.has(f.payee));
  if (stray.length > 0)
    throw new Error(`seed-money: the fraud scan flagged payees the plan did not mean to: ${JSON.stringify(stray)}`);
  return listed.length;
}

/**
 * The split write-off: charge back the planned tip (its crew slice was released and its owner's
 * earnings reserved by the payout run, so the crew's slice is the owner's split shortfall), then
 * the treasurer proposes writing the shortfall off. Returns null when the plan has none.
 */
async function seedWriteOff(
  ctx: SeedContext,
  plan: MoneyPlan,
  target: { spec: PaymentSpec; paid: Paid } | null,
  rail: Rail,
  sessions: MoneySessions,
  users: ReadonlyMap<string, SeededUser>,
): Promise<{ owner: string; key: string; cents: number } | null> {
  if (!plan.writeOff) return null;
  if (!target) throw new Error(`seed-money: the write-off tip ${plan.writeOff.key} was never paid`);
  const { spec, paid } = target;
  if (spec.reversal?.kind !== "chargeback") throw new Error(`seed-money: ${spec.key} is not planned as a chargeback`);
  await rail.chargeback(spec, paid, spec.reversal.outcome, spec.reversal.reason);
  const owner = users.get(plan.writeOff.owner);
  if (!owner) throw new Error(`seed-money: no seeded user "${plan.writeOff.owner}"`);
  const treasurer = await sessions.client("treasurer");
  const proposed = await call(
    `treasurer proposes writing off ${plan.writeOff.owner}'s split shortfall`,
    () => treasurer.money.treasurer.splits.proposeWriteOff({ username: owner.username, note: WRITE_OFF_NOTE }),
    ctx.signal,
  );
  return { owner: plan.writeOff.owner, key: spec.key, cents: proposed.amount.cents };
}
