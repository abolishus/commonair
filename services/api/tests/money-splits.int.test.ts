// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `money.splits.*` and `money.treasurer.splits.*` (ADR 0013, W2-splits) over HTTP against a real
 * database: the owner-only propose with the account-age, payout-account and owner-as-crew gates,
 * accept and reject, versions that supersede and freeze, the end (never backdated, notifies the
 * crew), the manual adapter's confirmation posting under the version and linking it, and the
 * treasurer's suspense release and forfeit and the two-person split-shortfall write-off, each with
 * its audit and outbox rows. The tests share state and run in order.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import {
  DEFAULT_PLATFORM_CUT,
  accounts,
  creatorBalances,
  postReversal,
  rawBalance,
  releaseDueHolds,
} from "@commonair/ledger";
import { activeSplit, postPaymentWithSplit } from "../src/money/splits.ts";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type Person = Awaited<ReturnType<typeof signUpAndSignIn>>;
interface Split {
  id: string;
  channelSlug: string;
  version: number;
  status: string;
  basis: string;
  startsAt: string;
  endsAt: string | null;
  shares: { recipient: { id: string; username: string }; bps: number; decision: string | null }[];
  acceptedAt: string | null;
  endedAt: string | null;
  awaitingYou: boolean;
}
interface WriteOff {
  id: string;
  owner: { id: string; username: string };
  amount: { cents: number; currency: string };
  status: string;
  approvedBy: { id: string } | null;
}
interface ErrorBody {
  code: string;
  data?: { reason?: string; requirement?: string };
}
type Page<T> = { items: T[]; nextCursor: string | null };

let api: TestApi;
let owner: Person;
let crewA: Person;
let crewB: Person;
let fresh: Person;
let t1: Person;
let t2: Person;
let payer: Person;
const db = () => api.db.db;
const DAY = 86_400_000;

async function age(p: Person, days: number) {
  await db()
    .update(schema.users)
    .set({ createdAt: new Date(Date.now() - days * DAY) })
    .where(eq(schema.users.id, p.userId));
}
async function payoutAccount(p: Person) {
  const r = await t1.client.call("PUT", `/api/treasurer/payout-accounts/${p.username}`, {
    payoutsEnabled: true,
    reference: "bank-ref",
  });
  if (r.status !== 200) throw new Error(`setPayoutAccount: ${r.status}`);
}

beforeAll(async () => {
  api = await startApi();
  [owner, crewA, crewB, fresh, t1, t2, payer] = await Promise.all([
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
  ]);
  await db().update(schema.users).set({ role: "treasurer" }).where(eq(schema.users.id, t1.userId));
  await db().update(schema.users).set({ role: "treasurer" }).where(eq(schema.users.id, t2.userId));
  for (const p of [crewA, crewB]) {
    await age(p, 40);
    await payoutAccount(p);
  }
}, 180_000);
afterAll(async () => {
  await api?.stop();
});

const propose = (as: Person, body: Record<string, unknown>, channel = owner.username) =>
  as.client.call<Split & ErrorBody>("POST", `/api/channels/${channel}/splits`, body);
const accept = (as: Person, id: string) => as.client.call<Split & ErrorBody>("POST", `/api/splits/${id}/accept`, {});
const reject = (as: Person, id: string) => as.client.call<Split & ErrorBody>("POST", `/api/splits/${id}/reject`, {});
const end = (as: Person, id: string, channel = owner.username) =>
  as.client.call<Split & ErrorBody>("POST", `/api/channels/${channel}/splits/${id}/end`, {});
const list = (as: Person, q = "") => as.client.call<Page<Split>>("GET", `/api/splits${q}`);

const channelOf = async (slug: string) => {
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, slug));
  if (!c) throw new Error(`no channel ${slug}`);
  return c;
};
const auditOf = (subjectId: string) =>
  db().select().from(schema.auditLog).where(eq(schema.auditLog.subjectId, subjectId));
const splitEvents = async (splitId: string) =>
  (await db().select().from(schema.events).where(eq(schema.events.type, "channel.split.update"))).filter(
    (e) => e.payload.split_id === splitId,
  );

async function expectLedgerBalanced() {
  const off = await db().execute<{ transaction_id: string }>(sql`
    select transaction_id from ledger_entries group by transaction_id, currency having sum(amount_cents) <> 0`);
  expect([...off]).toEqual([]);
}

/** A tip from `payer` to `channel`, confirmed by the treasurer through the manual adapter. */
async function confirmedTip(channel: string, cents: number): Promise<string> {
  const r = await payer.client.call<{ paymentId: string }>("POST", `/api/channels/${channel}/tips`, {
    returnPath: `/${channel}`,
    amountCents: cents,
    message: "",
    anonymous: false,
  });
  expect(r.status).toBe(200);
  const c = await t1.client.call("POST", `/api/treasurer/payments/${r.body.paymentId}/confirm`, {
    receivedAt: new Date().toISOString(),
  });
  expect(c.status).toBe(200);
  return r.body.paymentId;
}
const paymentTx = async (paymentId: string) => {
  const [tx] = await db()
    .select()
    .from(schema.ledgerTransactions)
    .where(eq(schema.ledgerTransactions.idempotencyKey, `payment:${paymentId}`));
  return tx!;
};

let v1: Split;

describe("propose", () => {
  test("only the owner proposes; the recipient gates come first", async () => {
    expect((await propose(crewA, { basis: "tips", shares: [{ username: crewB.username, bps: 1000 }] })).status).toBe(
      403,
    );
    const unknown = await propose(owner, { basis: "tips", shares: [{ username: "nobody_here_x", bps: 1000 }] });
    expect(unknown.status).toBe(404);
    const self = await propose(owner, { basis: "tips", shares: [{ username: owner.username, bps: 1000 }] });
    expect(self.status).toBe(412);
    expect(self.body.data?.requirement).toBe("split_owner_is_crew");
    const young = await propose(owner, { basis: "tips", shares: [{ username: fresh.username, bps: 1000 }] });
    expect(young.status).toBe(412);
    expect(young.body.data?.requirement).toBe("split_recipient_account_age");
    await age(fresh, 40);
    const noAccount = await propose(owner, { basis: "tips", shares: [{ username: fresh.username, bps: 1000 }] });
    expect(noAccount.status).toBe(412);
    expect(noAccount.body.data?.requirement).toBe("split_recipient_payout_account");
    const past = await propose(owner, {
      basis: "tips",
      shares: [{ username: crewA.username, bps: 1000 }],
      startsAt: new Date(Date.now() - DAY).toISOString(),
    });
    expect(past.status).toBe(400);
  });

  test("a proposal is version 1, proposed, awaiting each recipient, with audit and event", async () => {
    const r = await propose(owner, {
      basis: "all",
      shares: [
        { username: crewA.username, bps: 2000 },
        { username: crewB.username, bps: 1000 },
      ],
    });
    expect(r.status).toBe(200);
    v1 = r.body;
    expect(v1).toMatchObject({ version: 1, status: "proposed", basis: "all", channelSlug: owner.username });
    const byId = new Map(v1.shares.map((s) => [s.recipient.id, s]));
    expect(byId.get(crewA.userId)).toMatchObject({ bps: 2000, decision: null });
    expect(byId.get(crewB.userId)).toMatchObject({ bps: 1000, decision: null });
    expect(v1.shares).toHaveLength(2);
    const audits = await auditOf(v1.id);
    expect(audits.map((a) => a.action)).toEqual(["money.split.propose"]);
    expect(audits[0]?.details).toEqual({ version: 1, status: "proposed", basis: "all", recipients: 2 });
    const evs = await splitEvents(v1.id);
    expect(evs.map((e) => e.payload.status)).toEqual(["proposed"]);
    const ids = (evs[0]?.payload.recipient_user_ids ?? []) as string[];
    expect(new Set(ids)).toEqual(new Set([crewA.userId, crewB.userId]));
    // One open proposal at a time.
    expect((await propose(owner, { basis: "tips", shares: [{ username: crewA.username, bps: 10 }] })).status).toBe(409);
  });

  test("the recipient sees it awaiting them; the owner lists the channel's versions", async () => {
    const mine = await list(crewA);
    expect(mine.body.items.find((s) => s.id === v1.id)?.awaitingYou).toBe(true);
    const theirs = await list(owner, `?channel=${owner.username}`);
    expect(theirs.body.items.map((s) => s.id)).toEqual([v1.id]);
    expect((await list(crewA, `?channel=${owner.username}`)).status).toBe(403);
  });
});

describe("accept and the posting link", () => {
  test("only a recipient answers; the version is accepted once everyone has", async () => {
    expect((await accept(payer, v1.id)).status).toBe(404);
    const first = await accept(crewA, v1.id);
    expect(first.body).toMatchObject({ status: "proposed", awaitingYou: false });
    expect((await accept(crewA, v1.id)).status).toBe(409);
    const tip = await confirmedTip(owner.username, 1000);
    // Not accepted yet: the tip is the owner's alone.
    expect((await paymentTx(tip)).metadata).toMatchObject({ splitVersionId: null });
    const done = await accept(crewB, v1.id);
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("accepted");
    expect((await auditOf(v1.id)).map((a) => a.action).sort()).toEqual(
      ["money.split.accept", "money.split.answer", "money.split.propose"].sort(),
    );
    expect((await splitEvents(v1.id)).map((e) => e.payload.status)).toEqual(["proposed", "proposed", "accepted"]);
  });

  test("the manual adapter's confirmation posts under the version and links it in the same transaction", async () => {
    const tip = await confirmedTip(owner.username, 1000);
    const tx = await paymentTx(tip);
    expect(tx.metadata).toMatchObject({ splitVersionId: v1.id, creatorUserId: owner.userId });
    const [link] = await db()
      .select()
      .from(schema.revenueSplitPostings)
      .where(eq(schema.revenueSplitPostings.ledgerTransactionId, tx.id));
    expect(link?.splitId).toBe(v1.id);
    const crewHold = await rawBalance(db(), accounts.creatorHold(crewA.userId), "usd");
    expect(crewHold).toBeLessThan(0);
    await expectLedgerBalanced();
  });

  test("a version is frozen once linked: its shares never change", async () => {
    const refused = await db()
      .update(schema.revenueSplitShares)
      .set({ bps: 5 })
      .where(eq(schema.revenueSplitShares.splitId, v1.id))
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(refused).toBeInstanceOf(Error);
  });

  test("activeSplit picks the version covering the kind at a time; a subscription is covered by `all`", async () => {
    const c = await channelOf(owner.username);
    expect((await activeSplit(db(), c.id, "subscription", new Date()))?.versionId).toBe(v1.id);
    expect(await activeSplit(db(), c.id, "tip", new Date(Date.now() - 365 * DAY))).toBeNull();
  });
});

describe("versions, reject and end", () => {
  let v2: Split;

  test("a refused proposal is rejected and changes nothing", async () => {
    const r = await propose(owner, { basis: "all", shares: [{ username: crewA.username, bps: 4000 }] });
    expect(r.status).toBe(200);
    const no = await reject(crewA, r.body.id);
    expect(no.body.status).toBe("rejected");
    expect((await auditOf(r.body.id)).map((a) => a.action)).toContain("money.split.reject");
    const c = await channelOf(owner.username);
    expect((await activeSplit(db(), c.id, "tip", new Date()))?.versionId).toBe(v1.id);
  });

  test("a new accepted version supersedes the old one for future revenue", async () => {
    const r = await propose(owner, { basis: "all", shares: [{ username: crewA.username, bps: 3000 }] });
    expect(r.body.version).toBe(3);
    v2 = (await accept(crewA, r.body.id)).body;
    expect(v2.status).toBe("accepted");
    const [old] = await db().select().from(schema.revenueSplits).where(eq(schema.revenueSplits.id, v1.id));
    expect(old?.status).toBe("ended");
    expect((await auditOf(v1.id)).map((a) => a.action)).toContain("money.split.supersede");
    // The superseded version's crew are told, the one dropped from the new version included.
    for (const p of [crewA, crewB]) {
      const notes = await db()
        .select()
        .from(schema.notifications)
        .where(and(eq(schema.notifications.userId, p.userId), eq(schema.notifications.type, "payout")));
      expect(
        notes.some(
          (n) => n.payload.kind === "split_ended" && n.payload.splitId === v1.id && n.payload.reason === "superseded",
        ),
      ).toBe(true);
    }
    const tip = await confirmedTip(owner.username, 1000);
    expect((await paymentTx(tip)).metadata).toMatchObject({ splitVersionId: v2.id });
  });

  test("ending is never backdated, notifies the crew, and later payments are the owner's alone", async () => {
    expect((await end(crewA, v2.id)).status).toBe(403);
    const before = Date.now();
    const r = await end(owner, v2.id);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ended");
    expect(new Date(r.body.endsAt ?? 0).getTime()).toBeGreaterThanOrEqual(before - 60_000);
    const notes = await db()
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.userId, crewA.userId), eq(schema.notifications.type, "payout")));
    expect(notes.some((n) => n.payload.kind === "split_ended" && n.payload.splitId === v2.id)).toBe(true);
    expect((await splitEvents(v2.id)).map((e) => e.payload.status).at(-1)).toBe("ended");
    const tip = await confirmedTip(owner.username, 1000);
    expect((await paymentTx(tip)).metadata).toMatchObject({ splitVersionId: null });
    expect((await end(owner, v2.id)).status).toBe(409);
  });

  test("a future-start version takes over only when it starts, leaving no gap", async () => {
    // crewA's own channel, with crewB as crew, so the owner channel's later tests are unaffected.
    const cur = await propose(
      crewA,
      { basis: "tips", shares: [{ username: crewB.username, bps: 1000 }] },
      crewA.username,
    );
    expect(cur.status).toBe(200);
    const running = (await accept(crewB, cur.body.id)).body;
    expect(running.status).toBe("accepted");
    const startsAt = new Date(Date.now() + 3 * DAY);
    const next = await propose(
      crewA,
      { basis: "tips", shares: [{ username: crewB.username, bps: 2000 }], startsAt: startsAt.toISOString() },
      crewA.username,
    );
    expect(next.status).toBe(200);
    expect((await accept(crewB, next.body.id)).body.status).toBe("accepted");
    const [old] = await db().select().from(schema.revenueSplits).where(eq(schema.revenueSplits.id, running.id));
    expect(old?.status).toBe("ended");
    expect(old?.endsAt?.getTime()).toBe(startsAt.getTime());
    const c = await channelOf(crewA.username);
    expect((await activeSplit(db(), c.id, "tip", new Date(Date.now() + DAY)))?.versionId).toBe(running.id);
    expect((await activeSplit(db(), c.id, "tip", new Date(Date.now() + 4 * DAY)))?.versionId).toBe(next.body.id);
  });
});

describe("treasurer: suspense and write-off", () => {
  let gone: Person;
  let writeOff: WriteOff;

  test("a withheld share is released only once the restriction is lifted, with its audit row", async () => {
    const c = await channelOf(owner.username);
    const paymentId = uuidv7();
    const { cut, cutHistoryId } = { cut: DEFAULT_PLATFORM_CUT, cutHistoryId: null };
    // A split payment past the hold whose crew member is suspended at release.
    const [v] = await db()
      .insert(schema.revenueSplits)
      .values({ channelId: c.id, version: 10, basis: "tips", startsAt: new Date(Date.now() - 20 * DAY) })
      .returning();
    await db().insert(schema.revenueSplitShares).values({ splitId: v!.id, recipientUserId: crewB.userId, bps: 3000 });
    await db()
      .insert(schema.revenueSplitAcceptances)
      .values({ splitId: v!.id, recipientUserId: crewB.userId, decision: "accepted" });
    await db()
      .update(schema.revenueSplits)
      .set({ status: "accepted", acceptedAt: new Date(Date.now() - 20 * DAY) })
      .where(eq(schema.revenueSplits.id, v!.id));
    await db().transaction((tx) =>
      postPaymentWithSplit(tx, {
        channelId: c.id,
        paymentId,
        paymentKind: "tip",
        provider: "manual",
        creatorUserId: owner.userId,
        grossCents: 2000,
        taxCents: 0,
        feeCents: 0,
        currency: "usd",
        cut,
        cutHistoryId,
        occurredAt: new Date(Date.now() - 19 * DAY),
      }),
    );
    await db().update(schema.users).set({ banned: true }).where(eq(schema.users.id, crewB.userId));
    await releaseDueHolds(db(), { asOf: new Date(), holdDays: 7, currency: "usd", newRecipientHoldDays: 7 });
    expect(await rawBalance(db(), accounts.splitSuspense(crewB.userId), "usd")).toBe(-540);

    const refused = await t1.client.call<ErrorBody>(
      "POST",
      `/api/treasurer/split-suspense/${crewB.username}/release`,
      {},
    );
    expect(refused.status).toBe(412);
    expect(refused.body.data?.requirement).toBe("split_still_restricted");
    expect(
      (await crewA.client.call("POST", `/api/treasurer/split-suspense/${crewB.username}/release`, {})).status,
    ).toBe(403);
    await db().update(schema.users).set({ banned: false }).where(eq(schema.users.id, crewB.userId));
    const r = await t1.client.call<{ released: { cents: number } }>(
      "POST",
      `/api/treasurer/split-suspense/${crewB.username}/release`,
      {},
    );
    expect(r.status).toBe(200);
    expect(r.body.released.cents).toBe(540);
    expect(await rawBalance(db(), accounts.splitSuspense(crewB.userId), "usd")).toBe(0);
    const [tx] = await db()
      .select()
      .from(schema.ledgerTransactions)
      .where(eq(schema.ledgerTransactions.kind, "split_suspense_release"));
    const audits = await auditOf(tx!.id);
    expect(audits.map((a) => [a.action, a.actorId])).toEqual([["money.split.suspense.release", t1.userId]]);
    expect(
      (await t1.client.call<ErrorBody>("POST", `/api/treasurer/split-suspense/${crewB.username}/release`, {})).body.data
        ?.requirement,
    ).toBe("split_nothing_withheld");
  });

  test("a terminated recipient's withheld share is forfeited to the owner, never the co-op", async () => {
    // Withhold crewA's crew lot of the earlier split tips by deleting the account.
    await db().update(schema.users).set({ deletedAt: new Date() }).where(eq(schema.users.id, crewA.userId));
    const lots = await db().execute<{ payment_id: string }>(sql`
      select distinct split_part(e.memo, ':', 2) as payment_id from ledger_entries e
      join ledger_accounts a on a.id = e.account_id
      where a.code = ${`liability:creator-hold:${crewA.userId}@usd`}`);
    expect(lots.length).toBeGreaterThan(0);
    // Release now, as if the hold had passed.
    await releaseDueHolds(db(), { asOf: new Date(), holdDays: 0, currency: "usd", newRecipientHoldDays: 0 });
    const withheld = -(await rawBalance(db(), accounts.splitSuspense(crewA.userId), "usd"));
    expect(withheld).toBeGreaterThan(0);
    // The treasurer finds the recipient in the suspense list (a deleted account's name is its pseudonym).
    type Listed = {
      recipient: { id: string; username: string };
      withheld: { cents: number };
      restricted: boolean;
      forfeitable: boolean;
    };
    const list = await t2.client.call<{ items: Listed[] }>("GET", "/api/treasurer/split-suspense");
    expect(list.status).toBe(200);
    expect(list.body.items.find((i) => i.recipient.id === crewA.userId)).toEqual({
      recipient: { id: crewA.userId, username: crewA.username },
      withheld: { cents: withheld, currency: "usd" },
      restricted: true,
      forfeitable: true,
    });
    expect((await crewB.client.call("GET", "/api/treasurer/split-suspense")).status).toBe(403);
    const before = (await creatorBalances(db(), owner.userId, "usd")).liabilityCents;
    const r = await t2.client.call<{ forfeited: { cents: number } }>(
      "POST",
      `/api/treasurer/split-suspense/${crewA.username}/forfeit`,
      {},
    );
    expect(r.status).toBe(200);
    expect(r.body.forfeited.cents).toBe(withheld);
    expect((await creatorBalances(db(), owner.userId, "usd")).liabilityCents).toBe(before + withheld);
    const after = await t2.client.call<{ items: Listed[] }>("GET", "/api/treasurer/split-suspense");
    expect(after.body.items.map((i) => i.recipient.id)).not.toContain(crewA.userId);
    gone = crewA;
  });

  test("a split shortfall is written off only when due, by two different finance people", async () => {
    // A fresh owner whose crew share was released, then the owner is drained and refunds the tip.
    const shortOwner = await signUpAndSignIn(api);
    const c = await channelOf(shortOwner.username);
    const [v] = await db()
      .insert(schema.revenueSplits)
      .values({ channelId: c.id, version: 1, basis: "tips", startsAt: new Date(Date.now() - 20 * DAY) })
      .returning();
    await db().insert(schema.revenueSplitShares).values({ splitId: v!.id, recipientUserId: crewB.userId, bps: 5000 });
    await db()
      .insert(schema.revenueSplitAcceptances)
      .values({ splitId: v!.id, recipientUserId: crewB.userId, decision: "accepted" });
    await db()
      .update(schema.revenueSplits)
      .set({ status: "accepted", acceptedAt: new Date(Date.now() - 20 * DAY) })
      .where(eq(schema.revenueSplits.id, v!.id));
    const paymentId = uuidv7();
    await db().transaction((tx) =>
      postPaymentWithSplit(tx, {
        channelId: c.id,
        paymentId,
        paymentKind: "tip",
        provider: "manual",
        creatorUserId: shortOwner.userId,
        grossCents: 1000,
        taxCents: 0,
        feeCents: 0,
        currency: "usd",
        cut: DEFAULT_PLATFORM_CUT,
        cutHistoryId: null,
        occurredAt: new Date(Date.now() - 19 * DAY),
      }),
    );
    await releaseDueHolds(db(), { asOf: new Date(), holdDays: 7, currency: "usd", newRecipientHoldDays: 0 });
    await postReversal(db(), {
      kind: "refund",
      disputeId: uuidv7(),
      paymentId,
      amountCents: 1000,
      occurredAt: new Date(),
    });
    // The owner covered its own 450 from its released earnings; the crew's 450 is split shortfall.
    expect(await creatorBalances(db(), shortOwner.userId, "usd")).toMatchObject({ splitShortfallCents: 450 });

    const notDue = await t1.client.call<ErrorBody>("POST", "/api/treasurer/split-write-offs", {
      username: shortOwner.username,
    });
    expect(notDue.status).toBe(412);
    expect(notDue.body.data?.requirement).toBe("split_write_off_not_due");
    await db().update(schema.users).set({ deletedAt: new Date() }).where(eq(schema.users.id, shortOwner.userId));
    const proposed = await t1.client.call<WriteOff>("POST", "/api/treasurer/split-write-offs", {
      username: shortOwner.username,
    });
    expect(proposed.status).toBe(200);
    writeOff = proposed.body;
    expect(writeOff).toMatchObject({ status: "proposed", amount: { cents: 450, currency: "usd" } });
    const own = await t1.client.call<ErrorBody>("POST", `/api/treasurer/split-write-offs/${writeOff.id}/approve`, {
      approve: true,
    });
    expect(own.status).toBe(403);
    expect(own.body.data?.reason).toBe("second_approver");
    const ok = await t2.client.call<WriteOff>("POST", `/api/treasurer/split-write-offs/${writeOff.id}/approve`, {
      approve: true,
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: "approved", approvedBy: { id: t2.userId } });
    expect((await creatorBalances(db(), shortOwner.userId, "usd")).splitShortfallCents).toBe(0);
    expect((await auditOf(writeOff.id)).map((a) => a.action).sort()).toEqual([
      "money.split.writeoff.approve",
      "money.split.writeoff.propose",
    ]);
    const listed = await t1.client.call<Page<WriteOff>>("GET", "/api/treasurer/split-write-offs?status=approved");
    expect(listed.body.items.map((w) => w.id)).toContain(writeOff.id);
  });

  test("transparency shows the write-off as its own cost line and counts the suspense moves", async () => {
    const r = await payer.client.call<
      {
        costs: { category: string; amount: { cents: number } }[];
        splitSuspense: { released: number; forfeited: number; writeOffs: number };
      }[]
    >("GET", "/api/transparency?months=1");
    expect(r.status).toBe(200);
    const months = r.body;
    const line = months?.[0]?.costs.find((c) => c.category === "split-shortfall-writeoff");
    expect(line?.amount.cents).toBe(450);
    expect(months?.[0]?.splitSuspense).toMatchObject({ released: 1, forfeited: 1, writeOffs: 1 });
    expect(gone).toBeDefined();
    await expectLedgerBalanced();
  });
});
