// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Milestone E4b, money on the manual adapter (docs/testing/e4b-selectors.md, "The `e4b-money`
 * scenario"): a streamer sets three tiers; viewer A subscribes, gifts two subs to the channel's
 * community (B and C) and tips anonymously; the treasurer confirms each offline payment; chat
 * shows the events and A's subscriber badge; `/revenue` shows the creator shares inside the hold;
 * a refund and a chargeback claw them back exactly; a payout run pays nobody below the minimum;
 * `/transparency` shows the month; every ledger transaction behind it sums to zero.
 *
 * Every expected figure is computed from the tier prices set here and the `platform.cut` that
 * `money.support` reports, with the ledger's rounding rule (`src/money.ts`). `--set via=api`
 * drives the same steps through the API and the chat socket instead of the web app.
 */
import { join } from "node:path";
import type { ChatClient } from "../src/chat-client.ts";
import {
  ApiCreator,
  ApiPublic,
  ApiSupporter,
  ApiTreasurer,
  type ChatEventObserver,
  type Creator,
  type PublicReader,
  type RevenueView,
  SocketChatEvents,
  type Supporter,
  type SubscriptionView,
  type Treasurer,
  WebChatEvents,
  WebCreator,
  WebPublic,
  WebSupporter,
  WebTreasurer,
} from "../src/money-actors.ts";
import { grantRole, ledgerSums } from "../src/money-db.ts";
import {
  type RevenueExpectation,
  type ScenarioPlan,
  type Tier,
  expectedFigures,
  inconsistentLedgerRows,
  missingLedgerRows,
  monthlyShareCandidates,
  parseReference,
  parseVia,
  priceOf,
  sameFraction,
  sumNet,
  unbalancedTransactions,
  utcMonth,
} from "../src/money.ts";
import { playerBundles } from "../src/player-server.ts";
import { DEFAULT_REPORT_DIR } from "../src/report.ts";
import { defineScenario, type ScenarioContext } from "../src/scenario.ts";
import { ApiActor, type SocialActor, type WaitBudget, WebActor, remainingMs } from "../src/social.ts";
import type { SignedInUser } from "../src/users.ts";
import { waitFor } from "../src/wait.ts";
import { signInViaUi } from "../src/web/flows.ts";
import { ROUTES, TEST_IDS as T } from "../src/web/selectors.ts";
import { WebSession, byTestId } from "../src/web/session.ts";

const UI_TIMEOUT_MS = 20_000;
/** Chat is near real time; the badge needs the API's post-commit invalidate to land first. */
const CHAT_TIMEOUT_MS = 10_000;
const BADGE_TIMEOUT_MS = 20_000;
/** Ledger reads are synchronous with the confirm; this covers page loads and one retry. */
const SETTLE_TIMEOUT_MS = 20_000;
const ROLE_CLI_TIMEOUT_MS = 30_000;

/** Odd prices so the cut's floor is exercised (with 90/10: 499 → 449, 999 → 899, 998 → 898). */
const TIER_PRICES = [499, 999, 2499] as const;
const TIER_NAMES = ["Supporter", "Fan", "Patron"] as const;
const TIP_CENTS = 500;
const GIFT_COUNT = 2;

export default defineScenario({
  name: "e4b-money",
  description:
    "manual payments: tiers → subscribe, gift 2, anonymous tip, each confirmed by the treasurer → chat events and badge → /revenue figures (cut, hold) → refund + chargeback claw back exactly → payout run below the minimum → /transparency → ledger sums to zero",
  needs: ["api", "web", "chat", "worker", "mail", "browser"],
  inFull: true,
  timeoutMs: 10 * 60_000,
  async run(ctx) {
    const sessions: WebSession[] = [];
    const state = { finished: false, softFailed: false };
    ctx.defer(async () => {
      if (!state.finished || state.softFailed) await screenshotSessions(ctx, sessions);
      await Promise.allSettled(sessions.map((s) => s.close()));
    });
    const check: ScenarioContext["check"] = (name, condition, details) => {
      if (!condition) state.softFailed = true;
      return ctx.check(name, condition, details);
    };
    await e4bMoney(ctx, sessions, check);
    state.finished = true;
  },
});

async function screenshotSessions(ctx: ScenarioContext, sessions: readonly WebSession[]): Promise<void> {
  const dir = join(ctx.env.HARNESS_REPORT_DIR ?? DEFAULT_REPORT_DIR, `${ctx.runId}-${ctx.name}`);
  const files = (await Promise.all(sessions.map((s) => s.screenshotAll(dir)))).flat();
  if (files.length > 0) ctx.data("screenshots", files);
}

/** Poll `read` until `done`; on timeout return the last value so the assertions report it. */
async function settle<V>(what: string, read: () => Promise<V>, done: (v: V) => boolean, b: WaitBudget): Promise<V> {
  let last: { v: V } | null = null;
  try {
    return await waitFor(
      what,
      async () => {
        const v = await read();
        last = { v };
        return done(v) ? v : null;
      },
      { timeoutMs: b.timeoutMs, intervalMs: 1_000, signal: b.signal },
    );
  } catch (err) {
    const seen = last as { v: V } | null;
    if (seen && !b.signal.aborted) return seen.v;
    throw err;
  }
}

interface Person {
  user: SignedInUser;
  social: SocialActor;
  supporter: Supporter;
}

async function e4bMoney(ctx: ScenarioContext, sessions: WebSession[], check: ScenarioContext["check"]): Promise<void> {
  const p = ctx.platform;
  const signal = ctx.signal;
  const via = parseVia(ctx.param("via", "web"));
  ctx.data("via", via);
  const ui: WaitBudget = { timeoutMs: UI_TIMEOUT_MS, signal };
  const chat: WaitBudget = { timeoutMs: CHAT_TIMEOUT_MS, signal };
  const slow: WaitBudget = { timeoutMs: SETTLE_TIMEOUT_MS, signal };

  const databaseUrl = ctx.env.DATABASE_URL;
  ctx.assert(
    "DATABASE_URL is set (the treasurer role is granted with the operator CLI; run from the repo root so Bun loads .env)",
    databaseUrl !== undefined,
  );
  if (databaseUrl === undefined) return;

  // ------------------------------------------------------------ 1. setup
  const [streamer, treasurerAccount, a, b, c] = await ctx.step(
    "sign up streamer, treasurer and viewers A, B, C (API)",
    () =>
      Promise.all([
        p.signUp({ prefix: "e4b_st" }),
        p.signUp({ prefix: "e4b_tr" }),
        p.signUp({ prefix: "e4b_a" }),
        p.signUp({ prefix: "e4b_b" }),
        p.signUp({ prefix: "e4b_c" }),
      ]),
  );
  const channel = streamer.me.channelSlug ?? streamer.username;
  ctx.data("users", {
    streamer: streamer.username,
    treasurer: treasurerAccount.username,
    a: a.username,
    b: b.username,
    c: c.username,
  });

  const before = await ctx.step("money.support: provider and cut", () =>
    streamer.api.client.money.support({ channel }),
  );
  ctx.assert(
    "PAYMENTS_PROVIDER is manual (this scenario covers the manual adapter; Stripe runs against stripe-mock elsewhere)",
    before.provider === "manual",
    { provider: before.provider },
  );
  ctx.assert("a new channel has no tiers yet", before.tiers.length === 0, { tiers: before.tiers.length });
  const currency = before.currency;
  const plan: ScenarioPlan = {
    tierPrices: TIER_PRICES,
    cut: before.split,
    subTier: 2,
    giftTier: 1,
    giftCount: GIFT_COUNT,
    tipCents: TIP_CENTS,
  };
  const expected = expectedFigures(plan);
  ctx.data("money.plan", { ...plan, currency });
  ctx.data("money.expected", expected);

  await ctx.step("grant the treasurer role (operator CLI)", () =>
    grantRole(databaseUrl, treasurerAccount.username, "treasurer", ROLE_CLI_TIMEOUT_MS),
  );
  const treasurerUser = await ctx.step("treasurer: sign in again (API) to pick up the role", () =>
    p.users.signIn(treasurerAccount),
  );
  await ctx.step("treasurer: treasurer.payments is allowed", () =>
    treasurerUser.api.client.money.treasurer.payments({ limit: 1 }),
  );

  const month = utcMonth();
  const publicApi = new ApiPublic(streamer.api.client);
  const baseline = await ctx.step("transparency baseline for this month (API)", () => publicApi.transparency(month));
  ctx.data("transparency.baseline", baseline);

  // People, through the web app or the API.
  const { probe } = via === "web" ? await playerBundles() : { probe: "" };
  const webSession = async (who: string, user: SignedInUser): Promise<WebSession> => {
    const session = await WebSession.open({
      fleet: p.fleet,
      engine: "chromium",
      webUrl: ctx.env.HARNESS_WEB_URL,
      probeScript: probe,
      label: who,
      log: ctx.log,
    });
    sessions.push(session);
    await ctx.step(`${who}: sign in through the web UI`, async () => {
      const page = await session.goto(ROUTES.signin);
      await signInViaUi(page, user, UI_TIMEOUT_MS, signal);
      await byTestId(page, T.navUser, { username: user.username }).waitFor({ timeout: UI_TIMEOUT_MS });
    });
    return session;
  };
  const person = async (who: string, user: SignedInUser): Promise<Person> => {
    if (via === "api") {
      const social = new ApiActor(who, user.username, user.id, user.api.client, () => p.chat(user));
      ctx.defer(() => social.close());
      return { user, social, supporter: new ApiSupporter(who, user.api.client) };
    }
    const session = await webSession(who, user);
    const open = (path: string) => session.goto(path);
    return { user, social: new WebActor(who, user.username, open), supporter: new WebSupporter(who, open, currency) };
  };

  let creator: Creator;
  let treasurer: Treasurer;
  let publicReader: PublicReader;
  let events: ChatEventObserver;
  // An anonymous socket in the channel sees every message frame with its badges, on both paths.
  const observer: ChatClient = await ctx.step("anonymous chat observer joins the channel", async () => {
    const o = await p.chat();
    await o.join(channel);
    return o;
  });
  ctx.defer(() => observer.close());
  if (via === "api") {
    creator = new ApiCreator(streamer.api.client);
    treasurer = new ApiTreasurer(treasurerUser.api.client);
    publicReader = publicApi;
    events = new SocketChatEvents(() => observer, channel);
  } else {
    const s = await webSession("streamer", streamer);
    creator = new WebCreator((path) => s.goto(path));
    publicReader = new WebPublic((path) => s.goto(path, "public"));
    const chatPage = await ctx.step("streamer: open the own channel page (chat events)", async () => {
      const page = await s.goto(ROUTES.channel(channel), "chat");
      await byTestId(page, T.chat, { state: "open" }).waitFor({ timeout: UI_TIMEOUT_MS });
      return page;
    });
    events = new WebChatEvents(() => chatPage);
    const ts = await webSession("treasurer", treasurerUser);
    treasurer = new WebTreasurer((path) => ts.goto(path), currency);
    await ctx.step("treasurer: /treasury renders for a treasurer", async () => {
      const page = await ts.goto(ROUTES.treasury);
      await byTestId(page, T.treasury).waitFor({ timeout: UI_TIMEOUT_MS });
    });
  }
  const A = await person("A", a);
  const B = await person("B", b);
  const C = await person("C", c);

  const tiers = TIER_PRICES.map((cents, i) => ({
    name: TIER_NAMES[i] ?? `Tier ${i + 1}`,
    cents,
    benefits: `harness tier ${i + 1}`,
  }));
  await ctx.step("streamer: set three tiers", () => creator.setTiers(channel, tiers, currency, ui));
  const support = await ctx.step("money.support lists the three tiers", () =>
    waitFor(
      "money.support tiers to match what was saved",
      async () => {
        const s = await a.api.client.money.support({ channel });
        const ok = s.tiers.length === 3 && s.tiers.every((t, i) => t.price.cents === TIER_PRICES[i]);
        return ok ? s : null;
      },
      { timeoutMs: UI_TIMEOUT_MS, intervalMs: 500, signal },
    ),
  );
  ctx.assert(
    "tiers are in the instance currency",
    support.tiers.every((t) => t.price.currency === currency),
  );
  check("the cut has not changed since the plan", sameFraction(support.split.streamerShare, plan.cut.streamerShare), {
    split: support.split,
  });

  for (const [who, x] of [
    ["B", B],
    ["C", C],
  ] as const) {
    await ctx.step(`${who}: open the channel, follow it and chat once (gift pool)`, async () => {
      await x.social.openChannel(channel, ui);
      const f = await x.social.followState(ui);
      if (!f.following) await x.social.toggleFollow(ui);
      await x.social.send(`hello from ${who} ${ctx.runId}`, chat);
      await observer.waitFor(
        "message",
        (m) => m.channel === channel && m.message.user.username === x.user.username,
        CHAT_TIMEOUT_MS,
      );
    });
  }

  const paymentIds: string[] = [];
  const confirmAndSeeEvent = async (
    label: string,
    reference: string,
    eventWhat: string,
    match: Parameters<ChatEventObserver["waitEvent"]>[1],
  ) => {
    const found = await ctx.step(`treasurer: find ${label} by reference`, () =>
      waitFor(`treasurer finds ${reference}`, () => treasurer.find(reference, ui), {
        timeoutMs: UI_TIMEOUT_MS,
        intervalMs: 500,
        signal,
      }),
    );
    ctx.assert(`${label} is pending before confirmation`, found.status === "pending", found);
    const confirmed = performance.now();
    await ctx.step(`treasurer: confirm ${label}`, () => treasurer.confirm(reference, ui));
    const event = await ctx.step(`chat shows ${eventWhat}`, () => events.waitEvent(eventWhat, match, chat));
    ctx.metric(`${label.replaceAll(" ", "_")}.confirm_to_chat_event`, performance.now() - confirmed, "ms");
    return { found, event };
  };

  const waitSubscription = (who: Supporter, what: string, match: (s: SubscriptionView) => boolean) =>
    ctx.step(`${who.who}: /settings/subscriptions shows ${what}`, () =>
      settle(
        `${who.who}'s ${what}`,
        () => who.subscriptions(ui),
        (rows) => rows.some(match),
        slow,
      ),
    );

  // ------------------------------------------------------------ 2. subscribe
  const sub = await ctx.step("A: Support → tier 2 → instructions", () =>
    A.supporter.checkout(channel, { kind: "sub", tier: plan.subTier }, ui),
  );
  paymentIds.push(sub.paymentId);
  ctx.assert("support-reference is a CA- reference", parseReference(sub.reference) === sub.reference, sub);
  ctx.assert("support-amount is the tier-2 price", sub.cents === expected.sub.grossCents, sub);
  if (sub.shown) {
    check("support-dialog data-provider=manual", sub.shown.provider === "manual", sub.shown);
    check("support-total is the tier-2 price", sub.shown.totalCents === expected.sub.grossCents, sub.shown);
    check(
      "support-split shows the platform.cut",
      sameFraction(sub.shown.streamerShare, plan.cut.streamerShare) &&
        sameFraction(sub.shown.coopShare, plan.cut.coopShare),
      sub.shown,
    );
  }
  const subConfirmed = await confirmAndSeeEvent(
    "the subscription",
    sub.reference,
    `channel.subscribe by ${a.username} at tier ${plan.subTier}`,
    (e) => e.type === "channel.subscribe" && e.user === a.username && e.tier === plan.subTier,
  );
  check(
    "the treasurer saw the subscription amount",
    subConfirmed.found.cents === expected.sub.grossCents,
    subConfirmed.found,
  );
  const aSubs = await waitSubscription(
    A.supporter,
    `an active tier-${plan.subTier} subscription`,
    (s) => s.channel === channel && s.status === "active" && s.tier === plan.subTier && !s.gifted,
  );
  ctx.assert(
    `A holds an active tier-${plan.subTier} subscription`,
    aSubs.some((s) => s.channel === channel && s.status === "active" && s.tier === plan.subTier),
    aSubs,
  );

  await ctx.step("A: open the channel chat", () => A.social.openChannel(channel, ui));
  const badges = await ctx.step("A's next message carries the subscriber badge", () => {
    const deadline = Date.now() + BADGE_TIMEOUT_MS;
    let n = 0;
    return waitFor(
      "A's message with a subscriber badge",
      async () => {
        const text = `subscribed ${ctx.runId} ${n++}`;
        await A.social.send(text, { timeoutMs: remainingMs(deadline), signal });
        const f = await observer
          .waitFor(
            "message",
            (m) => m.channel === channel && m.message.user.username === a.username && m.message.body.includes(text),
            remainingMs(deadline, 5_000),
          )
          .catch(() => null);
        const found = f?.message.user.badges ?? [];
        return found.some((x) => x.type === "subscriber") ? found : null;
      },
      { timeoutMs: BADGE_TIMEOUT_MS, intervalMs: 1_000, signal },
    );
  });
  check(
    `the subscriber badge is tier ${plan.subTier}`,
    badges.some((x) => x.type === "subscriber" && (x.tier === undefined || x.tier === plan.subTier)),
    badges,
  );

  // ------------------------------------------------------------ 3. gift
  const gift = await ctx.step(`A: Support → gift ${GIFT_COUNT} tier-${plan.giftTier} subs to random viewers`, () =>
    A.supporter.checkout(channel, { kind: "gift", tier: plan.giftTier, count: plan.giftCount }, ui),
  );
  paymentIds.push(gift.paymentId);
  ctx.assert("gift support-amount is count × tier price", gift.cents === expected.gift.grossCents, gift);
  if (gift.shown)
    check("gift support-total is count × tier price", gift.shown.totalCents === expected.gift.grossCents, gift.shown);
  const giftConfirmed = await confirmAndSeeEvent(
    "the gift",
    gift.reference,
    `channel.subscription.gift by ${a.username} with total ${GIFT_COUNT}`,
    (e) => e.type === "channel.subscription.gift" && e.total === plan.giftCount,
  );
  check("the gift event names A as gifter", giftConfirmed.event.user === a.username, giftConfirmed.event);
  check(`the gift event is tier ${plan.giftTier}`, giftConfirmed.event.tier === plan.giftTier, giftConfirmed.event);
  for (const x of [B, C]) {
    const rows = await waitSubscription(
      x.supporter,
      `an active gifted tier-${plan.giftTier} subscription`,
      (s) => s.channel === channel && s.status === "active" && s.gifted && s.tier === plan.giftTier,
    );
    ctx.assert(
      `${x.supporter.who} holds an active gifted tier-${plan.giftTier} subscription`,
      rows.some((s) => s.channel === channel && s.status === "active" && s.gifted && s.tier === plan.giftTier),
      rows,
    );
  }
  const giftEvents = (await events.events()).filter((e) => e.type === "channel.subscription.gift");
  check("exactly one channel.subscription.gift event", giftEvents.length === 1, giftEvents);

  // ------------------------------------------------------------ 4. tip
  const tip = await ctx.step(`A: Support → tip ${TIP_CENTS} cents, anonymously, with a message`, () =>
    A.supporter.checkout(
      channel,
      { kind: "tip", cents: plan.tipCents, message: `thanks ${ctx.runId}`, anonymous: true },
      ui,
    ),
  );
  paymentIds.push(tip.paymentId);
  ctx.assert("tip support-amount is the tip", tip.cents === expected.tip.grossCents, tip);
  if (tip.shown) check("tip support-total is the tip", tip.shown.totalCents === expected.tip.grossCents, tip.shown);
  const tipConfirmed = await confirmAndSeeEvent(
    "the tip",
    tip.reference,
    `channel.tip of ${plan.tipCents} cents`,
    (e) => e.type === "channel.tip" && e.cents === plan.tipCents,
  );
  check("the anonymous tip event has an empty data-user", tipConfirmed.event.user === "", tipConfirmed.event);
  ctx.data("money.references", { sub: sub.reference, gift: gift.reference, tip: tip.reference });

  // ------------------------------------------------------------ 5. dashboard
  const checkRevenue = (stage: string, r: RevenueView, want: RevenueExpectation) => {
    ctx.data(`money.observed.${stage}`, r);
    check(`${stage}: revenue-held = creator shares (${want.held})`, r.held === want.held, { held: r.held });
    check(`${stage}: revenue-available = ${want.available} (inside the hold)`, r.available === want.available, {
      available: r.available,
    });
    check(`${stage}: revenue-owed = ${want.owed}`, r.owed === want.owed, { owed: r.owed });
    check(`${stage}: revenue-earned = ${want.earned}`, r.earned === want.earned, { earned: r.earned });
    check(`${stage}: ledger data-net sums to revenue-earned`, sumNet(r.ledger) === r.earned, {
      sum: sumNet(r.ledger),
      earned: r.earned,
    });
    for (const k of ["subscriptions", "gifts", "tips"] as const) {
      check(`${stage}: revenue-source ${k} = ${want.bySource[k]}`, (r.bySource[k] ?? 0) === want.bySource[k], {
        observed: r.bySource[k],
      });
    }
    for (const tier of [1, 2, 3] as const) {
      const row = r.tiers.find((t) => t.tier === tier);
      const active = row?.active ?? 0;
      check(`${stage}: tier ${tier} has ${want.activeByTier[tier]} active`, active === want.activeByTier[tier], {
        row,
      });
      const candidates = monthlyShareCandidates(priceOf(plan, tier as Tier), want.activeByTier[tier], plan.cut);
      check(
        `${stage}: tier ${tier} monthly share is the cut of ${want.activeByTier[tier]} × price`,
        candidates.includes(row?.cents ?? 0),
        {
          row,
          candidates,
        },
      );
    }
    const moneyRows = r.ledger.filter((l) => l.type !== "payout");
    check(`${stage}: ${want.ledger.length} revenue-ledger rows`, moneyRows.length === want.ledger.length, {
      rows: moneyRows,
    });
    const missing = missingLedgerRows(want.ledger, moneyRows);
    check(`${stage}: every expected revenue-ledger row is there`, missing.length === 0, { missing });
    const bad = inconsistentLedgerRows(moneyRows);
    check(`${stage}: data-gross + data-deductions = data-net on every row`, bad.length === 0, { bad });
  };
  const afterPayments = await ctx.step("streamer: /revenue after three confirmed payments", () =>
    settle(
      "revenue-held to reach the creator shares",
      () => creator.revenue(channel, ui),
      (r) => r.held === expected.afterPayments.held && r.ledger.length >= expected.afterPayments.ledger.length,
      slow,
    ),
  );
  checkRevenue("step5", afterPayments, expected.afterPayments);
  check("revenue-available data-minimum is the payout minimum", (afterPayments.minimum ?? 0) > 0, {
    minimum: afterPayments.minimum,
  });

  // ------------------------------------------------------------ 6. refund and chargeback
  await ctx.step("treasurer: refund the tip in full", () =>
    treasurer.refund(tip.reference, expected.tip.grossCents, "harness: refund requested", ui),
  );
  await ctx.step("treasurer: charge back the tier-2 payment", () =>
    treasurer.chargeback(sub.reference, expected.sub.grossCents, "harness: bank chargeback", ui),
  );
  const tipAfter = await treasurer.find(tip.reference, ui);
  const subAfter = await treasurer.find(sub.reference, ui);
  check(
    "the tip payment is refunded",
    tipAfter?.status === "refunded" && tipAfter.refunded === expected.tip.grossCents,
    tipAfter,
  );
  check("the tier-2 payment is charged_back", subAfter?.status === "charged_back", subAfter);
  const aAfter = await waitSubscription(
    A.supporter,
    "the charged-back subscription canceled",
    (s) => s.channel === channel && s.tier === plan.subTier && !s.gifted && s.status === "canceled",
  );
  ctx.assert(
    "A's subscription is canceled",
    aAfter.some((s) => s.channel === channel && s.tier === plan.subTier && !s.gifted && s.status === "canceled"),
    aAfter,
  );
  const afterReversals = await ctx.step("streamer: /revenue after the refund and the chargeback", () =>
    settle(
      "revenue-held to drop by the reversed shares",
      () => creator.revenue(channel, ui),
      (r) => r.held === expected.afterReversals.held && r.ledger.length >= expected.afterReversals.ledger.length,
      slow,
    ),
  );
  checkRevenue("step6", afterReversals, expected.afterReversals);
  const reversedShares = expected.tip.split.creatorCents + expected.sub.split.creatorCents;
  check(
    `revenue-held dropped by exactly the reversed creator shares (${reversedShares})`,
    afterPayments.held - afterReversals.held === reversedShares,
    {
      before: afterPayments.held,
      after: afterReversals.held,
    },
  );
  for (const type of ["refund", "chargeback"] as const) {
    const rows = afterReversals.ledger.filter((l) => l.type === type);
    check(`one ${type} ledger row with a negative data-net`, rows.length === 1 && (rows[0]?.net ?? 0) < 0, { rows });
  }

  // ------------------------------------------------------------ 7. payout threshold
  const run = await ctx.step("treasurer: run payouts for this month", () => treasurer.runPayouts(ui));
  ctx.data("money.payoutRun", run);
  // The run is instance-wide: on a shared stack an older creator could qualify; the streamer's own
  // payout list is the authoritative check.
  check("treasury-payouts-result data-created=0 (nobody above the minimum)", run.created === 0, run);
  const payouts = await ctx.step("treasurer: payout list", () => treasurer.payouts(ui));
  const streamerPayouts = payouts.filter((x) => x.username === streamer.username);
  ctx.assert(
    "no payout for the streamer (everything is inside the hold, below the minimum)",
    streamerPayouts.length === 0,
    {
      streamerPayouts,
    },
  );
  const afterRun = await ctx.step("streamer: /revenue after the payout run", () => creator.revenue(channel, ui));
  ctx.data("money.observed.step7", afterRun);
  const total = (r: RevenueView) => r.held + r.available + r.owed;
  check("nothing is lost: held + available + owed is unchanged", total(afterRun) === total(afterReversals), {
    before: { held: afterReversals.held, available: afterReversals.available, owed: afterReversals.owed },
    after: { held: afterRun.held, available: afterRun.available, owed: afterRun.owed },
  });
  check("revenue-held unchanged by the run", afterRun.held === afterReversals.held, { held: afterRun.held });

  // ------------------------------------------------------------ 8. transparency
  const wantRevenue = (baseline?.revenue ?? 0) + expected.transparencyRevenueDelta;
  const shown = await ctx.step(`/transparency shows ${month}`, () =>
    settle(
      `transparency-month-row[data-month=${month}] revenue ${wantRevenue}`,
      () => publicReader.transparency(month, ui),
      (m) => m !== null && m.revenue === wantRevenue,
      slow,
    ),
  );
  ctx.data("transparency.after", shown);
  check("the run stayed within one UTC month", utcMonth() === month, { started: month, now: utcMonth() });
  ctx.assert(`transparency has a ${month} row`, shown !== null);
  if (shown) {
    check(
      `data-revenue rose by the creator + co-op shares net of reversals (${expected.transparencyRevenueDelta})`,
      shown.revenue - (baseline?.revenue ?? 0) === expected.transparencyRevenueDelta,
      { baseline: baseline?.revenue ?? 0, now: shown.revenue },
    );
    check("data-payouts unchanged (nothing was paid)", shown.payouts === (baseline?.payouts ?? 0), {
      baseline: baseline?.payouts ?? 0,
      now: shown.payouts,
    });
  }

  // ------------------------------------------------------------ 9. ledger integrity
  const ledger = await ctx.step("ledger transactions for the scenario's payments sum to zero (read-only)", () =>
    ledgerSums(databaseUrl, paymentIds),
  );
  ctx.data("ledger.transactions", ledger.rows);
  ctx.data("ledger.disputes", ledger.disputes);
  for (const id of paymentIds) {
    ctx.assert(
      `payment ${id} reached the ledger`,
      ledger.rows.some((r) => r.refId === id),
      { paymentId: id },
    );
  }
  ctx.assert("both disputes are recorded", ledger.disputes.length === 2, ledger.disputes);
  for (const d of ledger.disputes) {
    ctx.assert(
      `dispute ${d.kind} reached the ledger`,
      ledger.rows.some((r) => r.refId === d.id),
      d,
    );
  }
  const unbalanced = unbalancedTransactions(ledger.rows);
  ctx.assert("every transaction sums to zero per currency", unbalanced.length === 0, { unbalanced });
}
