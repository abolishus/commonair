// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The database's own integrity protections. Each "bypass" test reproduces an attack
 * found in review and asserts the database refuses it.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";

// Governance flows wait out real (shortened) review and voting windows.
// Postgres runs DROP DATABASE one at a time: when many files finish together, teardown queues.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
import type { GovernanceRuleSnapshot } from "@commonair/contracts/shapes";
import * as s from "../src/schema/index.ts";
import { FAST_GOVERNANCE, createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { uuidv7 } from "../src/ids.ts";
import type { Database } from "../src/client.ts";

let t: TestDatabase;
/** Everything below runs as the least-privilege application role, like production services. */
let app: Database;

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
  app = t.app.db;
});
afterAll(async () => {
  await t?.drop();
});

let userSeq = 0;
async function makeUser(name = `user${++userSeq}`): Promise<string> {
  const [u] = await app
    .insert(s.users)
    .values({ name, email: `${name}@example.test`, username: name })
    .returning({ id: s.users.id });
  return u!.id;
}

async function account(code: string, ownerUserId: string | null = null): Promise<string> {
  const [a] = await app
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
    return app.transaction(async (tx) => {
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
      app.insert(s.ledgerTransactions).values({
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
      app.insert(s.ledgerEntries).values([
        { transactionId: id, accountId: cash, amountCents: -5000, currency: "usd" },
        { transactionId: id, accountId: rev, amountCents: 5000, currency: "usd" },
      ]),
      /only be added in the database transaction that created/,
    );
  });

  test("bypass: a temp table cannot shadow ledger_entries in the balance check", async () => {
    await expectPgError(
      app.transaction(async (tx) => {
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

  test("bypass: SET CONSTRAINTS ALL IMMEDIATE cannot let a transaction commit unbalanced", async () => {
    await expectPgError(
      app.transaction(async (tx) => {
        const [x] = await tx
          .insert(s.ledgerTransactions)
          .values({ kind: "test", description: "early", occurredAt: new Date(), idempotencyKey: uuidv7() })
          .returning();
        await tx.insert(s.ledgerEntries).values([
          { transactionId: x!.id, accountId: cash, amountCents: 5, currency: "usd" },
          { transactionId: x!.id, accountId: rev, amountCents: -5, currency: "usd" },
        ]);
        await tx.execute(sql`set constraints all immediate`);
        await tx.execute(sql`set constraints all deferred`);
        await tx
          .insert(s.ledgerEntries)
          .values({ transactionId: x!.id, accountId: cash, amountCents: 100_000_000, currency: "usd" });
      }),
      /unbalanced/,
    );
  });

  test("is append-only, and accounts are never retyped, deleted or reassigned", async () => {
    await expectPgError(app.update(s.ledgerEntries).set({ memo: "edited" }), /append-only|permission denied/);
    await expectPgError(app.delete(s.ledgerTransactions), /append-only|permission denied/);
    await expectPgError(app.execute(sql`truncate ledger_entries cascade`), /append-only|permission denied/);
    await expectPgError(app.update(s.ledgerAccounts).set({ type: "liability" }), /immutable/);
    const a = await makeUser();
    const b = await makeUser();
    const owned = await account(`liability:creator:${a}`, a);
    await expectPgError(
      app.update(s.ledgerAccounts).set({ ownerUserId: b }).where(eq(s.ledgerAccounts.id, owned)),
      /only be cleared/,
    );
    await app.update(s.ledgerAccounts).set({ ownerUserId: null }).where(eq(s.ledgerAccounts.id, owned));
  });

  test("audit log is append-only", async () => {
    await app.insert(s.auditLog).values({ actorType: "system", action: "test", subjectType: "x", subjectId: "1" });
    await expectPgError(app.update(s.auditLog).set({ reason: "rewritten" }), /append-only|permission denied/);
    await expectPgError(app.delete(s.auditLog), /append-only|permission denied/);
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
    await app.insert(s.memberships).values([
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
    app
      .update(s.proposals)
      .set({ status, ...extra })
      .where(eq(s.proposals.id, id));

  async function draft(
    changes: { key: string; value: unknown }[],
    kind: "ordinary" | "protected" = "protected",
  ): Promise<string> {
    const [p] = await app
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
    await app
      .insert(s.votes)
      .values([
        ...yes.map((userId) => ({ proposalId, userId, choice: "yes" as const })),
        ...no.map((userId) => ({ proposalId, userId, choice: "no" as const })),
      ]);
  }

  const apply = (key: string, value: unknown, proposalId: string | null) =>
    app
      .update(s.governanceSettings)
      .set({ value, updatedByProposalId: proposalId })
      .where(eq(s.governanceSettings.key, key));

  /** Apply every change and mark the proposal applied, in one transaction (all-or-nothing). */
  const applyAll = (proposalId: string, changes: [string, unknown][]) =>
    app.transaction(async (tx) => {
      for (const [key, value] of changes)
        await tx
          .update(s.governanceSettings)
          .set({ value, updatedByProposalId: proposalId })
          .where(eq(s.governanceSettings.key, key));
      await tx.update(s.proposals).set({ status: "applied" }).where(eq(s.proposals.id, proposalId));
    });

  async function passProtected(value: unknown, key = "platform.cut"): Promise<string> {
    const id = await openVote([{ key, value }]);
    await cast(id, [...viewers.slice(0, 4), streamers[0]!, streamers[1]!], [viewers[4]!, streamers[2]!]);
    await sleep(1600);
    await setStatus(id, "passed");
    return id;
  }

  const cutValue = async () =>
    (await app.select().from(s.governanceSettings).where(eq(s.governanceSettings.key, "platform.cut")))[0]!.value;

  test("an admin cannot change, delete, unprotect or truncate settings directly", async () => {
    await expectPgError(apply("platform.cut", nextCut(), null), /applying a passed proposal/);
    await expectPgError(apply("discovery.ranking", {}, null), /applying a passed proposal/);
    await expectPgError(
      app.delete(s.governanceSettings).where(eq(s.governanceSettings.key, "platform.cut")),
      /cannot be deleted|permission denied/,
    );
    await expectPgError(
      app.update(s.governanceSettings).set({ protected: false }).where(eq(s.governanceSettings.key, "platform.cut")),
      /applying a passed proposal/,
    );
    await expectPgError(app.execute(sql`truncate governance_settings cascade`), /append-only|permission denied/);
    await expectPgError(app.execute(sql`truncate governance_settings_history`), /append-only|permission denied/);
    await expectPgError(
      app.insert(s.governanceSettingsHistory).values({ key: "platform.cut", newValue: {} }),
      /written by the database only|permission denied/,
    );
  });

  test("new settings are defined only by the owner, and their protected flag is derived", async () => {
    await expectPgError(
      app.insert(s.governanceSettings).values({ key: "test.app", value: 1, protected: false, description: "x" }),
      /permission denied|defined by migrations/,
    );
    await t.db.insert(s.governanceSettings).values({ key: "test.free", value: 1, protected: true, description: "x" });
    const [row] = await app.select().from(s.governanceSettings).where(eq(s.governanceSettings.key, "test.free"));
    expect(row!.protected).toBe(false);
  });

  test("proposals start as drafts and the electorate is built from active memberships", async () => {
    await expectPgError(
      app.insert(s.proposals).values({
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
      app.insert(s.proposalElectorate).values({ proposalId: uuidv7(), userId: viewers[0]!, classes: ["streamer"] }),
      /written by the database only|permission denied/,
    );
    const id = await openVote([{ key: "platform.cut", value: nextCut() }]);
    const electorate = await app.select().from(s.proposalElectorate).where(eq(s.proposalElectorate.proposalId, id));
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
    const tally = (await app.execute(sql`select * from commonair_governance_tally(${id})`)) as unknown as {
      passed: boolean;
      reason: string;
    }[];
    expect(tally[0]).toEqual({ passed: false, reason: "streamer-class majority not met" });
    await setStatus(id, "rejected");
  });

  test("a passing vote cannot be marked rejected", async () => {
    const id = await passProtected(nextCut());
    expect((await app.select().from(s.proposals).where(eq(s.proposals.id, id)))[0]!.status).toBe("passed");
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
    await app.transaction(async (tx) => {
      await tx
        .update(s.governanceSettings)
        .set({ value, updatedByProposalId: id })
        .where(eq(s.governanceSettings.key, "platform.cut"));
      await tx.update(s.proposals).set({ status: "applied" }).where(eq(s.proposals.id, id));
    });
    expect(await cutValue()).toEqual(value);
    const history = await app
      .select()
      .from(s.governanceSettingsHistory)
      .where(eq(s.governanceSettingsHistory.key, "platform.cut"));
    expect(history.at(-1)!.proposalId).toBe(id);
  });

  test("bypass: an applied decision cannot be replayed to revert a newer one", async () => {
    const a = nextCut();
    const p1 = await passProtected(a);
    await app.transaction(async (tx) => {
      await tx
        .update(s.governanceSettings)
        .set({ value: a, updatedByProposalId: p1 })
        .where(eq(s.governanceSettings.key, "platform.cut"));
      await tx.update(s.proposals).set({ status: "applied" }).where(eq(s.proposals.id, p1));
    });
    const b = nextCut();
    const p2 = await passProtected(b);
    await applyAll(p2, [["platform.cut", b]]);
    await expectPgError(apply("platform.cut", a, p1), /not a passed, unapplied decision/);
    expect(await cutValue()).toEqual(b);
  });

  test("bypass: a passed proposal cannot be moved back to draft and re-targeted", async () => {
    const id = await passProtected(nextCut());
    await expectPgError(setStatus(id, "draft"), /cannot go from passed to draft/);
    await expectPgError(
      app
        .update(s.proposals)
        .set({ changes: [{ key: "platform.cut", value: { streamerShare: 0, coopShare: 1 } }] })
        .where(eq(s.proposals.id, id)),
      /frozen/,
    );
  });

  test("bypass: temp tables cannot impersonate a passed proposal", async () => {
    const fake = uuidv7();
    await expectPgError(
      app.transaction(async (tx) => {
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
    await app
      .update(s.votes)
      .set({ choice: "no" })
      .where(and(eq(s.votes.proposalId, id), eq(s.votes.userId, viewers[0]!)));
    // A transaction that began before the deadline cannot slip a vote in after it.
    await expectPgError(
      app.transaction(async (tx) => {
        await tx.execute(sql`select 1`);
        await sleep(1300);
        await tx.insert(s.votes).values({ proposalId: id, userId: viewers[1]!, choice: "yes" });
      }),
      /voting is not open/,
    );
    await expectPgError(app.delete(s.votes).where(eq(s.votes.proposalId, id)), /cannot be deleted|permission denied/);
    const history = await app.select().from(s.voteHistory).where(eq(s.voteHistory.proposalId, id));
    expect(history.map((h) => h.choice)).toEqual(["yes", "no"]);
  });

  test("a malformed governance.protections change is refused even when it passed", async () => {
    const bad = { protectedKeys: ["platform.cut"], memberWideThreshold: 2 / 3 };
    const id = await passProtected(bad, "governance.protections");
    await expectPgError(apply("governance.protections", bad, id), /must be a number|must be a string array/);
  });

  test("memberships are never deleted and every change is recorded", async () => {
    const u = await makeUser();
    const [m] = await app.insert(s.memberships).values({ userId: u, class: "viewer", basis: "share" }).returning();
    await app.update(s.memberships).set({ status: "exited", exitedAt: new Date() }).where(eq(s.memberships.id, m!.id));
    await expectPgError(
      app.delete(s.memberships).where(eq(s.memberships.id, m!.id)),
      /never deleted|permission denied/,
    );
    const h = await app.select().from(s.membershipHistory).where(eq(s.membershipHistory.membershipId, m!.id));
    expect(h.map((r) => [r.op, r.status])).toEqual([
      ["INSERT", "active"],
      ["UPDATE", "exited"],
    ]);
  });

  test("bypass: rules without thresholds cannot open a vote, and malformed rules never tally as passed", async () => {
    for (const rules of [
      { protected: true },
      { ...protectedRules, quorum: null },
      { ...protectedRules, memberWideThreshold: "0.1" },
    ]) {
      await expectPgError(openVote([{ key: "platform.cut", value: nextCut() }], rules as never), /malformed or weaker/);
    }
  });

  test("bypass: a caller's temp-table trigger cannot write history, electorate or applications", async () => {
    const id = await openVote([{ key: "platform.cut", value: nextCut() }]);
    const attempts = [
      `insert into public.governance_settings_history (id, key, new_value, changed_at) values (gen_random_uuid(), 'platform.cut', '{}', now())`,
      `insert into public.membership_history (id, membership_id, user_id, class, status, basis, op, at) values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'streamer', 'active', 'share', 'INSERT', now())`,
      `insert into public.proposal_electorate (proposal_id, user_id, classes) values ('${id}', '${viewers[0]}', '{streamer}')`,
      `insert into public.governance_applications (proposal_id, key) values ('${id}', 'platform.cut')`,
      `update public.governance_settings set protected = false where key = 'platform.cut'`,
    ];
    for (const stmt of attempts) {
      await expectPgError(
        app.transaction(async (tx) => {
          await tx.execute(sql.raw(`create temp table relay_t (x int) on commit drop`));
          await tx.execute(
            sql.raw(
              `create function pg_temp.relay_f() returns trigger language plpgsql as $f$ begin ${stmt}; return null; end $f$`,
            ),
          );
          await tx.execute(
            sql.raw(`create trigger relay_tr after insert on relay_t for each row execute function pg_temp.relay_f()`),
          );
          await tx.execute(sql.raw(`insert into relay_t values (1)`));
        }),
        /written by the database only|permission denied|only change by applying/,
      );
    }
  });

  test("protections and ordinary settings are bounded so no decision can lock out future decisions", async () => {
    const base = (
      await app.select().from(s.governanceSettings).where(eq(s.governanceSettings.key, "governance.protections"))
    )[0]!.value as Record<string, unknown>;
    const id = await passProtected({ ...base, councilReviewSeconds: 1e300 }, "governance.protections");
    await expectPgError(
      applyAll(id, [["governance.protections", { ...base, councilReviewSeconds: 1e300 }]]),
      /out of range/,
    );
  });

  test("an unapplied decision cannot be applied after a newer change to the same key", async () => {
    const a = nextCut();
    const stale = await passProtected(a);
    const b = nextCut();
    const fresh = await passProtected(b);
    await applyAll(fresh, [["platform.cut", b]]);
    await expectPgError(applyAll(stale, [["platform.cut", a]]), /superseded/);
  });

  test("content cannot change in the same statement as a transition; edits during discussion restart it", async () => {
    const id = await draft([{ key: "platform.cut", value: nextCut() }]);
    await setStatus(id, "discussion");
    const before = (await app.select().from(s.proposals).where(eq(s.proposals.id, id)))[0]!.discussionEndsAt!;
    await sleep(20);
    await app.update(s.proposals).set({ body: "edited" }).where(eq(s.proposals.id, id));
    const after = (await app.select().from(s.proposals).where(eq(s.proposals.id, id)))[0]!.discussionEndsAt!;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
    await expectPgError(setStatus(id, "council_review", { body: "sneaky" }), /cannot change during a transition/);
  });
});

describe("users identity", () => {
  async function adult(name: string): Promise<string> {
    const [u] = await app
      .insert(s.users)
      .values({ name, email: `${name}@example.test`, username: name, birthDate: "1990-01-01" })
      .returning({ id: s.users.id });
    return u!.id;
  }

  test("a set birth date cannot be changed by the app role", async () => {
    const id = await adult(`idb${++userSeq}`);
    await expectPgError(
      app.update(s.users).set({ birthDate: "2015-01-01" }).where(eq(s.users.id, id)),
      /birth_date cannot be changed/,
    );
    await expectPgError(
      app.update(s.users).set({ birthDate: null }).where(eq(s.users.id, id)),
      /birth_date cannot be changed/,
    );
  });

  test("a missing birth date can be filled in once", async () => {
    const id = await makeUser();
    await app.update(s.users).set({ birthDate: "2000-05-05" }).where(eq(s.users.id, id));
    await expectPgError(
      app.update(s.users).set({ birthDate: "2000-05-06" }).where(eq(s.users.id, id)),
      /birth_date cannot be changed/,
    );
  });

  test("account type and username are fixed", async () => {
    const id = await makeUser();
    await expectPgError(
      app.update(s.users).set({ accountType: "bot" }).where(eq(s.users.id, id)),
      /account_type cannot be changed/,
    );
    await expectPgError(
      app
        .update(s.users)
        .set({ username: `renamed${userSeq}` })
        .where(eq(s.users.id, id)),
      /username cannot be changed/,
    );
  });

  test("other profile fields and no-op writes still work", async () => {
    const id = await adult(`idn${++userSeq}`);
    const [before] = await app.select().from(s.users).where(eq(s.users.id, id));
    await app
      .update(s.users)
      .set({ name: "New Name", birthDate: before!.birthDate, username: before!.username })
      .where(eq(s.users.id, id));
    const [after] = await app.select().from(s.users).where(eq(s.users.id, id));
    expect(after!.name).toBe("New Name");
  });

  test("pseudonymization may rewrite identity fields", async () => {
    const id = await adult(`idp${++userSeq}`);
    await app
      .update(s.users)
      .set({ username: `deleted-${id}`, birthDate: null, pseudonymizedAt: new Date(), deletedAt: new Date() })
      .where(eq(s.users.id, id));
    const [after] = await app.select().from(s.users).where(eq(s.users.id, id));
    expect(after!.username).toBe(`deleted-${id}`);
    expect(after!.birthDate).toBeNull();
  });

  test("the table owner is not restricted", async () => {
    const id = await adult(`ido${++userSeq}`);
    await t.db.update(s.users).set({ birthDate: "1991-02-02" }).where(eq(s.users.id, id));
    const [after] = await app.select().from(s.users).where(eq(s.users.id, id));
    expect(after!.birthDate).toBe("1991-02-02");
  });
});
