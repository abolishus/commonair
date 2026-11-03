// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `e4b-money` B8 extensions of M1-connect (docs/testing/b8-selectors.md, "Scenarios"; ADR 0007
 * Amendment 1):
 *
 * - `connect-transfer`: an Express payee (its own actor, with a ready Stripe payout account and
 *   fixture earnings dated past the hold, as `fraud-hold` does) is paid by this month's payout run:
 *   the worker's `payout-transfers` job creates one Connect transfer on stripe-mock, the payout
 *   turns `paid`, the treasury's transfers tab shows `payout-transfer-status` `created`, and the
 *   transfer exists on stripe-mock. With `provider=manual` the step checks the other half of the
 *   rule instead: the run moves nothing (no transfer row).
 * - `transfer-reversed` (after `connect-transfer`, Stripe only): a signed local `transfer.reversed`
 *   for the whole amount returns it to the payee's payable, and a redelivery changes nothing.
 *
 * The ledger balances after each: every posting on the payout sums to zero per currency.
 */
import { createDb, type Database, schema, uuidv7 } from "@commonair/db";
import { creatorBalances, loadMoneySettings, paymentSucceeded, post } from "@commonair/ledger";
import { PAYMENT_FRAUD_RULES } from "@commonair/contracts/enums";
import { stripeEvent, stripeId } from "../stripe.ts";
import type { SignedInUser } from "../users.ts";
import { waitFor } from "../wait.ts";
import { signInViaUi } from "../web/flows.ts";
import { ROUTES, TEST_IDS as T } from "../web/selectors.ts";
import { WebSession, byTestId } from "../web/session.ts";
import { W1_ROUTES } from "../w1/selectors.ts";
import type { MoneyB8Extension } from "./kit.ts";

const DAY_MS = 86_400_000;
type Raw = ReturnType<typeof createDb>["sql"];
const UI_TIMEOUT_MS = 20_000;
/** The worker picks the job up within seconds; a retried unknown outcome takes longer. */
const TRANSFER_TIMEOUT_MS = 90_000;
export const TREASURY_TAB_TRANSFERS = "treasury-tab-transfers";
export const PAYOUT_TRANSFERS = "payout-transfers";
export const PAYOUT_TRANSFER_STATUS = "payout-transfer-status";

/** What `connect-transfer` leaves for `transfer-reversed` (one scenario process runs both). */
interface Paid {
  payee: SignedInUser;
  payoutId: string;
  transferId: string;
  providerRef: string;
  amountCents: number;
  currency: string;
  destination: string;
}
let paid: Paid | null = null;

/**
 * The fixture tip's gross: enough that the payee's share reaches the payout minimum, and below
 * `new_payee`'s first-payout threshold so the run does not hold it for review.
 */
export function connectTipCents(
  minimumCents: number,
  streamerShare: number,
  newPayeeCents = PAYMENT_FRAUD_RULES.newPayeeFirstPayoutCents,
): number {
  if (!(streamerShare > 0 && streamerShare <= 1)) throw new RangeError("the streamer share is a fraction in (0, 1]");
  // A dollar of margin over the minimum, for the split's rounding.
  const gross = Math.ceil((minimumCents + 100) / streamerShare);
  const share = Math.floor(gross * streamerShare);
  if (share >= newPayeeCents) throw new RangeError(`a ${share}-cent payout would raise new_payee`);
  return gross;
}

/** Per transaction and currency, the entry sums of every posting on the payout; all must be zero. */
async function unbalanced(sql: Raw, payoutId: string): Promise<{ key: string; sum: string }[]> {
  return sql<{ key: string; sum: string }[]>`
    select t.idempotency_key as key, sum(e.amount_cents)::text as sum
      from ledger_transactions t join ledger_entries e on e.transaction_id = t.id
     where t.ref_id::text = ${payoutId}
     group by t.id, e.currency
    having sum(e.amount_cents) <> 0`;
}

async function postingKinds(sql: Raw, payoutId: string): Promise<string[]> {
  const rows = await sql<{ kind: string }[]>`select kind from ledger_transactions where ref_id::text = ${payoutId}`;
  return rows.map((r) => r.kind).sort();
}

/** A payee with a Stripe payout account and one fixture tip, dated past the hold. */
async function fundedPayee(
  ext: MoneyB8Extension,
  db: Database,
): Promise<{ payee: SignedInUser; destination: string; gross: number }> {
  const { ctx } = ext;
  const payee = await ctx.step("connect-transfer: sign up an Express payee", () =>
    ctx.platform.signUp({ prefix: "b8cx" }),
  );
  const slug = payee.me.channelSlug ?? payee.username;
  const channelId = (await payee.api.client.channels.get({ channel: slug })).id;
  const payer = await ctx.step("connect-transfer: sign up a tipper", () => ctx.platform.signUp({ prefix: "b8cp" }));
  const settings = await loadMoneySettings(db);
  const destination = stripeId("acct");
  // Onboarding itself is Stripe's page (not followed); the account it leaves behind is the fixture.
  await db
    .insert(schema.payoutAccounts)
    .values({ userId: payee.id, provider: "stripe", providerAccountId: destination, payoutsEnabled: true })
    .onConflictDoUpdate({
      target: schema.payoutAccounts.userId,
      set: { provider: "stripe", providerAccountId: destination, payoutsEnabled: true },
    });
  const gross = connectTipCents(settings.payoutRules.minimumCents, settings.cut.streamerShare);
  const at = new Date(Date.now() - (Math.ceil(settings.payoutRules.holdDays) + 1) * DAY_MS);
  const paymentId = uuidv7(at.getTime());
  await db.transaction(async (tx) => {
    const [tip] = await tx
      .insert(schema.tips)
      .values({
        fromUserId: payer.id,
        channelId,
        amountCents: gross,
        currency: ext.currency,
        message: "",
        anonymous: false,
        paymentId,
        status: "succeeded",
      })
      .returning({ id: schema.tips.id });
    await tx.insert(schema.payments).values({
      id: paymentId,
      provider: "manual",
      providerRef: `CA-CX${paymentId.replaceAll("-", "").slice(-6).toUpperCase()}`,
      kind: "tip",
      status: "succeeded",
      userId: payer.id,
      channelId,
      tipId: tip?.id ?? null,
      amountCents: gross,
      currency: ext.currency,
      succeededAt: at,
    });
    await post(
      tx,
      paymentSucceeded({
        paymentId,
        paymentKind: "tip",
        provider: "manual",
        settlement: "cash",
        creatorUserId: payee.id,
        grossCents: gross,
        taxCents: 0,
        feeCents: 0,
        currency: ext.currency,
        cut: settings.cut,
        cutHistoryId: settings.cutHistoryId,
        occurredAt: at,
      }),
    );
  });
  ctx.data("b8.connect.fixture", { payee: payee.username, grossCents: gross, paymentId });
  return { payee, destination, gross };
}

async function payoutOf(ext: MoneyB8Extension, userId: string) {
  const r = await ext.treasurer.api.client.money.treasurer.payouts({ limit: 100 });
  return r.items.find((p) => p.user.id === userId) ?? null;
}

async function transferOf(ext: MoneyB8Extension, userId: string) {
  const r = await ext.treasurer.api.client.money.treasurer.transfers({ limit: 100 });
  return r.items.find((x) => x.user.id === userId) ?? null;
}

/** The treasurer's transfers tab: the payee's row status, as the web shows it. */
async function statusInUi(ext: MoneyB8Extension, transferId: string): Promise<string | null> {
  const { ctx, treasurer } = ext;
  const session = await WebSession.open({
    fleet: ctx.platform.fleet,
    engine: "chromium",
    webUrl: ctx.env.HARNESS_WEB_URL,
    probeScript: "",
    label: "treasurer (transfers)",
    log: ctx.log,
  });
  ctx.defer(() => session.close());
  const signin = await session.goto(ROUTES.signin);
  await signInViaUi(signin, treasurer, UI_TIMEOUT_MS, ctx.signal);
  await byTestId(signin, T.navUser, { username: treasurer.username }).waitFor({ timeout: UI_TIMEOUT_MS });
  const page = await session.goto(W1_ROUTES.treasury);
  await byTestId(page, T.treasury).waitFor({ timeout: UI_TIMEOUT_MS });
  await page.locator(`[data-testid="${TREASURY_TAB_TRANSFERS}"]`).click({ timeout: UI_TIMEOUT_MS });
  await page.locator(`[data-testid="${PAYOUT_TRANSFERS}"]`).waitFor({ timeout: UI_TIMEOUT_MS });
  const status = page.locator(`[data-transfer-id="${transferId}"] [data-testid="${PAYOUT_TRANSFER_STATUS}"]`);
  await status.waitFor({ timeout: UI_TIMEOUT_MS });
  return status.getAttribute("data-status");
}

export async function stepConnectTransfer(ext: MoneyB8Extension): Promise<void> {
  const { ctx, treasurer } = ext;
  paid = null;
  const db = createDb({ url: ext.databaseUrl, max: 2, applicationName: "commonair-harness-b8-connect" });
  ctx.defer(() => db.close());

  const { payee, destination } = await fundedPayee(ext, db.db);
  const run = await ctx.step("connect-transfer: treasurer runs this month's payouts", () =>
    treasurer.api.client.money.treasurer.runPayouts({ periodEnd: new Date().toISOString() }),
  );
  ctx.data("b8.connect.payoutRun", run);
  const payout = await payoutOf(ext, payee.id);
  ctx.assert("the run created the payee's payout", payout !== null, { payout });
  if (!payout) return;

  if (ext.provider !== "stripe") {
    // The manual adapter has no transfer: nothing is scheduled, queued or sent.
    await Bun.sleep(3_000);
    const rows = await db.sql<{ id: string }[]>`
      select id::text as id from payout_transfers where payout_id::text = ${payout.id}`;
    ctx.assert("PAYMENTS_PROVIDER=manual: the run created no Connect transfer", rows.length === 0, { rows });
    ctx.check("the payout waits for the treasurer, pending", payout.status === "pending", payout);
    ctx.log.info("connect-transfer: the Connect path runs with --set provider=stripe --set via=api");
    return;
  }

  ctx.check(
    "the Stripe payout left the run scheduled (or already paid)",
    ["scheduled", "paid"].includes(payout.status),
    payout,
  );
  const transfer = await ctx.step("connect-transfer: the worker's transfer is created", () =>
    waitFor(
      "the payee's transfer is created",
      async () => {
        const t = await transferOf(ext, payee.id);
        return t && t.status !== "pending" ? t : null;
      },
      { timeoutMs: TRANSFER_TIMEOUT_MS, intervalMs: 1_000, signal: ctx.signal },
    ).catch(() => transferOf(ext, payee.id)),
  );
  ctx.data("b8.connect.transfer", transfer);
  ctx.assert("one Connect transfer, created, for the payout's amount", transfer?.status === "created", transfer);
  if (!transfer || transfer.status !== "created" || !transfer.providerRef) return;
  ctx.check("the transfer moves exactly the payout", transfer.amount.cents === payout.amount.cents, {
    transfer: transfer.amount,
    payout: payout.amount,
  });
  const after = await payoutOf(ext, payee.id);
  ctx.assert("the payout is paid", after?.status === "paid", after);

  const [row] = await db.sql<{ idempotency_key: string; destination_ref: string }[]>`
    select idempotency_key, destination_ref from payout_transfers where id::text = ${transfer.id}`;
  ctx.check(
    "the row's key is the payout's, and it went to the payee's account",
    row?.idempotency_key === `payout-transfer:${payout.id}` && row.destination_ref === destination,
    { key: row?.idempotency_key, destination: row?.destination_ref },
  );
  const onMock = await fetch(
    `${ctx.env.HARNESS_STRIPE_MOCK_URL.replace(/\/+$/, "")}/v1/transfers/${transfer.providerRef}`,
    {
      headers: { authorization: "Bearer sk_test_123" },
      signal: ctx.signal,
    },
  );
  ctx.check("the transfer exists on stripe-mock", onMock.ok, { status: onMock.status });

  const ui = await ctx.step("connect-transfer: the treasury's transfers tab", () => statusInUi(ext, transfer.id));
  ctx.check("payout-transfer-status reads created", ui === "created", { ui });

  const kinds = await postingKinds(db.sql, payout.id);
  ctx.check(
    "the payout was reserved and sent (payout_reserve, payout)",
    kinds.includes("payout") && kinds.includes("payout_reserve"),
    kinds,
  );
  const off = await unbalanced(db.sql, payout.id);
  ctx.assert("the ledger balances: every posting on the payout sums to zero", off.length === 0, off);
  const owed = await creatorBalances(db.db, payee.id, transfer.amount.currency);
  ctx.check("nothing is left owed to the payee", owed.availableCents === 0, owed);

  const events = await db.sql<{ id: string }[]>`
    select id::text as id from events
     where type = 'money.payout_transfer.created' and payload->>'transfer_id' = ${transfer.id}`;
  ctx.check("the money.payout_transfer.created outbox row exists", events.length > 0);

  paid = {
    payee,
    payoutId: payout.id,
    transferId: transfer.id,
    providerRef: transfer.providerRef,
    amountCents: transfer.amount.cents,
    currency: transfer.amount.currency,
    destination,
  };
}

export async function stepTransferReversed(ext: MoneyB8Extension): Promise<void> {
  const { ctx } = ext;
  if (ext.provider !== "stripe" || !ext.stripe) {
    ctx.log.info("transfer-reversed: Stripe only (--set provider=stripe --set via=api); nothing to reverse");
    return;
  }
  const p = paid;
  ctx.assert("connect-transfer paid a transfer to reverse", p !== null);
  if (!p) return;
  const db = createDb({ url: ext.databaseUrl, max: 2, applicationName: "commonair-harness-b8-reversed" });
  ctx.defer(() => db.close());
  const hook = ext.stripe;

  const object = {
    id: p.providerRef,
    object: "transfer",
    amount: p.amountCents,
    amount_reversed: p.amountCents,
    currency: p.currency,
    destination: p.destination,
    reversed: true,
    transfer_group: null,
    metadata: { payout_id: p.payoutId, transfer_id: p.transferId },
  };
  const first = await ctx.step("transfer-reversed: Stripe reverses the whole transfer", () =>
    hook.send(stripeEvent("transfer.reversed", object)),
  );
  ctx.assert("the webhook posted the reversal", first.body.outcome === "transfer_reversed", first.body);
  const again = await ctx.step("transfer-reversed: Stripe redelivers it", () =>
    hook.send(stripeEvent("transfer.reversed", object)),
  );
  ctx.check("a redelivery changes nothing", again.body.outcome === "duplicate", again.body);

  const transfer = await transferOf(ext, p.payee.id);
  ctx.check(
    "the transfer is reversed, every cent",
    transfer?.status === "reversed" && transfer.reversed.cents === p.amountCents,
    transfer,
  );
  const owed = await creatorBalances(db.db, p.payee.id, p.currency);
  ctx.assert("the amount is back in the payee's payable", owed.availableCents === p.amountCents, {
    owed,
    amountCents: p.amountCents,
  });
  const kinds = await postingKinds(db.sql, p.payoutId);
  ctx.check(
    "one payout_transfer_reversal posting",
    kinds.filter((k) => k === "payout_transfer_reversal").length === 1,
    kinds,
  );
  const off = await unbalanced(db.sql, p.payoutId);
  ctx.assert("the ledger balances: every posting on the payout sums to zero", off.length === 0, off);
  const audits = await db.sql<{ action: string }[]>`
    select action from audit_log where subject_type = 'payout_transfer' and subject_id = ${p.transferId}`;
  ctx.check(
    "audit rows: created, then reversed",
    audits.some((a) => a.action === "payout_transfer.created") &&
      audits.some((a) => a.action === "payout_transfer.reversed"),
    audits,
  );
}
