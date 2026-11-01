// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Fair predictions over REST (batch 7 decision (v), ADR 0039 decision 3) on a live channel with
 * the verified-watch gate on: bets judged by media time against `lockMediaTs` (a far viewer's bet
 * just after the wall-clock lock counts, a near viewer's does not), DVR and far-behind refusals,
 * the team refused by the API and by the 0046 trigger, unverified viewers refused, the resolver
 * and the result card recorded with an audit row, an overdraw still `insufficient_points`, and a
 * second bet a CONFLICT with `reason: already_bet`.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { KEYS } from "@commonair/contracts/internal";
import { postPointsInTx, schema, uuidv7 } from "@commonair/db";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type Account = Awaited<ReturnType<typeof signUpAndSignIn>>;
interface Prediction {
  id: string;
  status: string;
  outcomes: { id: string; title: string; points: number; users: number }[];
  lockedAt: string | null;
  lockMediaTs: string | null;
  resolvedBy: { id: string; username: string } | null;
  result: { pool: number; winners: number; payoutSum: number } | null;
  myBet: { outcomeId: string; points: number; payout: number | null } | null;
}
interface Err {
  code: string;
  data?: { requirement?: string; reason?: string };
}

const GRANT = 1000;
let api: TestApi;
let streamer: Account;
let mod: Account;
let unverified: Account;
let viewers: Account[];
let channelId: string;
let broadcastId: string;

const db = () => api.db.db;

beforeAll(async () => {
  // The gate on instance-wide, so the API asks for verified-watch standing on a gated channel.
  api = await startApi({ env: { CHAT_WATCH_GATE: "on" } });
  const accounts = await Promise.all(Array.from({ length: 9 }, () => signUpAndSignIn(api)));
  [streamer, mod, unverified] = [accounts[0]!, accounts[1]!, accounts[2]!];
  viewers = accounts.slice(3);
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, streamer.username));
  channelId = c!.id;
  const [b] = await db()
    .insert(schema.broadcasts)
    .values({
      channelId,
      ingestProtocol: "rtmp",
      path: `live/${streamer.username}`,
      startedAt: new Date(Date.now() - 600_000),
    })
    .returning({ id: schema.broadcasts.id });
  broadcastId = b!.id;
  await db()
    .update(schema.channels)
    .set({ liveBroadcastId: broadcastId, chatSettings: { ...c!.chatSettings, minVerifiedWatchSeconds: 60 } })
    .where(eq(schema.channels.id, channelId));
  await db().insert(schema.channelRoles).values({ channelId, userId: mod.userId, role: "moderator" });
  for (const a of [...viewers, mod, unverified]) {
    await db().transaction((tx) =>
      postPointsInTx(tx, { channelId, userId: a.userId, delta: GRANT, reason: "moderator_adjust", refId: null }),
    );
  }
  // Verified watchers of this broadcast (the integrity worker's key, ADR 0015); the moderator too,
  // so only the team rule refuses them.
  for (const a of [...viewers, mod])
    await api.deps.valkey.set(
      KEYS.verifiedWatch(channelId, a.userId),
      JSON.stringify({ b: broadcastId, s: 120, f: 0 }),
      "EX",
      600,
    );
}, 180_000);
afterAll(async () => {
  await api?.stop();
});

const create = () =>
  streamer.client.call<Prediction & Err>("POST", `/api/channels/${streamer.username}/predictions`, {
    title: "Who wins?",
    outcomes: ["Alpha", "Beta"],
    windowSeconds: 120,
  });
const bet = (
  as: Account,
  id: string,
  outcomeId: string,
  points: number,
  mediaTs: Date | null,
  playbackMode: "live" | "dvr" = "live",
) =>
  as.client.call<Prediction & Err>("POST", `/api/predictions/${id}/bets`, {
    outcomeId,
    points,
    mediaTs: mediaTs?.toISOString() ?? null,
    playbackMode,
  });
const lock = (id: string) => streamer.client.call<Prediction & Err>("POST", `/api/predictions/${id}/lock`, {});
const resolve = (as: Account, id: string, winningOutcomeId: string) =>
  as.client.call<Prediction & Err>("POST", `/api/predictions/${id}/resolve`, { winningOutcomeId });
const cancel = (id: string) => streamer.client.call<Prediction & Err>("POST", `/api/predictions/${id}/cancel`, {});
const ago = (ms: number) => new Date(Date.now() - ms);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fresh(): Promise<Prediction> {
  const r = await create();
  expect(r.status).toBe(200);
  return r.body;
}

describe("the media-time lock", () => {
  test("after the lock only a playhead before lockMediaTs counts; resolve records the resolver and the result", async () => {
    const p = await fresh();
    const [A, B] = [p.outcomes[0]!.id, p.outcomes[1]!.id];
    const [nearEarly, farEarly, near, far] = viewers as [Account, Account, Account, Account];

    // Before the lock both latencies bet.
    expect((await bet(nearEarly, p.id, A, 100, ago(500))).status).toBe(200);
    expect((await bet(farEarly, p.id, B, 200, ago(9_000))).status).toBe(200);

    const locked = await lock(p.id);
    expect(locked.status).toBe(200);
    const lockMediaTs = Date.parse(locked.body.lockMediaTs ?? "");
    expect(lockMediaTs).toBe(Date.parse(locked.body.lockedAt ?? ""));
    const [row] = await db().select().from(schema.predictions).where(eq(schema.predictions.id, p.id));
    expect(row?.lockMediaTs?.getTime()).toBe(lockMediaTs);
    await sleep(400);

    // The far viewer (~9 s behind) still sees the stream before the lock; the near one does not.
    const farBet = await bet(far, p.id, A, 300, ago(9_000));
    expect(farBet.status).toBe(200);
    expect(Date.parse(farBet.body.lockMediaTs ?? "")).toBe(lockMediaTs);
    const nearBet = await bet(near, p.id, A, 50, ago(200));
    expect(nearBet.status).toBe(409);
    // No playhead is "now": refused after the lock.
    expect((await bet(near, p.id, A, 50, null)).status).toBe(409);

    const [stored] = await db()
      .select()
      .from(schema.predictionBets)
      .where(and(eq(schema.predictionBets.predictionId, p.id), eq(schema.predictionBets.userId, far.userId)));
    expect(stored?.mediaTs?.getTime()).toBeLessThan(lockMediaTs);

    const resolved = await resolve(mod, p.id, A);
    expect(resolved.status).toBe(200);
    expect(resolved.body.resolvedBy).toEqual({ id: mod.userId, username: mod.username });
    expect(resolved.body.result).toEqual({ pool: 600, winners: 2, payoutSum: 600 });
    const [settled] = await db().select().from(schema.predictions).where(eq(schema.predictions.id, p.id));
    expect(settled?.resolvedById).toBe(mod.userId);

    // Anyone reading `current` sees the same result card.
    const seen = await near.client.call<Prediction>("GET", `/api/channels/${streamer.username}/predictions/current`);
    expect(seen.body.result).toEqual({ pool: 600, winners: 2, payoutSum: 600 });
    expect(seen.body.resolvedBy?.id).toBe(mod.userId);

    const [audit] = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectId, p.id), eq(schema.auditLog.action, "prediction.resolve")));
    expect(audit).toMatchObject({ actorId: mod.userId, subjectType: "prediction", channelId });
    expect(audit?.details).toMatchObject({ winningOutcomeId: A, pool: 600, payoutSum: 600, winners: 2 });
  });

  test("a DVR session and a playhead over 30 s behind are refused before the lock", async () => {
    const p = await fresh();
    const A = p.outcomes[0]!.id;
    const v = viewers[4]!;
    const dvr = await bet(v, p.id, A, 10, ago(1_000), "dvr");
    expect([dvr.status, dvr.body.data]).toEqual([412, { requirement: "not_live" }]);
    const behind = await bet(v, p.id, A, 10, ago(31_000));
    expect([behind.status, behind.body.data]).toEqual([412, { requirement: "behind" }]);
    expect((await bet(v, p.id, A, 10, ago(25_000))).status).toBe(200);
    expect((await cancel(p.id)).body).toMatchObject({
      status: "canceled",
      resolvedBy: { id: streamer.userId },
      result: { pool: 10, winners: 0, payoutSum: 10 },
    });
  });
});

describe("who may bet", () => {
  test("a moderator is refused by the API and by the trigger on a direct insert", async () => {
    const p = await fresh();
    const r = await bet(mod, p.id, p.outcomes[0]!.id, 10, ago(500));
    expect([r.status, r.body.data]).toEqual([403, { reason: "staff" }]);
    const direct = await api.db.app.db
      .insert(schema.predictionBets)
      .values({ predictionId: p.id, userId: mod.userId, outcomeId: p.outcomes[0]!.id, points: 10, mediaTs: new Date() })
      .then(
        () => "accepted",
        (err: unknown) => {
          const parts: string[] = [];
          for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) parts.push(String((e as Error).message));
          return parts.join(" | ");
        },
      );
    expect(direct).toMatch(/owner, moderators and editors cannot bet/);
    await cancel(p.id);
  });

  test("a viewer without verified-watch standing (or with a key for another broadcast) is refused", async () => {
    const p = await fresh();
    const r = await bet(unverified, p.id, p.outcomes[0]!.id, 10, ago(500));
    expect([r.status, r.body.data]).toEqual([412, { requirement: "unverified" }]);
    await api.deps.valkey.set(
      KEYS.verifiedWatch(channelId, unverified.userId),
      JSON.stringify({ b: uuidv7(), s: 600, f: 0 }),
      "EX",
      600,
    );
    expect((await bet(unverified, p.id, p.outcomes[0]!.id, 10, ago(500))).body.data).toEqual({
      requirement: "unverified",
    });
    await cancel(p.id);
  });

  test("an overdraw still maps to insufficient_points and writes nothing", async () => {
    const p = await fresh();
    const v = viewers[5]!;
    const r = await bet(v, p.id, p.outcomes[0]!.id, GRANT + 1, ago(500));
    expect([r.status, r.body.data]).toEqual([412, { requirement: "insufficient_points" }]);
    const rows = await db()
      .select()
      .from(schema.predictionBets)
      .where(and(eq(schema.predictionBets.predictionId, p.id), eq(schema.predictionBets.userId, v.userId)));
    expect(rows).toHaveLength(0);
    await cancel(p.id);
  });

  test("a second bet is a CONFLICT with reason already_bet, not a closed one", async () => {
    const p = await fresh();
    const v = viewers[5]!;
    expect((await bet(v, p.id, p.outcomes[0]!.id, 10, ago(500))).status).toBe(200);
    const again = await bet(v, p.id, p.outcomes[1]!.id, 10, ago(500));
    expect([again.status, again.body.code, again.body.data]).toEqual([409, "CONFLICT", { reason: "already_bet" }]);
    await cancel(p.id);
  });
});
