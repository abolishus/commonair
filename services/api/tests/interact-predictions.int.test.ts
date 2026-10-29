// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `interact.predictions.*` over REST (E8-polls, ADR 0026 decision 3): create, bet, lock, resolve
 * and cancel; the channel's team cannot bet; payouts, refunds and balances; who may do what; the
 * outbox and audit rows. A channel holds one open prediction, so each test settles what it starts.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { pointsBalance, postPointsInTx, schema } from "@commonair/db";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type Account = Awaited<ReturnType<typeof signUpAndSignIn>>;
interface Prediction {
  id: string;
  status: string;
  outcomes: { id: string; title: string; points: number; users: number }[];
  lockedAt: string | null;
  endedAt: string | null;
  winningOutcomeId: string | null;
  myBet: { outcomeId: string; points: number; payout: number | null } | null;
}
interface Err {
  code: string;
  data?: { requirement?: string };
}

const GRANT = 1000;
let api: TestApi;
let streamer: Account;
let mod: Account;
let editor: Account;
let other: Account;
let viewers: Account[];
let channelId: string;

const db = () => api.db.db;

beforeAll(async () => {
  api = await startApi();
  const accounts = await Promise.all(Array.from({ length: 7 }, () => signUpAndSignIn(api)));
  [streamer, mod, editor, other] = [accounts[0]!, accounts[1]!, accounts[2]!, accounts[3]!];
  viewers = accounts.slice(4);
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, streamer.username));
  channelId = c!.id;
  await db()
    .insert(schema.channelRoles)
    .values([
      { channelId, userId: mod.userId, role: "moderator" },
      { channelId, userId: editor.userId, role: "editor" },
    ]);
  for (const a of [...viewers, streamer, mod, editor]) await grant(a.userId, GRANT);
}, 180_000);
afterAll(async () => {
  await api?.stop();
});

function grant(userId: string, delta: number) {
  return db().transaction((tx) =>
    postPointsInTx(tx, { channelId, userId, delta, reason: "moderator_adjust", refId: null }),
  );
}
const balance = (a: Account) => pointsBalance(db(), channelId, a.userId);
const create = (as: Account, body: Record<string, unknown> = {}) =>
  as.client.call<Prediction & Err>("POST", `/api/channels/${streamer.username}/predictions`, {
    title: "Who wins?",
    outcomes: ["Alpha", "Beta"],
    windowSeconds: 120,
    ...body,
  });
const bet = (as: Account, id: string, outcomeId: string, points: number) =>
  as.client.call<Prediction & Err>("POST", `/api/predictions/${id}/bets`, { outcomeId, points });
const lock = (as: Account, id: string) => as.client.call<Prediction & Err>("POST", `/api/predictions/${id}/lock`, {});
const resolve = (as: Account, id: string, winningOutcomeId: string) =>
  as.client.call<Prediction & Err>("POST", `/api/predictions/${id}/resolve`, { winningOutcomeId });
const cancel = (as: Account, id: string) =>
  as.client.call<Prediction & Err>("POST", `/api/predictions/${id}/cancel`, {});
const current = (as: Account) =>
  as.client.call<Prediction | null>("GET", `/api/channels/${streamer.username}/predictions/current`);
const events = (type: string, id: string) =>
  db()
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.channelId, channelId), eq(schema.events.type, type)))
    .then((rows) => rows.filter((r) => r.payload.id === id));

async function fresh(): Promise<Prediction> {
  const r = await create(streamer);
  expect(r.status).toBe(200);
  return r.body;
}

describe("a prediction runs", () => {
  test("bets, lock, resolve: payouts by largest remainder, balances, events, audit", async () => {
    const p = await fresh();
    expect(p).toMatchObject({ status: "active", lockedAt: null, endedAt: null, myBet: null });
    expect(await events("channel.prediction.begin", p.id)).toHaveLength(1);
    const [A, B] = [p.outcomes[0]!.id, p.outcomes[1]!.id];
    const [v0, v1, v2] = viewers as [Account, Account, Account];
    const before = await Promise.all(viewers.map(balance));

    const placed = await bet(v0, p.id, A, 100);
    expect(placed.status).toBe(200);
    expect(placed.body.myBet).toEqual({ outcomeId: A, points: 100, payout: null });
    await bet(v1, p.id, A, 300);
    const last = await bet(v2, p.id, B, 200);
    expect(last.body.outcomes.map((o) => [o.points, o.users])).toEqual([
      [400, 2],
      [200, 1],
    ]);
    expect(await balance(v0)).toBe(before[0]! - 100);
    const betEvents = (
      await db()
        .select()
        .from(schema.events)
        .where(and(eq(schema.events.channelId, channelId), eq(schema.events.type, "channel.points.change")))
    ).filter((e) => e.payload.reason === "prediction_bet" && e.payload.user_id === v1.userId);
    expect(betEvents.map((e) => [e.payload.delta, e.payload.balance])).toEqual([[-300, before[1]! - 300]]);

    // One bet per viewer.
    expect((await bet(v0, p.id, A, 5)).status).toBe(409);

    const locked = await lock(mod, p.id);
    expect(locked.body.status).toBe("locked");
    expect(locked.body.lockedAt).not.toBeNull();
    expect(await events("channel.prediction.lock", p.id)).toHaveLength(1);
    expect((await bet(viewers[0]!, p.id, B, 1)).status).toBe(409);

    const resolved = await resolve(editor, p.id, A);
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({ status: "resolved", winningOutcomeId: A });
    expect(resolved.body.endedAt).not.toBeNull();
    expect(await Promise.all(viewers.map(balance))).toEqual([
      before[0]! - 100 + 150,
      before[1]! - 300 + 450,
      before[2]! - 200,
    ]);
    expect((await current(v1)).body?.myBet).toEqual({ outcomeId: A, points: 300, payout: 450 });
    expect((await current(v2)).body?.myBet).toEqual({ outcomeId: B, points: 200, payout: 0 });

    const [end] = await events("channel.prediction.end", p.id);
    expect(end?.payload).toMatchObject({ status: "resolved", winning_outcome_id: A });
    const outcomes = end?.payload.outcomes as {
      channel_points: number;
      top_predictors: { user_id: string; channel_points_used: number; channel_points_won: number }[];
    }[];
    expect(outcomes.map((o) => o.channel_points)).toEqual([400, 200]);
    expect(outcomes[0]?.top_predictors.map((t) => [t.user_id, t.channel_points_used, t.channel_points_won])).toEqual([
      [v1.userId, 300, 450],
      [v0.userId, 100, 150],
    ]);
    const payouts = await db()
      .select()
      .from(schema.loyaltyTransactions)
      .where(
        and(eq(schema.loyaltyTransactions.refId, p.id), eq(schema.loyaltyTransactions.reason, "prediction_payout")),
      );
    expect(payouts.reduce((s, x) => s + x.delta, 0)).toBe(600);

    // Settled once: a second resolve or a cancel conflicts.
    expect((await resolve(streamer, p.id, A)).status).toBe(409);
    expect((await cancel(streamer, p.id)).status).toBe(409);

    const audits = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectType, "prediction"), eq(schema.auditLog.subjectId, p.id)));
    expect(audits.map((a) => a.action).sort()).toEqual(["prediction.create", "prediction.lock", "prediction.resolve"]);
    for (const a of audits) {
      expect(a.reason).toBe("");
      expect(JSON.stringify(a.details)).not.toMatch(/Who wins|Alpha|Beta/);
    }
    expect(audits.find((a) => a.action === "prediction.resolve")?.details).toEqual({
      status: "resolved",
      bettors: 3,
      credited: 2,
      pool: 600,
    });
  });

  test("a resolve nobody bet on refunds every bet and ends canceled", async () => {
    const p = await fresh();
    const [A, B] = [p.outcomes[0]!.id, p.outcomes[1]!.id];
    const before = await Promise.all(viewers.map(balance));
    await bet(viewers[0]!, p.id, A, 50);
    await bet(viewers[1]!, p.id, A, 70);
    expect((await resolve(streamer, p.id, B)).status).toBe(409); // not locked yet
    await lock(streamer, p.id);
    const r = await resolve(streamer, p.id, B);
    expect(r.body).toMatchObject({ status: "canceled", winningOutcomeId: null });
    expect(await Promise.all(viewers.map(balance))).toEqual(before);
    const refunds = await db()
      .select()
      .from(schema.loyaltyTransactions)
      .where(
        and(eq(schema.loyaltyTransactions.refId, p.id), eq(schema.loyaltyTransactions.reason, "prediction_refund")),
      );
    expect(refunds.map((x) => x.delta).sort((a, b) => a - b)).toEqual([50, 70]);
    const [end] = await events("channel.prediction.end", p.id);
    expect(end?.payload).toMatchObject({ status: "canceled", winning_outcome_id: null });
  });

  test("cancel from active refunds", async () => {
    const p = await fresh();
    const before = await balance(viewers[2]!);
    await bet(viewers[2]!, p.id, p.outcomes[1]!.id, 33);
    expect((await cancel(mod, p.id)).body.status).toBe("canceled");
    expect(await balance(viewers[2]!)).toBe(before);
  });

  test("two concurrent resolves pay once", async () => {
    const p = await fresh();
    const A = p.outcomes[0]!.id;
    await bet(viewers[0]!, p.id, A, 10);
    await bet(viewers[1]!, p.id, p.outcomes[1]!.id, 10);
    await lock(streamer, p.id);
    const before = await balance(viewers[0]!);
    const results = await Promise.all([resolve(streamer, p.id, A), resolve(mod, p.id, A)]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 409]);
    expect(await balance(viewers[0]!)).toBe(before + 20);
  });
});

describe("refusals", () => {
  test("the owner, an editor and a moderator cannot bet", async () => {
    const p = await fresh();
    for (const a of [streamer, editor, mod]) expect((await bet(a, p.id, p.outcomes[0]!.id, 10)).status).toBe(403);
    await cancel(streamer, p.id);
  });

  test("one open prediction per channel; channel points off refuses create", async () => {
    const p = await fresh();
    expect((await create(streamer)).status).toBe(409);
    await lock(streamer, p.id);
    expect((await create(mod)).status).toBe(409);
    await cancel(streamer, p.id);

    await db()
      .insert(schema.botConfigs)
      .values({ channelId, config: { loyalty: { enabled: false, pointsName: "points" } } as never });
    const off = await create(streamer);
    expect(off.status).toBe(412);
    expect(off.body.data).toEqual({ requirement: "points_disabled" });
    await db().delete(schema.botConfigs).where(eq(schema.botConfigs.channelId, channelId));
  });

  test("an overdraw is insufficient_points and writes nothing; banned viewers and late bets refused", async () => {
    const p = await fresh();
    const v = viewers[0]!;
    const before = await balance(v);
    const r = await bet(v, p.id, p.outcomes[0]!.id, before + 1);
    expect(r.status).toBe(412);
    expect(r.body.data).toEqual({ requirement: "insufficient_points" });
    expect(await balance(v)).toBe(before);
    expect(
      await db()
        .select()
        .from(schema.predictionBets)
        .where(and(eq(schema.predictionBets.predictionId, p.id), eq(schema.predictionBets.userId, v.userId))),
    ).toEqual([]);

    await db().insert(schema.chatBans).values({ channelId, userId: viewers[1]!.userId, reason: "" });
    expect((await bet(viewers[1]!, p.id, p.outcomes[0]!.id, 1)).status).toBe(403);
    await db()
      .update(schema.chatBans)
      .set({ liftedAt: new Date() })
      .where(eq(schema.chatBans.userId, viewers[1]!.userId));

    await db()
      .update(schema.predictions)
      .set({ locksAt: new Date(Date.now() - 1000) })
      .where(eq(schema.predictions.id, p.id));
    expect((await bet(viewers[2]!, p.id, p.outcomes[0]!.id, 1)).status).toBe(409);
    await cancel(streamer, p.id);
  });

  test("moderator routes: FORBIDDEN for a viewer or another streamer, NOT_FOUND for an unknown id", async () => {
    const p = await fresh();
    const A = p.outcomes[0]!.id;
    for (const a of [viewers[0]!, other]) {
      expect((await lock(a, p.id)).status).toBe(403);
      expect((await resolve(a, p.id, A)).status).toBe(403);
      expect((await cancel(a, p.id)).status).toBe(403);
    }
    expect((await create(other)).status).toBe(403);
    const unknown = "01900000-0000-7000-8000-000000000000";
    expect((await lock(mod, unknown)).status).toBe(404);
    expect((await resolve(mod, unknown, A)).status).toBe(404);
    expect((await cancel(mod, unknown)).status).toBe(404);
    expect((await bet(viewers[0]!, unknown, A, 1)).status).toBe(404);
    await cancel(streamer, p.id);
  });
});
