// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overhaul wave 5 (w5-notify): the governance mailer against real Postgres and Valkey. Proposals
 * go through the real lifecycle (`@commonair/governance`, FAST_GOVERNANCE periods, application
 * role), so the electorate, the events and the tally are the ones production writes.
 */
import { schema, type Database } from "@commonair/db";
import { FAST_GOVERNANCE, createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { MemoryMailer, type Mailer } from "@commonair/email";
import { advanceProposals } from "@commonair/governance";
import { NOTIFY_JOBS } from "@commonair/contracts/internal";
import { verifyUnsubscribeToken } from "@commonair/tokens";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import type { EnqueueOptions, WorkerContext } from "../src/context.ts";
import { governanceEmailClaimKey, sendGovernanceEmailPage } from "../src/notify/governance-email/send.ts";
import { siteAt } from "./e6-fixtures.ts";
import { AUTH_SECRET, setup, type TestEnv } from "./fixtures.ts";

const site = siteAt("http://air.example.test");
let env: TestEnv;
let fast: TestDatabase;
const db = (): Database => fast.app.db;

beforeAll(async () => {
  env = await setup({ jobs: [], outbox: false, segments: false });
  fast = await createTestDatabase({ governance: FAST_GOVERNANCE });
});
afterAll(async () => {
  await env?.close();
  await fast?.drop();
});

interface Enqueued {
  name: string;
  data: unknown;
  opts?: EnqueueOptions;
}

function context(mailer: Mailer): { ctx: WorkerContext; enqueued: Enqueued[] } {
  const enqueued: Enqueued[] = [];
  const ctx: WorkerContext = {
    ...env.worker.ctx,
    db: db(),
    mailer,
    site,
    enqueue: async (_queue, name, data, opts) => {
      enqueued.push({ name, data, ...(opts ? { opts } : {}) });
    },
  };
  return { ctx, enqueued };
}

let seq = 0;
/** A streamer member (or a non-member) with governance email on unless said otherwise. */
async function person(o: { member?: boolean; optIn?: boolean | null; verified?: boolean } = {}) {
  const name = `gv${++seq}${crypto.randomUUID().slice(0, 6)}`;
  const [u] = await db()
    .insert(schema.users)
    .values({ name, email: `${name}@example.test`, username: name, emailVerified: o.verified ?? true })
    .returning({ id: schema.users.id, email: schema.users.email });
  const user = u!;
  if (o.member ?? true)
    await db().insert(schema.memberships).values({ userId: user.id, class: "streamer", basis: "streaming_hours" });
  const optIn = o.optIn === undefined ? true : o.optIn;
  if (optIn !== null)
    await db()
      .insert(schema.notificationPreferences)
      .values({ userId: user.id, type: "governance", channelId: null, medium: "email", enabled: optIn });
  return user;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Submit a proposal and step it into voting; returns its id and the vote-opened event id. */
async function openVote(authorId: string, title: string) {
  const [p] = await db()
    .insert(schema.proposals)
    .values({ authorId, title, body: "Body", kind: "ordinary", affectsCreators: false, changes: [] })
    .returning({ id: schema.proposals.id });
  const id = p!.id;
  await db().update(schema.proposals).set({ status: "discussion" }).where(eq(schema.proposals.id, id));
  await sleep(20);
  for (let i = 0; i < 20; i++) {
    await advanceProposals(db());
    const [row] = await db()
      .select({ status: schema.proposals.status })
      .from(schema.proposals)
      .where(eq(schema.proposals.id, id));
    if (row?.status === "voting") break;
    await sleep(100);
  }
  return { id, eventId: await eventFor(id, "voting") };
}

async function eventFor(proposalId: string, status: string): Promise<string> {
  const [e] = await db()
    .select({ id: schema.events.id })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.type, "coop.proposal.update"),
        sql`${schema.events.payload}->>'proposal_id' = ${proposalId}`,
        sql`${schema.events.payload}->>'status' = ${status}`,
      ),
    );
  if (!e) throw new Error(`no ${status} event`);
  return e.id;
}

/** Wait for the vote to close, then decide it. */
async function decide(proposalId: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    await advanceProposals(db());
    const [row] = await db()
      .select({ status: schema.proposals.status })
      .from(schema.proposals)
      .where(eq(schema.proposals.id, proposalId));
    if (row?.status === "passed" || row?.status === "rejected" || row?.status === "applied")
      return eventFor(proposalId, row.status === "applied" ? "passed" : row.status);
    await sleep(100);
  }
  throw new Error("vote not decided");
}

describe("the governance mailer", () => {
  test("vote opened: the opted-in electorate only, with List-Unsubscribe; a re-run sends nothing", async () => {
    const author = await person();
    const optedIn = await person();
    const optedOut = await person({ optIn: false });
    const builtIn = await person({ optIn: null });
    const unverified = await person({ verified: false });
    const outsider = await person({ member: false });
    const { id, eventId } = await openVote(author.id, "Make clips longer");

    const mailer = new MemoryMailer({ site });
    const { ctx } = context(mailer);
    const r = await sendGovernanceEmailPage(ctx, { eventId, after: null });
    expect(r).toMatchObject({ kind: "vote_opened", failed: 0, nextPage: false });
    const to = mailer.sent.map((m) => m.to);
    expect(to).toContain(optedIn.email);
    expect(to).toContain(author.email);
    for (const u of [optedOut, builtIn, unverified, outsider]) expect(to).not.toContain(u.email);
    const mail = mailer.to(optedIn.email)[0];
    expect(mail?.template).toBe("governanceVoteOpened");
    expect(mail?.subject).toBe("Vote now: Make clips longer");
    expect(mail?.html).toContain(`href="http://air.example.test/coop/proposals/${id}"`);
    const unsubscribe = /^<(.+)>$/.exec(mail?.headers["List-Unsubscribe"] ?? "")?.[1] ?? "";
    expect(unsubscribe).toMatch(/^http:\/\/air\.example\.test\/api\/email\/unsubscribe\?list=governance&token=/);
    const token = new URL(unsubscribe).searchParams.get("token") ?? "";
    expect(await verifyUnsubscribeToken(AUTH_SECRET, token, "governance")).toBe(optedIn.id);
    expect(mail?.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(await ctx.valkey.exists(governanceEmailClaimKey(eventId, optedIn.id))).toBe(1);

    // A redelivered event, or a retried page: everyone is already claimed.
    const again = new MemoryMailer({ site });
    const r2 = await sendGovernanceEmailPage(context(again).ctx, { eventId, after: null });
    expect(again.sent).toEqual([]);
    expect(r2.skipped).toBe(r.sent);
  });

  test("pages the recipients, enqueueing the next page with a deterministic id", async () => {
    const author = await person();
    await person();
    await person();
    const { id, eventId } = await openVote(author.id, "Paging");
    const mailer = new MemoryMailer({ site });
    const { ctx, enqueued } = context(mailer);
    // The electorate members with governance email on and a verified address.
    const pe = schema.proposalElectorate;
    const np = schema.notificationPreferences;
    const electorate = await db()
      .select({ userId: pe.userId })
      .from(pe)
      .innerJoin(
        np,
        and(eq(np.userId, pe.userId), eq(np.type, "governance"), eq(np.medium, "email"), eq(np.enabled, true)),
      )
      .innerJoin(schema.users, eq(schema.users.id, pe.userId))
      .where(and(eq(pe.proposalId, id), eq(schema.users.emailVerified, true)));
    const total = electorate.length;
    expect(total).toBeGreaterThanOrEqual(3);

    let after: string | null = null;
    let sent = 0;
    for (let page = 0; page < total; page++) {
      const r = await sendGovernanceEmailPage(ctx, { eventId, after }, { pageSize: 2 });
      sent += r.sent;
      const next = enqueued.at(-1);
      if (!r.nextPage) break;
      expect(next?.name).toBe(NOTIFY_JOBS.governanceEmail);
      const data = next?.data as { eventId: string; after: string };
      expect(data.eventId).toBe(eventId);
      expect(next?.opts?.jobId).toBe(`governance-email-${eventId}-${data.after}`);
      after = data.after;
    }
    expect(sent).toBe(total);
    expect(new Set(mailer.sent.map((m) => m.to)).size).toBe(total);
  });

  test("result published: every opted-in active member, with the outcome and turnout", async () => {
    const author = await person();
    const voter = await person();
    const { id, eventId: openedId } = await openVote(author.id, "A result");
    await db().insert(schema.votes).values({ proposalId: id, userId: voter.id, choice: "yes" });
    const joinedLater = await person();
    const resultId = await decide(id);
    expect(resultId).not.toBe(openedId);

    // The vote has closed: a late vote-opened page mails nobody.
    const late = new MemoryMailer({ site });
    expect((await sendGovernanceEmailPage(context(late).ctx, { eventId: openedId, after: null })).sent).toBe(0);
    expect(late.sent).toEqual([]);

    const mailer = new MemoryMailer({ site });
    const r = await sendGovernanceEmailPage(context(mailer).ctx, { eventId: resultId, after: null });
    expect(r).toMatchObject({ kind: "result", failed: 0 });
    const mail = mailer.to(joinedLater.email)[0];
    expect(mail?.template).toBe("governanceResultPublished");
    expect(mail?.subject).toBe("Vote result: A result");
    expect(mail?.text).toMatch(/Outcome\s+(Passed|Not passed)/);
    expect(mail?.text).toMatch(/Turnout\s+\d+(\.\d+)?%/);
    expect(mail?.headers["List-Unsubscribe"]).toContain("list=governance");
    expect(mailer.to(voter.email)).toHaveLength(1);
  });

  test("a failed send drops its claim and throws, so the retry mails only who is left", async () => {
    const author = await person();
    await person();
    const { eventId } = await openVote(author.id, "Flaky mail");
    const good = new MemoryMailer({ site });
    let calls = 0;
    const flaky: Mailer = {
      send: async (template, props, to) => {
        calls++;
        if (calls === 1) throw new Error("smtp down");
        return good.send(template, props, to);
      },
      close: async () => {},
    };
    await expect(sendGovernanceEmailPage(context(flaky).ctx, { eventId, after: null })).rejects.toThrow(
      /1 sends failed/,
    );
    const first = good.sent.length;
    expect(first).toBeGreaterThan(0);
    const retry = await sendGovernanceEmailPage(context(good).ctx, { eventId, after: null });
    expect(retry.sent).toBe(1);
    expect(retry.skipped).toBe(first);
    expect(new Set(good.sent.map((m) => m.to)).size).toBe(good.sent.length);
  });

  test("an event that is not a vote opening or a result mails nobody", async () => {
    const author = await person();
    const { id } = await openVote(author.id, "Other event");
    const mailer = new MemoryMailer({ site });
    const missing = await sendGovernanceEmailPage(context(mailer).ctx, {
      eventId: "0190f0f0-0000-7000-8000-00000000dead",
      after: null,
    });
    expect(missing).toMatchObject({ kind: null, sent: 0 });
    // Council review and applied are status changes too, but nothing members are mailed about.
    const others = await db()
      .insert(schema.events)
      .values(
        ["council_review", "applied"].map((status) => ({
          type: "coop.proposal.update",
          payload: { proposal_id: id, title: "Other event", status, kind: "ordinary", passed: null, reason: null },
        })),
      )
      .returning({ id: schema.events.id });
    expect(others).toHaveLength(2);
    for (const e of others) {
      const r = await sendGovernanceEmailPage(context(mailer).ctx, { eventId: e.id, after: null });
      expect(r).toMatchObject({ kind: null, sent: 0 });
    }
    expect(mailer.sent).toEqual([]);
  });

  test("without a mailer nothing is read or sent", async () => {
    const { ctx } = context(new MemoryMailer({ site }));
    const r = await sendGovernanceEmailPage(
      { ...ctx, mailer: undefined },
      { eventId: crypto.randomUUID(), after: null },
    );
    expect(r).toMatchObject({ kind: null, sent: 0 });
  });
});
