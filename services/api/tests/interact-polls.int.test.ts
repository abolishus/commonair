// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `interact.polls.*` over REST (E8-polls): create, vote, extra votes paid with points, end and
 * archive, who may do what, and the outbox and audit rows they write. Tests share accounts but
 * each uses its own poll; a channel holds one active poll, so each test ends what it starts.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { POLL_RULES } from "@commonair/contracts/enums";
import { pointsBalance, postPointsInTx, schema } from "@commonair/db";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type Account = Awaited<ReturnType<typeof signUpAndSignIn>>;
interface Poll {
  id: string;
  status: string;
  choices: { id: string; title: string; votes: number }[];
  endsAt: string;
  endedAt: string | null;
  myVote: string | null;
  myVotes: number;
}
interface Err {
  code: string;
  data?: { requirement?: string };
}

let api: TestApi;
let streamer: Account;
let mod: Account;
let viewers: Account[];
let other: Account; // owns another channel; nobody in the streamer's
let channelId: string;

const db = () => api.db.db;

beforeAll(async () => {
  api = await startApi();
  const accounts = await Promise.all(Array.from({ length: 6 }, () => signUpAndSignIn(api)));
  [streamer, mod, other] = [accounts[0]!, accounts[1]!, accounts[2]!];
  viewers = accounts.slice(3);
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, streamer.username));
  channelId = c!.id;
  await db().insert(schema.channelRoles).values({ channelId, userId: mod.userId, role: "moderator" });
}, 180_000);
afterAll(async () => {
  await api?.stop();
});

const create = (as: Account, body: Record<string, unknown> = {}) =>
  as.client.call<Poll & Err>("POST", `/api/channels/${streamer.username}/polls`, {
    title: "Best map?",
    choices: ["Ex", "Why", "Zed"],
    durationSeconds: 60,
    ...body,
  });
const vote = (as: Account, id: string, choiceId: string, extraVotes?: number) =>
  as.client.call<Poll & Err>("POST", `/api/polls/${id}/votes`, {
    choiceId,
    ...(extraVotes === undefined ? {} : { extraVotes }),
  });
const end = (as: Account, id: string, status: "terminated" | "archived" = "terminated") =>
  as.client.call<Poll & Err>("POST", `/api/polls/${id}/end`, { status });
const current = (as: Account) => as.client.call<Poll | null>("GET", `/api/channels/${streamer.username}/polls/current`);
const events = (type: string, pollId: string) =>
  db()
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.channelId, channelId), eq(schema.events.type, type)))
    .then((rows) => rows.filter((r) => r.payload.id === pollId));
const grant = (userId: string, delta: number) =>
  db().transaction((tx) => postPointsInTx(tx, { channelId, userId, delta, reason: "moderator_adjust", refId: null }));

async function fresh(body: Record<string, unknown> = {}): Promise<Poll> {
  const r = await create(streamer, body);
  expect(r.status).toBe(200);
  return r.body;
}

describe("create, vote, end", () => {
  test("a poll runs: begin event, votes counted, terminated with an end event and an audit row", async () => {
    const poll = await fresh();
    expect(poll).toMatchObject({ status: "active", endedAt: null, myVote: null, myVotes: 0 });
    expect(poll.choices.map((c) => [c.title, c.votes])).toEqual([
      ["Ex", 0],
      ["Why", 0],
      ["Zed", 0],
    ]);
    expect(await events("channel.poll.begin", poll.id)).toHaveLength(1);

    const [x, y] = poll.choices;
    expect((await vote(viewers[0]!, poll.id, x!.id)).body).toMatchObject({ myVote: x!.id, myVotes: 1 });
    await vote(viewers[1]!, poll.id, x!.id);
    await vote(viewers[2]!, poll.id, y!.id);
    // No per-vote event: progress is the tick's.
    expect(await events("channel.poll.progress", poll.id)).toHaveLength(0);

    const seen = await current(viewers[0]!);
    expect(seen.body).toMatchObject({ id: poll.id, myVote: x!.id, myVotes: 1 });
    expect(seen.body?.choices.map((c) => c.votes)).toEqual([2, 1, 0]);
    const anon = await api.app.fetch(new Request(`${api.url}/api/channels/${streamer.username}/polls/current`));
    expect(await anon.json()).toMatchObject({ id: poll.id, myVote: null, myVotes: 0 });

    const ended = await end(mod, poll.id);
    expect(ended.status).toBe(200);
    expect(ended.body.status).toBe("terminated");
    expect(ended.body.endedAt).not.toBeNull();
    const [endEvent] = await events("channel.poll.end", poll.id);
    expect(endEvent?.payload).toMatchObject({ status: "terminated" });
    const [row] = await db().select().from(schema.polls).where(eq(schema.polls.id, poll.id));
    expect(row?.choices.map((c) => c.votes)).toEqual([2, 1, 0]);

    // A second end conflicts; archive hides it from `current`.
    expect((await end(mod, poll.id)).status).toBe(409);
    expect((await current(viewers[0]!)).body?.id).toBe(poll.id);
    expect((await end(streamer, poll.id, "archived")).body.status).toBe("archived");
    expect((await current(viewers[0]!)).body?.id).not.toBe(poll.id);
    // Archiving an ended poll hides it but sends no second `end`.
    expect(await events("channel.poll.end", poll.id)).toHaveLength(1);

    const audits = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectType, "poll"), eq(schema.auditLog.subjectId, poll.id)));
    expect(audits.map((a) => a.action).sort()).toEqual(["poll.create", "poll.end", "poll.end"]);
    for (const a of audits) {
      expect(a.reason).toBe("");
      // Ids, counts and enums only: never the title or a choice.
      expect(JSON.stringify(a.details)).not.toMatch(/Best map|"(Ex|Why|Zed)"/);
    }
    expect(audits.find((a) => a.action === "poll.create")?.details).toEqual({
      choices: 3,
      durationSeconds: 60,
      pointsPerExtraVote: 0,
    });
  });

  test("a vote after endsAt, a second vote on another choice, a repeat without extras: CONFLICT", async () => {
    const poll = await fresh();
    const [x, y] = poll.choices;
    expect((await vote(viewers[0]!, poll.id, x!.id)).status).toBe(200);
    expect((await vote(viewers[0]!, poll.id, y!.id)).status).toBe(409);
    expect((await vote(viewers[0]!, poll.id, x!.id)).status).toBe(409);
    expect((await vote(viewers[1]!, poll.id, "not-a-choice")).status).toBe(400);

    await db()
      .update(schema.polls)
      .set({ endsAt: new Date(Date.now() - 1000) })
      .where(eq(schema.polls.id, poll.id));
    expect((await vote(viewers[1]!, poll.id, x!.id)).status).toBe(409);
    await end(streamer, poll.id);
  });

  test("a banned or timed-out viewer cannot vote", async () => {
    const poll = await fresh();
    await db()
      .insert(schema.chatBans)
      .values({ channelId, userId: viewers[2]!.userId, reason: "", expiresAt: new Date(Date.now() + 600_000) });
    expect((await vote(viewers[2]!, poll.id, poll.choices[0]!.id)).status).toBe(403);
    await db()
      .update(schema.chatBans)
      .set({ liftedAt: new Date() })
      .where(eq(schema.chatBans.userId, viewers[2]!.userId));
    expect((await vote(viewers[2]!, poll.id, poll.choices[0]!.id)).status).toBe(200);
    await end(streamer, poll.id);
  });

  test("one active poll per channel, also under concurrency", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => create(streamer)));
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 409, 409, 409, 409]);
    const winner = results.find((r) => r.status === 200)!.body;
    const active = await db()
      .select()
      .from(schema.polls)
      .where(and(eq(schema.polls.channelId, channelId), eq(schema.polls.status, "active")));
    expect(active.map((p) => p.id)).toEqual([winner.id]);
    await end(streamer, winner.id);
  });
});

describe("extra votes", () => {
  test("without pointsPerExtraVote: BAD_REQUEST", async () => {
    const poll = await fresh();
    expect((await vote(viewers[0]!, poll.id, poll.choices[0]!.id, 2)).status).toBe(400);
    await end(streamer, poll.id);
  });

  test("debit points, emit channel.points.change, count in the view; over the cap: CONFLICT", async () => {
    const poll = await fresh({ pointsPerExtraVote: 10 });
    const v = viewers[1]!;
    await grant(v.userId, 2000);
    const before = await pointsBalance(db(), channelId, v.userId);
    const choice = poll.choices[1]!.id;

    const first = await vote(v, poll.id, choice, 3);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ myVote: choice, myVotes: 4 });
    expect(await pointsBalance(db(), channelId, v.userId)).toBe(before - 30);
    const second = await vote(v, poll.id, choice, 2);
    expect(second.body.myVotes).toBe(6);
    expect(await pointsBalance(db(), channelId, v.userId)).toBe(before - 50);

    const changes = (
      await db()
        .select()
        .from(schema.events)
        .where(and(eq(schema.events.channelId, channelId), eq(schema.events.type, "channel.points.change")))
    ).filter((e) => e.payload.user_id === v.userId && e.payload.reason === "poll_vote");
    expect(changes.map((e) => [e.payload.delta, e.payload.balance])).toEqual([
      [-30, before - 30],
      [-50 + 30, before - 50],
    ]);
    const ledger = await db()
      .select()
      .from(schema.loyaltyTransactions)
      .where(and(eq(schema.loyaltyTransactions.userId, v.userId), eq(schema.loyaltyTransactions.refId, poll.id)));
    expect(ledger.map((l) => [l.reason, l.delta])).toEqual([
      ["poll_vote", -30],
      ["poll_vote", -20],
    ]);
    const [pv] = await db()
      .select()
      .from(schema.pollVotes)
      .where(and(eq(schema.pollVotes.pollId, poll.id), eq(schema.pollVotes.userId, v.userId)));
    expect(pv).toMatchObject({ votes: 6, pointsSpent: 50 });

    // 5 extra so far; the cap is per viewer across calls.
    const over = await vote(v, poll.id, choice, POLL_RULES.maxExtraVotesPerUser - 4);
    expect(over.status).toBe(409);
    expect(await pointsBalance(db(), channelId, v.userId)).toBe(before - 50);
    await end(streamer, poll.id);
  });

  test("an overdraw is PRECONDITION_FAILED insufficient_points and writes nothing", async () => {
    const poll = await fresh({ pointsPerExtraVote: 1000 });
    const v = viewers[0]!;
    const before = await pointsBalance(db(), channelId, v.userId);
    const r = await vote(v, poll.id, poll.choices[0]!.id, 100);
    expect(r.status).toBe(412);
    expect(r.body.data).toEqual({ requirement: "insufficient_points" });
    expect(await pointsBalance(db(), channelId, v.userId)).toBe(before);
    expect(
      await db()
        .select()
        .from(schema.pollVotes)
        .where(and(eq(schema.pollVotes.pollId, poll.id), eq(schema.pollVotes.userId, v.userId))),
    ).toEqual([]);
    const [row] = await db().select().from(schema.polls).where(eq(schema.polls.id, poll.id));
    expect(row?.changedAt).toBeNull();
    await end(streamer, poll.id);
  });

  test("channel points off: PRECONDITION_FAILED points_disabled", async () => {
    const poll = await fresh({ pointsPerExtraVote: 1 });
    await db()
      .insert(schema.botConfigs)
      .values({ channelId, config: { loyalty: { enabled: false, pointsName: "points" } } as never });
    const r = await vote(viewers[1]!, poll.id, poll.choices[0]!.id, 1);
    expect(r.status).toBe(412);
    expect(r.body.data).toEqual({ requirement: "points_disabled" });
    await db().delete(schema.botConfigs).where(eq(schema.botConfigs.channelId, channelId));
    await end(streamer, poll.id);
  });
});

describe("access", () => {
  test("viewers and other streamers cannot create or end; an unknown poll is NOT_FOUND", async () => {
    expect((await create(viewers[0]!)).status).toBe(403);
    expect((await create(other)).status).toBe(403);
    const poll = await fresh();
    expect((await end(other, poll.id)).status).toBe(403);
    expect((await end(viewers[0]!, poll.id)).status).toBe(403);
    expect((await end(mod, "01900000-0000-7000-8000-000000000000")).status).toBe(404);
    expect((await vote(viewers[0]!, "01900000-0000-7000-8000-000000000000", "x")).status).toBe(404);
    expect((await end(mod, poll.id)).status).toBe(200);
  });

  test("anonymous callers cannot vote; current on an unknown channel is NOT_FOUND", async () => {
    const res = await fetch(`${api.url}/api/polls/01900000-0000-7000-8000-000000000000/votes`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ choiceId: "x" }),
    });
    expect(res.status).toBe(401);
    const missing = await fetch(`${api.url}/api/channels/nochannel_${Date.now()}/polls/current`);
    expect(missing.status).toBe(404);
  });
});
