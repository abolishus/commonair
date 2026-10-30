// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `e4b-money` extension `fraud-hold` (docs/testing/w1-selectors.md, "Scenarios"; ADR 0036): a
 * fresh payee receives tips from accounts created just before, above the concentration floor; the
 * `money-fraud-scan` ops tick flags them; this month's payout run holds the payout with
 * `fraud_review`; a direct `held → pending` update fails with `23514`; the treasurer reviews, the
 * same treasurer's decision is refused (`second_approver`), and a second treasurer (granted with
 * the role CLI; W1 has no admin web path) clears it, after which the payout is `pending`.
 *
 * The tips are fixtures: payment and tip rows written through the owner connection and posted
 * with the ledger's own rules, dated one day past the payout hold, so the payout run can reserve
 * them now (a live tip would sit inside the 7-day hold). Everything after that runs through the
 * product: the scan job, the payout run, the review and the decisions (web or API, per `via`).
 */
import { FRAUD_REVIEW_HOLD, PAYMENT_FRAUD_RULES } from "@commonair/contracts/enums";
import { createDb, type Database, schema, uuidv7 } from "@commonair/db";
import { loadMoneySettings, paymentSucceeded, post } from "@commonair/ledger";
import type { Page } from "playwright";
import { grantRole } from "../money-db.ts";
import { apiError, errorOf } from "../safety.ts";
import type { SignedInUser } from "../users.ts";
import { waitFor } from "../wait.ts";
import { signInViaUi } from "../web/flows.ts";
import { ROUTES, TEST_IDS as T } from "../web/selectors.ts";
import { WebSession, byTestId } from "../web/session.ts";
import type { MoneyExtension } from "./kit.ts";
import { W1_ROUTES, W1_TEST_IDS as W, byW1Id } from "./selectors.ts";

const DAY_MS = 86_400_000;
const UI_TIMEOUT_MS = 20_000;
const ROLE_CLI_TIMEOUT_MS = 30_000;
/** New accounts tipping the payee: three, so the top-three share is everything. */
export const FRAUD_PAYERS = 3;
/**
 * The treasury's fraud tab. Not in docs/testing/w1-selectors.md yet: W1-fraud-floor's contract
 * request adds `treasury-tab-fraud` there and to `W1_TEST_IDS`.
 */
export const TREASURY_TAB_FRAUD = "treasury-tab-fraud";

export interface FraudTipPlan {
  /** Cents per payer; their sum reaches the concentration floor. */
  cents: number[];
  /** When the fixture payments succeeded: one day past the payout hold, inside the concentration window. */
  at: Date;
}

/** The fixture tips: `payers` equal tips (rounded up) summing to at least the floor, dated past the hold. */
export function fraudTipPlan(
  now: Date,
  holdDays: number,
  payers = FRAUD_PAYERS,
  rules: { concentrationMinGrossCents: number; concentrationWindowDays: number } = PAYMENT_FRAUD_RULES,
): FraudTipPlan {
  if (payers < 1) throw new RangeError("at least one payer");
  const backDays = Math.ceil(holdDays) + 1;
  if (backDays >= rules.concentrationWindowDays)
    throw new RangeError(
      `the hold (${holdDays} days) leaves no room inside the ${rules.concentrationWindowDays}-day window`,
    );
  const each = Math.ceil(rules.concentrationMinGrossCents / payers);
  return { cents: Array.from({ length: payers }, () => each), at: new Date(now.getTime() - backDays * DAY_MS) };
}

/** The SQLSTATE of a rejected query (drizzle wraps the driver error). */
export function sqlState(err: unknown): string | null {
  for (let e: unknown = err, depth = 0; e && typeof e === "object" && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/** The contract's four-eyes refusal (`SECOND_APPROVER`). */
export function isSecondApproverRefusal(err: unknown): boolean {
  const e = apiError(err);
  return e.code === "FORBIDDEN" && e.reason === "second_approver";
}

interface FlagView {
  id: string;
  kind: string;
  status: string;
  payee: { username: string };
  heldPayouts: number;
}

/** The newest flag of `kind` on `username`. */
export function flagFor<F extends FlagView>(items: readonly F[], username: string, kind: string): F | null {
  return items.find((f) => f.payee.username === username && f.kind === kind) ?? null;
}

async function payoutOf(user: SignedInUser, treasurer: SignedInUser) {
  const r = await treasurer.api.client.money.treasurer.payouts({ limit: 100 });
  return r.items.find((p) => p.user.id === user.id) ?? null;
}

async function flagOf(treasurer: SignedInUser, username: string) {
  const r = await treasurer.api.client.money.treasurer.fraudFlags.list({ limit: 100 });
  return flagFor(r.items, username, "payer_concentration");
}

/** Post the fixture tips (payment, tip row, ledger posting) for `payee` from `payers`. */
async function postFixtureTips(
  db: Database,
  opts: { payee: SignedInUser; channelId: string; payers: SignedInUser[]; plan: FraudTipPlan; currency: string },
): Promise<string[]> {
  const settings = await loadMoneySettings(db);
  const ids: string[] = [];
  for (const [i, payer] of opts.payers.entries()) {
    const cents = opts.plan.cents[i] ?? 0;
    const paymentId = uuidv7(opts.plan.at.getTime());
    await db.transaction(async (tx) => {
      const [tip] = await tx
        .insert(schema.tips)
        .values({
          fromUserId: payer.id,
          channelId: opts.channelId,
          amountCents: cents,
          currency: opts.currency,
          message: "",
          anonymous: false,
          paymentId,
          status: "succeeded",
        })
        .returning({ id: schema.tips.id });
      await tx.insert(schema.payments).values({
        id: paymentId,
        provider: "manual",
        providerRef: `CA-FH${paymentId.replaceAll("-", "").slice(-6).toUpperCase()}`,
        kind: "tip",
        status: "succeeded",
        userId: payer.id,
        channelId: opts.channelId,
        tipId: tip?.id ?? null,
        amountCents: cents,
        currency: opts.currency,
        succeededAt: opts.plan.at,
      });
      await post(
        tx,
        paymentSucceeded({
          paymentId,
          paymentKind: "tip",
          provider: "manual",
          settlement: "cash",
          creatorUserId: opts.payee.id,
          grossCents: cents,
          taxCents: 0,
          feeCents: 0,
          currency: opts.currency,
          cut: settings.cut,
          cutHistoryId: settings.cutHistoryId,
          occurredAt: opts.plan.at,
        }),
      );
    });
    ids.push(paymentId);
  }
  return ids;
}

/** One treasurer's web session on /treasury, fraud tab open. */
async function fraudTab(ext: MoneyExtension, who: string, user: SignedInUser): Promise<Page> {
  const { ctx } = ext;
  const session = await WebSession.open({
    fleet: ctx.platform.fleet,
    engine: "chromium",
    webUrl: ctx.env.HARNESS_WEB_URL,
    probeScript: "",
    label: who,
    log: ctx.log,
  });
  ctx.defer(() => session.close());
  const signin = await session.goto(ROUTES.signin);
  await signInViaUi(signin, user, UI_TIMEOUT_MS, ctx.signal);
  // Land on the signed-in app before the next navigation.
  await byTestId(signin, T.navUser, { username: user.username }).waitFor({ timeout: UI_TIMEOUT_MS });
  const page = await session.goto(W1_ROUTES.treasury);
  await byTestId(page, T.treasury).waitFor({ timeout: UI_TIMEOUT_MS });
  await page.locator(`[data-testid="${TREASURY_TAB_FRAUD}"]`).click({ timeout: UI_TIMEOUT_MS });
  await byW1Id(page, W.fraudFlags).waitFor({ timeout: UI_TIMEOUT_MS });
  return page;
}

/** Click review or decide on the payee's flag, pick `clear`, confirm, and wait for `status`. */
async function actInUi(page: Page, payee: string, action: "review" | "decide", status: string): Promise<void> {
  const flag = byW1Id(page, W.fraudFlag, { payee, kind: "payer_concentration" }).first();
  await flag.waitFor({ timeout: UI_TIMEOUT_MS });
  await byW1Id(flag, action === "review" ? W.fraudFlagReview : W.fraudFlagDecide).click({ timeout: UI_TIMEOUT_MS });
  await byW1Id(page, W.fraudDecisionClear).click({ timeout: UI_TIMEOUT_MS });
  await byTestId(page, T.confirmDialogConfirm).click({ timeout: UI_TIMEOUT_MS });
  await byW1Id(page, W.fraudFlag, { payee, kind: "payer_concentration", status }).waitFor({ timeout: UI_TIMEOUT_MS });
}

export async function stepFraudHold(ext: MoneyExtension): Promise<void> {
  const { ctx, treasurer } = ext;
  const p = ctx.platform;
  const db = createDb({ url: ext.databaseUrl, max: 2, applicationName: "commonair-harness-w1-fraud" });
  ctx.defer(() => db.close());

  // 1. A fresh payee (its own actor, not the run's streamer) with a ready payout account, so a
  //    cleared payout becomes `pending`, and three accounts created just before they tip.
  const payee = await ctx.step("fraud-hold: sign up a fresh payee", () => p.signUp({ prefix: "w1fp" }));
  const slug = payee.me.channelSlug ?? payee.username;
  const channelId = (await payee.api.client.channels.get({ channel: slug })).id;
  await ctx.step("fraud-hold: treasurer enables the payee's payouts", () =>
    treasurer.api.client.money.treasurer.setPayoutAccount({
      username: payee.username,
      payoutsEnabled: true,
      reference: "harness fraud-hold",
    }),
  );
  const payers = await ctx.step(`fraud-hold: sign up ${FRAUD_PAYERS} new accounts`, () =>
    Promise.all(Array.from({ length: FRAUD_PAYERS }, () => p.signUp({ prefix: "w1fn" }))),
  );
  const { payoutRules } = await loadMoneySettings(db.db);
  const plan = fraudTipPlan(new Date(), payoutRules.holdDays);
  const paymentIds = await ctx.step("fraud-hold: the new accounts' tips (fixtures past the hold)", () =>
    postFixtureTips(db.db, { payee, channelId, payers, plan, currency: ext.currency }),
  );
  ctx.data("w1.fraud.payments", paymentIds);

  // 2. The scan flags the payee.
  const scan = await ctx.step("fraud-hold: money-fraud-scan ops tick", () => ext.hooks.ops("money-fraud-scan"));
  ctx.data("w1.fraud.scan", scan);
  const flag = await flagOf(treasurer, payee.username);
  ctx.assert("the scan raised an open payer_concentration flag on the payee", flag?.status === "open", flag);
  if (!flag) return;

  // 3. This month's payout run holds the payout for review.
  const run = await ctx.step("fraud-hold: treasurer runs this month's payouts", () =>
    treasurer.api.client.money.treasurer.runPayouts({ periodEnd: new Date().toISOString() }),
  );
  ctx.data("w1.fraud.payoutRun", run);
  const held = await payoutOf(payee, treasurer);
  ctx.assert(
    "the payee's payout is held with fraud_review",
    held?.status === "held" && held.holdReason === FRAUD_REVIEW_HOLD,
    held,
  );
  if (!held) return;
  // With a zero platform cut the tips reach the new_payee threshold too, and clearing
  // payer_concentration alone would leave the payout held: stop here with the reason.
  const newPayee = await db.sql<{ id: string }[]>`
    select id from payment_fraud_flags where payee_user_id = ${payee.id} and kind = 'new_payee'`;
  ctx.assert(
    "the payout run raised no new_payee flag (a zero platform cut puts the fixture tips over its threshold)",
    newPayee.length === 0,
    { newPayee: newPayee.map((r) => r.id), payoutCents: held.amount.cents },
  );
  if (newPayee.length > 0) return;

  // 4. The database refuses releasing it by hand.
  const refused = await errorOf(() =>
    db.sql`update payouts set status = 'pending', hold_reason = null where id = ${held.id}`.then(() => undefined),
  );
  ctx.assert("a direct held → pending update fails with 23514", sqlState(refused) === "23514", {
    sqlState: sqlState(refused),
  });

  // 5. Review, the refused second look by the same treasurer, and a second treasurer's clear.
  const t1Page =
    ext.via === "web"
      ? await ctx.step("fraud-hold: treasurer opens the fraud tab", () => fraudTab(ext, "treasurer (fraud)", treasurer))
      : null;
  await ctx.step(`fraud-hold: treasurer reviews (${ext.via})`, async () => {
    if (t1Page) await actInUi(t1Page, payee.username, "review", "reviewed");
    else
      await treasurer.api.client.money.treasurer.fraudFlags.review({ id: flag.id, recommendation: "clear", note: "" });
  });
  if (t1Page) {
    const decide = byW1Id(byW1Id(t1Page, W.fraudFlag, { payee: payee.username }).first(), W.fraudFlagDecide);
    const disabled = (await decide.isDisabled({ timeout: UI_TIMEOUT_MS }).catch(() => false)) === true;
    ctx.check("fraud-flag-decide is disabled for the reviewer", disabled);
  }
  const own = await ctx.step("fraud-hold: the same treasurer's decision is refused", () =>
    errorOf(() => treasurer.api.client.money.treasurer.fraudFlags.decide({ id: flag.id, decision: "clear", note: "" })),
  );
  ctx.assert("the reviewer's own decision is FORBIDDEN second_approver", isSecondApproverRefusal(own), apiError(own));

  const second = await ctx.step("fraud-hold: sign up a second treasurer", () => p.signUp({ prefix: "w1ft" }));
  await ctx.step("fraud-hold: grant treasurer (operator CLI)", () =>
    grantRole(ext.databaseUrl, second.username, "treasurer", ROLE_CLI_TIMEOUT_MS),
  );
  const t2 = await ctx.step("fraud-hold: second treasurer signs in again", () => p.users.signIn(second));
  await ctx.step(`fraud-hold: the second treasurer clears (${ext.via})`, async () => {
    if (ext.via === "web") {
      const page = await fraudTab(ext, "second treasurer (fraud)", t2);
      await actInUi(page, payee.username, "decide", "cleared");
    } else {
      await t2.api.client.money.treasurer.fraudFlags.decide({ id: flag.id, decision: "clear", note: "" });
    }
  });

  // 6. The payout is released.
  const after = await waitFor(
    "the payee's payout is pending",
    async () => {
      const row = await payoutOf(payee, treasurer);
      return row?.status === "pending" ? row : null;
    },
    { timeoutMs: UI_TIMEOUT_MS, intervalMs: 500, signal: ctx.signal },
  ).catch(() => null);
  ctx.assert("after the clear the payout is pending", after?.status === "pending", after);
  const cleared = await flagOf(t2, payee.username);
  ctx.check(
    "the flag is cleared and holds nothing",
    cleared?.status === "cleared" && cleared.heldPayouts === 0,
    cleared,
  );

  // The audit trail: raise (system), review, decide; ids and enums only.
  const audit = await db.sql<{ action: string; details: Record<string, unknown> }[]>`
    select action, details from audit_log where subject_type = 'payment_fraud_flag' and subject_id = ${flag.id}`;
  ctx.check(
    "audit rows money.fraud.raise, review and decide",
    ["money.fraud.decide", "money.fraud.raise", "money.fraud.review"].every((a) => audit.some((r) => r.action === a)),
    audit,
  );
}
