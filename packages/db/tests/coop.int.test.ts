// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Co-op protections (0021, ADR 0020) and a re-assertion of ADR 0004 for E5: a protected decision
 * that passes member-wide but fails in the streamer class cannot be recorded as passed by any
 * direct write the application role can make.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";

// Governance flows wait out real (shortened) review and voting windows.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
import type { GovernanceRuleSnapshot, TallyBreakdown } from "@commonair/contracts/shapes";
import * as s from "../src/schema/index.ts";
import { FAST_GOVERNANCE, createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { uuidv7 } from "../src/ids.ts";
import type { Database } from "../src/client.ts";

let t: TestDatabase;
/** Everything that exercises a protection runs as the least-privilege application role. */
let app: Database;

async function expectPgError(p: PromiseLike<unknown>, pattern: RegExp): Promise<void> {
  const err = await Promise.resolve(p).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, "expected the database to reject").toBeInstanceOf(Error);
  const e = err as Error & { cause?: Error };
  expect(e.cause?.message ?? e.message).toMatch(pattern);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  t = await createTestDatabase({ governance: FAST_GOVERNANCE });
  app = t.app.db;
});
afterAll(async () => {
  await t?.drop();
});

let userSeq = 0;
async function makeUser(role: "user" | "treasurer" | "admin" = "user"): Promise<string> {
  const name = `coop${++userSeq}`;
  const [u] = await app
    .insert(s.users)
    .values({ name, email: `${name}@example.test`, username: name })
    .returning({ id: s.users.id });
  // Roles are granted by the operator CLI, i.e. the owner.
  if (role !== "user") await t.db.update(s.users).set({ role }).where(eq(s.users.id, u!.id));
  return u!.id;
}

async function account(code: string, type: "asset" | "liability" | "equity"): Promise<string> {
  const [a] = await app
    .insert(s.ledgerAccounts)
    .values({ code: `${code}@usd`, type, name: code, currency: "usd" })
    .onConflictDoNothing()
    .returning({ id: s.ledgerAccounts.id });
  if (a) return a.id;
  const [b] = await app
    .select()
    .from(s.ledgerAccounts)
    .where(eq(s.ledgerAccounts.code, `${code}@usd`));
  return b!.id;
}

/** A balanced two-line posting with the given idempotency key, in its own transaction. */
async function post(key: string, kind: string, debit: string, credit: string, cents: number): Promise<string> {
  return app.transaction(async (tx) => {
    const [txn] = await tx
      .insert(s.ledgerTransactions)
      .values({ kind, description: kind, occurredAt: new Date(), idempotencyKey: key })
      .returning({ id: s.ledgerTransactions.id });
    await tx.insert(s.ledgerEntries).values([
      { transactionId: txn!.id, accountId: debit, amountCents: cents, currency: "usd" },
      { transactionId: txn!.id, accountId: credit, amountCents: -cents, currency: "usd" },
    ]);
    return txn!.id;
  });
}

const protectedRules: GovernanceRuleSnapshot = {
  ruleVersion: "test",
  protected: true,
  memberWideThreshold: 2 / 3,
  streamerClassThreshold: 0.5,
  quorum: 0.2,
  streamerClassQuorum: 0.2,
  councilReviewRequired: true,
};

describe("protected decision and tallies", () => {
  let viewers: string[] = [];
  let streamers: string[] = [];
  let worker = "";

  beforeAll(async () => {
    viewers = await Promise.all(Array.from({ length: 2 }, () => makeUser()));
    streamers = await Promise.all(Array.from({ length: 2 }, () => makeUser()));
    worker = await makeUser();
    await app
      .insert(s.memberships)
      .values([
        ...viewers.map((userId) => ({ userId, class: "viewer" as const, basis: "share" as const })),
        ...streamers.map((userId) => ({ userId, class: "streamer" as const, basis: "streaming_hours" as const })),
        { userId: worker, class: "worker" as const, basis: "board_appointment" as const },
      ]);
  });

  async function rejectedProtected(): Promise<string> {
    const [p] = await app
      .insert(s.proposals)
      .values({
        authorId: worker,
        title: "Lower the streamer share",
        body: "test",
        kind: "protected",
        affectsCreators: true,
        changes: [{ key: "platform.cut", value: { streamerShare: 0.85, coopShare: 0.15 } }],
      })
      .returning({ id: s.proposals.id });
    const id = p!.id;
    const set = (status: (typeof s.proposals.$inferSelect)["status"], extra = {}) =>
      app
        .update(s.proposals)
        .set({ status, ...extra })
        .where(eq(s.proposals.id, id));
    await set("discussion");
    await set("council_review");
    await sleep(1100);
    await set("voting", { rules: protectedRules, votingEndsAt: new Date(Date.now() + 1500) });
    // Member-wide 4 of 5 yes (80% ≥ 2/3); streamer class 1 of 2 (not a majority).
    await app.insert(s.votes).values([
      { proposalId: id, userId: viewers[0]!, choice: "yes" },
      { proposalId: id, userId: viewers[1]!, choice: "yes" },
      { proposalId: id, userId: worker, choice: "yes" },
      { proposalId: id, userId: streamers[0]!, choice: "yes" },
      { proposalId: id, userId: streamers[1]!, choice: "no" },
    ]);
    await sleep(1600);
    return id;
  }

  const count = (eligible: number, yes: number, no: number, abstain = 0) => ({ eligible, yes, no, abstain });
  const breakdown = (over: Partial<TallyBreakdown> = {}): TallyBreakdown => ({
    memberWide: count(5, 4, 1),
    byClass: { streamer: count(2, 1, 1), viewer: count(2, 2, 0), worker: count(1, 1, 0) },
    checks: [],
    ...over,
  });

  test("the database refuses to record the protected decision as passed, in every form", async () => {
    const id = await rejectedProtected();
    await expectPgError(
      app.update(s.proposals).set({ status: "passed" }).where(eq(s.proposals.id, id)),
      /streamer-class majority not met/,
    );
    // A tally row before the proposal is decided, or claiming it passed, is refused.
    await expectPgError(
      app.insert(s.tallies).values({ proposalId: id, breakdown: breakdown(), passed: true, reason: "passed" }),
      /only for a decided proposal/,
    );
    await app.update(s.proposals).set({ status: "rejected" }).where(eq(s.proposals.id, id));
    await expectPgError(
      app.insert(s.tallies).values({ proposalId: id, breakdown: breakdown(), passed: true, reason: "passed" }),
      /disagrees with the database tally/,
    );
    await expectPgError(
      app
        .update(s.governanceSettings)
        .set({ value: { streamerShare: 0.85, coopShare: 0.15 }, updatedByProposalId: id })
        .where(eq(s.governanceSettings.key, "platform.cut")),
      /not a passed, unapplied decision/,
    );
    const [cut] = await app.select().from(s.governanceSettings).where(eq(s.governanceSettings.key, "platform.cut"));
    expect(cut!.value).toEqual({ streamerShare: 0.9, coopShare: 0.1 });
  });

  test("tally counts must equal the recorded votes, member-wide and per class", async () => {
    const id = await rejectedProtected();
    await app.update(s.proposals).set({ status: "rejected" }).where(eq(s.proposals.id, id));
    const reason = "streamer-class majority not met";
    await expectPgError(
      app.insert(s.tallies).values({
        proposalId: id,
        breakdown: breakdown({ memberWide: count(5, 5, 0) }),
        passed: false,
        reason,
      }),
      /counts disagree/,
    );
    await expectPgError(
      app.insert(s.tallies).values({
        proposalId: id,
        breakdown: breakdown({ byClass: { streamer: count(2, 0, 2), viewer: count(2, 2, 0), worker: count(1, 1, 0) } }),
        passed: false,
        reason,
      }),
      /streamer class disagree/,
    );
    await expectPgError(
      app.insert(s.tallies).values({ proposalId: id, breakdown: breakdown(), passed: false, reason: "passed" }),
      /disagrees with the database tally/,
    );
    await app.insert(s.tallies).values({ proposalId: id, breakdown: breakdown(), passed: false, reason });
    await expectPgError(
      app.update(s.tallies).set({ passed: true }).where(eq(s.tallies.proposalId, id)),
      /append-only|permission denied/,
    );
    await expectPgError(app.delete(s.tallies).where(eq(s.tallies.proposalId, id)), /append-only|permission denied/);
    await expectPgError(app.execute(sql`truncate tallies`), /append-only|permission denied/);
  });

  test("votes cannot be inserted twice for one member", async () => {
    const id = await rejectedProtected();
    await expectPgError(
      app.insert(s.votes).values({ proposalId: id, userId: viewers[0]!, choice: "no" }),
      /duplicate key|voting/,
    );
  });
});

describe("council", () => {
  let seated = "";
  let outsider = "";
  let author = "";

  beforeAll(async () => {
    seated = await makeUser();
    outsider = await makeUser();
    author = await makeUser();
    await app.insert(s.memberships).values([
      { userId: seated, class: "streamer", basis: "streaming_hours" },
      { userId: outsider, class: "streamer", basis: "streaming_hours" },
      { userId: author, class: "viewer", basis: "share" },
    ]);
  });

  async function seat(userIds: string[], startsAt = new Date(Date.now() - 1000)): Promise<string> {
    return app.transaction(async (tx) => {
      const [term] = await tx
        .insert(s.councilTerms)
        .values({ startsAt, endsAt: new Date(Date.now() + 3_600_000), method: {} })
        .returning({ id: s.councilTerms.id });
      if (userIds.length)
        await tx
          .insert(s.councilMembers)
          .values(userIds.map((userId, i) => ({ termId: term!.id, userId, rank: i + 1, contributionScore: 1 })));
      return term!.id;
    });
  }

  async function inReview(): Promise<string> {
    const [p] = await app
      .insert(s.proposals)
      .values({ authorId: author, title: "Spotlight", body: "b", kind: "ordinary", affectsCreators: true, changes: [] })
      .returning({ id: s.proposals.id });
    await app.update(s.proposals).set({ status: "discussion" }).where(eq(s.proposals.id, p!.id));
    return p!.id;
  }

  test("terms and seats are append-only and seats join only with their term", async () => {
    const termId = await seat([seated]);
    await expectPgError(
      app.insert(s.councilMembers).values({ termId, userId: outsider, rank: 2, contributionScore: 1 }),
      /only with their term/,
    );
    await expectPgError(
      app.update(s.councilTerms).set({ endsAt: new Date() }).where(eq(s.councilTerms.id, termId)),
      /append-only|permission denied/,
    );
    await expectPgError(
      app.update(s.councilMembers).set({ rank: 9 }).where(eq(s.councilMembers.termId, termId)),
      /append-only|permission denied/,
    );
    await expectPgError(
      app.delete(s.councilTerms).where(eq(s.councilTerms.id, termId)),
      /append-only|permission denied/,
    );
  });

  test("only a member of the current term responds, once, during council review", async () => {
    const oldTerm = await seat([outsider], new Date(Date.now() - 5000));
    const termId = await seat([seated]);
    const id = await inReview();
    const respond = (by: string, term = termId) =>
      app
        .insert(s.councilResponses)
        .values({ proposalId: id, termId: term, stance: "support", body: "ok", publishedById: by });
    await expectPgError(respond(seated), /only while a proposal is in council review/);
    await app.update(s.proposals).set({ status: "council_review" }).where(eq(s.proposals.id, id));
    await expectPgError(respond(outsider), /only a seated council member/);
    await expectPgError(respond(outsider, oldTerm), /only the current council term/);
    await respond(seated);
    await expectPgError(respond(seated), /duplicate key/);
    await expectPgError(
      app.update(s.councilResponses).set({ stance: "oppose" }).where(eq(s.councilResponses.proposalId, id)),
      /final|permission denied/,
    );
  });

  test("comments come from members while a proposal is open, and are never edited", async () => {
    const id = await inReview();
    const stranger = await makeUser();
    await expectPgError(
      app.insert(s.proposalComments).values({ proposalId: id, authorId: stranger, body: "hi" }),
      /only members comment/,
    );
    const [c] = await app
      .insert(s.proposalComments)
      .values({ proposalId: id, authorId: author, body: "hi" })
      .returning({ id: s.proposalComments.id });
    await expectPgError(
      app.update(s.proposalComments).set({ body: "edited" }).where(eq(s.proposalComments.id, c!.id)),
      /not edited/,
    );
    const [draft] = await app
      .insert(s.proposals)
      .values({ authorId: author, title: "Draft", body: "b", kind: "ordinary", affectsCreators: false, changes: [] })
      .returning({ id: s.proposals.id });
    await expectPgError(
      app.insert(s.proposalComments).values({ proposalId: draft!.id, authorId: author, body: "early" }),
      /comments are open only/,
    );
  });
});

describe("member shares", () => {
  let cash = "";
  let liability = "";

  beforeAll(async () => {
    cash = await account("asset:cash:manual", "asset");
    liability = await account("liability:member-share:test", "liability");
  });

  async function pendingShare(): Promise<{ shareId: string; paymentId: string; userId: string }> {
    const userId = await makeUser();
    const [pay] = await app
      .insert(s.payments)
      .values({
        provider: "manual",
        providerRef: `CA-${uuidv7()}`,
        kind: "membership_share",
        userId,
        amountCents: 500,
        currency: "usd",
      })
      .returning({ id: s.payments.id });
    const [share] = await app
      .insert(s.membershipShares)
      .values({ userId, amountCents: 500, currency: "usd", paymentId: pay!.id })
      .returning({ id: s.membershipShares.id });
    return { shareId: share!.id, paymentId: pay!.id, userId };
  }

  const setShare = (id: string, v: Partial<typeof s.membershipShares.$inferInsert>) =>
    app.update(s.membershipShares).set(v).where(eq(s.membershipShares.id, id));

  test("a share starts pending and is held only after its payment and posting", async () => {
    const userId = await makeUser();
    await expectPgError(
      app.insert(s.membershipShares).values({ userId, amountCents: 500, currency: "usd", status: "held" }),
      /starts pending/,
    );
    const { shareId, paymentId } = await pendingShare();
    await expectPgError(setShare(shareId, { status: "held", purchasedAt: new Date() }), /payment succeeded/);
    await app
      .update(s.payments)
      .set({ status: "succeeded", succeededAt: new Date() })
      .where(eq(s.payments.id, paymentId));
    await expectPgError(setShare(shareId, { status: "held", purchasedAt: new Date() }), /purchase is posted/);
    await post(`share-purchase:${shareId}`, "share_purchase", cash, liability, 500);
    await setShare(shareId, { status: "held", purchasedAt: new Date() });
    await expectPgError(setShare(shareId, { amountCents: 1 }), /never change/);
    await expectPgError(
      setShare(shareId, { status: "refunded", refundedAt: new Date() }),
      /cannot go from held to refunded/,
    );
    await setShare(shareId, { status: "refund_pending" });
    // refund_pending is still open: no second share until the refund is paid.
    const owner = (await app.select().from(s.membershipShares).where(eq(s.membershipShares.id, shareId)))[0]!.userId;
    await expectPgError(
      app.insert(s.membershipShares).values({ userId: owner, amountCents: 500, currency: "usd" }),
      /already has an open share/,
    );
    await expectPgError(setShare(shareId, { status: "refunded", refundedAt: new Date() }), /refund is posted/);
    await post(`share-refund:${shareId}`, "share_refund", liability, cash, 500);
    await setShare(shareId, { status: "refunded", refundedAt: new Date() });
    await expectPgError(
      app.delete(s.membershipShares).where(eq(s.membershipShares.id, shareId)),
      /never deleted|permission denied/,
    );
  });

  test("one open share per user; an unpaid share can be cancelled", async () => {
    const { shareId, userId } = await pendingShare();
    await expectPgError(
      app.insert(s.membershipShares).values({ userId, amountCents: 500, currency: "usd" }),
      /already has an open share|duplicate key/,
    );
    await setShare(shareId, { status: "cancelled" });
    await expectPgError(setShare(shareId, { status: "pending" }), /cannot go from cancelled to pending/);
  });
});

describe("patronage", () => {
  let treasurer1 = "";
  let treasurer2 = "";
  let plainUser = "";
  let member = "";
  let seq = 0;

  beforeAll(async () => {
    treasurer1 = await makeUser("treasurer");
    treasurer2 = await makeUser("treasurer");
    plainUser = await makeUser();
    member = await makeUser();
  });

  async function computed(allocationCents: number): Promise<string> {
    const start = new Date(Date.UTC(2020, 0, 1 + ++seq));
    const [p] = await app
      .insert(s.patronagePeriods)
      .values({
        periodStart: start,
        periodEnd: new Date(start.getTime() + 86_400_000),
        status: "computed",
        formulaVersion: "2026.1",
        weights: {
          revenue: 0.5,
          streamingHours: 0.2,
          relayBandwidth: 0.2,
          viewerHours: 0.1,
          dailyStreamingHourCap: 8,
          viewerHoursChannelCap: 0.1,
        },
        surplusCents: 1000,
        currency: "usd",
        computedAt: new Date(),
        computedById: treasurer1,
      })
      .returning({ id: s.patronagePeriods.id });
    if (allocationCents > 0)
      await app
        .insert(s.patronageAllocations)
        .values({ periodId: p!.id, userId: member, amountCents: allocationCents, lines: [] });
    return p!.id;
  }

  const approve = (id: string, by: string, ledgerTransactionId: string | null = null) =>
    app
      .update(s.patronagePeriods)
      .set({ status: "approved", approvedById: by, approvedAt: new Date(), ledgerTransactionId })
      .where(eq(s.patronagePeriods.id, id));

  test("the person who ran it cannot approve it; nor can someone without the role", async () => {
    const id = await computed(0);
    await expectPgError(approve(id, treasurer1), /someone other than the person who ran it/);
    await expectPgError(approve(id, plainUser), /treasurer or an admin/);
    await approve(id, treasurer2);
  });

  test("an allocation is approved only with its posting, and then everything is frozen", async () => {
    const id = await computed(400);
    await expectPgError(approve(id, treasurer2), /allocation posted/);
    const surplus = await account("equity:retained-surplus", "equity");
    const payable = await account("liability:patronage-payable:test", "liability");
    const txn = await post(`patronage-allocation:${id}`, "patronage_allocation", surplus, payable, 400);
    await approve(id, treasurer2, txn);
    await expectPgError(
      app.update(s.patronageAllocations).set({ amountCents: 900 }).where(eq(s.patronageAllocations.periodId, id)),
      /frozen/,
    );
    await expectPgError(
      app.insert(s.patronageAllocations).values({ periodId: id, userId: treasurer1, amountCents: 1, lines: [] }),
      /frozen/,
    );
    await expectPgError(
      app.update(s.patronagePeriods).set({ surplusCents: 5 }).where(eq(s.patronagePeriods.id, id)),
      /frozen/,
    );
    await expectPgError(app.delete(s.patronagePeriods).where(eq(s.patronagePeriods.id, id)), /never deleted/);
    await app.update(s.patronagePeriods).set({ status: "distributed" }).where(eq(s.patronagePeriods.id, id));
  });

  test("a draft cannot skip computing, and approval fields are set only by approving", async () => {
    const id = await computed(0);
    await expectPgError(
      app.update(s.patronagePeriods).set({ approvedById: treasurer2 }).where(eq(s.patronagePeriods.id, id)),
      /only by approving/,
    );
    await app.update(s.patronagePeriods).set({ status: "draft" }).where(eq(s.patronagePeriods.id, id));
    await expectPgError(approve(id, treasurer2), /only a computed patronage period/);
  });
});
