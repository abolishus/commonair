// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * W2 schema (0042, 0043; ADR 0013, ADR 0014, batch 6 decisions (d), (f), (g), (m)): the rehearsal
 * refusals, revenue split versions, shares, answers and payment links, split suspense debits and
 * the two-approver write-off, the attestation chain and key history, and the `rule_ref` and
 * exclusion-group CHECKs. Run as the least-privilege app role.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import type { Database, Executor } from "../src/client.ts";
import { uuidv7 } from "../src/ids.ts";
import * as s from "../src/schema/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;
let app: Database;
let owner: Database;

beforeAll(async () => {
  t = await createTestDatabase();
  app = t.app.db;
  owner = t.db;
});
afterAll(async () => {
  await t?.drop();
});

/** The SQLSTATE and message of a rejected query (drizzle wraps the driver error in `cause`). */
async function refused(p: PromiseLike<unknown>, message: RegExp = /./): Promise<string | undefined> {
  const err = await Promise.resolve(p).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, "expected the database to reject").toBeInstanceOf(Error);
  const e = err as Error & { code?: string; cause?: { code?: string; message?: string } };
  expect(e.cause?.message ?? e.message).toMatch(message);
  return e.cause?.code ?? e.code;
}

type Role = (typeof s.users.$inferInsert)["role"];
async function newUser(role: Role = "user"): Promise<string> {
  const name = `w2_${uuidv7().replace(/-/g, "").slice(-12)}`;
  const [u] = await owner
    .insert(s.users)
    .values({ name, email: `${name}@example.test`, username: name, role })
    .returning({ id: s.users.id });
  return u!.id;
}
async function newChannel(): Promise<{ channelId: string; ownerId: string }> {
  const ownerId = await newUser();
  const [c] = await app
    .insert(s.channels)
    .values({ ownerId, slug: `c${ownerId.slice(-10)}`, displayName: "W2" })
    .returning({ id: s.channels.id });
  return { channelId: c!.id, ownerId };
}
async function newBroadcast(channelId: string, kind: "live" | "rehearsal" = "live"): Promise<string> {
  const [b] = await app
    .insert(s.broadcasts)
    .values({ channelId, ingestProtocol: "rtmp", path: "live/w2", kind })
    .returning({ id: s.broadcasts.id });
  return b!.id;
}

const accountIds = new Map<string, string>();
async function account(code: string, type: "asset" | "liability" | "expense" | "revenue"): Promise<string> {
  const stored = `${code}@usd`;
  const known = accountIds.get(stored);
  if (known) return known;
  const [a] = await app
    .insert(s.ledgerAccounts)
    .values({ code: stored, type, name: code, currency: "usd" })
    .returning({ id: s.ledgerAccounts.id });
  accountIds.set(stored, a!.id);
  return a!.id;
}

interface Post {
  kind: string;
  entries: [string, number][];
  refType?: string;
  refId?: string;
  metadata?: Record<string, unknown>;
  /** Runs in the same transaction, after the entries (audit rows, link rows). */
  after?: (tx: Executor, txId: string) => Promise<void>;
}
function post(p: Post): Promise<string> {
  return app.transaction(async (tx) => {
    const [x] = await tx
      .insert(s.ledgerTransactions)
      .values({
        kind: p.kind,
        description: "w2 test",
        occurredAt: new Date(),
        idempotencyKey: uuidv7(),
        refType: p.refType,
        refId: p.refId,
        metadata: p.metadata ?? {},
      })
      .returning({ id: s.ledgerTransactions.id });
    await tx.insert(s.ledgerEntries).values(
      p.entries.map(([accountId, amountCents]) => ({
        transactionId: x!.id,
        accountId,
        amountCents,
        currency: "usd",
      })),
    );
    await p.after?.(tx, x!.id);
    return x!.id;
  });
}

describe("rehearsals (decision (f))", () => {
  test("a broadcast's kind never changes", async () => {
    const { channelId } = await newChannel();
    const b = await newBroadcast(channelId, "rehearsal");
    expect(
      await refused(app.update(s.broadcasts).set({ kind: "live" }).where(eq(s.broadcasts.id, b)), /kind never changes/),
    ).toBe("23514");
    const live = await newBroadcast(channelId);
    expect(await refused(app.update(s.broadcasts).set({ kind: "rehearsal" }).where(eq(s.broadcasts.id, live)))).toBe(
      "23514",
    );
    await app.update(s.broadcasts).set({ title: "renamed" }).where(eq(s.broadcasts.id, b));
  });

  test("a rehearsal is never the channel's live broadcast, never a stream hour, never in the rollup", async () => {
    const { channelId } = await newChannel();
    const r = await newBroadcast(channelId, "rehearsal");
    const live = await newBroadcast(channelId);
    expect(await refused(app.update(s.channels).set({ liveBroadcastId: r }).where(eq(s.channels.id, channelId)))).toBe(
      "23514",
    );
    await app.update(s.channels).set({ liveBroadcastId: live }).where(eq(s.channels.id, channelId));
    const hour = { channelId, hourStart: new Date("2026-10-01T10:00:00Z"), liveSeconds: 60 };
    expect(await refused(app.insert(s.streamHours).values({ ...hour, broadcastId: r }), /stream_hours/)).toBe("23514");
    await app.insert(s.streamHours).values({ ...hour, broadcastId: live });
    // An existing live row cannot be repointed at the rehearsal either.
    expect(
      await refused(app.update(s.streamHours).set({ broadcastId: r }).where(eq(s.streamHours.broadcastId, live))),
    ).toBe("23514");
    expect(await refused(app.insert(s.broadcastAudienceMinutes).values({ broadcastId: r, minute: new Date() }))).toBe(
      "23514",
    );
    const totals = {
      channelId,
      durationSeconds: 60,
      sessions: 0,
      peakVerifiedConcurrent: 0,
      verifiedViewerSeconds: 0,
      unverifiedViewerSeconds: 0,
      excludedViewerSeconds: 0,
    };
    expect(await refused(app.insert(s.broadcastAudienceTotals).values({ ...totals, broadcastId: r }))).toBe("23514");
    await app.insert(s.broadcastAudienceTotals).values({ ...totals, broadcastId: live });
    expect(await refused(app.insert(s.broadcastCosts).values({ broadcastId: r, currency: "usd", costCents: 0 }))).toBe(
      "23514",
    );
  });

  test("a ledger posting never references a rehearsal broadcast", async () => {
    const { channelId } = await newChannel();
    const r = await newBroadcast(channelId, "rehearsal");
    const live = await newBroadcast(channelId);
    const cash = await account("asset:cash:w2-rehearsal", "asset");
    const rev = await account("revenue:w2-rehearsal", "revenue");
    const entries: [string, number][] = [
      [cash, 100],
      [rev, -100],
    ];
    expect(await refused(post({ kind: "test", refType: "broadcast", refId: r, entries }), /ledger/)).toBe("23514");
    await post({ kind: "test", refType: "broadcast", refId: live, entries });
  });

  test("at most five invitees per arm, never the owner, only on the channel's rehearsal", async () => {
    const { channelId, ownerId } = await newChannel();
    const armId = uuidv7();
    expect(await refused(app.insert(s.rehearsalInvitees).values({ armId, channelId, userId: ownerId }), /owner/)).toBe(
      "23514",
    );
    for (let i = 0; i < 5; i++)
      await app.insert(s.rehearsalInvitees).values({ armId, channelId, userId: await newUser() });
    expect(
      await refused(app.insert(s.rehearsalInvitees).values({ armId, channelId, userId: await newUser() }), /at most 5/),
    ).toBe("23514");
    // The list carries over into the rehearsal broadcast; a live broadcast is refused.
    const live = await newBroadcast(channelId);
    const r = await newBroadcast(channelId, "rehearsal");
    expect(
      await refused(
        app.update(s.rehearsalInvitees).set({ broadcastId: live }).where(eq(s.rehearsalInvitees.armId, armId)),
      ),
    ).toBe("23514");
    await app.update(s.rehearsalInvitees).set({ broadcastId: r }).where(eq(s.rehearsalInvitees.armId, armId));
  });
});

describe("revenue splits (ADR 0013 decision 8)", () => {
  async function proposal(
    channelId: string,
    recipients: [string, number][],
    opts: { basis?: "tips" | "subs" | "all" } = {},
  ) {
    const [v] = await app
      .select({ n: sql<number>`coalesce(max(${s.revenueSplits.version}), 0)::int` })
      .from(s.revenueSplits)
      .where(eq(s.revenueSplits.channelId, channelId));
    const [sp] = await app
      .insert(s.revenueSplits)
      .values({ channelId, version: (v?.n ?? 0) + 1, basis: opts.basis ?? "all" })
      .returning();
    if (recipients.length)
      await app
        .insert(s.revenueSplitShares)
        .values(recipients.map(([recipientUserId, bps]) => ({ splitId: sp!.id, recipientUserId, bps })));
    return sp!;
  }
  const answer = (splitId: string, recipientUserId: string, decision: "accepted" | "rejected" = "accepted") =>
    app.insert(s.revenueSplitAcceptances).values({ splitId, recipientUserId, decision });
  const accept = (splitId: string) =>
    app
      .update(s.revenueSplits)
      .set({ status: "accepted", acceptedAt: new Date() })
      .where(eq(s.revenueSplits.id, splitId));

  test("a version starts proposed; channel, number, basis and start never change; never deleted", async () => {
    const { channelId } = await newChannel();
    expect(
      await refused(app.insert(s.revenueSplits).values({ channelId, version: 1, basis: "tips", status: "accepted" })),
    ).toBe("23514");
    const crew = await newUser();
    const sp = await proposal(channelId, [[crew, 1000]]);
    expect(await refused(app.update(s.revenueSplits).set({ basis: "subs" }).where(eq(s.revenueSplits.id, sp.id)))).toBe(
      "23514",
    );
    expect(await refused(app.update(s.revenueSplits).set({ version: 9 }).where(eq(s.revenueSplits.id, sp.id)))).toBe(
      "23514",
    );
    expect(await refused(app.delete(s.revenueSplits).where(eq(s.revenueSplits.id, sp.id)))).toBe("42501");
  });

  test("the owner is never a crew recipient; shares change only while proposed", async () => {
    const { channelId, ownerId } = await newChannel();
    const sp = await proposal(channelId, []);
    expect(
      await refused(
        app.insert(s.revenueSplitShares).values({ splitId: sp.id, recipientUserId: ownerId, bps: 100 }),
        /owner/,
      ),
    ).toBe("23514");
    const crew = await newUser();
    await app.insert(s.revenueSplitShares).values({ splitId: sp.id, recipientUserId: crew, bps: 100 });
    expect(
      await refused(app.update(s.revenueSplitShares).set({ bps: 200 }).where(eq(s.revenueSplitShares.splitId, sp.id))),
    ).toBe("42501");
    await answer(sp.id, crew);
    // Once anyone has answered, the shares are what they answered to.
    expect(
      await refused(
        app.insert(s.revenueSplitShares).values({ splitId: sp.id, recipientUserId: await newUser(), bps: 100 }),
        /answered/,
      ),
    ).toBe("42501");
    expect(
      await refused(app.delete(s.revenueSplitShares).where(eq(s.revenueSplitShares.splitId, sp.id)), /answered/),
    ).toBe("42501");
    await accept(sp.id);
    expect(
      await refused(
        app.insert(s.revenueSplitShares).values({ splitId: sp.id, recipientUserId: await newUser(), bps: 100 }),
        /frozen/,
      ),
    ).toBe("42501");
    expect(await refused(app.delete(s.revenueSplitShares).where(eq(s.revenueSplitShares.splitId, sp.id)))).toBe(
      "42501",
    );
  });

  test("only recipients answer, once; acceptance needs every recipient; rejection needs a refusal", async () => {
    const { channelId } = await newChannel();
    const [a, b] = [await newUser(), await newUser()];
    const sp = await proposal(channelId, [
      [a, 1000],
      [b, 1000],
    ]);
    expect(await refused(answer(sp.id, await newUser()), /recipient/)).toBe("23514");
    expect(
      await refused(
        app
          .update(s.revenueSplits)
          .set({ status: "rejected", rejectedAt: new Date() })
          .where(eq(s.revenueSplits.id, sp.id)),
      ),
    ).toBe("23514");
    await answer(sp.id, a);
    expect(await refused(accept(sp.id), /every recipient/)).toBe("23514");
    expect(await refused(answer(sp.id, a))).toBeDefined();
    expect(
      await refused(
        app
          .update(s.revenueSplitAcceptances)
          .set({ decision: "rejected" })
          .where(eq(s.revenueSplitAcceptances.splitId, sp.id)),
      ),
    ).toBe("42501");
    await answer(sp.id, b, "rejected");
    await app
      .update(s.revenueSplits)
      .set({ status: "rejected", rejectedAt: new Date() })
      .where(eq(s.revenueSplits.id, sp.id));
    expect(await refused(answer(sp.id, b))).toBeDefined();
  });

  test("the bps of overlapping accepted versions covering one payment kind total at most 10,000", async () => {
    const { channelId } = await newChannel();
    const [a, b, c] = [await newUser(), await newUser(), await newUser()];
    const tips = await proposal(channelId, [[a, 6000]], { basis: "tips" });
    await answer(tips.id, a);
    await accept(tips.id);
    // Subscriptions are another kind: no overlap with a tips version.
    const subs = await proposal(channelId, [[b, 6000]], { basis: "subs" });
    await answer(subs.id, b);
    await accept(subs.id);
    // `all` covers tips too: 6000 + 5000 > 10000.
    const all = await proposal(channelId, [[c, 5000]], { basis: "all" });
    await answer(all.id, c);
    expect(await refused(accept(all.id), /exceed 10000/)).toBe("23514");
    // Once the tips version ends, a later `all` version fits next to subs' 6000. (Ends use the
    // database clock: the app's clock may run behind the version's `starts_at`.)
    await app
      .update(s.revenueSplits)
      .set({ status: "ended", endedAt: sql`now()`, endsAt: sql`now()` })
      .where(eq(s.revenueSplits.id, tips.id));
    await app
      .update(s.revenueSplits)
      .set({ status: "ended", endedAt: sql`now()`, endsAt: sql`now()` })
      .where(eq(s.revenueSplits.id, all.id));
    const later = await proposal(channelId, [[c, 4000]], { basis: "all" });
    await answer(later.id, c);
    await accept(later.id);
  });

  test("an end is never backdated and freezes the version", async () => {
    const { channelId } = await newChannel();
    const crew = await newUser();
    const sp = await proposal(channelId, [[crew, 500]]);
    await answer(sp.id, crew);
    await accept(sp.id);
    const end = (endsAt: Date) =>
      app
        .update(s.revenueSplits)
        .set({ status: "ended", endedAt: new Date(), endsAt })
        .where(eq(s.revenueSplits.id, sp.id));
    expect(await refused(end(new Date(Date.now() - 3_600_000)), /not in the past/)).toBe("23514");
    await end(new Date(Date.now() + 1000));
    expect(
      await refused(app.update(s.revenueSplits).set({ status: "accepted" }).where(eq(s.revenueSplits.id, sp.id))),
    ).toBe("23514");
  });

  test("a fixed window whose preset end has passed can still be ended at that end", async () => {
    const { channelId } = await newChannel();
    const crew = await newUser();
    // A preset window that closed an hour ago (database clock).
    const [sp] = await app
      .insert(s.revenueSplits)
      .values({
        channelId,
        version: 1,
        basis: "all",
        startsAt: sql`now() - interval '2 hours'`,
        endsAt: sql`now() - interval '1 hour'`,
      })
      .returning();
    await app.insert(s.revenueSplitShares).values({ splitId: sp!.id, recipientUserId: crew, bps: 500 });
    await answer(sp!.id, crew);
    await accept(sp!.id);
    // Moving the end is still refused when it would be in the past; keeping it is not.
    expect(
      await refused(
        app
          .update(s.revenueSplits)
          .set({ status: "ended", endedAt: sql`now()`, endsAt: sql`now() - interval '90 minutes'` })
          .where(eq(s.revenueSplits.id, sp!.id)),
      ),
    ).toBe("23514");
    const [ended] = await app
      .update(s.revenueSplits)
      .set({ status: "ended", endedAt: sql`now()` })
      .where(eq(s.revenueSplits.id, sp!.id))
      .returning();
    expect(ended?.status).toBe("ended");
  });

  test("a proposal withdrawn before acceptance never applies and never counts toward the cap", async () => {
    const { channelId } = await newChannel();
    const [a, b] = [await newUser(), await newUser()];
    const withdrawn = await proposal(channelId, [[a, 6000]]);
    await app
      .update(s.revenueSplits)
      .set({ status: "ended", endedAt: sql`now()`, endsAt: sql`now() + interval '1 hour'` })
      .where(eq(s.revenueSplits.id, withdrawn.id));
    const cash = await account("asset:cash:w2-withdrawn", "asset");
    const rev = await account("revenue:w2-withdrawn", "revenue");
    expect(
      await refused(
        post({
          kind: "payment",
          entries: [
            [cash, 1000],
            [rev, -1000],
          ],
          metadata: { splitVersionId: withdrawn.id },
          after: async (tx, txId) => {
            await tx.insert(s.revenueSplitPostings).values({ ledgerTransactionId: txId, splitId: withdrawn.id });
          },
        }),
        /accepted/,
      ),
    ).toBe("23514");
    // 6000 withdrawn + 6000 here would exceed the cap if the withdrawn proposal counted.
    const sp = await proposal(channelId, [[b, 6000]]);
    await answer(sp.id, b);
    await accept(sp.id);
  });

  test("a posting link names a payment whose splitVersionId is an accepted version, and is append-only", async () => {
    const { channelId } = await newChannel();
    const crew = await newUser();
    const sp = await proposal(channelId, [[crew, 2500]]);
    const cash = await account("asset:cash:w2-splits", "asset");
    const rev = await account("revenue:w2-splits", "revenue");
    const entries: [string, number][] = [
      [cash, 1000],
      [rev, -1000],
    ];
    const link = (splitId: string) => async (tx: Executor, txId: string) => {
      await tx.insert(s.revenueSplitPostings).values({ ledgerTransactionId: txId, splitId });
    };
    // Not accepted yet.
    expect(
      await refused(
        post({ kind: "payment", entries, metadata: { splitVersionId: sp.id }, after: link(sp.id) }),
        /accepted/,
      ),
    ).toBe("23514");
    await answer(sp.id, crew);
    await accept(sp.id);
    expect(
      await refused(post({ kind: "payment", entries, metadata: { splitVersionId: uuidv7() }, after: link(sp.id) })),
    ).toBe("23514");
    expect(
      await refused(post({ kind: "refund", entries, metadata: { splitVersionId: sp.id }, after: link(sp.id) })),
    ).toBe("23514");
    const txId = await post({ kind: "payment", entries, metadata: { splitVersionId: sp.id }, after: link(sp.id) });
    expect(
      await refused(app.delete(s.revenueSplitPostings).where(eq(s.revenueSplitPostings.ledgerTransactionId, txId))),
    ).toBe("42501");
    // A linked version still ends; nothing else about it changes.
    expect(
      await refused(
        app
          .update(s.revenueSplits)
          .set({ acceptedAt: new Date(0) })
          .where(eq(s.revenueSplits.id, sp.id)),
      ),
    ).toBe("23514");
  });
});

describe("split suspense and write-offs (ADR 0013 decisions 6, 7)", () => {
  let crew = "";
  let treasurer = "";
  let suspense = "";
  let earnings = "";
  beforeAll(async () => {
    crew = await newUser();
    treasurer = await newUser("treasurer");
    suspense = await account(`liability:split-suspense:${crew}`, "liability");
    earnings = await account(`liability:creator:${crew}`, "liability");
    const hold = await account(`liability:creator-hold:${crew}`, "liability");
    // Fund the suspense account the way a withheld release does (a credit needs no audit row).
    await post({
      kind: "hold_release",
      entries: [
        [hold, 5000],
        [suspense, -5000],
      ],
    });
  });
  const auditBy = (actorId: string) => async (tx: Executor, txId: string) => {
    await tx.insert(s.auditLog).values({
      actorType: "user",
      actorId,
      action: "money.split.suspense.release",
      subjectType: "ledger_transaction",
      subjectId: txId,
    });
  };

  const audit = (tx: Executor, txId: string) => auditBy(treasurer)(tx, txId);

  test("only a release or a forfeit debits split suspense, and only with its audit row", async () => {
    const entries: [string, number][] = [
      [suspense, 100],
      [earnings, -100],
    ];
    expect(await refused(post({ kind: "hold_release", entries, after: audit }), /release or a forfeit/)).toBe("23514");
    expect(await refused(post({ kind: "split_suspense_release", entries }), /audit_log/)).toBe("23514");
    // The audit row must be a treasurer's or an admin's.
    expect(
      await refused(post({ kind: "split_suspense_release", entries, after: auditBy(crew) }), /treasurer or an admin/),
    ).toBe("23514");
    await post({ kind: "split_suspense_release", entries, after: audit });
    await post({ kind: "split_suspense_forfeit", entries, after: audit });
  });

  test("a write-off needs two different finance people and its posting", async () => {
    const ownerUser = await newUser();
    const [t1, t2, plain] = [await newUser("treasurer"), await newUser("treasurer"), await newUser()];
    const receivable = await account(`asset:receivable:split-shortfall:${ownerUser}`, "asset");
    const writeoff = await account("expense:split-shortfall-writeoff", "expense");
    const propose = (by: string) =>
      app
        .insert(s.splitWriteoffProposals)
        .values({ ownerUserId: ownerUser, currency: "usd", amountCents: 300, proposedById: by })
        .returning({ id: s.splitWriteoffProposals.id });
    expect(await refused(propose(plain), /treasurer or an admin/)).toBe("42501");
    expect(await refused(propose(ownerUser))).toBe("42501");
    const [p] = await propose(t1);
    const entries: [string, number][] = [
      [writeoff, 300],
      [receivable, -300],
    ];
    // A posting with no approved proposal behind it.
    expect(await refused(post({ kind: "split_shortfall_writeoff", entries }), /approved proposal/)).toBe("23514");
    const decide = (by: string) => (tx: Executor, txId: string) =>
      tx
        .update(s.splitWriteoffProposals)
        .set({ status: "approved", decidedById: by, decidedAt: new Date(), ledgerTransactionId: txId })
        .where(eq(s.splitWriteoffProposals.id, p!.id))
        .then(() => undefined);
    expect(
      await refused(post({ kind: "split_shortfall_writeoff", entries, after: decide(t1) }), /second treasurer/),
    ).toBe("42501");
    expect(await refused(post({ kind: "split_shortfall_writeoff", entries, after: decide(plain) }))).toBe("42501");
    // The posting is exactly the proposal: the right accounts, the proposal's amount.
    expect(
      await refused(
        post({
          kind: "split_shortfall_writeoff",
          entries: [
            [writeoff, 299],
            [receivable, -299],
          ],
          after: decide(t2),
        }),
        /proposal's amount/,
      ),
    ).toBe("23514");
    const elsewhere = await account(`asset:receivable:split-shortfall:${await newUser()}`, "asset");
    expect(
      await refused(
        post({
          kind: "split_shortfall_writeoff",
          entries: [
            [writeoff, 300],
            [elsewhere, -300],
          ],
          after: decide(t2),
        }),
        /proposal's amount/,
      ),
    ).toBe("23514");
    await post({ kind: "split_shortfall_writeoff", entries, after: decide(t2) });
    expect(
      await refused(
        app.update(s.splitWriteoffProposals).set({ status: "rejected" }).where(eq(s.splitWriteoffProposals.id, p!.id)),
        /frozen/,
      ),
    ).toBe("42501");
    expect(await refused(app.delete(s.splitWriteoffProposals).where(eq(s.splitWriteoffProposals.id, p!.id)))).toBe(
      "42501",
    );
  });

  test("an approval must name a write-off posting; a rejection posts nothing", async () => {
    const ownerUser = await newUser();
    const [t1, t2] = [await newUser("treasurer"), await newUser("admin")];
    const [p] = await app
      .insert(s.splitWriteoffProposals)
      .values({ ownerUserId: ownerUser, currency: "usd", amountCents: 50, proposedById: t1 })
      .returning({ id: s.splitWriteoffProposals.id });
    expect(
      await refused(
        app
          .update(s.splitWriteoffProposals)
          .set({ status: "approved", decidedById: t2, decidedAt: new Date() })
          .where(eq(s.splitWriteoffProposals.id, p!.id)),
        /posting/,
      ),
    ).toBe("23514");
    await app
      .update(s.splitWriteoffProposals)
      .set({ status: "rejected", decidedById: t2, decidedAt: new Date() })
      .where(eq(s.splitWriteoffProposals.id, p!.id));
  });
});

describe("attestations (ADR 0014)", () => {
  const kidOf = (n: number) => `kid${String(n).padStart(19, "0")}`;
  let keySeq = 0;
  async function newKey(): Promise<string> {
    keySeq += 1;
    const kid = kidOf(keySeq);
    await app.insert(s.integritySigningKeys).values({ kid, publicKey: `pk-${kid}` });
    return kid;
  }
  const entry = (
    channelId: string,
    broadcastId: string,
    kid: string,
    seq: number,
    prev: string | null,
    kind: "broadcast" | "supersede" = "broadcast",
    supersedes: string | null = null,
  ) => {
    const entryHash = `h-${uuidv7()}`;
    return {
      row: {
        channelId,
        broadcastId,
        seq,
        kind,
        kid,
        payload: "p",
        signature: "s",
        entryHash,
        prevHash: prev,
        supersedes,
        signedAt: new Date(),
        salt: "salt",
      },
      entryHash,
    };
  };

  test("the chain refuses gaps, wrong links, a second broadcast entry and unknown supersedes", async () => {
    const { channelId } = await newChannel();
    const b1 = await newBroadcast(channelId);
    const b2 = await newBroadcast(channelId);
    const kid = await newKey();
    const ins = (r: ReturnType<typeof entry>) => app.insert(s.integrityAttestations).values(r.row);
    expect(await refused(ins(entry(channelId, b1, kid, 2, null)), /head \+ 1/)).toBe("23514");
    const first = entry(channelId, b1, kid, 1, null);
    await ins(first);
    expect(await refused(ins(entry(channelId, b2, kid, 2, "not-the-head")), /prev_hash/)).toBe("23514");
    expect(await refused(ins(entry(channelId, b1, kid, 2, first.entryHash)), /exactly one broadcast entry/)).toBe(
      "23514",
    );
    expect(
      await refused(ins(entry(channelId, b1, kid, 2, first.entryHash, "supersede", "nope")), /same broadcast/),
    ).toBe("23514");
    const second = entry(channelId, b1, kid, 2, first.entryHash, "supersede", first.entryHash);
    await ins(second);
    await ins(entry(channelId, b2, kid, 3, second.entryHash));
    // Another channel's chain starts at 1, and a broadcast of another channel is refused.
    const other = await newChannel();
    expect(await refused(ins(entry(other.channelId, b1, kid, 1, null)), /own channel/)).toBe("23514");
  });

  test("attestations are append-only and never cover a rehearsal", async () => {
    const { channelId } = await newChannel();
    const b = await newBroadcast(channelId);
    const r = await newBroadcast(channelId, "rehearsal");
    const kid = await newKey();
    expect(
      await refused(app.insert(s.integrityAttestations).values(entry(channelId, r, kid, 1, null).row), /rehearsal/),
    ).toBe("23514");
    await app.insert(s.integrityAttestations).values(entry(channelId, b, kid, 1, null).row);
    expect(
      await refused(
        app.update(s.integrityAttestations).set({ salt: "x" }).where(eq(s.integrityAttestations.channelId, channelId)),
      ),
    ).toBe("42501");
    expect(
      await refused(app.delete(s.integrityAttestations).where(eq(s.integrityAttestations.channelId, channelId))),
    ).toBe("42501");
  });

  test("retired and compromised keys sign nothing; keys only gain retired_at and compromised_at, once", async () => {
    const { channelId } = await newChannel();
    const b = await newBroadcast(channelId);
    const retired = await newKey();
    const compromised = await newKey();
    expect(
      await refused(
        app.insert(s.integritySigningKeys).values({ kid: kidOf(900), publicKey: "x", retiredAt: new Date() }),
      ),
    ).toBe("23514");
    await app
      .update(s.integritySigningKeys)
      .set({ retiredAt: new Date() })
      .where(eq(s.integritySigningKeys.kid, retired));
    await app
      .update(s.integritySigningKeys)
      .set({ compromisedAt: new Date() })
      .where(eq(s.integritySigningKeys.kid, compromised));
    expect(
      await refused(app.insert(s.integrityAttestations).values(entry(channelId, b, retired, 1, null).row), /active/),
    ).toBe("23514");
    expect(
      await refused(app.insert(s.integrityAttestations).values(entry(channelId, b, compromised, 1, null).row)),
    ).toBe("23514");
    expect(
      await refused(
        app
          .update(s.integritySigningKeys)
          .set({ retiredAt: new Date(0) })
          .where(eq(s.integritySigningKeys.kid, retired)),
        /once each/,
      ),
    ).toBe("42501");
    expect(
      await refused(
        app.update(s.integritySigningKeys).set({ publicKey: "other" }).where(eq(s.integritySigningKeys.kid, retired)),
      ),
    ).toBe("42501");
    // A retired key may still be marked compromised later.
    await app
      .update(s.integritySigningKeys)
      .set({ compromisedAt: new Date() })
      .where(eq(s.integritySigningKeys.kid, retired));
    expect(await refused(app.delete(s.integritySigningKeys).where(eq(s.integritySigningKeys.kid, retired)))).toBe(
      "42501",
    );
  });
});

describe("enforcement and group-appeal CHECKs (decisions (d), (m))", () => {
  test("rule_ref has the clause format and sits only on platform mod actions", async () => {
    const { channelId } = await newChannel();
    const target = await newUser();
    const base = { channelId, targetUserId: target, action: "ban" as const };
    await app.insert(s.modActions).values({ ...base, scope: "platform", ruleRef: "honesty.spam@1" });
    expect(
      await refused(app.insert(s.modActions).values({ ...base, scope: "channel", ruleRef: "honesty.spam@1" })),
    ).toBe("23514");
    for (const bad of ["honesty.spam", "Honesty.spam@1", "honesty.spam@0", "honesty spam@1", "@1"])
      expect(await refused(app.insert(s.modActions).values({ ...base, scope: "platform", ruleRef: bad })), bad).toBe(
        "23514",
      );
    await app.insert(s.modActions).values({ ...base, scope: "channel" });
    await app.insert(s.moderationCases).values({
      tier: "t1",
      origin: "classifier",
      subjectType: "broadcast",
      subjectId: uuidv7(),
      ruleRef: "safety.sexual-explicit@1",
    });
    expect(
      await refused(
        app
          .insert(s.moderationCases)
          .values({ tier: "t1", origin: "classifier", subjectType: "broadcast", subjectId: uuidv7(), ruleRef: "x" }),
      ),
    ).toBe("23514");
  });

  test("an exclusion_group appeal is an integrity appeal with a category, and only it has one", async () => {
    const appellantId = await newUser();
    const a = { appellantId, subjectId: uuidv7(), body: "please look again" };
    await app
      .insert(s.appeals)
      .values({ ...a, kind: "integrity", subjectType: "exclusion_group", exclusionCategory: "datacenter" });
    expect(
      await refused(
        app.insert(s.appeals).values({ ...a, subjectId: uuidv7(), kind: "integrity", subjectType: "exclusion_group" }),
      ),
    ).toBe("23514");
    expect(
      await refused(
        app.insert(s.appeals).values({
          ...a,
          subjectId: uuidv7(),
          kind: "moderation",
          subjectType: "exclusion_group",
          exclusionCategory: "other",
        }),
      ),
    ).toBe("23514");
    expect(
      await refused(
        app
          .insert(s.appeals)
          .values({ ...a, subjectId: uuidv7(), kind: "integrity", subjectType: "session", exclusionCategory: "other" }),
      ),
    ).toBe("23514");
    await app.insert(s.appeals).values({
      ...a,
      subjectId: uuidv7(),
      kind: "moderation",
      subjectType: "moderation_case",
      ruleRef: "decency.hate@1",
    });
  });
});
