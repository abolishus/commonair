// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `e5-coop` B8 extensions of M1-coop-money (docs/testing/b8-selectors.md, "Scenarios"; ADR 0020):
 *
 * - `share-stripe`: with `PAYMENTS_PROVIDER=stripe` (stripe-mock), the step turns
 *   `shares.cardPayments` on through an ordinary proposal its own members vote, a new viewer buys the
 *   share by card (`share-buy-stripe` on the web, `coop.buyShare` answering a Stripe Checkout
 *   redirect), a signed `checkout.session.completed` books it, and the viewer membership is active
 *   with the `share_purchase` posting. The step then has the buyer leave (the share waits
 *   `refund_pending` for the treasurer: never refunded by itself) and turns the setting off again, so
 *   later runs start from the seeded default. On a manual instance it checks the other half of the
 *   rule: the share is still a bank transfer, and the setting stays off.
 * - `patronage-payout`: an approved period (fixture rows: computed by T1, approved by T2, with the
 *   allocation posted) for a manual member and an Express member (a member with a ready Stripe
 *   account, the step's own fixture) is paid out with `patronage-pay`: T1 requests, T1 again is
 *   refused, T2 approves. The manual member's row is marked paid with a reference; the Express
 *   member's row is paid by the worker through Connect (Stripe instances), and `patronage-payouts`
 *   shows both `paid`.
 *
 * The ledger balances after each: every posting on the share or the period sums to zero. Inserts go
 * through drizzle on the owner connection (no raw timestamps).
 */

import { createDb, type Database, schema, uuidv7 } from "@commonair/db";
import { accounts, patronageAllocation, post, rawBalance } from "@commonair/ledger";
import { governancePeriods } from "../coop.ts";
import { paymentCompleted, stripeId, StripeWebhook, stripeWebhookSecret } from "../stripe.ts";
import type { SignedInUser } from "../users.ts";
import { waitFor } from "../wait.ts";
import { signInViaUi } from "../web/flows.ts";
import { ROUTES, TEST_IDS as T } from "../web/selectors.ts";
import { WebSession, byTestId } from "../web/session.ts";
import type { CoopB8Extension } from "./kit.ts";

export const SHARE_BUY_STRIPE = "share-buy-stripe";
export const PATRONAGE_PAYOUTS = "patronage-payouts";
export const PATRONAGE_PAY = "patronage-pay";
export const CARD_PAYMENTS = "shares.cardPayments";
const UI_TIMEOUT_MS = 20_000;
const PAYOUT_TIMEOUT_MS = 90_000;
const WINDOW_SLACK_MS = 90_000;
/** Members the step appoints to vote the setting (the jury step's electorate is gone by now). */
const VOTERS = 3;
type Raw = ReturnType<typeof createDb>["sql"];

// ---------------------------------------------------------------- pure (unit-tested)

/** Whether card payment for shares is on in a settings list (`{ enabled: true }` only). */
export function cardPaymentsOn(settings: readonly { key: string; value: unknown }[]): boolean {
  const v = settings.find((s) => s.key === CARD_PAYMENTS)?.value;
  return typeof v === "object" && v !== null && (v as { enabled?: unknown }).enabled === true;
}

/** A far-past month no real period uses, distinct per run (`runId` hashed into 1950–2049). */
export function fixturePeriod(runId: string): { periodStart: Date; periodEnd: Date } {
  let h = 0;
  for (const c of runId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const month = h % 1_200;
  return {
    periodStart: new Date(Date.UTC(1950, month, 1)),
    periodEnd: new Date(Date.UTC(1950, month + 1, 1)),
  };
}

/** The postings among `rows` (per transaction and currency) that do not sum to zero. */
export function offBalance(rows: readonly { key: string; sum: string }[]): { key: string; sum: string }[] {
  return rows.filter((r) => BigInt(r.sum) !== 0n);
}

// ---------------------------------------------------------------- helpers

async function unbalanced(sql: Raw, refId: string): Promise<{ key: string; sum: string }[]> {
  const rows = await sql<{ key: string; sum: string }[]>`
    select t.idempotency_key as key, sum(e.amount_cents)::text as sum
      from ledger_transactions t join ledger_entries e on e.transaction_id = t.id
     where t.ref_id::text = ${refId}
     group by t.id, e.currency`;
  return offBalance(rows);
}

/** Pass an ordinary proposal changing one setting, voted yes by `members` (the e5 short windows). */
async function passSetting(ext: CoopB8Extension, members: readonly SignedInUser[], value: unknown, title: string) {
  const { ctx, hooks } = ext;
  const anon = ctx.platform.api().client;
  const periods = governancePeriods(await anon.coop.settings());
  const author = members[0];
  if (!author) throw new Error("no members to propose");
  const draft = await author.api.client.coop.proposals.create({
    title,
    body: "Harness e5-coop share-stripe (M1-coop-money): card payment for member shares.",
    changes: [{ key: CARD_PAYMENTS, value }],
    affectsCreators: false,
  });
  const p = await author.api.client.coop.proposals.submit({ id: draft.id });
  let voted = false;
  const budget =
    (periods.discussionSeconds + periods.councilReviewSeconds + periods.votingSeconds) * 1_000 + WINDOW_SLACK_MS * 2;
  await hooks.tickUntil(
    "proposals-advance",
    `${title}: applied`,
    async () => {
      const now = await anon.coop.proposals.get({ id: p.id });
      if (now.status === "rejected" || now.status === "withdrawn") throw new Error(`the proposal was ${now.status}`);
      if (now.status === "voting" && !voted) {
        await Promise.all(members.map((m) => m.api.client.coop.proposals.vote({ id: p.id, choice: "yes" })));
        voted = true;
      }
      return now.status === "applied" ? true : null;
    },
    { timeoutMs: budget, intervalMs: 2_000 },
  );
}

async function signedInPage(ext: CoopB8Extension, user: SignedInUser, label: string, path: string) {
  const { ctx } = ext;
  const session = await WebSession.open({
    fleet: ctx.platform.fleet,
    engine: "chromium",
    webUrl: ctx.env.HARNESS_WEB_URL,
    probeScript: "",
    label,
    log: ctx.log,
  });
  ctx.defer(() => session.close());
  const signin = await session.goto(ROUTES.signin);
  await signInViaUi(signin, user, UI_TIMEOUT_MS, ctx.signal);
  await byTestId(signin, T.navUser, { username: user.username }).waitFor({ timeout: UI_TIMEOUT_MS });
  return session.goto(path);
}

// ---------------------------------------------------------------- share-stripe

export async function stepShareStripe(ext: CoopB8Extension): Promise<void> {
  const { ctx, people } = ext;
  const anon = ctx.platform.api().client;
  const info = await anon.instance.info();
  const settings = await anon.coop.settings();
  ctx.data("b8.shareStripe.provider", info.features.payments);
  const buyer = await ctx.step("share-stripe: sign up a buyer", () => ctx.platform.signUp({ prefix: "b8sh" }));

  if (info.features.payments !== "stripe") {
    ctx.check("the seed keeps card payment for shares off", !cardPaymentsOn(settings), { value: settings });
    const r = await buyer.api.client.coop.buyShare({ returnPath: "/coop/membership" });
    ctx.assert("PAYMENTS_PROVIDER=manual: a share is a bank transfer", r.kind === "instructions", { kind: r.kind });
    // The buyer is the step's own: their unpaid share expires with its payment.
    ctx.log.info("share-stripe: the card path runs with PAYMENTS_PROVIDER=stripe (stripe-mock)");
    return;
  }

  const secret = stripeWebhookSecret(ctx.env);
  ctx.assert("the instance's webhook secret is set (HARNESS_STRIPE_WEBHOOK_SECRET or STRIPE_WEBHOOK_SECRET)", !!secret);
  if (!secret) return;
  const hook = new StripeWebhook(ctx.env.HARNESS_API_URL, secret, ctx.signal);
  const db = createDb({ url: ext.databaseUrl, max: 2, applicationName: "commonair-harness-b8-shares" });
  ctx.defer(() => db.close());

  // ------------------------------------------------------------ the setting on
  const voters = await ctx.step(`share-stripe: sign up ${String(VOTERS)} voters`, () =>
    Promise.all(Array.from({ length: VOTERS }, () => ctx.platform.signUp({ prefix: "b8shv" }))),
  );
  await ctx.step("share-stripe: the board appoints them as worker members", async () => {
    for (const m of voters)
      await people.admin.api.client.coop.appointWorker({ username: m.username, boardMinuteRef: `shares-${ctx.runId}` });
  });
  const wasOn = cardPaymentsOn(settings);
  if (!wasOn)
    await ctx.step("share-stripe: shares.cardPayments on through an ordinary proposal", () =>
      passSetting(ext, voters, { enabled: true }, `Card payment for member shares (${ctx.runId})`),
    );
  ctx.defer(async () => {
    // Later runs start from the seeded default (off), then the voters leave.
    if (!wasOn)
      await passSetting(ext, voters, { enabled: false }, `Card payment for member shares off (${ctx.runId})`).catch(
        (err: unknown) => ctx.log.warn("share-stripe: could not turn the setting off again", { err: String(err) }),
      );
    for (const m of voters) await m.api.client.coop.exit({ class: "worker" }).catch(() => undefined);
  });
  ctx.assert("shares.cardPayments is on", cardPaymentsOn(await anon.coop.settings()));

  // ------------------------------------------------------------ the purchase
  if (ext.via === "web") {
    const page = await ctx.step("share-stripe: the membership page offers Pay by card", () =>
      signedInPage(ext, buyer, "buyer (membership)", "/coop/membership"),
    );
    const button = page.locator(`[data-testid="${SHARE_BUY_STRIPE}"]`);
    await button.waitFor({ timeout: UI_TIMEOUT_MS });
    ctx.check("share-buy-stripe is enabled", await button.isEnabled());
  }
  const r = await ctx.step("share-stripe: buyShare starts a Stripe Checkout", () =>
    buyer.api.client.coop.buyShare({ returnPath: "/coop/membership" }),
  );
  ctx.assert("the share is paid by card: a Checkout redirect", r.kind === "redirect", { kind: r.kind });
  if (r.kind !== "redirect") return;
  const [row] = await db.sql<
    { id: string; provider: string; status: string; amount_cents: string; currency: string }[]
  >`
    select id::text as id, provider::text as provider, status::text as status, amount_cents::text as amount_cents, currency
      from payments where id = ${r.paymentId}::uuid and kind = 'membership_share'`;
  ctx.assert("a pending Stripe membership_share payment", row?.provider === "stripe" && row.status === "pending", row);
  if (!row) return;
  const p = { id: row.id, amountCents: Number(row.amount_cents), currency: row.currency };
  const pi = stripeId("pi");
  const done = await ctx.step("share-stripe: Stripe completes the checkout (signed event)", () =>
    hook.send(
      paymentCompleted({ paymentId: p.id, paymentIntent: pi, amountCents: p.amountCents, currency: p.currency }),
    ),
  );
  ctx.assert("the webhook booked the share", done.body.outcome === "share_confirmed", done.body);
  const again = await hook.send(
    paymentCompleted({ paymentId: p.id, paymentIntent: pi, amountCents: p.amountCents, currency: p.currency }),
  );
  ctx.check("a redelivery changes nothing", again.body.outcome !== "share_confirmed", again.body);

  const view = await buyer.api.client.coop.membership();
  ctx.assert(
    "the viewer membership is active, by share",
    view.memberships.some((m) => m.class === "viewer" && m.status === "active" && m.basis === "share"),
    view.memberships,
  );
  ctx.check("the share is held", view.share?.status === "held", view.share);
  const shareId = view.share?.id ?? "";
  const kinds = await db.sql<{ kind: string }[]>`select kind from ledger_transactions where ref_id::text = ${shareId}`;
  ctx.check("one share_purchase posting", kinds.filter((k) => k.kind === "share_purchase").length === 1, kinds);
  const off = await unbalanced(db.sql, shareId);
  ctx.assert("the ledger balances: every posting on the share sums to zero", off.length === 0, off);

  // ------------------------------------------------------------ leaving does not refund
  await buyer.api.client.coop.exit({ class: "viewer" });
  const after = await buyer.api.client.coop.membership();
  ctx.check(
    "leaving sets the share refund_pending for the treasurer",
    after.share?.status === "refund_pending",
    after.share,
  );
}

// ---------------------------------------------------------------- patronage-payout

/** An approved period allocating to `members`: computed by T1, approved by T2, allocation posted. */
async function approvedPeriod(
  ext: CoopB8Extension,
  db: Database,
  sql: Raw,
  members: readonly { userId: string; cents: number }[],
): Promise<string> {
  const { periodStart, periodEnd } = fixturePeriod(ext.ctx.runId);
  const id = uuidv7();
  const total = members.reduce((s, m) => s + m.cents, 0);
  await db.insert(schema.patronagePeriods).values({
    id,
    periodStart,
    periodEnd,
    status: "computed",
    formulaVersion: "harness-b8",
    weights: {
      revenue: 1,
      streamingHours: 0,
      relayBandwidth: 0,
      viewerHours: 0,
      dailyStreamingHourCap: 12,
      viewerHoursChannelCap: 1,
    },
    surplusCents: total,
    currency: ext.currency,
    computedAt: new Date(),
    computedById: ext.people.t1.id,
  });
  await db
    .insert(schema.patronageAllocations)
    .values(members.map((m) => ({ periodId: id, userId: m.userId, amountCents: m.cents, lines: [] })));
  const r = await post(
    db,
    patronageAllocation({
      periodId: id,
      currency: ext.currency,
      occurredAt: new Date(),
      allocations: members.map((m) => ({ userId: m.userId, amountCents: m.cents })),
    }),
  );
  // The approval is the database's own clock (no client timestamp in raw SQL).
  await sql`
    update patronage_periods
       set status = 'approved', approved_at = now(), approved_by_id = ${ext.people.t2.id}::uuid,
           ledger_transaction_id = ${r.transactionId}::uuid
     where id = ${id}::uuid`;
  return id;
}

interface MarkPaidClient {
  markPaid(input: { payoutId: string; reference: string; paidAt: string }): Promise<{ status: string }>;
}

export async function stepPatronagePayout(ext: CoopB8Extension): Promise<void> {
  const { ctx, people } = ext;
  const anon = ctx.platform.api().client;
  const provider = (await anon.instance.info()).features.payments;
  const db = createDb({ url: ext.databaseUrl, max: 2, applicationName: "commonair-harness-b8-patronage" });
  ctx.defer(() => db.close());

  const [manual, express] = await ctx.step("patronage-payout: sign up a manual member and an Express member", () =>
    Promise.all([ctx.platform.signUp({ prefix: "b8pm" }), ctx.platform.signUp({ prefix: "b8px" })]),
  );
  // Onboarding is Stripe's page (not followed); the ready account it leaves behind is the fixture.
  await db.db
    .insert(schema.payoutAccounts)
    .values({ userId: express.id, provider: "stripe", providerAccountId: stripeId("acct"), payoutsEnabled: true })
    .onConflictDoUpdate({
      target: schema.payoutAccounts.userId,
      set: { provider: "stripe", providerAccountId: stripeId("acct"), payoutsEnabled: true },
    });
  const periodId = await ctx.step("patronage-payout: an approved period (fixture)", () =>
    approvedPeriod(ext, db.db, db.sql, [
      { userId: manual.id, cents: 1_100 },
      { userId: express.id, cents: 900 },
    ]),
  );
  ctx.data("b8.patronage.periodId", periodId);

  const first = await ctx.step("patronage-payout: T1 asks to pay the period out", () =>
    people.t1.api.client.coop.patronage.pay({ periodId }),
  );
  ctx.assert("the first call waits for a second approver", first.state === "awaiting_second_approver", first);
  const self = await people.t1.api.client.coop.patronage.pay({ periodId }).then(
    () => "allowed",
    (err: unknown) => String((err as { code?: unknown }).code ?? err),
  );
  ctx.check("the requester cannot approve their own request", self === "FORBIDDEN", { self });
  const approved = await ctx.step("patronage-payout: T2 approves", () =>
    people.t2.api.client.coop.patronage.pay({ periodId }),
  );
  ctx.assert("approved: one row per member", approved.state === "approved" && approved.created === 2, approved);
  const repeat = await people.t2.api.client.coop.patronage.pay({ periodId });
  ctx.check("a repeat creates nothing", repeat.created === 0, repeat);

  const rows = await people.t1.api.client.coop.patronage.payouts({ periodId });
  const manualRow = rows.find((x) => x.user.id === manual.id);
  const expressRow = rows.find((x) => x.user.id === express.id);
  ctx.assert("both members have a row", manualRow !== undefined && expressRow !== undefined, rows);
  if (!manualRow || !expressRow) return;
  ctx.check("the manual member's row is a bank transfer", manualRow.provider === "manual", manualRow);
  ctx.check(
    provider === "stripe" ? "the Express member's row goes through Connect" : "manual instance: every row is manual",
    expressRow.provider === (provider === "stripe" ? "stripe" : "manual"),
    expressRow,
  );

  // The manual row: the treasurer marks it paid with their reference (`coop.patronage.markPaid`).
  const patronage = people.t1.api.client.coop.patronage as unknown as MarkPaidClient;
  const paid = await ctx.step("patronage-payout: T1 marks the manual payout paid", () =>
    patronage.markPaid({
      payoutId: manualRow.id,
      reference: `B8-${ctx.runId.slice(0, 8)}`,
      paidAt: new Date().toISOString(),
    }),
  );
  ctx.assert("the manual payout is paid", paid.status === "paid", paid);
  if (expressRow.provider === "manual")
    await patronage.markPaid({
      payoutId: expressRow.id,
      reference: `B8X-${ctx.runId.slice(0, 8)}`,
      paidAt: new Date().toISOString(),
    });

  const settled = await ctx.step("patronage-payout: both payouts are paid", () =>
    waitFor(
      "both payouts paid",
      async () => {
        const now = await people.t1.api.client.coop.patronage.payouts({ periodId });
        return now.length === 2 && now.every((x) => x.status === "paid") ? now : null;
      },
      { timeoutMs: PAYOUT_TIMEOUT_MS, intervalMs: 1_000, signal: ctx.signal },
    ).catch(() => people.t1.api.client.coop.patronage.payouts({ periodId })),
  );
  ctx.assert(
    "patronage-payouts: both paid",
    settled.every((x) => x.status === "paid"),
    settled,
  );
  if (provider === "stripe")
    ctx.check(
      "the Express payout carries its Stripe transfer id",
      (settled.find((x) => x.user.id === express.id)?.reference ?? "").startsWith("tr_"),
      settled,
    );

  for (const m of [manual, express]) {
    const owed = 0 - (await rawBalance(db.db, accounts.patronagePayable(m.id), ext.currency));
    ctx.check(`${m.username}: nothing left in the patronage payable`, owed === 0, { owed });
  }
  const off = await unbalanced(db.sql, periodId);
  ctx.assert("the ledger balances: every posting on the period sums to zero", off.length === 0, off);

  if (ext.via === "web") {
    const page = await ctx.step("patronage-payout: the period page's payout section", () =>
      signedInPage(ext, people.t1, "T1 (payouts)", `/coop/patronage/${periodId}`),
    );
    await page.locator(`[data-testid="${PATRONAGE_PAY}"]`).waitFor({ timeout: UI_TIMEOUT_MS });
    const list = page.locator(`[data-testid="${PATRONAGE_PAYOUTS}"]`);
    await list.waitFor({ timeout: UI_TIMEOUT_MS });
    // The list shows skeleton rows (no data-payout-id) until the payouts load.
    const read = () =>
      list
        .locator("tr[data-payout-id]")
        .evaluateAll((trs) => trs.map((tr) => [tr.getAttribute("data-user-id"), tr.getAttribute("data-status")]));
    const statuses = await waitFor(
      "the payout rows",
      async () => {
        const rows = await read();
        return rows.length === 2 ? rows : null;
      },
      { timeoutMs: UI_TIMEOUT_MS, intervalMs: 250, signal: ctx.signal },
    ).catch(read);
    ctx.check(
      "patronage-payouts shows both paid",
      statuses.length === 2 && statuses.every(([, s]) => s === "paid"),
      statuses,
    );
  }
}
