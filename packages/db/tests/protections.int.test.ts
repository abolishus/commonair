// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The database's own integrity protections. Each "bypass" test reproduces an attack
 * found in review and asserts the database refuses it.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";

// Governance flows wait out real (shortened) review and voting windows.
vi.setConfig({ testTimeout: 30_000 });
import type { GovernanceRuleSnapshot } from "@commonair/contracts/shapes";
import * as s from "../src/schema/index.ts";
import { FAST_GOVERNANCE, createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { uuidv7 } from "../src/ids.ts";

let t: TestDatabase;

/** Drizzle wraps driver errors as "Failed query: …"; assert on the database's own message. */
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
});
afterAll(async () => {
  await t?.drop();
});

let userSeq = 0;
async function makeUser(name = `user${++userSeq}`): Promise<string> {
  const [u] = await t.db
    .insert(s.users)
    .values({ name, email: `${name}@example.test`, username: name })
    .returning({ id: s.users.id });
  return u!.id;
}

async function account(code: string, ownerUserId: string | null = null): Promise<string> {
  const [a] = await t.db
    .insert(s.ledgerAccounts)
    .values({ code, type: "asset", name: code, currency: "usd", ownerUserId })
    .returning({ id: s.ledgerAccounts.id });
  return a!.id;
}

describe("ledger", () => {
  let cash = "";
  let rev = "";
  beforeAll(async () => {
    cash = await account("asset:test-cash");
    rev = await account("revenue:test");
  });

  async function post(amounts: [string, number][]): Promise<string> {
    return t.db.transaction(async (tx) => {
      const [x] = await tx
        .insert(s.ledgerTransactions)
        .values({
          kind: "test",
          description: "t",
          occurredAt: new Date(),
          idempotencyKey: uuidv7(),
        })
        .returning();
      await tx.insert(s.ledgerEntries).values(
        amounts.map(([accountId, amountCents]) => ({
          transactionId: x!.id,
          accountId,
          amountCents,
          currency: "usd",
        })),
      );
      return x!.id;
    });
  }

  test("accepts a balanced transaction and rejects an unbalanced one at commit", async () => {
    await expect(
      post([
        [cash, 500],
        [rev, -500],
      ]),
    ).resolves.toBeTypeOf("string");
    await expectPgError(
      post([
        [cash, 500],
        [rev, -499],
      ]),
      /unbalanced/,
    );
  });

  test("rejects transactions without entries and zero-amount entries", async () => {
    await expectPgError(
      t.db.insert(s.ledgerTransactions).values({
        kind: "test",
        description: "empty",
        occurredAt: new Date(),
        idempotencyKey: uuidv7(),
      }),
      /at least 2 required/,
    );
    await expectPgError(
      post([
        [cash, 0],
        [rev, 0],
      ]),
      /ledger_entries_nonzero/,
    );
  });

  test("bypass: entries cannot be added to an already committed transaction", async () => {
    const id = await post([
      [cash, 100],
      [rev, -100],
    ]);
    await expectPgError(
      t.db.insert(s.ledgerEntries).values([
        { transactionId: id, accountId: cash, amountCents: -5000, currency: "usd" },
        { transactionId: id, accountId: rev, amountCents: 5000, currency: "usd" },
      ]),
      /only be added in the database transaction that created/,
    );
  });

  test("bypass: a temp table cannot shadow ledger_entries in the balance check", async () => {
    await expectPgError(
      t.db.transaction(async (tx) => {
        await tx.execute(sql`create temp table ledger_entries (like public.ledger_entries) on commit drop`);
        await tx.execute(sql`insert into ledger_entries (id, transaction_id, account_id, amount_cents, currency, created_at)
          select gen_random_uuid(), gen_random_uuid(), ${cash}, 1, 'usd', now() from generate_series(1, 2)`);
        const [x] = await tx
          .insert(s.ledgerTransactions)
          .values({
            kind: "test",
            description: "hijack",
            occurredAt: new Date(),
            idempotencyKey: uuidv7(),
          })
          .returning();
        await tx.execute(
          sql`insert into public.ledger_entries (id, transaction_id, account_id, amount_cents, currency) values (gen_random_uuid(), ${x!.id}, ${cash}, 1000000, 'usd')`,
        );
      }),
      /has 1 entries|unbalanced/,
    );
  });

  test("is append-only, and accounts are never retyped, deleted or reassigned", async () => {
    await expectPgError(t.db.update(s.ledgerEntries).set({ memo: "edited" }), /append-only/);
    await expectPgError(t.db.delete(s.ledgerTransactions), /append-only/);
    await expectPgError(t.db.execute(sql`truncate ledger_entries cascade`), /append-only/);
    await expectPgError(t.db.update(s.ledgerAccounts).set({ type: "liability" }), /immutable/);
    const a = await makeUser();
    const b = await makeUser();
    const owned = await account(`liability:creator:${a}`, a);
    await expectPgError(
      t.db.update(s.ledgerAccounts).set({ ownerUserId: b }).where(eq(s.ledgerAccounts.id, owned)),
      /only be cleared/,
    );
    await t.db.update(s.ledgerAccounts).set({ ownerUserId: null }).where(eq(s.ledgerAccounts.id, owned));
  });

  test("audit log is append-only", async () => {
    await t.db.insert(s.auditLog).values({ actorType: "system", action: "test", subjectType: "x", subjectId: "1" });
    await expectPgError(t.db.update(s.auditLog).set({ reason: "rewritten" }), /append-only/);
    await expectPgError(t.db.delete(s.auditLog), /append-only/);
  });
});

describe("governance", () => {
  const protectedRules: GovernanceRuleSnapshot = {
    ruleVersion: "test",
    protected: true,
    memberWideThreshold: 2 / 3,
    streamerClassThreshold: 0.5,
    quorum: 0.2,
    streamerClassQuorum: 0.2,
    councilReviewRequired: true,
  };
  let viewers: string[] = [];
  let streamers: string[] = [];
  let cutSeq = 0;
  const nextCut = () => {
    const streamerShare = 0.9 + ++cutSeq / 1000;
    return { streamerShare, coopShare: Number((1 - streamerShare).toFixed(4)) };
  };

  beforeAll(async () => {
    viewers = await Promise.all(Array.from({ length: 6 }, () => makeUser()));
    streamers = await Promise.all(Array.from({ length: 3 }, () => makeUser()));
    await t.db.insert(s.memberships).values([
      ...viewers.map((userId) => ({ userId, class: "viewer" as const, basis: "share" as const })),
      ...streamers.map((userId) => ({
        userId,
        class: "streamer" as const,
        basis: "streaming_hours" as const,
      })),
    ]);
  });

  type Status = (typeof s.proposals.$inferSelect)["status"];
  const setStatus = (id: string, status: Status, extra: Partial<typeof s.proposals.$inferInsert> = {}) =>
    t.db
      .update(s.proposals)
      .set({ status, ...extra })
      .where(eq(s.proposals.id, id));

  async function draft(
    changes: { key: string; value: unknown }[],
    kind: "ordinary" | "protected" = "protected",
  ): Promise<string> {
    const [p] = await t.db
      .insert(s.proposals)
      .values({
        authorId: streamers[0]!,
        title: "Change",
        body: "test",
        kind,
        affectsCreators: kind === "protected",
        changes,
      })
      .returning({ id: s.proposals.id });
    return p!.id;
  }

  /** Draft → discussion → council review (1 s) → voting with a window of `windowMs`. */
  async function openVote(
    changes: { key: string; value: unknown }[],
    rules = protectedRules,
    windowMs = 1500,
  ): Promise<string> {
    const id = await draft(changes);
    await setStatus(id, "discussion");
    await setStatus(id, "council_review");
    await sleep(1100);
    await setStatus(id, "voting", { rules, votingEndsAt: new Date(Date.now() + windowMs) });
    return id;
  }

  async function cast(proposalId: string, yes: string[], no: string[]): Promise<void> {
    await t.db
      .insert(s.votes)
      .values([
        ...yes.map((userId) => ({ proposalId, userId, choice: "yes" as const })),
        ...no.map((userId) => ({ proposalId, userId, choice: "no" as const })),
      ]);
  }

  const apply = (key: string, value: unknown, proposalId: string | null) =>
    t.db
      .update(s.governanceSettings)
      .set({ value, updatedByProposalId: proposalId })
      .where(eq(s.governanceSettings.key, key));

  async function passProtected(value: unknown, key = "platform.cut"): Promise<string> {
    const id = await openVote([{ key, value }]);
    await cast(id, [...viewers.slice(0, 4), streamers[0]!, streamers[1]!], [viewers[4]!, streamers[2]!]);
    await sleep(1600);
    await setStatus(id, "passed");
    return id;
  }

  const cutValue = async () =>
    (await t.db.select().from(s.governanceSettings).where(eq(s.governanceSettings.key, "platform.cut")))[0]!.value;

  test("an admin cannot change, delete, unprotect or truncate settings directly", async () => {
    await expectPgError(apply("platform.cut", nextCut(), null), /applying a passed proposal/);
    await expectPgError(apply("discovery.ranking", {}, null), /applying a passed proposal/);
    await expectPgError(
      t.db.delete(s.governanceSettings).where(eq(s.governanceSettings.key, "platform.cut")),
      /cannot be deleted/,
    );
    await expectPgError(
      t.db.update(s.governanceSettings).set({ protected: false }).where(eq(s.governanceSettings.key, "platform.cut")),
      /applying a passed proposal/,
    );
    await expectPgError(t.db.execute(sql`truncate governance_settings cascade`), /append-only/);
    await expectPgError(t.db.execute(sql`truncate governance_settings_history`), /append-only/);
    await expectPgError(
      t.db.insert(s.governanceSettingsHistory).values({ key: "platform.cut", newValue: {} }),
      /written by the database only/,
    );
  });

  test("new settings derive their protected flag; it cannot be chosen", async () => {
    await t.db.insert(s.governanceSettings).values({ key: "test.free", value: 1, protected: true, description: "x" });
    const [row] = await t.db.select().from(s.governanceSettings).where(eq(s.governanceSettings.key, "test.free"));
    expect(row!.protected).toBe(false);
  });

  test("proposals start as drafts and the electorate is built from active memberships", async () => {
    await expectPgError(
      t.db.insert(s.proposals).values({
        authorId: streamers[0]!,
        title: "x",
        body: "",
        kind: "ordinary",
        affectsCreators: false,
        status: "passed",
      }),
      /start as drafts/,
    );
    await expectPgError(
      t.db.insert(s.proposalElectorate).values({ proposalId: uuidv7(), userId: viewers[0]!, classes: ["streamer"] }),
      /written by the database only/,
    );
    const id = await openVote([{ key: "platform.cut", value: nextCut() }]);
    const electorate = await t.db.select().from(s.proposalElectorate).where(eq(s.proposalElectorate.proposalId, id));
    expect(electorate).toHaveLength(9);
    expect(electorate.filter((e) => e.classes.includes("streamer"))).toHaveLength(3);
  });

  test("a proposal that passes member-wide but fails within the streamer class is rejected", async () => {
    const value = nextCut();
    const id = await openVote([{ key: "platform.cut", value }]);
    // 7 of 9 yes member-wide (78% ≥ 2/3) but only 1 of 3 streamers.
    await cast(id, [...viewers, streamers[0]!], [streamers[1]!, streamers[2]!]);
    await sleep(1600);
    await expectPgError(setStatus(id, "passed"), /streamer-class majority not met/);
    await expectPgError(apply("platform.cut", value, id), /not a passed, unapplied decision/);
    const tally = (await t.db.execute(sql`select * from commonair_governance_tally(${id})`)) as unknown as {
      passed: boolean;
      reason: string;
    }[];
    expect(tally[0]).toEqual({ passed: false, reason: "streamer-class majority not met" });
    await setStatus(id, "rejected");
  });

  test("a passing vote cannot be marked rejected", async () => {
    const id = await passProtected(nextCut());
    expect((await t.db.select().from(s.proposals).where(eq(s.proposals.id, id)))[0]!.status).toBe("passed");
    await expectPgError(setStatus(id, "rejected"), /cannot go from passed to rejected/);
  });

  test("a passed protected decision applies exactly once and then the proposal is marked applied", async () => {
    const value = nextCut();
    const id = await passProtected(value);
    await expectPgError(
      apply("platform.cut", { streamerShare: 0.5, coopShare: 0.5 }, id),
      /does not contain this change/,
    );
    await expectPgError(setStatus(id, "applied"), /apply every change/);
    await t.db.transaction(async (tx) => {
      await tx
        .update(s.governanceSettings)
        .set({ value, updatedByProposalId: id })
        .where(eq(s.governanceSettings.key, "platform.cut"));
      await tx.update(s.proposals).set({ status: "applied" }).where(eq(s.proposals.id, id));
    });
    expect(await cutValue()).toEqual(value);
    const history = await t.db
      .select()
      .from(s.governanceSettingsHistory)
      .where(eq(s.governanceSettingsHistory.key, "platform.cut"));
    expect(history.at(-1)!.proposalId).toBe(id);
  });

  test("bypass: an applied decision cannot be replayed to revert a newer one", async () => {
    const a = nextCut();
    const p1 = await passProtected(a);
    await t.db.transaction(async (tx) => {
      await tx
        .update(s.governanceSettings)
        .set({ value: a, updatedByProposalId: p1 })
        .where(eq(s.governanceSettings.key, "platform.cut"));
      await tx.update(s.proposals).set({ status: "applied" }).where(eq(s.proposals.id, p1));
    });
    const b = nextCut();
    const p2 = await passProtected(b);
    await apply("platform.cut", b, p2);
    await expectPgError(apply("platform.cut", a, p1), /not a passed, unapplied decision/);
    expect(await cutValue()).toEqual(b);
  });

  test("bypass: a passed proposal cannot be moved back to draft and re-targeted", async () => {
    const id = await passProtected(nextCut());
    await expectPgError(setStatus(id, "draft"), /cannot go from passed to draft/);
    await expectPgError(
      t.db
        .update(s.proposals)
        .set({ changes: [{ key: "platform.cut", value: { streamerShare: 0, coopShare: 1 } }] })
        .where(eq(s.proposals.id, id)),
      /frozen/,
    );
  });

  test("bypass: temp tables cannot impersonate a passed proposal", async () => {
    const fake = uuidv7();
    await expectPgError(
      t.db.transaction(async (tx) => {
        await tx.execute(sql`create temp table proposals (like public.proposals) on commit drop`);
        await tx.execute(sql`insert into proposals (id, author_id, title, body, kind, affects_creators, status, changes, created_at, updated_at)
          values (${fake}, ${streamers[0]!}, 'x', 'x', 'protected', true, 'passed', '[{"key":"platform.cut","value":{"streamerShare":0,"coopShare":1}}]', now(), now())`);
        await tx.execute(
          sql`update public.governance_settings set value = '{"streamerShare":0,"coopShare":1}', updated_by_proposal_id = ${fake} where key = 'platform.cut'`,
        );
      }),
      /violates foreign key|not a passed/,
    );
  });

  test("weaker rules, short windows and skipped council review cannot open a vote", async () => {
    await expectPgError(
      openVote([{ key: "platform.cut", value: nextCut() }], {
        ...protectedRules,
        memberWideThreshold: 0.5,
      }),
      /weaker than/,
    );
    await expectPgError(
      openVote([{ key: "platform.cut", value: nextCut() }], protectedRules, 100),
      /shorter than the minimum/,
    );
    const id = await draft([{ key: "platform.cut", value: nextCut() }]);
    await setStatus(id, "discussion");
    await expectPgError(
      setStatus(id, "voting", {
        rules: protectedRules,
        votingEndsAt: new Date(Date.now() + 60_000),
      }),
      /creator council review/,
    );
    await setStatus(id, "council_review");
    await expectPgError(
      setStatus(id, "voting", {
        rules: protectedRules,
        votingEndsAt: new Date(Date.now() + 60_000),
      }),
      /creator council review/,
    );
  });

  test("protected changes must be filed as protected proposals; changes must name real settings once", async () => {
    await expectPgError(draft([{ key: "patronage.formula", value: {} }], "ordinary"), /must be kind=protected/);
    await expectPgError(draft([{ key: "no.such.setting", value: 1 }], "ordinary"), /existing settings/);
    await expectPgError(
      draft([
        { key: "platform.cut", value: 1 },
        { key: "platform.cut", value: 2 },
      ]),
      /each once/,
    );
  });

  test("votes: electorate only, wall-clock window, no deletes, every change in history", async () => {
    const id = await openVote([{ key: "platform.cut", value: nextCut() }], protectedRules, 1200);
    const outsider = await makeUser();
    await expectPgError(cast(id, [outsider], []), /not in the electorate/);
    await cast(id, [viewers[0]!], []);
    await t.db
      .update(s.votes)
      .set({ choice: "no" })
      .where(and(eq(s.votes.proposalId, id), eq(s.votes.userId, viewers[0]!)));
    // A transaction that began before the deadline cannot slip a vote in after it.
    await expectPgError(
      t.db.transaction(async (tx) => {
        await tx.execute(sql`select 1`);
        await sleep(1300);
        await tx.insert(s.votes).values({ proposalId: id, userId: viewers[1]!, choice: "yes" });
      }),
      /voting is not open/,
    );
    await expectPgError(t.db.delete(s.votes).where(eq(s.votes.proposalId, id)), /cannot be deleted/);
    const history = await t.db.select().from(s.voteHistory).where(eq(s.voteHistory.proposalId, id));
    expect(history.map((h) => h.choice)).toEqual(["yes", "no"]);
  });

  test("a malformed governance.protections change is refused even when it passed", async () => {
    const bad = { protectedKeys: ["platform.cut"], memberWideThreshold: 2 / 3 };
    const id = await passProtected(bad, "governance.protections");
    await expectPgError(apply("governance.protections", bad, id), /must be a number|must be a string array/);
  });

  test("memberships are never deleted and every change is recorded", async () => {
    const u = await makeUser();
    const [m] = await t.db.insert(s.memberships).values({ userId: u, class: "viewer", basis: "share" }).returning();
    await t.db.update(s.memberships).set({ status: "exited", exitedAt: new Date() }).where(eq(s.memberships.id, m!.id));
    await expectPgError(t.db.delete(s.memberships).where(eq(s.memberships.id, m!.id)), /never deleted/);
    const h = await t.db.select().from(s.membershipHistory).where(eq(s.membershipHistory.membershipId, m!.id));
    expect(h.map((r) => [r.op, r.status])).toEqual([
      ["INSERT", "active"],
      ["UPDATE", "exited"],
    ]);
  });
});
