// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The proposal lifecycle against a real database, as the application role, with the short test
 * periods (FAST_GOVERNANCE: no discussion, 1 s council review, 2 s voting). Each describe gets
 * its own database so its electorate is exactly the members it creates.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { schema as s, type Database } from "@commonair/db";
import { FAST_GOVERNANCE, createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import type { GovernanceChange } from "@commonair/contracts/shapes";
import { advanceProposal, advanceProposals, emptyAdvanceResult, type AdvanceResult } from "../src/lifecycle.ts";
import { tally } from "../src/tally.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function expectPgError(p: PromiseLike<unknown>, pattern: RegExp): Promise<void> {
  const err = await Promise.resolve(p).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, "expected the database to reject").toBeInstanceOf(Error);
  const e = err as Error & { cause?: Error };
  expect(e.cause?.message ?? e.message).toMatch(pattern);
}

type Cls = "streamer" | "viewer" | "worker";
const BASIS = { streamer: "streaming_hours", viewer: "share", worker: "board_appointment" } as const;

/** A throwaway database and helpers bound to it (application role). */
function fixture() {
  const f = {
    t: undefined as unknown as TestDatabase,
    app: undefined as unknown as Database,
    seq: 0,
    async member(cls: Cls): Promise<string> {
      const name = `lc${++f.seq}${crypto.randomUUID().slice(0, 6)}`;
      const [u] = await f.app
        .insert(s.users)
        .values({ name, email: `${name}@example.test`, username: name })
        .returning({ id: s.users.id });
      await f.app.insert(s.memberships).values({ userId: u!.id, class: cls, basis: BASIS[cls] });
      return u!.id;
    },
    /** A submitted proposal (draft → discussion, as the author's submit does). */
    async submitted(
      authorId: string,
      o: { changes?: GovernanceChange[]; kind?: "ordinary" | "protected"; affectsCreators?: boolean } = {},
    ): Promise<string> {
      const [p] = await f.app
        .insert(s.proposals)
        .values({
          authorId,
          title: "A proposal",
          body: "Body text",
          kind: o.kind ?? "ordinary",
          affectsCreators: o.affectsCreators ?? false,
          changes: o.changes ?? [],
        })
        .returning({ id: s.proposals.id });
      await f.app.update(s.proposals).set({ status: "discussion" }).where(eq(s.proposals.id, p!.id));
      // The discussion period is 0 s; a deadline must strictly pass.
      await sleep(20);
      return p!.id;
    },
    async proposal(id: string) {
      const [p] = await f.app.select().from(s.proposals).where(eq(s.proposals.id, id));
      return p!;
    },
    async vote(proposalId: string, ballots: [string, "yes" | "no" | "abstain"][]) {
      await f.app.insert(s.votes).values(ballots.map(([userId, choice]) => ({ proposalId, userId, choice })));
    },
    /** Wait until the proposal's voting window has closed by the database clock. */
    async afterVoting(id: string) {
      const p = await f.proposal(id);
      await sleep(Math.max(0, p.votingEndsAt!.getTime() - Date.now()));
      // The database clock may run a little behind this process's (Postgres in a VM).
      for (let i = 0; i < 100; i++) {
        const [r] = (await f.app.execute(
          sql`select clock_timestamp() > voting_ends_at + interval '5 milliseconds' as done from proposals where id = ${id}::uuid`,
        )) as unknown as { done: boolean }[];
        if (r?.done) return;
        await sleep(50);
      }
      throw new Error("voting did not end");
    },
    async audits(id: string) {
      return f.app
        .select()
        .from(s.auditLog)
        .where(and(eq(s.auditLog.subjectType, "proposal"), eq(s.auditLog.subjectId, id)))
        .orderBy(s.auditLog.createdAt, s.auditLog.id);
    },
    async events(id: string) {
      const rows = await f.app
        .select()
        .from(s.events)
        .where(and(eq(s.events.type, "coop.proposal.update"), sql`${s.events.payload}->>'proposal_id' = ${id}`))
        .orderBy(s.events.occurredAt, s.events.id);
      return rows;
    },
    async setting(key: string) {
      const [row] = await f.app.select().from(s.governanceSettings).where(eq(s.governanceSettings.key, key));
      return row!;
    },
    async tallyRow(id: string) {
      const [row] = await f.app.select().from(s.tallies).where(eq(s.tallies.proposalId, id));
      return row;
    },
  };
  beforeAll(async () => {
    f.t = await createTestDatabase({ governance: FAST_GOVERNANCE });
    f.app = f.t.app.db;
  });
  afterAll(async () => {
    await f.t?.drop();
  });
  return f;
}

const advance = (f: ReturnType<typeof fixture>, opts: Parameters<typeof advanceProposals>[1] = {}) =>
  advanceProposals(f.app, opts);
const only = (over: Partial<AdvanceResult>): AdvanceResult => ({ ...emptyAdvanceResult(), ...over });

describe("an ordinary creator-affecting proposal", () => {
  const f = fixture();

  test("goes discussion → council_review → voting → passed → applied with audit, events and notifications", async () => {
    const [s1, s2, v, w] = [
      await f.member("streamer"),
      await f.member("streamer"),
      await f.member("viewer"),
      await f.member("worker"),
    ];
    const ranking = (await f.setting("discovery.ranking")).value as Record<string, unknown>;
    const next = { ...ranking, spotlightSlots: 5 };
    const id = await f.submitted(s2, { affectsCreators: true, changes: [{ key: "discovery.ranking", value: next }] });

    expect(await advance(f)).toEqual(only({ councilReview: 1 }));
    expect((await f.proposal(id)).status).toBe("council_review");
    // The review lasts 1 s: nothing is due yet.
    expect(await advance(f)).toEqual(only({}));

    await sleep(1_100);
    expect(await advance(f)).toEqual(only({ votingOpened: 1, notified: 4 }));
    const voting = await f.proposal(id);
    expect(voting.status).toBe("voting");
    expect(voting.rules).toMatchObject({ protected: false, councilReviewRequired: true, memberWideThreshold: 0.5 });
    // votingSeconds (2) plus the one-second margin, from the database clock.
    const window = voting.votingEndsAt!.getTime() - voting.votingStartsAt!.getTime();
    expect(window).toBeGreaterThanOrEqual(2_900);
    expect(window).toBeLessThan(3_100);
    const notes = await f.app
      .select()
      .from(s.notifications)
      .where(and(eq(s.notifications.type, "vote_open"), sql`${s.notifications.payload}->>'proposalId' = ${id}`));
    expect(notes.map((n) => n.userId).sort()).toEqual([s1, s2, v, w].sort());
    expect(notes[0]!.payload).toEqual({
      proposalId: id,
      kind: "ordinary",
      votingEndsAt: voting.votingEndsAt!.toISOString(),
    });

    await f.vote(id, [
      [s1, "yes"],
      [s2, "yes"],
      [v, "yes"],
      [w, "yes"],
    ]);
    expect(await advance(f)).toEqual(only({}));
    await f.afterVoting(id);
    expect(await advance(f)).toEqual(only({ passed: 1 }));
    expect((await f.proposal(id)).status).toBe("passed");
    const t = await f.tallyRow(id);
    expect(t).toMatchObject({ passed: true, reason: "passed" });
    expect(t!.breakdown.memberWide).toEqual({ eligible: 4, yes: 4, no: 0, abstain: 0 });
    expect(t!.breakdown.byClass).toEqual({
      streamer: { eligible: 2, yes: 2, no: 0, abstain: 0 },
      viewer: { eligible: 1, yes: 1, no: 0, abstain: 0 },
      worker: { eligible: 1, yes: 1, no: 0, abstain: 0 },
    });

    expect(await advance(f)).toEqual(only({ applied: 1 }));
    const applied = await f.proposal(id);
    expect(applied.status).toBe("applied");
    expect(applied.appliedAt).not.toBeNull();
    const setting = await f.setting("discovery.ranking");
    expect(setting.value).toEqual(next);
    expect(setting.updatedByProposalId).toBe(id);
    expect(await advance(f)).toEqual(only({}));

    const audits = await f.audits(id);
    expect(audits.map((a) => [a.action, a.actorType])).toEqual([
      ["proposal.council_review", "system"],
      ["proposal.open_vote", "system"],
      ["proposal.decide", "system"],
      ["proposal.apply", "system"],
    ]);
    expect(audits[2]!.details).toEqual({ passed: true, rule: "passed" });
    const events = await f.events(id);
    expect(events.map((e) => e.payload.status)).toEqual(["council_review", "voting", "passed", "applied"]);
    expect(events[2]!.payload).toMatchObject({ passed: true, reason: "passed", kind: "ordinary" });

    // Secret ballot: no choice and no voter id in any audit row or event of this proposal.
    const written = JSON.stringify([audits.map((a) => a.details), events.map((e) => e.payload)]);
    expect(written).not.toMatch(/"choice"|"yes"|"no"/);
    for (const voter of [s1, s2, v, w]) expect(written).not.toContain(voter);
  });
});

describe("a protected proposal", () => {
  const f = fixture();
  let s1 = "";
  let s2 = "";
  let v = "";
  let w = "";

  beforeAll(async () => {
    s1 = await f.member("streamer");
    s2 = await f.member("streamer");
    v = await f.member("viewer");
    w = await f.member("worker");
  });

  test("that passes member-wide and fails in the streamer class is rejected, and platform.cut is unchanged", async () => {
    const before = (await f.setting("platform.cut")).value;
    const change = { key: "platform.cut", value: { streamerShare: 0.85, coopShare: 0.15 } };
    const id = await f.submitted(w, { kind: "protected", affectsCreators: true, changes: [change] });
    expect(await advance(f)).toEqual(only({ councilReview: 1 }));
    await sleep(1_100);
    expect(await advance(f)).toEqual(only({ votingOpened: 1, notified: 4 }));
    expect((await f.proposal(id)).rules).toMatchObject({ protected: true, councilReviewRequired: true });

    // Member-wide 3 of 4 (≥ 2/3); streamer class 1 of 2 (not a majority).
    await f.vote(id, [
      [v, "yes"],
      [w, "yes"],
      [s2, "yes"],
      [s1, "no"],
    ]);
    await f.afterVoting(id);
    expect(await advance(f)).toEqual(only({ rejected: 1 }));
    const p = await f.proposal(id);
    expect(p.status).toBe("rejected");
    const t = await f.tallyRow(id);
    expect(t).toMatchObject({ passed: false, reason: "streamer-class majority not met" });
    expect(t!.breakdown.byClass.streamer).toEqual({ eligible: 2, yes: 1, no: 1, abstain: 0 });
    expect(t!.breakdown.memberWide).toEqual({ eligible: 4, yes: 3, no: 1, abstain: 0 });
    const decide = (await f.audits(id)).find((a) => a.action === "proposal.decide");
    expect(decide!.details).toEqual({ passed: false, rule: "streamer_class_majority" });
    const last = (await f.events(id)).at(-1)!;
    expect(last.payload).toMatchObject({
      status: "rejected",
      passed: false,
      reason: "streamer-class majority not met",
    });

    // Rejected is terminal: nothing more to do, and no write the app role can make records it as passed.
    expect(await advance(f)).toEqual(only({}));
    await expectPgError(
      f.app.update(s.proposals).set({ status: "passed" }).where(eq(s.proposals.id, id)),
      /cannot go from rejected to passed/,
    );
    await expectPgError(
      f.app.insert(s.tallies).values({ proposalId: id, breakdown: t!.breakdown, passed: true, reason: "passed" }),
      /duplicate key|append-only|disagrees/,
    );
    await expectPgError(
      f.app
        .update(s.governanceSettings)
        .set({ value: change.value, updatedByProposalId: id })
        .where(eq(s.governanceSettings.key, "platform.cut")),
      /not a passed, unapplied decision/,
    );
    expect((await f.setting("platform.cut")).value).toEqual(before);
  });

  test("an ordinary proposal without enough turnout misses quorum and skips council review", async () => {
    const id = await f.submitted(v);
    expect(await advance(f)).toEqual(only({ votingOpened: 1, notified: 4 }));
    expect((await f.audits(id)).map((a) => a.action)).toEqual(["proposal.open_vote"]);
    await f.afterVoting(id);
    expect(await advance(f)).toEqual(only({ rejected: 1 }));
    expect(await f.tallyRow(id)).toMatchObject({ passed: false, reason: "member-wide quorum not met" });
    const decide = (await f.audits(id)).find((a) => a.action === "proposal.decide");
    expect(decide!.details).toEqual({ passed: false, rule: "member_wide_quorum" });
  });

  test("a TS tally the database disagrees with records nothing, is logged, and the next run decides", async () => {
    const id = await f.submitted(v);
    await advance(f);
    await f.vote(id, [
      [v, "yes"],
      [w, "yes"],
    ]);
    await f.afterVoting(id);
    const logger = {
      info: vi.fn<(msg: string, fields?: Record<string, unknown>) => void>(),
      warn: vi.fn<(msg: string, fields?: Record<string, unknown>) => void>(),
      error: vi.fn<(msg: string, fields?: Record<string, unknown>) => void>(),
    };

    // An electorate mismatch: the TS tally misses one member, so its counts differ from the database's.
    const missing: typeof tally = (rules, electorate, votes, o) => tally(rules, electorate.slice(1), votes, o);
    expect(await advance(f, { logger, tallyFn: missing })).toEqual(only({ disagreements: 1 }));
    // A wrong outcome with the right counts.
    const lying: typeof tally = (...args) => ({
      ...tally(...args),
      passed: false,
      reason: "member-wide quorum not met",
    });
    expect(await advance(f, { logger, tallyFn: lying })).toEqual(only({ disagreements: 1 }));

    expect((await f.proposal(id)).status).toBe("voting");
    expect(await f.tallyRow(id)).toBeUndefined();
    expect((await f.audits(id)).map((a) => a.action)).toEqual(["proposal.open_vote"]);
    expect((await f.events(id)).map((e) => e.payload.status)).toEqual(["voting"]);
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenLastCalledWith(expect.stringMatching(/disagrees/), {
      proposalId: id,
      tsReason: "member-wide quorum not met",
      sqlReason: "passed",
      code: "23514",
    });

    expect(await advance(f, { logger })).toEqual(only({ passed: 1 }));
    expect(await f.tallyRow(id)).toMatchObject({ passed: true, reason: "passed" });
  });
});

describe("applying", () => {
  const f = fixture();

  test("a change superseded since the vote opened is refused once, and never retried", async () => {
    const author = await f.member("viewer");
    const voters = [author, await f.member("streamer"), await f.member("worker")];
    const ranking = (await f.setting("discovery.ranking")).value as Record<string, unknown>;
    const a = await f.submitted(author, {
      changes: [{ key: "discovery.ranking", value: { ...ranking, spotlightSlots: 6 } }],
    });
    const b = await f.submitted(author, {
      changes: [{ key: "discovery.ranking", value: { ...ranking, spotlightSlots: 7 } }],
    });
    expect(await advance(f)).toEqual(only({ votingOpened: 2, notified: 6 }));
    for (const id of [a, b])
      await f.vote(
        id,
        voters.map((u) => [u, "yes"] as [string, "yes"]),
      );
    await f.afterVoting(b);
    expect(await advance(f)).toEqual(only({ passed: 2 }));

    const logger = {
      info: vi.fn<(msg: string, fields?: Record<string, unknown>) => void>(),
      warn: vi.fn<(msg: string, fields?: Record<string, unknown>) => void>(),
      error: vi.fn<(msg: string, fields?: Record<string, unknown>) => void>(),
    };
    expect(await advance(f, { logger })).toEqual(only({ applied: 1, applyRefused: 1 }));
    const statuses = [(await f.proposal(a)).status, (await f.proposal(b)).status].sort();
    expect(statuses).toEqual(["applied", "passed"]);
    const refused = (await f.proposal(a)).status === "passed" ? a : b;
    const winner = refused === a ? b : a;
    expect((await f.setting("discovery.ranking")).updatedByProposalId).toBe(winner);
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { proposalId: refused, code: "42501" });
    const audit = (await f.audits(refused)).filter((x) => x.action === "proposal.apply_refused");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details).toEqual({ proposalId: refused, keys: ["discovery.ranking"], code: "42501" });

    // Not retried every run.
    expect(await advance(f, { logger })).toEqual(only({}));
    expect((await f.audits(refused)).filter((x) => x.action === "proposal.apply_refused")).toHaveLength(1);
    expect((await f.proposal(refused)).status).toBe("passed");
  });

  test("a passed proposal without changes is simply marked applied", async () => {
    const author = await f.member("viewer");
    const id = await f.submitted(author);
    await advance(f);
    const electorate = await f.app
      .select({ userId: s.proposalElectorate.userId })
      .from(s.proposalElectorate)
      .where(eq(s.proposalElectorate.proposalId, id));
    await f.vote(
      id,
      electorate.map((e) => [e.userId, "yes"] as [string, "yes"]),
    );
    await f.afterVoting(id);
    expect(await advance(f)).toEqual(only({ passed: 1 }));
    expect(await advance(f)).toEqual(only({ applied: 1 }));
    expect((await f.proposal(id)).status).toBe("applied");
  });
});

describe("concurrency", () => {
  const f = fixture();

  test("concurrent runs open, decide and apply each proposal exactly once", async () => {
    const voters = [await f.member("viewer"), await f.member("streamer"), await f.member("worker")];
    const ids = [await f.submitted(voters[0]!), await f.submitted(voters[1]!), await f.submitted(voters[2]!)];
    const runAll = async () => {
      const results = await Promise.all([1, 2, 3].map(() => advance(f)));
      const sum = emptyAdvanceResult();
      for (const r of results) for (const k of Object.keys(sum) as (keyof AdvanceResult)[]) sum[k] += r[k];
      return sum;
    };
    expect(await runAll()).toEqual(only({ votingOpened: 3, notified: 9 }));
    for (const id of ids)
      await f.vote(
        id,
        voters.map((u) => [u, "yes"] as [string, "yes"]),
      );
    await f.afterVoting(ids[2]!);
    // A run that lists a proposal after another run decided it may apply it in the same round.
    const first = await runAll();
    const second = await runAll();
    expect({ passed: first.passed + second.passed, applied: first.applied + second.applied }).toEqual({
      passed: 3,
      applied: 3,
    });
    expect(first.passed).toBe(3);
    expect(first.failed + second.failed + first.disagreements + second.disagreements).toBe(0);
    expect(await runAll()).toEqual(only({}));

    const tallies = await f.app.select().from(s.tallies).where(inArray(s.tallies.proposalId, ids));
    expect(tallies).toHaveLength(3);
    const notes = await f.app.select().from(s.notifications).where(eq(s.notifications.type, "vote_open"));
    expect(notes).toHaveLength(9);
    for (const id of ids) {
      expect((await f.audits(id)).map((a) => a.action)).toEqual([
        "proposal.open_vote",
        "proposal.decide",
        "proposal.apply",
      ]);
    }
  });

  test("advanceProposal on a proposal with nothing due is a no-op", async () => {
    const author = await f.member("viewer");
    const [p] = await f.app
      .insert(s.proposals)
      .values({ authorId: author, title: "Draft", body: "b", kind: "ordinary", affectsCreators: false, changes: [] })
      .returning({ id: s.proposals.id });
    const result = emptyAdvanceResult();
    expect(await advanceProposal(f.app, p!.id, result)).toBeNull();
    expect(await advanceProposal(f.app, crypto.randomUUID(), result)).toBeNull();
    expect(result).toEqual(emptyAdvanceResult());
  });
});
