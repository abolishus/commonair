// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `e4b-money` W2 extensions `split-release`, `split-clawback`, `split-won-chargeback` and
 * `split-new-payee` (docs/testing/w2-selectors.md, "Scenarios"; ADR 0013). Each step uses its own
 * actors: a fresh channel owner, a crew member (the account backdated past
 * `splitRecipientMinAccountAgeDays`, a fixture, with a manual payout account the treasurer sets),
 * and a payer. The owner proposes a 2-way split on `/crew` (web) or through the API, and the crew
 * member accepts it the same way.
 *
 * Tips the hold must have passed are fixtures: payment and tip rows written through the owner
 * connection and posted with the ledger's own rules under the accepted version, linked in the same
 * transaction exactly as `postPaymentWithSplit` does, dated past the hold (a live tip would sit
 * inside it). Everything after that runs through the product: the treasurer's payout run releases
 * due holds per recipient (`releaseDueHolds`) and runs the batch with the fraud floor, the
 * treasurer records chargebacks, `/transparency` shows the split lines. The manual adapter has no
 * won-dispute path (a won dispute is a Stripe event), so `split-won-chargeback` posts the ledger's
 * `postChargebackReversal` for the treasurer's chargeback, as the Stripe handler does.
 */
import { FRAUD_REVIEW_HOLD } from "@commonair/contracts/enums";
import { createDb, type Database, schema, uuidv7 } from "@commonair/db";
import {
  type PlatformCut,
  ReversalMetaV2,
  creatorBalances,
  holdReleaseKey,
  loadMoneySettings,
  paymentHoldRemaining,
  paymentSucceeded,
  post,
  postChargebackReversal,
  splitNet,
  splitNetN,
} from "@commonair/ledger";
import type { Locator, Page } from "playwright";
import type { SignedInUser } from "../users.ts";
import { waitFor } from "../wait.ts";
import { signInViaUi } from "../web/flows.ts";
import { ROUTES, TEST_IDS as T } from "../web/selectors.ts";
import { WebSession, byTestId } from "../web/session.ts";
import type { MoneyExtension } from "./kit.ts";

const DAY_MS = 86_400_000;
const UI_TIMEOUT_MS = 20_000;
/** The crew member's share in every step. */
export const CREW_BPS = 2000;
/** Gross of each fixture tip (no tax, no fee). */
export const SPLIT_TIP_CENTS = 2000;

/** `/crew` test ids (docs/testing/w2-selectors.md "Crew"). */
export const CREW_IDS = {
  page: "crew-page",
  form: "crew-propose-form",
  recipient: "crew-recipient",
  bps: "crew-bps",
  preview: "crew-preview",
  submit: "crew-propose-submit",
  split: "crew-split",
  accept: "crew-accept",
  payoutNote: "crew-payout-note",
  writeOff: "transparency-split-writeoff",
  suspense: "transparency-split-suspense",
} as const;
export const CREW_ROUTE = "/crew";
const TRANSPARENCY_ROUTE = "/transparency";

export function crewTid(id: string, data: Record<string, string> = {}): string {
  const attrs = Object.entries(data)
    .map(([k, v]) => `[data-${k}="${v.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"]`)
    .join("");
  return `[data-testid="${id}"]${attrs}`;
}
const byCrewId = (scope: Page | Locator, id: string, data?: Record<string, string>) => scope.locator(crewTid(id, data));

/** The preview's priced attributes, as the propose form renders them (empty until the form is complete). */
export interface CrewPreviewAttributes {
  getAttribute(name: string, opts?: { timeout?: number }): Promise<string | null>;
}

/**
 * The recipient's and the example's cents from the propose form's preview, once it is priced. The
 * page prices the example only after `money.support` answers with the instance's cut, so a read
 * right after filling the form can see the unpriced (empty) preview. Waits for a value; never
 * accepts an empty or non-numeric one.
 */
export async function readCrewPreview(
  preview: CrewPreviewAttributes,
  opts: { timeoutMs: number; intervalMs?: number; signal?: AbortSignal },
): Promise<{ recipientCents: number; exampleCents: number }> {
  const recipientCents = await waitFor(
    "crew-preview priced",
    async () => {
      const raw = (await preview.getAttribute("data-recipient-cents", { timeout: opts.timeoutMs })) ?? "";
      return /^\d+$/.test(raw) ? Number(raw) : null;
    },
    { timeoutMs: opts.timeoutMs, intervalMs: opts.intervalMs ?? 100, ...(opts.signal ? { signal: opts.signal } : {}) },
  );
  const exampleCents = Number((await preview.getAttribute("data-example-cents")) ?? "");
  return { recipientCents, exampleCents };
}

/**
 * When the fixture tips succeeded: `released` past the hold and a new crew recipient's extra days
 * (both lots due), `ownerOnly` past the hold only (the owner's lot due, a first crew lot not yet).
 */
export function splitFixtureDates(
  now: Date,
  holdDays: number,
  newRecipientHoldDays: number,
): { released: Date; ownerOnly: Date } {
  const released = Math.ceil(holdDays + newRecipientHoldDays) + 1;
  const ownerOnly = Math.ceil(holdDays) + 1;
  if (ownerOnly >= released) throw new RangeError("the new-recipient hold adds no days");
  return {
    released: new Date(now.getTime() - released * DAY_MS),
    ownerOnly: new Date(now.getTime() - ownerOnly * DAY_MS),
  };
}

/** Each recipient's slice of a tip under the split, with the ledger's own rounding. */
export function expectedSlices(
  grossCents: number,
  cut: PlatformCut,
  owner: string,
  crew: string,
  crewBps = CREW_BPS,
): { owner: number; crew: number; creator: number } {
  const { creatorCents } = splitNet(grossCents, cut);
  const shares = splitNetN(creatorCents, owner, [{ userId: crew, bps: crewBps }]);
  const of = (id: string) => shares.find((s) => s.userId === id.toLowerCase())?.creatorCents ?? 0;
  return { owner: of(owner), crew: of(crew), creator: creatorCents };
}

/**
 * The released fixture's crew slice is earned (released, or reserved by the run's payout) and the
 * only crew hold left is what live tips still inside the hold put there.
 */
export function crewEarnedSlice(
  crewNow: { liabilityCents: number; reservedCents: number; holdCents: number },
  releasedCrewCents: number,
  liveHeldCents: number,
): boolean {
  return crewNow.liabilityCents + crewNow.reservedCents === releasedCrewCents && crewNow.holdCents === liveHeldCents;
}

/**
 * What a chargeback leaves the owner owing (ADR 0013 decision 5). The owner covers the rest of its
 * own slice first and then the crew's, from its released earnings and held lots as they stood
 * before the chargeback (`ownerBefore`, less what its own lot already gave). Whatever is left of
 * its own slice becomes the clawback receivable, and whatever is left of the crew's becomes the
 * split shortfall. A payout run that reserves nothing (each slice under the payout minimum) leaves
 * the owner's slice in released earnings, so the receivable is then 0.
 */
export function ownerClawbackOwed(
  ownerBefore: { liabilityCents: number; holdCents: number },
  ownerSlice: { sliceCents: number; fromOwnLotCents: number },
  crewOwnerCoveredCents: number,
): { receivableCents: number; splitShortfallCents: number } {
  let sources =
    Math.max(0, ownerBefore.liabilityCents) + Math.max(0, ownerBefore.holdCents - ownerSlice.fromOwnLotCents);
  const ownRest = ownerSlice.sliceCents - ownerSlice.fromOwnLotCents;
  const own = Math.min(ownRest, sources);
  sources -= own;
  const crew = Math.min(crewOwnerCoveredCents, sources);
  return { receivableCents: ownRest - own, splitShortfallCents: crewOwnerCoveredCents - crew };
}

/**
 * A gross (at least `SPLIT_TIP_CENTS`) whose crew slice reaches the payout minimum, so
 * the run creates the crew member's first payout: a 2000 tip's 360 crew slice is under the
 * seeded 2500 minimum and would be carried over instead.
 */
export function crewPayoutTipCents(
  minimumCents: number,
  cut: PlatformCut,
  owner: string,
  crew: string,
  crewBps = CREW_BPS,
): number {
  let gross = Math.max(SPLIT_TIP_CENTS, Math.ceil((minimumCents * 10_000) / (crewBps * cut.streamerShare)));
  // The proportional estimate ignores rounding; step up the few cents it can miss.
  for (let i = 0; i < 1000; i++, gross++) {
    if (expectedSlices(gross, cut, owner, crew, crewBps).crew >= minimumCents) return gross;
  }
  throw new RangeError("no tip reaches the payout minimum for the crew slice");
}

interface SplitSetup {
  owner: SignedInUser;
  crew: SignedInUser;
  payer: SignedInUser;
  channel: string;
  channelId: string;
  versionId: string;
  db: Database;
  sql: ReturnType<typeof createDb>["sql"];
  cut: PlatformCut;
  holdDays: number;
  newRecipientHoldDays: number;
  minimumPayoutCents: number;
}

async function openAs(ext: MoneyExtension, label: string, user: SignedInUser, path: string): Promise<Page> {
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

/** Owner, crew and payer for one step; the split proposed and accepted (web or API, per `via`). */
async function setUp(ext: MoneyExtension, prefix: string): Promise<SplitSetup> {
  const { ctx, treasurer } = ext;
  const p = ctx.platform;
  const handle = createDb({ url: ext.databaseUrl, max: 2, applicationName: `commonair-harness-${prefix}` });
  ctx.defer(() => handle.close());
  const db = handle.db;
  const [owner, crew, payer] = await ctx.step(`${prefix}: sign up an owner, a crew member and a payer`, () =>
    Promise.all([
      p.signUp({ prefix: `${prefix}o` }),
      p.signUp({ prefix: `${prefix}c` }),
      p.signUp({ prefix: `${prefix}p` }),
    ]),
  );
  const channel = owner.me.channelSlug ?? owner.username;
  const channelId = (await owner.api.client.channels.get({ channel })).id;
  const settings = await loadMoneySettings(db);
  const minAge = settings.payoutRules.splitRecipientMinAccountAgeDays;
  // Fixture: a recipient's account must be old enough (decision (i)); a fresh signup is not.
  await ctx.step(`${prefix}: backdate the crew account ${minAge + 1} days (fixture)`, () =>
    handle.sql`update users set created_at = now() - make_interval(days => ${minAge + 1}) where id = ${crew.id}`.then(
      () => undefined,
    ),
  );
  await ctx.step(`${prefix}: treasurer sets the crew member's manual payout account`, () =>
    treasurer.api.client.money.treasurer.setPayoutAccount({
      username: crew.username,
      payoutsEnabled: true,
      reference: `harness ${prefix}`,
    }),
  );

  let versionId: string;
  if (ext.via === "web") {
    const page = await ctx.step(`${prefix}: owner opens /crew`, () =>
      openAs(ext, `${prefix} owner`, owner, CREW_ROUTE),
    );
    await byCrewId(page, CREW_IDS.page).waitFor({ timeout: UI_TIMEOUT_MS });
    ctx.check("crew-payout-note is shown", (await byCrewId(page, CREW_IDS.payoutNote).count()) === 1);
    await ctx.step(`${prefix}: owner fills the propose form`, async () => {
      await byCrewId(page, CREW_IDS.recipient).first().fill(crew.username, { timeout: UI_TIMEOUT_MS });
      await byCrewId(page, CREW_IDS.bps).first().fill(String(CREW_BPS), { timeout: UI_TIMEOUT_MS });
    });
    const { recipientCents: previewCents, exampleCents: example } = await readCrewPreview(
      byCrewId(page, CREW_IDS.preview),
      { timeoutMs: UI_TIMEOUT_MS, signal: ctx.signal },
    );
    const expected = expectedSlices(example, settings.cut, owner.id, crew.id);
    ctx.check("crew-preview prices the example tip for the recipient", previewCents === expected.crew, {
      previewCents,
      expected,
    });
    await ctx.step(`${prefix}: owner proposes the split`, async () => {
      await byCrewId(page, CREW_IDS.submit).click({ timeout: UI_TIMEOUT_MS });
      await byCrewId(page, CREW_IDS.split, { status: "proposed" }).first().waitFor({ timeout: UI_TIMEOUT_MS });
    });
    versionId =
      (await byCrewId(page, CREW_IDS.split, { status: "proposed" }).first().getAttribute("data-split-id")) ?? "";
    const crewPage = await ctx.step(`${prefix}: crew member opens /crew`, () =>
      openAs(ext, `${prefix} crew`, crew, CREW_ROUTE),
    );
    await ctx.step(`${prefix}: crew member accepts`, async () => {
      const row = byCrewId(crewPage, CREW_IDS.split, { "split-id": versionId });
      await byCrewId(row, CREW_IDS.accept).click({ timeout: UI_TIMEOUT_MS });
      await byCrewId(crewPage, CREW_IDS.split, { "split-id": versionId, status: "accepted" }).waitFor({
        timeout: UI_TIMEOUT_MS,
      });
    });
  } else {
    const proposed = await ctx.step(`${prefix}: owner proposes a 2-way split (API)`, () =>
      owner.api.client.money.splits.propose({
        channel,
        basis: "tips",
        shares: [{ username: crew.username, bps: CREW_BPS }],
      }),
    );
    versionId = proposed.id;
    const accepted = await ctx.step(`${prefix}: crew member accepts (API)`, () =>
      crew.api.client.money.splits.accept({ id: proposed.id }),
    );
    ctx.assert("the split is accepted once its recipient accepts", accepted.status === "accepted", accepted);
  }
  const [row] = await handle.sql<{ status: string }[]>`select status from revenue_splits where id = ${versionId}`;
  ctx.assert("the split version is accepted", row?.status === "accepted", row);
  return {
    owner,
    crew,
    payer,
    channel,
    channelId,
    versionId,
    db,
    sql: handle.sql,
    cut: settings.cut,
    holdDays: settings.payoutRules.holdDays,
    newRecipientHoldDays: settings.payoutRules.splitNewRecipientHoldDays,
    minimumPayoutCents: settings.payoutRules.minimumCents,
  };
}

/** A fixture tip under the split (rows, posting and link in one transaction). */
async function fixtureTip(s: SplitSetup, currency: string, at: Date, cents = SPLIT_TIP_CENTS): Promise<string> {
  const paymentId = uuidv7(at.getTime());
  const crew = [{ userId: s.crew.id, bps: CREW_BPS }];
  await s.db.transaction(async (tx) => {
    const [tip] = await tx
      .insert(schema.tips)
      .values({
        fromUserId: s.payer.id,
        channelId: s.channelId,
        amountCents: cents,
        currency,
        message: "",
        anonymous: false,
        paymentId,
        status: "succeeded",
      })
      .returning({ id: schema.tips.id });
    await tx.insert(schema.payments).values({
      id: paymentId,
      provider: "manual",
      providerRef: `CA-SP${paymentId.replaceAll("-", "").slice(-6).toUpperCase()}`,
      kind: "tip",
      status: "succeeded",
      userId: s.payer.id,
      channelId: s.channelId,
      tipId: tip?.id ?? null,
      amountCents: cents,
      currency,
      succeededAt: at,
    });
    const r = await post(
      tx,
      paymentSucceeded({
        paymentId,
        paymentKind: "tip",
        provider: "manual",
        settlement: "cash",
        creatorUserId: s.owner.id,
        grossCents: cents,
        taxCents: 0,
        feeCents: 0,
        currency,
        cut: s.cut,
        cutHistoryId: null,
        occurredAt: at,
        split: { versionId: s.versionId, crew },
      }),
    );
    await tx.insert(schema.revenueSplitPostings).values({ ledgerTransactionId: r.transactionId, splitId: s.versionId });
  });
  return paymentId;
}

/** The treasurer's payout run for this month: it releases due holds first, then runs the batch. */
async function runPayouts(ext: MoneyExtension, label: string) {
  const run = await ext.ctx.step(`${label}: treasurer runs this month's payouts (releases due holds)`, () =>
    ext.treasurer.api.client.money.treasurer.runPayouts({ periodEnd: new Date().toISOString() }),
  );
  ext.ctx.data(`w2.splits.${label}.payoutRun`, run);
  return run;
}

async function released(s: SplitSetup, paymentId: string, userId: string): Promise<boolean> {
  const rows = await s.sql<{ id: string }[]>`
    select id from ledger_transactions where idempotency_key = ${holdReleaseKey(paymentId, userId)}`;
  return rows.length === 1;
}

async function ledgerSumsToZero(ext: MoneyExtension, s: SplitSetup, label: string): Promise<void> {
  const rows = await s.sql<{ currency: string; total: string }[]>`
    select currency, sum(amount_cents)::text as total from ledger_entries group by currency`;
  const off = rows.filter((r) => Number(r.total) !== 0);
  ext.ctx.assert(`${label}: the ledger sums to zero in every currency`, off.length === 0, off);
}

async function chargebackOf(ext: MoneyExtension, s: SplitSetup, paymentId: string, label: string) {
  await ext.ctx.step(`${label}: treasurer records a full chargeback`, () =>
    ext.treasurer.api.client.money.treasurer.chargeback({
      paymentId,
      amountCents: SPLIT_TIP_CENTS,
      reason: "harness: split chargeback",
    }),
  );
  const [cb] = await s.sql<{ metadata: unknown }[]>`
    select metadata from ledger_transactions where kind = 'chargeback' and ref_id = ${paymentId}
    order by created_at desc limit 1`;
  return cb ? ReversalMetaV2.parse(cb.metadata) : null;
}

/** A 2-way split proposed and accepted; a live tip is posted under it; a tip releases holds to both. */
export async function stepSplitRelease(ext: MoneyExtension): Promise<void> {
  const { ctx } = ext;
  const s = await setUp(ext, "w2sr");

  const expected = expectedSlices(SPLIT_TIP_CENTS, s.cut, s.owner.id, s.crew.id);
  // A live tip through the product's posting site (the manual adapter's confirmation). It is
  // inside the hold, so its crew lot stays held after the payout run.
  let liveHeldCents = 0;
  if (ext.provider === "manual") {
    const tip = await ctx.step("w2sr: payer tips the owner", () =>
      s.payer.api.client.money.tip({
        channel: s.channel,
        amountCents: SPLIT_TIP_CENTS,
        message: "",
        anonymous: false,
        returnPath: `/${s.channel}`,
      }),
    );
    await ctx.step("w2sr: treasurer confirms the tip", () =>
      ext.treasurer.api.client.money.treasurer.confirm({
        paymentId: tip.paymentId,
        receivedAt: new Date().toISOString(),
        note: "",
      }),
    );
    const [tx] = await s.sql<{ id: string; metadata: { splitVersionId?: unknown } }[]>`
      select id, metadata from ledger_transactions where idempotency_key = ${`payment:${tip.paymentId}`}`;
    const [link] = tx
      ? await s.sql<{ splitId: string }[]>`
          select split_id as "splitId" from revenue_split_postings where ledger_transaction_id = ${tx.id}`
      : [];
    ctx.assert(
      "the confirmed tip is posted under the split version and linked in its transaction",
      tx?.metadata.splitVersionId === s.versionId && link?.splitId === s.versionId,
      { metadata: tx?.metadata, link },
    );
    liveHeldCents = await paymentHoldRemaining(s.db, tip.paymentId, s.crew.id, ext.currency);
    ctx.assert("the live tip's crew slice is held", liveHeldCents === expected.crew, { liveHeldCents, expected });
  } else {
    ctx.skipStep(
      "w2sr: a live tip under the split",
      "the provider is Stripe; money-stripe.int.test.ts covers its posting site",
    );
  }

  const dates = splitFixtureDates(new Date(), s.holdDays, s.newRecipientHoldDays);
  const paymentId = await ctx.step("w2sr: a tip past the hold (fixture)", () =>
    fixtureTip(s, ext.currency, dates.released),
  );
  await runPayouts(ext, "w2sr");
  const both = (await released(s, paymentId, s.owner.id)) && (await released(s, paymentId, s.crew.id));
  ctx.assert("the tip's hold is released once per recipient (owner and crew)", both, { paymentId });
  const crewNow = await creatorBalances(s.db, s.crew.id, ext.currency);
  ctx.assert(
    "the crew member earned exactly their slice (released or reserved for a payout)",
    crewEarnedSlice(crewNow, expected.crew, liveHeldCents) &&
      (await paymentHoldRemaining(s.db, paymentId, s.crew.id, ext.currency)) === 0,
    { crewNow, expected, liveHeldCents },
  );
  await ledgerSumsToZero(ext, s, "w2sr");
}

/** A chargeback claws back per the policy (own lot first, the owner absorbs, no crew receivable); transparency lines. */
export async function stepSplitClawback(ext: MoneyExtension): Promise<void> {
  const { ctx } = ext;
  const s = await setUp(ext, "w2sc");
  const dates = splitFixtureDates(new Date(), s.holdDays, s.newRecipientHoldDays);
  const paymentId = await ctx.step("w2sc: a tip past the hold (fixture)", () =>
    fixtureTip(s, ext.currency, dates.released),
  );
  // The run releases both lots. Whether it also reserves payouts depends on the payout minimum
  // (the seeded 2500 is above both slices), so the owner's expectation is computed from its
  // balances just before the chargeback.
  await runPayouts(ext, "w2sc");
  const crewBefore = await creatorBalances(s.db, s.crew.id, ext.currency);
  const ownerBefore = await creatorBalances(s.db, s.owner.id, ext.currency);
  const meta = await chargebackOf(ext, s, paymentId, "w2sc");
  const expected = expectedSlices(SPLIT_TIP_CENTS, s.cut, s.owner.id, s.crew.id);
  const crewSlice = meta?.shares.find((x) => x.userId === s.crew.id.toLowerCase());
  ctx.assert(
    "the crew slice came from no crew account: the owner covered it",
    crewSlice?.fromOwnLotCents === 0 && crewSlice.ownerCoveredCents === expected.crew,
    meta,
  );
  const crewAfter = await creatorBalances(s.db, s.crew.id, ext.currency);
  ctx.assert(
    "the crew member's balances are untouched and they owe nothing",
    crewAfter.liabilityCents === crewBefore.liabilityCents &&
      crewAfter.reservedCents === crewBefore.reservedCents &&
      crewAfter.receivableCents === 0 &&
      crewAfter.splitShortfallCents === 0,
    { crewBefore, crewAfter },
  );
  const owner = await creatorBalances(s.db, s.owner.id, ext.currency);
  const ownerSlice = meta?.shares.find((x) => x.userId === s.owner.id.toLowerCase());
  const owed = ownerClawbackOwed(
    ownerBefore,
    { sliceCents: expected.owner, fromOwnLotCents: ownerSlice?.fromOwnLotCents ?? 0 },
    crewSlice?.ownerCoveredCents ?? 0,
  );
  ctx.assert(
    "what the owner could not cover is its receivable (own slice) and split shortfall (the crew's)",
    owner.receivableCents - ownerBefore.receivableCents === owed.receivableCents &&
      owner.splitShortfallCents - ownerBefore.splitShortfallCents === owed.splitShortfallCents &&
      owed.splitShortfallCents > 0,
    { ownerBefore, owner, expected, owed },
  );

  // The transparency page's split lines.
  const months = await ctx.step("w2sc: read /transparency (API)", () =>
    s.payer.api.client.coop.transparency({ months: 1 }),
  );
  const month = months[0];
  ctx.check("transparency months carry splitSuspense", month?.splitSuspense !== undefined, month?.splitSuspense);
  if (ext.via === "web") {
    const page = await ctx.step("w2sc: open /transparency", () =>
      openAs(ext, "w2sc payer", s.payer, TRANSPARENCY_ROUTE),
    );
    for (const id of [CREW_IDS.writeOff, CREW_IDS.suspense]) {
      const el = byCrewId(page, id);
      await el.waitFor({ timeout: UI_TIMEOUT_MS }).catch(() => undefined);
      const cents = await el.getAttribute("data-cents").catch(() => null);
      ctx.assert(`${id} is shown with integer cents`, cents !== null && Number.isInteger(Number(cents)), { cents });
    }
    const writeOff = month?.costs.find((c) => c.category === "split-shortfall-writeoff")?.amount.cents ?? 0;
    const shown = Number((await byCrewId(page, CREW_IDS.writeOff).getAttribute("data-cents")) ?? "NaN");
    ctx.check("transparency-split-writeoff matches the month's write-off cost line", shown === writeOff, {
      shown,
      writeOff,
    });
  }
  await ledgerSumsToZero(ext, s, "w2sc");
}

/** A won chargeback restores each slice to where it came from. */
export async function stepSplitWonChargeback(ext: MoneyExtension): Promise<void> {
  const { ctx } = ext;
  const s = await setUp(ext, "w2sw");
  // Inside the hold: the chargeback takes each slice back from its own lot.
  const paymentId = await ctx.step("w2sw: a tip inside the hold (fixture)", () =>
    fixtureTip(s, ext.currency, new Date()),
  );
  const meta = await chargebackOf(ext, s, paymentId, "w2sw");
  const expected = expectedSlices(SPLIT_TIP_CENTS, s.cut, s.owner.id, s.crew.id);
  ctx.assert(
    "the chargeback took each slice from its own lot",
    meta?.shares.every((x) => x.ownerCoveredCents === 0) === true,
    meta,
  );
  // The manual adapter has no won-dispute event: post the ledger's reversal, as the Stripe handler does.
  await ctx.step("w2sw: the dispute is won (postChargebackReversal, as charge.dispute.closed does)", async () => {
    if (!meta) throw new Error("no chargeback posted");
    await postChargebackReversal(s.db, { disputeId: meta.disputeId, occurredAt: new Date() });
  });
  const [owner, crew] = await Promise.all([
    creatorBalances(s.db, s.owner.id, ext.currency),
    creatorBalances(s.db, s.crew.id, ext.currency),
  ]);
  ctx.assert(
    "each slice is restored to its recipient's released earnings, and nothing is held again",
    owner.liabilityCents === expected.owner &&
      crew.liabilityCents === expected.crew &&
      owner.holdCents === 0 &&
      crew.holdCents === 0 &&
      owner.splitShortfallCents === 0,
    { owner, crew, expected },
  );
  await ledgerSumsToZero(ext, s, "w2sw");
}

/** A fresh recipient's extra hold, a chargeback, and their first payout held by `new_payee`. */
export async function stepSplitNewPayee(ext: MoneyExtension): Promise<void> {
  const { ctx } = ext;
  const s = await setUp(ext, "w2sn");
  const dates = splitFixtureDates(new Date(), s.holdDays, s.newRecipientHoldDays);
  // Big enough that the crew slice reaches the payout minimum, so the run creates their first payout.
  const oldCents = crewPayoutTipCents(s.minimumPayoutCents, s.cut, s.owner.id, s.crew.id);
  const old = await ctx.step("w2sn: a tip past the new-recipient hold (fixture)", () =>
    fixtureTip(s, ext.currency, dates.released, oldCents),
  );
  const young = await ctx.step("w2sn: a tip past the hold only (fixture)", () =>
    fixtureTip(s, ext.currency, dates.ownerOnly),
  );
  const disputed = await ctx.step("w2sn: a tip inside the hold (fixture)", () =>
    fixtureTip(s, ext.currency, new Date()),
  );
  await chargebackOf(ext, s, disputed, "w2sn");
  await runPayouts(ext, "w2sn");
  ctx.assert(
    "the first crew lot waited for the extra days: the younger tip's crew lot is still held",
    (await released(s, old, s.crew.id)) &&
      !(await released(s, young, s.crew.id)) &&
      (await released(s, young, s.owner.id)) &&
      (await paymentHoldRemaining(s.db, young, s.crew.id, ext.currency)) > 0,
    { old, young },
  );
  const flags = await ext.treasurer.api.client.money.treasurer.fraudFlags.list({ limit: 100, status: "open" });
  const flag = flags.items.find((f) => f.payee.username === s.crew.username && f.kind === "new_payee");
  ctx.assert("the crew member's first payout raised new_payee", flag?.status === "open", flag);
  const payouts = await ext.treasurer.api.client.money.treasurer.payouts({ limit: 100 });
  const payout = payouts.items.find((p) => p.user.id === s.crew.id);
  ctx.assert(
    "the crew member's first payout is held for fraud review",
    payout?.status === "held" && payout.holdReason === FRAUD_REVIEW_HOLD,
    payout,
  );
  const crewAccounts = await s.sql<{ code: string }[]>`
    select code from ledger_accounts where owner_user_id = ${s.crew.id} and code like 'asset:receivable:%'`;
  ctx.assert("the chargeback created no receivable on the crew member", crewAccounts.length === 0, crewAccounts);
  await ledgerSumsToZero(ext, s, "w2sn");
}
