// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Revenue dashboard, statements, payouts, costs and transparency (E4b api-reports unit). Every
 * money figure is read from the ledger (`@commonair/ledger` queries or `ledger_entries` on the
 * creator's own accounts); `payments` rows only classify a posting (tier, gift, tip, payer),
 * never supply its amount. See docs/testing/e4b-selectors.md.
 */
import { type SQL, and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { DELIVERY_SOURCES, MEMBER_CLASSES, type PROPOSAL_STATUSES } from "@commonair/contracts/enums";
import { type Executor, schema, uuidv7 } from "@commonair/db";
import {
  PayoutStateError,
  accounts,
  creatorBalances,
  infrastructureCost,
  loadMoneySettings,
  monthlyAggregates,
  post,
  postPayout,
  releaseDueHolds,
  runPayoutBatch,
  splitNet,
  statement,
  storedCode,
} from "@commonair/ledger";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { decodeCursor, encodeCursor, pageOf } from "../lib/cursor.ts";
import { isoOrNull } from "../lib/dto.ts";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.ts";
import { type ResolvedContext, os, requireCaller, requireChannel } from "../lib/orpc.ts";
import { stripePayoutAccount } from "./stripe-connect.ts";
import {
  type PaymentFacts,
  type Period,
  PeriodError,
  REVENUE_KINDS,
  REVENUE_LEDGER_KINDS,
  addMonths,
  costCategory,
  csvSafeReference,
  isCategorySlug,
  isIdCursor,
  isMicroKeyCursor,
  isReservedCostCategory,
  isRevenueLedgerKind,
  monthStart,
  parsePeriod,
  payoutMonth,
  payoutRunRefusal,
  payoutRunSubject,
  previousPeriod,
  revenueLineType,
  revenueSource,
  utcDays,
  visiblePayer,
} from "./reports-lib.ts";

const { payments, payouts, payoutAccounts, subscriptions, users, infraCosts } = schema;

/** int8/numeric arrive from the driver as strings. */
const num = (v: string | number | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));
const money = (cents: number, currency: string) => ({ cents, currency });
const kindList = (kinds: readonly string[]) =>
  sql.join(
    kinds.map((k) => sql`${k}`),
    sql`, `,
  );

function period(from: string | undefined, to: string | undefined, now: Date): Period {
  try {
    return parsePeriod(from, to, now);
  } catch (err) {
    if (err instanceof PeriodError) throw badRequest(err.message);
    throw err;
  }
}

/**
 * Revenue is the channel owner's own money: editors (whom `owner` access also admits) and
 * platform staff do not see it here.
 */
function requireOwnChannel(ctx: Pick<ResolvedContext, "caller" | "channel">) {
  const caller = requireCaller(ctx);
  const channel = requireChannel(ctx);
  if (channel.ownerId !== caller.user.id) throw forbidden("Only the channel owner can see its revenue");
  return channel;
}

/** The three accounts that make up what the co-op owes a creator (natural sum = owed). */
function creatorCodes(userId: string, currency: string): SQL {
  return sql`(${storedCode(accounts.creator(userId), currency)}, ${storedCode(accounts.creatorHold(userId), currency)}, ${storedCode(accounts.creatorReceivable(userId), currency)})`;
}

// Revenue summary ----------------------------------------------------------------------------

interface RevenueGroup {
  day: string;
  kind: string;
  paymentKind: PaymentFacts["kind"] | null;
  multi: boolean;
  gift: boolean;
  /** Change to what is owed to the creator (positive = earned). */
  net: number;
  /** Signed payment gross (negative for reversals). */
  gross: number;
  coop: number;
  count: number;
}

/**
 * Revenue postings on the creator's accounts in `[from, to)`, grouped by UTC day, posting kind
 * and the payment facts that classify the source.
 */
async function revenueGroups(db: Executor, userId: string, currency: string, p: Period): Promise<RevenueGroup[]> {
  const rows = await db.execute<{
    day: string;
    kind: string;
    payment_kind: PaymentFacts["kind"] | null;
    multi: boolean | null;
    gift: boolean | null;
    net: string;
    gross: string;
    coop: string;
    n: string;
  }>(sql`
    with tx as (
      select t.id, t.kind, t.occurred_at, t.ref_type, t.ref_id, t.metadata, -sum(e.amount_cents) as net
      from ledger_entries e
      join ledger_accounts a on a.id = e.account_id
      join ledger_transactions t on t.id = e.transaction_id
      where a.code in ${creatorCodes(userId, currency)}
        and t.kind in (${kindList(REVENUE_KINDS)})
        and t.occurred_at >= ${p.from.toISOString()}::timestamptz
        and t.occurred_at < ${p.to.toISOString()}::timestamptz
      group by t.id
    ), classified as (
      select to_char(tx.occurred_at at time zone 'UTC', 'YYYY-MM-DD') as day, tx.kind, tx.net,
             (tx.metadata->>'revenueGrossCents')::bigint as gross, (tx.metadata->>'coopCents')::bigint as coop,
             p.kind as payment_kind, p.quantity > 1 as multi,
             exists (select 1 from subscriptions s where s.gift_payment_id = p.id) as gift
      from tx left join payments p on tx.ref_type = 'payment' and p.id = tx.ref_id
    )
    select day, kind, payment_kind, multi, gift, sum(net)::text as net,
           coalesce(sum(gross), 0)::text as gross, coalesce(sum(coop), 0)::text as coop, count(*)::text as n
    from classified
    group by day, kind, payment_kind, multi, gift`);
  return [...rows].map((r) => ({
    day: r.day,
    kind: r.kind,
    paymentKind: r.payment_kind,
    multi: r.multi === true,
    gift: r.gift === true,
    net: num(r.net),
    gross: num(r.gross),
    coop: num(r.coop),
    count: num(r.n),
  }));
}

const sumNet = (groups: readonly RevenueGroup[]) => groups.reduce((s, g) => s + g.net, 0);

async function revenueSummary(
  deps: Deps,
  channel: { id: string; ownerId: string },
  input: { from?: string; to?: string },
) {
  const { db } = deps;
  const currency = deps.env.CURRENCY;
  const p = period(input.from, input.to, deps.now());
  const prev = previousPeriod(p);
  const [settings, groups, prevGroups, balances, tierRows] = await Promise.all([
    loadMoneySettings(db),
    revenueGroups(db, channel.ownerId, currency, p),
    revenueGroups(db, channel.ownerId, currency, prev),
    creatorBalances(db, channel.ownerId, currency),
    db
      .select({ tier: subscriptions.tier, price: subscriptions.priceCents, n: sql<string>`count(*)::text` })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.channelId, channel.id),
          inArray(subscriptions.status, ["active", "past_due"]),
          eq(subscriptions.currency, currency),
        ),
      )
      .groupBy(subscriptions.tier, subscriptions.priceCents),
  ]);

  let gross = 0;
  let reversed = 0;
  let coop = 0;
  let tips = 0;
  const bySource = { subscriptions: 0, gifts: 0, tips: 0 };
  const daily = new Map(utcDays(p).map((d) => [d, { date: d, gross: 0, net: 0 }]));
  for (const g of groups) {
    if (g.kind === "payment") gross += g.gross;
    else reversed -= g.gross;
    coop += g.coop;
    if (g.kind === "payment" && g.paymentKind === "tip") tips += g.count;
    if (g.paymentKind)
      bySource[revenueSource({ kind: g.paymentKind, quantity: g.multi ? 2 : 1, giftSubscription: g.gift })] += g.net;
    const day = daily.get(g.day);
    if (day) {
      // Daily gross is what was paid that day; reversals show in net only.
      if (g.kind === "payment") day.gross += g.gross;
      day.net += g.net;
    }
  }

  // Today's cut, the ledger's rounding rule, per subscription (grouped by identical price).
  const tiers = [1, 2, 3].map((tier) => {
    const rows = tierRows.filter((r) => r.tier === tier);
    const active = rows.reduce((s, r) => s + num(r.n), 0);
    const share = rows.reduce((s, r) => s + splitNet(r.price, settings.cut).creatorCents * num(r.n), 0);
    return { tier, active, monthlyShare: money(share, currency) };
  });
  const activeOf = (tier: number) => tiers.find((t) => t.tier === tier)?.active ?? 0;

  return {
    periodStart: p.from.toISOString(),
    periodEnd: p.to.toISOString(),
    gross: money(gross, currency),
    coopCut: money(coop, currency),
    refundsAndChargebacks: money(reversed, currency),
    net: money(sumNet(groups), currency),
    pendingPayout: money(balances.reservedCents, currency),
    activeSubscriptions: { tier1: activeOf(1), tier2: activeOf(2), tier3: activeOf(3) },
    tips,
    split: { streamerShare: settings.cut.streamerShare, coopShare: settings.cut.coopShare },
    daily: [...daily.values()],
    balance: {
      // A receivable larger than released earnings shows as owed, not as a negative balance.
      available: money(Math.max(0, balances.availableCents), currency),
      held: money(balances.holdCents, currency),
      owed: money(balances.receivableCents, currency),
      minimumPayout: money(settings.payoutRules.minimumCents, currency),
      holdDays: settings.payoutRules.holdDays,
    },
    bySource,
    tiers,
    previousNet: money(sumNet(prevGroups), currency),
  };
}

// Revenue ledger -----------------------------------------------------------------------------

async function revenueLedger(
  deps: Deps,
  ownerId: string,
  input: { from?: string; to?: string; cursor?: string; limit: number },
) {
  const { db } = deps;
  const currency = deps.env.CURRENCY;
  const cur = decodeCursor(input.cursor, isMicroKeyCursor);
  // Same period rules as the summary (default: the current UTC month), so the CSV matches it.
  const p = period(input.from, input.to, deps.now());
  const rows = [
    ...(await db.execute<{
      id: string;
      kind: string;
      occurred_at: string | Date;
      /** Microsecond key for the cursor (a JS Date would truncate to milliseconds). */
      t_key: string;
      ref_type: string | null;
      ref_id: string | null;
      gross: string | null;
      net: string;
    }>(sql`
      select t.id, t.kind, t.occurred_at, t.ref_type, t.ref_id,
             to_char(t.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t_key,
             t.metadata->>'revenueGrossCents' as gross, (-sum(e.amount_cents))::text as net
      from ledger_entries e
      join ledger_accounts a on a.id = e.account_id
      join ledger_transactions t on t.id = e.transaction_id
      where a.code in ${creatorCodes(ownerId, currency)}
        and t.kind in (${kindList(REVENUE_LEDGER_KINDS)})
        and t.occurred_at >= ${p.from.toISOString()}::timestamptz
        and t.occurred_at < ${p.to.toISOString()}::timestamptz
        ${cur ? sql`and (t.occurred_at, t.id) < (${cur.t}::timestamptz, ${cur.id}::uuid)` : sql``}
      group by t.id
      order by t.occurred_at desc, t.id desc
      limit ${input.limit + 1}`)),
  ];

  const paymentIds = [
    ...new Set(rows.filter((r) => r.ref_type === "payment" && r.ref_id).map((r) => r.ref_id as string)),
  ];
  const payoutIds = [
    ...new Set(rows.filter((r) => r.ref_type === "payout" && r.ref_id).map((r) => r.ref_id as string)),
  ];
  const [paymentRows, payoutRows] = await Promise.all([
    paymentIds.length
      ? db
          .select({
            id: payments.id,
            kind: payments.kind,
            providerRef: payments.providerRef,
            tier: payments.tier,
            quantity: payments.quantity,
            anonymous: schema.tips.anonymous,
            userId: users.id,
            username: users.username,
            name: users.name,
            gift: sql<boolean>`exists (select 1 from subscriptions s where s.gift_payment_id = ${payments.id})`,
          })
          .from(payments)
          .leftJoin(users, eq(users.id, payments.userId))
          .leftJoin(schema.tips, eq(schema.tips.id, payments.tipId))
          .where(inArray(payments.id, paymentIds))
      : [],
    payoutIds.length
      ? db
          .select({ id: payouts.id, providerRef: payouts.providerRef })
          .from(payouts)
          .where(inArray(payouts.id, payoutIds))
      : [],
  ]);
  const paymentById = new Map(paymentRows.map((r) => [r.id, r]));
  const payoutById = new Map(payoutRows.map((r) => [r.id, r]));

  return pageOf(
    rows,
    input.limit,
    (r) => {
      const at = new Date(r.occurred_at);
      const kind = isRevenueLedgerKind(r.kind) ? r.kind : "payment";
      const net = num(r.net);
      const pay = r.ref_type === "payment" && r.ref_id ? paymentById.get(r.ref_id) : undefined;
      const facts: PaymentFacts | null = pay
        ? { kind: pay.kind, quantity: pay.quantity, giftSubscription: pay.gift === true }
        : null;
      const isPayout = kind === "payout_reserve" || kind === "payout_cancel";
      const gross = isPayout || r.gross === null ? null : num(r.gross);
      return {
        id: r.id,
        occurredAt: at.toISOString(),
        type: revenueLineType(kind, facts),
        tier: pay?.tier ?? null,
        quantity: pay?.quantity ?? 1,
        from: pay
          ? visiblePayer({
              kind: pay.kind,
              anonymous: pay.anonymous,
              user:
                pay.userId && pay.username
                  ? { id: pay.userId, username: pay.username, displayName: pay.name ?? pay.username }
                  : null,
            })
          : null,
        reference: csvSafeReference(
          pay ? pay.providerRef : r.ref_type === "payout" && r.ref_id ? payoutById.get(r.ref_id)?.providerRef : null,
        ),
        gross: gross === null ? null : money(gross, currency),
        // gross + deductions = net: tax, the co-op share and fees, opposite in sign to gross.
        deductions: gross === null ? null : money(net - gross, currency),
        net: money(net, currency),
      };
    },
    (last) => encodeCursor({ t: last.t_key, id: last.id }),
  );
}

// Payouts ------------------------------------------------------------------------------------

type PayoutRow = typeof payouts.$inferSelect;
const payoutDto = (p: PayoutRow) => ({
  id: p.id,
  periodStart: p.periodStart.toISOString(),
  periodEnd: p.periodEnd.toISOString(),
  amount: money(p.amountCents, p.currency),
  status: p.status,
  provider: p.provider,
  holdReason: p.holdReason,
  paidAt: isoOrNull(p.paidAt),
});

/** The newest payouts a creator sees on their own page; months, so a few years fit. */
const MY_PAYOUTS_LIMIT = 120;

export const reportHandlers = {
  revenue: os.money.revenue.handler(async ({ context, input }) => {
    const c = requireOwnChannel(context);
    return revenueSummary(context.deps, c, input);
  }),

  revenueLedger: os.money.revenueLedger.handler(async ({ context, input }) => {
    const c = requireOwnChannel(context);
    return revenueLedger(context.deps, c.ownerId, input);
  }),

  payouts: os.money.payouts.handler(async ({ context }) => {
    const caller = requireCaller(context);
    const rows = await context.deps.db
      .select()
      .from(payouts)
      .where(eq(payouts.userId, caller.user.id))
      .orderBy(desc(payouts.periodStart), desc(payouts.createdAt), desc(payouts.id))
      .limit(MY_PAYOUTS_LIMIT);
    return rows.map(payoutDto);
  }),

  payoutAccount: os.money.payoutAccount.handler(async ({ context }) => {
    const caller = requireCaller(context);
    const { deps } = context;
    const [row] = await deps.db
      .select({
        provider: payoutAccounts.provider,
        enabled: payoutAccounts.payoutsEnabled,
        accountId: payoutAccounts.providerAccountId,
      })
      .from(payoutAccounts)
      .where(eq(payoutAccounts.userId, caller.user.id));
    const provider = row?.provider ?? deps.env.PAYMENTS_PROVIDER;
    const enabled = row?.enabled === true;
    if (provider === "stripe" && deps.env.PAYMENTS_PROVIDER === "stripe") {
      // Connect Express: create the account on first visit, sync payouts_enabled from Stripe, and
      // hand out a fresh onboarding link while it is not enabled (links are single-use).
      const status = await stripePayoutAccount(deps, caller.user.id, row?.accountId ?? null);
      return { provider, ...status, instructions: null };
    }
    return {
      provider,
      payoutsEnabled: enabled,
      onboardingUrl: null,
      instructions: provider === "manual" && !enabled ? deps.env.MANUAL_PAYOUT_INSTRUCTIONS : null,
    };
  }),

  statement: os.money.statement.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    let page: Awaited<ReturnType<typeof statement>>;
    try {
      page = await statement(context.deps.db, caller.user.id, { cursor: input.cursor, limit: input.limit });
    } catch (err) {
      if (err instanceof RangeError) throw badRequest("Invalid cursor");
      throw err;
    }
    return {
      items: page.items.map((l) => ({
        transactionId: l.transactionId,
        occurredAt: l.occurredAt.toISOString(),
        kind: l.kind,
        description: l.description,
        account: l.account,
        amount: l.amount,
      })),
      nextCursor: page.nextCursor,
    };
  }),
};

// Treasurer ----------------------------------------------------------------------------------

export const treasurerReportHandlers = {
  runPayouts: os.money.treasurer.runPayouts.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    const { deps } = context;
    const now = deps.now();
    const periodEnd = new Date(input.periodEnd);
    const refusal = payoutRunRefusal(periodEnd, now);
    if (refusal) throw badRequest(refusal);
    const currency = deps.env.CURRENCY;
    const { payoutRules } = await loadMoneySettings(deps.db);
    // Holds that are due count as available in this run.
    await releaseDueHolds(deps.db, { asOf: now, holdDays: payoutRules.holdDays, currency });
    const month = payoutMonth(periodEnd);
    return deps.db.transaction(async (tx) => {
      const r = await runPayoutBatch(tx, {
        periodStart: month.from,
        periodEnd: month.to,
        currency,
        minimumCents: payoutRules.minimumCents,
      });
      await audit(tx, {
        actorType: "admin",
        actorId: caller.user.id,
        action: "payout.run",
        subjectType: "payout_run",
        subjectId: payoutRunSubject(periodEnd, currency),
        details: {
          periodStart: month.from.toISOString(),
          periodEnd: month.to.toISOString(),
          created: r.created,
          held: r.held,
          totalCents: r.totalCents,
          currency,
        },
      });
      return { created: r.created, held: r.held, total: money(r.totalCents, currency) };
    });
  }),

  payouts: os.money.treasurer.payouts.handler(async ({ context, input }) => {
    const { db } = context.deps;
    // uuidv7 ids are time-ordered and unique, so the id alone is an exact keyset.
    const cur = decodeCursor(input.cursor, isIdCursor);
    const rows = await db
      .select({ p: payouts, u: { id: users.id, username: users.username, name: users.name } })
      .from(payouts)
      .innerJoin(users, eq(users.id, payouts.userId))
      .where(and(input.status ? eq(payouts.status, input.status) : undefined, cur ? lt(payouts.id, cur.id) : undefined))
      .orderBy(desc(payouts.id))
      .limit(input.limit + 1);
    return pageOf(
      rows,
      input.limit,
      ({ p, u }) => ({
        ...payoutDto(p),
        user: { id: u.id, username: u.username, displayName: u.name },
        reference: p.providerRef,
        createdAt: p.createdAt.toISOString(),
      }),
      ({ p }) => encodeCursor({ id: p.id }),
    );
  }),

  markPaid: os.money.treasurer.markPaid.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    const { deps } = context;
    const reference = input.reference.trim();
    if (!reference) throw badRequest("A payout reference is required");
    const [row] = await deps.db.select().from(payouts).where(eq(payouts.id, input.id));
    if (!row) throw notFound("Payout not found");
    if (row.status !== "pending") throw conflict(`This payout is ${row.status}`);
    const now = deps.now();
    await deps.db.transaction(async (tx) => {
      let created: boolean;
      try {
        // Locks the payout row and re-checks its state; a second call finds it posted.
        ({ created } = await postPayout(tx, { payoutId: row.id, paidAt: now, providerRef: reference }));
      } catch (err) {
        if (err instanceof PayoutStateError) throw conflict("This payout is no longer pending");
        throw err;
      }
      if (!created) throw conflict("This payout was already marked paid");
      await audit(tx, {
        actorType: "admin",
        actorId: caller.user.id,
        action: "payout.paid",
        subjectType: "payout",
        subjectId: row.id,
        details: { userId: row.userId, amountCents: row.amountCents, currency: row.currency },
      });
    });
    return { ok: true as const };
  }),

  recordCost: os.money.treasurer.recordCost.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    const { deps } = context;
    const category = input.category.trim();
    if (!isCategorySlug(category)) {
      throw badRequest("The category must be a lowercase slug (letters, digits, dashes)");
    }
    if (isReservedCostCategory(category)) throw badRequest("This category is reserved for the co-op's own bookings");
    const periodStart = new Date(input.periodStart);
    const periodEnd = new Date(input.periodEnd);
    if (!(periodStart < periodEnd)) throw badRequest("periodStart must be before periodEnd");
    const now = deps.now();
    if (periodStart > now) throw badRequest("periodStart cannot be in the future");
    const currency = deps.env.CURRENCY;
    const id = uuidv7(now.getTime());
    await deps.db.transaction(async (tx) => {
      // The cost is booked in the period it belongs to; the treasury pays it (manual cash),
      // whatever adapter collects payments. The description stays in infra_costs only.
      const r = await post(
        tx,
        infrastructureCost({
          infraCostId: id,
          category,
          provider: "manual",
          amountCents: input.amountCents,
          currency,
          occurredAt: periodStart,
        }),
      );
      await tx.insert(infraCosts).values({
        id,
        periodStart,
        periodEnd,
        category,
        description: input.description.trim(),
        amountCents: input.amountCents,
        currency,
        recordedBy: caller.user.id,
        ledgerTransactionId: r.transactionId,
      });
      await audit(tx, {
        actorType: "admin",
        actorId: caller.user.id,
        action: "cost.record",
        subjectType: "infra_cost",
        subjectId: id,
        details: { category, amountCents: input.amountCents, currency },
      });
    });
    return { ok: true as const };
  }),
};

// Transparency -------------------------------------------------------------------------------

type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
type MemberClass = (typeof MEMBER_CLASSES)[number];
type DeliverySource = (typeof DELIVERY_SOURCES)[number];

async function transparency(deps: Deps, months: number) {
  const { db } = deps;
  const currency = deps.env.CURRENCY;
  const now = deps.now();
  const to = addMonths(now, 1);
  const from = addMonths(monthStart(now), -(months - 1));
  const range = { from: from.toISOString(), to: to.toISOString() };

  const [aggregates, egress, decided, members] = await Promise.all([
    monthlyAggregates(db, { from, to, currency }),
    db.execute<{ month: string; source: DeliverySource; bytes: string }>(sql`
      select to_char(date_trunc('month', bucket_start at time zone 'UTC'), 'YYYY-MM') as month, source,
             sum(bytes)::text as bytes
      from egress_samples
      where bucket_start >= ${range.from}::timestamptz and bucket_start < ${range.to}::timestamptz
      group by 1, 2`),
    db.execute<{ month: string; id: string; title: string; status: ProposalStatus; decided_at: string | Date }>(sql`
      select to_char(decided_at at time zone 'UTC', 'YYYY-MM') as month, id, title, status, decided_at
      from proposals
      where decided_at >= ${range.from}::timestamptz and decided_at < ${range.to}::timestamptz
      order by decided_at, id`),
    // Members per class at each month end (the end is exclusive: joined before, not gone by then).
    db.execute<{ month: string; class: MemberClass; n: string }>(sql`
      with months as (
        select g.m as start, (g.m + interval '1 month') at time zone 'UTC' as month_end
        from generate_series((${range.from}::timestamptz at time zone 'UTC'),
                             (${range.to}::timestamptz at time zone 'UTC') - interval '1 month',
                             interval '1 month') as g(m)
      )
      select to_char(months.start, 'YYYY-MM') as month, ms.class, count(*)::text as n
      from months join memberships ms
        on ms.joined_at < months.month_end
       and (ms.exited_at is null or ms.exited_at >= months.month_end)
       and (ms.lapsed_at is null or ms.lapsed_at >= months.month_end)
      group by 1, 2`),
  ]);

  return aggregates
    .map((m) => {
      const costs = new Map<string, number>();
      for (const c of m.costs)
        costs.set(costCategory(c.category), (costs.get(costCategory(c.category)) ?? 0) + c.cents);
      const egressBySource = Object.fromEntries(DELIVERY_SOURCES.map((s) => [s, 0])) as Record<DeliverySource, number>;
      for (const e of egress) if (e.month === m.month) egressBySource[e.source] += num(e.bytes);
      const memberCounts = Object.fromEntries(MEMBER_CLASSES.map((c) => [c, 0])) as Record<MemberClass, number>;
      for (const r of members) if (r.month === m.month) memberCounts[r.class] += num(r.n);
      return {
        month: m.month,
        revenue: money(m.revenueCents, currency),
        streamerPayouts: money(m.streamerPayoutsCents, currency),
        coopRetained: money(m.platformCutCents, currency),
        costs: [...costs].map(([category, cents]) => ({ category, amount: money(cents, currency) })),
        surplus: money(m.surplusCents, currency),
        patronageDistributed: money(m.patronageDistributedCents, currency),
        egressBySource,
        governance: [...decided]
          .filter((d) => d.month === m.month)
          .map((d) => ({
            proposalId: d.id,
            title: d.title,
            status: d.status,
            decidedAt: new Date(d.decided_at).toISOString(),
          })),
        members: memberCounts,
      };
    })
    .reverse();
}

/** Public and identical for every viewer (no caller-specific data), so it can be cached. */
export const transparencyHandler = os.coop.transparency.handler(async ({ context, input }) =>
  transparency(context.deps, input.months),
);
