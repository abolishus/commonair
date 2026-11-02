// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MONEY_LIMITS } from "@commonair/contracts/currency";
import { PAYMENT_FRAUD_RULES } from "@commonair/contracts/enums";
import { describe, expect, test } from "vite-plus/test";
import { expectedFigures, splitPayment } from "../../src/money.ts";
import { FIXED_ACCOUNTS, bulkStreamerHandle, bulkViewerHandle } from "../../src/seed/accounts.ts";
import { unit } from "../../src/seed/money.ts";
import { pool } from "../../src/seed/money/api.ts";
import { TIP_MESSAGES } from "../../src/seed/money/content.ts";
import {
  BASE,
  CREW,
  DAY_MS,
  LAPSE_MIN_AGE_DAYS,
  MAX_PAYMENTS_PER_PAYER,
  MIN_PAYER_AGE_DAYS,
  PAYER_SLACK,
  PAYOUT_CLOCK_MARGIN_MS,
  PAYOUT_PERIOD_END_LAG_MS,
  type MoneyAccount,
  type MoneyPlan,
  type PaymentSpec,
  SUPPORTER,
  VELOCITY_TIPS,
  fraudExposure,
  monthStart,
  paidCreators,
  paymentFigures,
  payoutRunWaitMs,
  planCosts,
  planMoney,
  plannedCounts,
  subscriptionStatus,
  subscriptionsByUser,
} from "../../src/seed/money/plan.ts";
import { createRng } from "../../src/seed/prng.ts";
import { SEED_SCALES, type SeedScale } from "../../src/seed/scale.ts";

const NOW = new Date("2026-11-01T12:00:00.000Z");
const PRICES = [500, 1_000, 2_500] as const;
const CUT = { streamerShare: 0.9, coopShare: 0.1 };
const small = SEED_SCALES.small;

/** Accounts shaped like seed-social's: fixed ones `historyDays` old, 80 % of bulk ones over 31 days. */
function accounts(scale: SeedScale): { accounts: MoneyAccount[]; streamers: string[] } {
  const ago = (days: number) => new Date(NOW.getTime() - days * DAY_MS);
  const out: MoneyAccount[] = FIXED_ACCOUNTS.map((a) => ({
    handle: a.handle,
    kind: a.bot ? "bot" : "fixed",
    createdAt: ago(scale.historyDays),
  }));
  for (let i = 1; i <= scale.streamers; i++)
    out.push({ handle: bulkStreamerHandle(i), kind: "bulk-streamer", createdAt: ago(40 + (i % 30)) });
  for (let i = 1; i <= scale.viewers; i++)
    out.push({
      handle: bulkViewerHandle(i),
      kind: "bulk-viewer",
      createdAt: ago(i % 5 === 0 ? 3 + (i % 27) : 35 + (i % 50)),
    });
  const streamers = [
    ...FIXED_ACCOUNTS.filter((a) => a.streamer).map((a) => a.handle),
    ...Array.from({ length: scale.streamers }, (_, i) => bulkStreamerHandle(i + 1)),
  ];
  return { accounts: out, streamers };
}

const plan = (seed = 7, scale: SeedScale = small, banned?: Set<string>): MoneyPlan => {
  const a = accounts(scale);
  return planMoney(createRng(seed).fork("money"), scale, NOW, {
    ...a,
    banned,
    tierPrices: PRICES,
    currency: "usd",
  });
};
const P = plan();
const A = accounts(small).accounts;
const of = (p: MoneyPlan, f: (x: MoneyPlan["payments"][number]) => boolean) => p.payments.filter(f);

describe("seed-money unit", () => {
  test("claims its stub's tables, runs after social, and leaves nothing pending", () => {
    expect(unit.name).toBe("money");
    expect(unit.after).toEqual(["social"]);
    // Payouts and the write-off come from the hold-release ops tick (OPS_TEST_HOOKS).
    expect(unit.pending).toEqual([]);
    expect(unit.tables).toEqual(expect.arrayContaining(["payouts", "split_writeoff_proposals"]));
    expect(unit.tables).toContain("revenue_split_postings");
  });
});

describe("planMoney: determinism and scale", () => {
  test("the same seed and scale give the same specs", () => {
    expect(JSON.stringify(plan(7))).toBe(JSON.stringify(P));
  });

  test("a different seed gives different content but the same counts", () => {
    const other = plan(8);
    expect(JSON.stringify(other.payments)).not.toBe(JSON.stringify(P.payments));
    expect(plannedCounts(other)).toEqual(plannedCounts(P));
  });

  test("bulk counts are the base counts times the factor", () => {
    for (const scale of [small, SEED_SCALES.medium]) {
      const p = plan(7, scale);
      const bulk = of(p, (x) => x.payer !== SUPPORTER && !x.velocity);
      const f = scale.factor;
      const subs = BASE.subs + BASE.pendingSubs + BASE.abandonedSubs + 2 * BASE.reversals;
      const tips = BASE.tips + BASE.pendingTips + BASE.abandonedTips + 4 * BASE.reversals;
      expect(bulk.filter((x) => x.kind === "sub")).toHaveLength(subs * f);
      expect(bulk.filter((x) => x.kind === "gift")).toHaveLength(BASE.gifts * f);
      expect(bulk.filter((x) => x.kind === "tip")).toHaveLength(tips * f);
      expect(p.flags).toHaveLength(2);
    }
  });

  test("the largest preset plans without writing, inside every rule", () => {
    const large = SEED_SCALES.large;
    const a = accounts(large);
    const p = plan(7, large);
    expect(p.payments.length).toBeGreaterThan(5_000);
    expect(fraudExposure(p, a.accounts, NOW)).toEqual({ velocity: [p.velocity?.payee], concentration: [] });
    expect(p.costs).toHaveLength(Math.ceil(large.historyDays / 30) * 5);
  });

  test("zero bulk accounts: the fixed logins still get their rows, fraud flags fall back to fixed streamers", () => {
    const none: SeedScale = { ...small, streamers: 0, viewers: 0 };
    const p = plan(7, none);
    expect(p.velocity).toBeNull();
    expect(of(p, (x) => x.payer === SUPPORTER).length).toBeGreaterThan(5);
    expect(p.flags.map((f) => f.payee)).toEqual(["council2", "council1"]);
    // viewer2 is the only other payer, capped like any bulk payer.
    expect(new Set(p.payments.map((x) => x.payer))).toEqual(new Set([SUPPORTER, "viewer2"]));
    expect(of(p, (x) => x.payer === "viewer2").length).toBeLessThanOrEqual(MAX_PAYMENTS_PER_PAYER);
  });
});

describe("planMoney: the fixed logins", () => {
  const mine = of(P, (x) => x.payer === SUPPORTER);

  test("viewer1 subscribes at all three tiers, gifts one, tips several, and sees every lifecycle", () => {
    const subs = mine.filter((x) => x.kind === "sub");
    expect(new Set(subs.map((x) => x.tier))).toEqual(new Set([1, 2, 3]));
    expect(mine.filter((x) => x.kind === "gift")).toHaveLength(1);
    expect(mine.filter((x) => x.kind === "tip").length).toBeGreaterThanOrEqual(3);
    expect(new Set(subs.map(subscriptionStatus))).toEqual(new Set(["active", "past_due", "expired"]));
    expect(subs.some((x) => x.lifecycle === "cancel_at_period_end")).toBe(true);
    expect(mine.filter((x) => x.settle === "paid").length).toBeLessThanOrEqual(PAYMENT_FRAUD_RULES.velocityMaxPayments);
  });

  test("streamer2 receives subs and tips from many payers; streamer3 stays without revenue", () => {
    const s2 = of(P, (x) => x.payee === "streamer2" && x.settle === "paid");
    expect(s2.some((x) => x.kind === "sub")).toBe(true);
    expect(s2.filter((x) => x.kind === "tip").length).toBeGreaterThanOrEqual(3);
    expect(new Set(s2.map((x) => x.payer)).size).toBeGreaterThan(3);
    expect(of(P, (x) => x.payee === "streamer3" && x.settle === "paid")).toHaveLength(0);
    expect(paidCreators(P)).toEqual(expect.arrayContaining(["streamer1", "streamer2", "council1", "council2"]));
    expect(paidCreators(P)).not.toContain("streamer3");
  });

  test("payout accounts: streamer1 ready, streamer2 held, the crew recipient has one", () => {
    const acct = new Map(P.payoutAccounts.map((a) => [a.handle, a.enabled]));
    expect(acct.get("streamer1")).toBe(true);
    expect(acct.get("streamer2")).toBe(false);
    for (const s of P.splits) for (const c of s.crew) expect(acct.get(c.handle)).toBe(true);
  });

  test("streamer1's split with the crew is accepted, streamer2's stays proposed", () => {
    expect(P.splits).toEqual([
      { owner: "streamer1", basis: "all", crew: [{ handle: CREW, bps: 2_000 }], accept: true },
      { owner: "streamer2", basis: "tips", crew: [{ handle: CREW, bps: 1_500 }], accept: false },
    ]);
  });

  test("the treasurer has pending checkouts to confirm, costs and flags to decide", () => {
    expect(of(P, (x) => x.settle === "pending").length).toBe(BASE.pendingSubs + BASE.pendingTips);
    expect(P.costs.length).toBeGreaterThan(0);
    expect(P.flags.map((f) => f.decision)).toEqual(["confirm", "clear"]);
    expect(P.velocity).not.toBeNull();
  });
});

describe("planMoney: states", () => {
  test("every subscription state appears at small", () => {
    const subs = of(P, (x) => x.kind === "sub");
    expect(new Set(subs.map(subscriptionStatus))).toEqual(
      new Set(["incomplete", "active", "past_due", "canceled", "expired"]),
    );
    expect(subs.some((x) => x.lifecycle === "cancel_at_period_end" && subscriptionStatus(x) === "active")).toBe(true);
  });

  test("refunds full and partial, and chargebacks open, won and lost, at small", () => {
    const r = P.payments.flatMap((x) => (x.reversal ? [{ x, r: x.reversal }] : []));
    expect(r.some(({ x, r: v }) => v.kind === "refund" && v.cents === x.cents && x.kind === "sub")).toBe(true);
    expect(r.some(({ x, r: v }) => v.kind === "refund" && v.cents === x.cents && x.kind === "tip")).toBe(true);
    expect(r.some(({ x, r: v }) => v.kind === "refund" && v.cents < x.cents)).toBe(true);
    const outcomes = r.flatMap(({ r: v }) => (v.kind === "chargeback" ? [v.outcome] : []));
    expect(new Set(outcomes)).toEqual(new Set(["open", "won", "lost"]));
    for (const { x } of r) expect(x.settle).toBe("paid");
  });
});

describe("planMoney: the split write-off", () => {
  test("a paid streamer1 tip under the accepted all-revenue split is charged back (lost) for the write-off", () => {
    expect(P.writeOff).not.toBeNull();
    const w = P.writeOff!;
    expect(w.owner).toBe("streamer1");
    const spec = P.payments.find((x) => x.key === w.key)!;
    expect(spec).toMatchObject({ payee: "streamer1", kind: "tip", settle: "paid", lifecycle: "none", velocity: false });
    expect(spec.reversal).toEqual({ kind: "chargeback", outcome: "lost", reason: expect.any(String) });
    const split = P.splits.find((x) => x.owner === w.owner)!;
    expect(split).toMatchObject({ accept: true, basis: "all" });
    // The crew's slice is what the owner cannot cover once its earnings are reserved: never zero.
    const fig = paymentFigures(P, CUT).find((f) => f.key === w.key)!;
    expect(fig.shares.find((x) => x.role === "crew")!.creatorCents).toBeGreaterThan(0);
    // The owner clears the payout minimum (2500 by default), so the run reserves its earnings
    // before the chargeback and the crew's slice cannot come out of them.
    const keep = new Set(P.payments.filter((x) => x.payee === w.owner && x.reversal === null).map((x) => x.key));
    const owned = paymentFigures(P, CUT)
      .filter((f) => keep.has(f.key))
      .reduce((n, f) => n + (f.shares.find((x) => x.role === "owner")?.creatorCents ?? 0), 0);
    expect(owned).toBeGreaterThanOrEqual(2_500);
  });

  test("exactly one write-off chargeback, counted among the disputes", () => {
    for (const seed of [1, 2, 3]) {
      const p = plan(seed);
      expect(p.writeOff).not.toBeNull();
      expect(plannedCounts(p).disputes).toBe(p.payments.filter((x) => x.reversal !== null).length);
    }
  });

  test("no accepted split (no crew account), no write-off", () => {
    const a = accounts(small);
    const p = planMoney(createRng(7).fork("money"), small, NOW, {
      accounts: a.accounts.filter((x) => x.handle !== CREW),
      streamers: a.streamers,
      tierPrices: PRICES,
      currency: "usd",
    });
    expect(p.splits).toEqual([]);
    expect(p.writeOff).toBeNull();
  });
});

describe("payoutRunWaitMs", () => {
  const lag = PAYOUT_PERIOD_END_LAG_MS + PAYOUT_CLOCK_MARGIN_MS;
  test("right after the last checkout, waits until the run's periodEnd (now - 5 s) is past it, with a margin", () => {
    const settled = 1_000_000;
    expect(payoutRunWaitMs(settled, settled)).toBe(lag);
    expect(payoutRunWaitMs(settled, settled + 1_200)).toBe(lag - 1_200);
    // After the wait the run's periodEnd is after the last posting.
    const runAt = settled + payoutRunWaitMs(settled, settled);
    expect(runAt - PAYOUT_PERIOD_END_LAG_MS).toBeGreaterThan(settled);
  });

  test("no wait once enough time has passed", () => {
    expect(payoutRunWaitMs(0, lag)).toBe(0);
    expect(payoutRunWaitMs(0, lag + 60_000)).toBe(0);
  });
});

describe("planMoney: money is integer cents in an explicit currency", () => {
  const all = [P, plan(7, SEED_SCALES.medium)].flatMap((p) => p.payments);

  test("every amount is a positive integer of cents within the API's limits", () => {
    for (const x of all) {
      expect(Number.isSafeInteger(x.cents)).toBe(true);
      expect(x.cents).toBeGreaterThanOrEqual(MONEY_LIMITS.tipMinCents);
      expect(x.currency).toBe("usd");
      expect(x.message.length).toBeLessThanOrEqual(MONEY_LIMITS.tipMessageMaxLength);
    }
    for (const x of all.filter((y) => y.kind === "tip")) expect(x.cents).toBeLessThanOrEqual(MONEY_LIMITS.tipMaxCents);
    for (const x of all.filter((y) => y.kind !== "tip")) expect(x.cents).toBe(PRICES[(x.tier ?? 1) - 1]);
    const refunds = all.flatMap((x) =>
      x.reversal?.kind === "refund" ? [{ cents: x.cents, back: x.reversal.cents }] : [],
    );
    expect(refunds.length).toBeGreaterThan(0);
    for (const r of refunds) {
      expect(Number.isSafeInteger(r.back)).toBe(true);
      expect(r.back).toBeGreaterThanOrEqual(MONEY_LIMITS.tipMinCents);
      expect(r.back).toBeLessThanOrEqual(r.cents);
    }
  });

  test("a bad currency or tier price is refused", () => {
    const a = accounts(small);
    const run = (currency: string, prices: readonly [number, number, number]) =>
      planMoney(createRng(1), small, NOW, { ...a, currency, tierPrices: prices });
    expect(() => run("USD", PRICES)).toThrow(RangeError);
    expect(() => run("usd", [500, 10.5, 2_500])).toThrow(RangeError);
    expect(() => run("usd", [50, 1_000, 2_500])).toThrow(RangeError);
  });

  test("planned figures match splitPayment and expectedFigures for every paid payment", () => {
    const figures = paymentFigures(P, CUT);
    expect(figures).toHaveLength(of(P, (x) => x.settle === "paid").length);
    for (const f of figures) {
      expect(f.split).toEqual(splitPayment(f.grossCents, 0, CUT));
      expect(f.split.creatorCents + f.split.coopCents + f.split.taxCents).toBe(f.grossCents);
      const e = expectedFigures({
        tierPrices: PRICES,
        cut: CUT,
        subTier: 1,
        giftTier: 1,
        giftCount: 1,
        tipCents: f.grossCents,
      });
      expect(f.split).toEqual(e.tip.split);
    }
  });

  test("split payments divide by the accepted shares in integer cents", () => {
    const figures = paymentFigures(P, CUT);
    const s1 = figures.filter((f) => f.payee === "streamer1");
    expect(s1.length).toBeGreaterThan(0);
    for (const f of figures) {
      const sum = f.shares.reduce((s, x) => s + x.creatorCents, 0);
      expect(sum).toBe(f.split.creatorCents);
      for (const s of f.shares) expect(Number.isSafeInteger(s.creatorCents)).toBe(true);
    }
    for (const f of figures.filter((x) => x.payee !== "streamer1"))
      expect(f.shares).toEqual([{ handle: f.payee, role: "owner", bps: 10_000, creatorCents: f.split.creatorCents }]);
    for (const f of s1) {
      const crew = f.shares.find((s) => s.role === "crew");
      expect(crew?.handle).toBe(CREW);
      expect(crew?.bps).toBe(2_000);
      const exact = (f.split.creatorCents * 2_000) / 10_000;
      expect(crew?.creatorCents).toBeGreaterThanOrEqual(Math.floor(exact));
      expect(crew?.creatorCents).toBeLessThanOrEqual(Math.ceil(exact));
    }
  });
});

describe("planMoney: the fraud floor", () => {
  test("only the velocity payee is exposed, at every preset", () => {
    for (const scale of [small, SEED_SCALES.medium, SEED_SCALES.large]) {
      const p = plan(7, scale);
      expect(fraudExposure(p, accounts(scale).accounts, NOW)).toEqual({
        velocity: [p.velocity?.payee],
        concentration: [],
      });
    }
  });

  test("the velocity payer pays one payee one over the rule and nothing else", () => {
    const v = P.velocity;
    if (!v) throw new Error("no velocity payer");
    const theirs = of(P, (x) => x.payer === v.payer);
    expect(theirs).toHaveLength(VELOCITY_TIPS);
    expect(theirs.every((x) => x.velocity && x.payee === v.payee && x.kind === "tip")).toBe(true);
    expect(VELOCITY_TIPS).toBe(PAYMENT_FRAUD_RULES.velocityMaxPayments + 1);
    expect(P.flags.map((f) => f.payee)).not.toContain(v.payee);
  });

  test("every bulk payer stays under the cap and is older than a new payer", () => {
    const counts = new Map<string, number>();
    for (const x of P.payments) if (!x.velocity) counts.set(x.payer, (counts.get(x.payer) ?? 0) + 1);
    const created = new Map(A.map((a) => [a.handle, a.createdAt.getTime()]));
    for (const [payer, n] of [...counts].filter(([h]) => h !== SUPPORTER))
      expect(n, payer).toBeLessThanOrEqual(MAX_PAYMENTS_PER_PAYER);
    for (const payer of counts.keys())
      expect(NOW.getTime() - (created.get(payer) ?? 0)).toBeGreaterThanOrEqual(MIN_PAYER_AGE_DAYS * DAY_MS);
  });

  test("few distinct payers sign in (sign-ins are rate limited per address)", () => {
    for (const scale of [small, SEED_SCALES.medium]) {
      const p = plan(7, scale);
      const bulk = of(p, (x) => x.payer !== SUPPORTER && !x.velocity);
      const payers = new Set(bulk.map((x) => x.payer));
      expect(payers.size).toBeLessThanOrEqual(Math.ceil((bulk.length / MAX_PAYMENTS_PER_PAYER) * PAYER_SLACK) + 3);
    }
  });

  test("the exposure check counts anonymous tips toward a payer's share, as the scan does", () => {
    const p = plan();
    const payee = "s0003";
    const heavy: PaymentSpec = {
      ...p.payments[0]!,
      key: "x",
      payer: "v00001",
      payee,
      kind: "tip",
      tier: null,
      cents: PAYMENT_FRAUD_RULES.concentrationMinGrossCents,
      settle: "paid",
      anonymous: true,
      velocity: false,
    };
    expect(fraudExposure({ payments: [...p.payments, heavy] }, A, NOW).concentration).toContain(payee);
  });

  test("the exposure check does see a concentrated payee", () => {
    const p = plan();
    const payee = "s0003";
    const heavy: PaymentSpec = {
      ...p.payments[0]!,
      key: "x",
      payer: "v00001",
      payee,
      kind: "tip",
      tier: null,
      cents: PAYMENT_FRAUD_RULES.concentrationMinGrossCents,
      settle: "paid",
      anonymous: false,
      velocity: false,
    };
    const exposed = fraudExposure({ payments: [...p.payments, heavy] }, A, NOW);
    expect(exposed.concentration).toContain(payee);
  });
});

describe("planMoney: subscriptions and gifts", () => {
  test("every lapsing subscriber is older than the month a lapse moves the period back", () => {
    for (const scale of [small, SEED_SCALES.medium, SEED_SCALES.large])
      for (const seed of [1, 2, 3, 7, 42]) {
        const p = plan(seed, scale);
        const created = new Map(accounts(scale).accounts.map((a) => [a.handle, a.createdAt.getTime()]));
        const lapsing = of(p, (x) => x.lifecycle === "lapse");
        expect(lapsing.length).toBeGreaterThan(0);
        for (const x of lapsing)
          expect(NOW.getTime() - (created.get(x.payer) ?? NOW.getTime()), x.payer).toBeGreaterThanOrEqual(
            LAPSE_MIN_AGE_DAYS * DAY_MS,
          );
      }
  });

  test("a young payer pool yields fewer lapses rather than lapses that predate the account", () => {
    const a = accounts(small);
    // Every bulk viewer between the payer floor and a month old.
    const young = a.accounts.map((x) =>
      x.kind === "bulk-viewer" ? { ...x, createdAt: new Date(NOW.getTime() - (MIN_PAYER_AGE_DAYS + 5) * DAY_MS) } : x,
    );
    const p = planMoney(createRng(7).fork("money"), small, NOW, {
      accounts: young,
      streamers: a.streamers,
      tierPrices: PRICES,
      currency: "usd",
    });
    const lapsing = of(p, (x) => x.lifecycle === "lapse");
    const created = new Map(young.map((x) => [x.handle, x]));
    expect(lapsing.length).toBeGreaterThan(0);
    for (const x of lapsing) {
      expect(created.get(x.payer)?.kind, x.payer).not.toBe("bulk-viewer");
      expect(NOW.getTime() - (created.get(x.payer)?.createdAt.getTime() ?? NOW.getTime())).toBeGreaterThanOrEqual(
        LAPSE_MIN_AGE_DAYS * DAY_MS,
      );
    }
  });

  test("one subscription per subscriber and channel, gifts never to the gifter or the owner", () => {
    const pairs = new Set<string>();
    for (const x of P.payments) {
      if (x.kind === "tip") continue;
      const who = x.kind === "gift" ? x.giftTo : x.payer;
      expect(who).not.toBeNull();
      expect(who).not.toBe(x.payee);
      const k = `${who}\0${x.payee}`;
      expect(pairs.has(k)).toBe(false);
      pairs.add(k);
    }
    const gifts = P.payments.filter((x) => x.kind === "gift");
    expect(gifts.length).toBeGreaterThan(0);
    for (const x of gifts) expect(x.giftTo).not.toBe(x.payer);
  });

  test("a recipient banned in the channel never gets a gift there", () => {
    const base = plan();
    const banned = new Set(base.payments.filter((x) => x.kind === "gift").map((x) => `${x.payee}\0${x.giftTo}`));
    const p = plan(7, small, banned);
    for (const x of p.payments.filter((y) => y.kind === "gift"))
      expect(banned.has(`${x.payee}\0${x.giftTo}`)).toBe(false);
  });

  test("subscriptionsByUser agrees with the plan", () => {
    const slug = (h: string) => `demo_${h}`;
    const byUser = subscriptionsByUser(P, slug);
    const entries = Object.values(byUser).flat();
    expect(entries).toHaveLength(of(P, (x) => x.kind !== "tip").length);
    for (const x of P.payments.filter((y) => y.kind !== "tip")) {
      const who = (x.kind === "gift" ? x.giftTo : x.payer) ?? "";
      expect(byUser[who]).toContainEqual({ channelSlug: slug(x.payee), tier: x.tier, status: subscriptionStatus(x) });
    }
    expect((byUser[SUPPORTER] ?? []).map((e) => e.tier).sort((a, b) => a - b)).toEqual([1, 1, 2, 2, 3]);
  });
});

describe("planMoney: costs and text", () => {
  test("one month of costs per 30 days of history, never before the treasurer's account", () => {
    const created = new Date(NOW.getTime() - small.historyDays * DAY_MS);
    const costs = planCosts(createRng(3), small, NOW, created);
    const months = new Set(costs.map((c) => c.periodEnd.toISOString()));
    expect(months.size).toBe(Math.ceil(small.historyDays / 30));
    for (const c of costs) {
      expect(c.periodStart.getTime()).toBeGreaterThanOrEqual(created.getTime() + DAY_MS);
      expect(c.periodStart.getTime()).toBeLessThan(c.periodEnd.getTime());
      expect(c.periodStart.getTime()).toBeLessThanOrEqual(NOW.getTime());
      expect(Number.isSafeInteger(c.cents) && c.cents > 0).toBe(true);
      expect(c.category).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
    }
    expect(costs.at(-1)?.periodEnd).toEqual(monthStart(NOW, 1));
  });

  test("no personal text: tip messages come from the fixed list, reasons and notes are seed markers", () => {
    const allowed = new Set<string>(TIP_MESSAGES);
    for (const x of P.payments) expect(allowed.has(x.message)).toBe(true);
    const reasons = P.payments.flatMap((x) => (x.reversal ? [x.reversal.reason] : []));
    expect(reasons.length).toBeGreaterThan(0);
    for (const r of reasons) expect(r.startsWith("seed:")).toBe(true);
    expect(P.revenuePeriod).toBe("2026-11");
  });
});

describe("pool", () => {
  test("runs every item with bounded concurrency and rethrows the first failure", async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: number[] = [];
    await pool([1, 2, 3, 4, 5, 6], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      seen.push(n);
      inFlight--;
    });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(peak).toBe(2);
    await expect(
      pool([1, 2], 2, async (n) => {
        if (n === 2) throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
