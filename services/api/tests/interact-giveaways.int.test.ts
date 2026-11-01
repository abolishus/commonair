// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `interact.giveaways.*` over REST (batch 7 decisions (a), (s), (t); ADR 0039 §1–§2): the flag-off
 * refusal; open, enter, close, draw, cancel and verify; one open per channel; one entry per
 * account; no entry after close (API and trigger); the immutable commitment and the checked reveal
 * (triggers); the draw re-run from `verify`; a banned winner skipped; the timed close; audit,
 * outbox and the winner's notification; verified-watch eligibility.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { KEYS } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { commit, draw, newSeed } from "@commonair/draw";
import { winnersMatchDraw } from "@commonair/interact";
import { decryptSecret } from "@commonair/tokens";
import { SEED_PURPOSE, scrubText } from "../src/interact/giveaways/service.ts";
import { setGiveawayCloseQueue } from "../src/interact/giveaways/queue.ts";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type Account = Awaited<ReturnType<typeof signUpAndSignIn>>;
interface Giveaway {
  id: string;
  status: string;
  title: string;
  prize: string;
  keyword: string | null;
  seedCommitment: string;
  closesAt: string | null;
  entries: number;
  me: { entered: boolean; pseudonym: string | null; eligible: boolean; reason: string | null; won: boolean } | null;
  winners: { rank: number; pseudonym: string }[];
}
interface Verification {
  status: string;
  seedCommitment: string;
  seed: string | null;
  entries: string[];
  winnerCount: number;
  winners: { rank: number; index: number; pseudonym: string; username: string | null }[];
}
interface Err {
  code: string;
  data?: { reason?: string };
}

let api: TestApi;
let streamer: Account;
let editor: Account;
let mod: Account;
let viewers: Account[];
let channelId: string;
const scheduled: { id: string; closesAt: Date }[] = [];

const owner = () => api.db.db;
const app = () => api.db.app.db;

beforeAll(async () => {
  api = await startApi({ env: { GIVEAWAYS_ENABLED: "true" } });
  setGiveawayCloseQueue(api.deps, {
    async schedule(id, closesAt) {
      scheduled.push({ id, closesAt });
    },
    async close() {},
  });
  const accounts = await Promise.all(Array.from({ length: 8 }, () => signUpAndSignIn(api)));
  [streamer, editor, mod] = [accounts[0]!, accounts[1]!, accounts[2]!];
  viewers = accounts.slice(3);
  const [c] = await owner().select().from(schema.channels).where(eq(schema.channels.slug, streamer.username));
  channelId = c!.id;
  await owner()
    .insert(schema.channelRoles)
    .values([
      { channelId, userId: editor.userId, role: "editor" },
      { channelId, userId: mod.userId, role: "moderator" },
    ]);
}, 180_000);
afterAll(async () => {
  await api?.stop();
});

const base = `/api/channels/`;
const open = (as: Account, body: Record<string, unknown> = {}) =>
  as.client.call<Giveaway & Err>("POST", `${base}${streamer.username}/giveaways`, {
    title: "Launch giveaway",
    prize: "A sticker pack",
    winnerCount: 1,
    ...body,
  });
const enter = (as: Account, id: string) => as.client.call<Giveaway & Err>("POST", `/api/giveaways/${id}/entries`, {});
const act = (as: Account, id: string, what: "close" | "draw" | "cancel") =>
  as.client.call<Giveaway & Err>("POST", `${base}${streamer.username}/giveaways/${id}/${what}`, {});
const current = (as: Account) =>
  as.client.call<(Giveaway & Err) | null>("GET", `${base}${streamer.username}/giveaways/current`);
const verify = (as: Account, id: string) =>
  as.client.call<Verification & Err>("GET", `${base}${streamer.username}/giveaways/${id}/verify`);
const audits = (id: string) =>
  owner()
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.subjectType, "giveaway"), eq(schema.auditLog.subjectId, id)));
const events = (type: string, id: string) =>
  owner()
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.channelId, channelId), eq(schema.events.type, type)))
    .then((rows) => rows.filter((r) => r.payload.id === id));

async function fresh(body: Record<string, unknown> = {}): Promise<Giveaway> {
  const r = await open(streamer, body);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}
/** The database's refusal, with the driver's message from the cause chain (drizzle wraps it). */
async function refused(p: PromiseLike<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const messages: string[] = [];
    let e: unknown = err;
    for (let depth = 0; e && depth < 5; depth++) {
      messages.push(String((e as { message?: unknown }).message));
      e = (e as { cause?: unknown }).cause;
    }
    return messages.join(" | ");
  }
  throw new Error("expected the database to refuse");
}
async function sealedSeed(id: string): Promise<string> {
  const [g] = await owner().select().from(schema.giveaways).where(eq(schema.giveaways.id, id));
  return decryptSecret(api.deps.env.AUTH_SECRET, SEED_PURPOSE, g!.sealedSeed);
}

describe("the flag", () => {
  test("off: every procedure answers FORBIDDEN giveaways_disabled, and instance.info says so", async () => {
    const g = await fresh();
    const env = api.deps.env as { GIVEAWAYS_ENABLED: boolean };
    env.GIVEAWAYS_ENABLED = false;
    try {
      const calls = [
        () => open(streamer),
        () => current(viewers[0]!),
        () => enter(viewers[0]!, g.id),
        () => act(streamer, g.id, "close"),
        () => act(streamer, g.id, "draw"),
        () => act(streamer, g.id, "cancel"),
        () => verify(viewers[0]!, g.id),
      ];
      for (const call of calls) {
        const r = (await call()) as { status: number; body: Err };
        expect(r.status).toBe(403);
        expect(r.body.data?.reason).toBe("giveaways_disabled");
      }
      const info = await viewers[0]!.client.call<{ features: { giveaways: boolean } }>("GET", "/api/instance");
      expect(info.body.features.giveaways).toBe(false);
    } finally {
      env.GIVEAWAYS_ENABLED = true;
    }
    expect((await act(streamer, g.id, "cancel")).status).toBe(200);
  });
});

describe("a giveaway runs", () => {
  test("open → enter → close → draw → verify re-runs the draw; audit, outbox, notification", async () => {
    const g = await fresh({ title: "  Big‮ night \u0007 ", keyword: "!enter", winnerCount: 2 });
    expect(g).toMatchObject({ status: "open", title: "Big night", keyword: "!enter", entries: 0 });
    expect(g.seedCommitment).toMatch(/^[0-9a-f]{64}$/);
    expect(g.me).toMatchObject({ entered: false, eligible: true, reason: null });
    const [begin] = await events("channel.giveaway.begin", g.id);
    expect(begin?.payload).toMatchObject({ seed_commitment: g.seedCommitment, winner_count: 2, keyword: "!enter" });

    const entrants = viewers.slice(0, 4);
    for (const v of entrants) expect((await enter(v, g.id)).status).toBe(200);
    // One entry per account.
    const twice = await enter(entrants[0]!, g.id);
    expect(twice.status).toBe(409);
    expect(twice.body.data?.reason).toBe("already_entered");

    const mine = (await current(entrants[0]!)).body!;
    expect(mine.me).toMatchObject({ entered: true, eligible: true });
    expect(mine.me?.pseudonym).toMatch(/^[0-9a-f]{64}$/);
    expect(mine.entries).toBe(4);
    // Entrants are public only as pseudonyms; each sees their own.
    const before = await verify(viewers[4]!, g.id);
    expect(before.body.seed).toBeNull();
    expect(before.body.entries).toContain(mine.me!.pseudonym);
    expect(Object.keys(before.body)).not.toContain("salt");

    expect((await act(editor, g.id, "close")).body.status).toBe("closed");
    // Moderators do not run giveaways.
    expect((await act(mod, g.id, "draw")).status).toBe(403);
    const late = await enter(viewers[4]!, g.id);
    expect(late.status).toBe(409);
    expect(late.body.data?.reason).toBe("closed");

    const drawn = await act(streamer, g.id, "draw");
    expect(drawn.status).toBe(200);
    expect(drawn.body.status).toBe("drawn");
    expect(drawn.body.winners.map((w) => w.rank)).toEqual([1, 2]);

    const v = (await verify(viewers[4]!, g.id)).body;
    expect(v.seed).toMatch(/^[0-9a-f]{64}$/);
    expect(await commit(v.seed!)).toBe(v.seedCommitment);
    expect(v.entries).toEqual([...v.entries].sort());
    // Deterministic given the seed: anyone re-running the draw gets the same winners.
    const order = await draw(v.seed!, v.entries, v.entries.length);
    expect(v.winners.map((w) => w.index)).toEqual(order.slice(0, 2));
    expect(v.winners.map((w) => w.pseudonym)).toEqual(order.slice(0, 2).map((i) => v.entries[i]));
    expect(v.winners.every((w) => w.username === null)).toBe(true);
    expect(winnersMatchDraw(order, v.winners, v.winnerCount)).toEqual({ match: true, skipped: 0 });

    const actions = (await audits(g.id)).map((a) => a.action).sort();
    expect(actions).toEqual(["giveaway.close", "giveaway.draw", "giveaway.open"]);
    const drawAudit = (await audits(g.id)).find((a) => a.action === "giveaway.draw")!;
    expect(drawAudit.details).toMatchObject({ seed: v.seed, entries: 4, winners: 2 });
    const [end] = await events("channel.giveaway.end", g.id);
    expect(end?.payload).toMatchObject({ status: "drawn", seed: v.seed, entries: 4, winners: 2 });

    const winnerIds = await owner()
      .select({ userId: schema.giveawayWinners.userId })
      .from(schema.giveawayWinners)
      .where(eq(schema.giveawayWinners.giveawayId, g.id));
    const notes = await owner()
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.dedupeKey, `giveaway-won-${g.id}`));
    expect(notes.map((n) => n.userId).sort()).toEqual(winnerIds.map((w) => w.userId).sort());
    const winner = entrants.find((e) => e.userId === winnerIds[0]!.userId)!;
    expect((await current(winner)).body?.me?.won).toBe(true);

    // A drawn giveaway is final.
    expect((await act(streamer, g.id, "draw")).status).toBe(409);
    expect((await act(streamer, g.id, "cancel")).status).toBe(409);
  });

  test("one open giveaway per channel (API and the partial unique index)", async () => {
    const g = await fresh();
    const second = await open(editor);
    expect(second.status).toBe(409);
    expect(
      await refused(
        app()
          .insert(schema.giveaways)
          .values({
            channelId,
            title: "x",
            prize: "y",
            eligibility: { minAccountAgeDays: 0, minFollowDays: null, minVerifiedWatchSeconds: 0 },
            winnerCount: 1,
            seedCommitment: "0".repeat(64),
            sealedSeed: "v1.x",
            salt: "ab".repeat(32),
          }),
      ),
    ).toMatch(/giveaways_channel_open_uq/);
    const c = await act(streamer, g.id, "cancel");
    expect(c.body.status).toBe("cancelled");
    const [end] = await events("channel.giveaway.end", g.id);
    expect(end?.payload).toMatchObject({ status: "cancelled", seed: null, winners: 0 });
    expect((await audits(g.id)).map((a) => a.action).sort()).toEqual(["giveaway.cancel", "giveaway.open"]);
  });

  test("an empty giveaway draws no winners", async () => {
    const g = await fresh();
    const d = await act(streamer, g.id, "draw");
    expect(d.body).toMatchObject({ status: "drawn", winners: [], entries: 0 });
  });
});

describe("the triggers", () => {
  test("no entry after close, even by a direct insert", async () => {
    const g = await fresh();
    await act(streamer, g.id, "close");
    expect(
      await refused(
        app().insert(schema.giveawayEntries).values({ giveawayId: g.id, userId: viewers[0]!.userId, pseudonym: "ab" }),
      ),
    ).toMatch(/closed to entries/);
    await act(streamer, g.id, "cancel");
  });

  test("the commitment never changes, a wrong seed is refused, and no reveal while open", async () => {
    const g = await fresh();
    // An entrant, so the winner insert below is refused for the unrevealed seed alone.
    expect((await enter(viewers[0]!, g.id)).status).toBe(200);
    expect(
      await refused(
        app()
          .update(schema.giveaways)
          .set({ seedCommitment: "1".repeat(64) })
          .where(eq(schema.giveaways.id, g.id)),
      ),
    ).toMatch(/commitment never changes/);
    const real = await sealedSeed(g.id);
    // While open, even the right seed cannot be revealed.
    expect(
      await refused(app().update(schema.giveaways).set({ seed: real }).where(eq(schema.giveaways.id, g.id))),
    ).toMatch(/revealed only after entries close/);
    await act(streamer, g.id, "close");
    let wrong = newSeed();
    while (wrong === real) wrong = newSeed();
    expect(
      await refused(app().update(schema.giveaways).set({ seed: wrong }).where(eq(schema.giveaways.id, g.id))),
    ).toMatch(/does not match the commitment/);
    // Winners need the revealed seed.
    expect(
      await refused(
        app()
          .insert(schema.giveawayWinners)
          .values({ giveawayId: g.id, userId: viewers[0]!.userId, rank: 1, drawIndex: 0 }),
      ),
    ).toMatch(/winners are drawn after entries close/);
    await act(streamer, g.id, "cancel");
  });

  test("winners are append-only", async () => {
    const g = await fresh();
    await enter(viewers[0]!, g.id);
    await act(streamer, g.id, "draw");
    expect(
      await refused(app().delete(schema.giveawayWinners).where(eq(schema.giveawayWinners.giveawayId, g.id))),
    ).toMatch(/append-only|permission denied/);
    expect(
      await refused(
        app().update(schema.giveawayWinners).set({ rank: 2 }).where(eq(schema.giveawayWinners.giveawayId, g.id)),
      ),
    ).toMatch(/append-only|permission denied/);
  });
});

describe("the draw", () => {
  test("a winner banned before the draw is skipped and the next drawn entrant wins", async () => {
    const g = await fresh();
    const entrants = viewers.slice(0, 3);
    for (const v of entrants) await enter(v, g.id);
    await act(streamer, g.id, "close");
    // Work out who the draw picks first, then ban them.
    const seed = await sealedSeed(g.id);
    const rows = await owner().select().from(schema.giveawayEntries).where(eq(schema.giveawayEntries.giveawayId, g.id));
    const sorted = rows.map((r) => r.pseudonym).sort();
    const order = await draw(seed, sorted, sorted.length);
    const first = rows.find((r) => r.pseudonym === sorted[order[0]!])!;
    await owner().insert(schema.chatBans).values({ channelId, userId: first.userId, reason: "" });
    try {
      const d = await act(streamer, g.id, "draw");
      expect(d.status).toBe(200);
      const v = (await verify(viewers[4]!, g.id)).body;
      expect(v.winners).toEqual([{ rank: 1, index: order[1], pseudonym: sorted[order[1]!], username: null }]);
      expect(winnersMatchDraw(order, v.winners, 1)).toEqual({ match: true, skipped: 1 });
      const drawAudit = (await audits(g.id)).find((a) => a.action === "giveaway.draw")!;
      expect(drawAudit.details).toMatchObject({ skippedIndices: [order[0]] });
    } finally {
      await owner()
        .update(schema.chatBans)
        .set({ liftedAt: new Date() })
        .where(and(eq(schema.chatBans.channelId, channelId), eq(schema.chatBans.userId, first.userId)));
    }
  });

  test("a banned viewer cannot enter", async () => {
    const g = await fresh();
    const v = viewers[4]!;
    await owner().insert(schema.chatBans).values({ channelId, userId: v.userId, reason: "" });
    try {
      const r = await enter(v, g.id);
      expect(r.status).toBe(403);
      expect(r.body.data?.reason).toBe("banned");
      expect((await current(v)).body?.me).toMatchObject({ eligible: false, reason: "banned" });
    } finally {
      await owner()
        .update(schema.chatBans)
        .set({ liftedAt: new Date() })
        .where(and(eq(schema.chatBans.channelId, channelId), eq(schema.chatBans.userId, v.userId)));
      await act(streamer, g.id, "cancel");
    }
  });
});

describe("eligibility", () => {
  test("an unverified viewer is refused when verified watching is required; a verified one enters", async () => {
    const g = await fresh({ eligibility: { minVerifiedWatchSeconds: 120 } });
    const [verified, unverified] = [viewers[0]!, viewers[1]!];
    // Offline: nobody has verified seconds on a live broadcast.
    const offline = await enter(verified, g.id);
    expect(offline.status).toBe(403);
    expect(offline.body.data?.reason).toBe("verified_watch");

    const [b] = await owner()
      .insert(schema.broadcasts)
      .values({ channelId, ingestProtocol: "rtmp", path: `live/${uuidv7()}` })
      .returning();
    await owner().update(schema.channels).set({ liveBroadcastId: b!.id }).where(eq(schema.channels.id, channelId));
    try {
      await api.deps.valkey.set(
        KEYS.verifiedWatch(channelId, verified.userId),
        JSON.stringify({ b: b!.id, s: 150, f: 0 }),
      );
      // A key for an older broadcast is stale.
      await api.deps.valkey.set(
        KEYS.verifiedWatch(channelId, unverified.userId),
        JSON.stringify({ b: uuidv7(), s: 9999, f: 0 }),
      );
      expect((await current(unverified)).body?.me).toMatchObject({ eligible: false, reason: "verified_watch" });
      const refused = await enter(unverified, g.id);
      expect(refused.status).toBe(403);
      expect(refused.body.data?.reason).toBe("verified_watch");
      const ok = await enter(verified, g.id);
      expect(ok.status).toBe(200);
      expect(ok.body.me?.entered).toBe(true);
    } finally {
      await owner().update(schema.channels).set({ liveBroadcastId: null }).where(eq(schema.channels.id, channelId));
      await owner().update(schema.broadcasts).set({ endedAt: new Date() }).where(eq(schema.broadcasts.id, b!.id));
      await act(streamer, g.id, "cancel");
    }
  });

  test("following rules: not following, then too recent", async () => {
    const g = await fresh({ eligibility: { minFollowDays: 2 } });
    const v = viewers[2]!;
    expect((await enter(v, g.id)).body.data?.reason).toBe("not_following");
    await owner().insert(schema.follows).values({ followerId: v.userId, channelId });
    expect((await enter(v, g.id)).body.data?.reason).toBe("follow_age");
    await owner()
      .update(schema.follows)
      .set({ createdAt: sql`now() - interval '3 days'` })
      .where(and(eq(schema.follows.followerId, v.userId), eq(schema.follows.channelId, channelId)));
    expect((await enter(v, g.id)).status).toBe(200);
    await act(streamer, g.id, "cancel");
  });

  test("account age", async () => {
    const g = await fresh({ eligibility: { minAccountAgeDays: 30 } });
    const r = await enter(viewers[3]!, g.id);
    expect(r.status).toBe(403);
    expect(r.body.data?.reason).toBe("account_age");
    await act(streamer, g.id, "cancel");
  });
});

describe("timing and input", () => {
  test("a timed giveaway schedules its close; past closes_at it is closed on the next read", async () => {
    const g = await fresh({ durationMinutes: 5 });
    expect(scheduled.find((s) => s.id === g.id)?.closesAt.toISOString()).toBe(g.closesAt);
    await owner()
      .update(schema.giveaways)
      .set({ closesAt: sql`now() - interval '1 second'` })
      .where(eq(schema.giveaways.id, g.id));
    // The trigger refuses an entry past closes_at even before the status changes.
    expect(
      await refused(
        app().insert(schema.giveawayEntries).values({ giveawayId: g.id, userId: viewers[0]!.userId, pseudonym: "cd" }),
      ),
    ).toMatch(/closed to entries/);
    const c = (await current(viewers[0]!)).body!;
    expect(c.status).toBe("closed");
    const close = (await audits(g.id)).find((a) => a.action === "giveaway.close")!;
    expect(close).toMatchObject({ actorType: "system", details: { trigger: "timed" } });
    await act(streamer, g.id, "cancel");
  });

  test("validation: winner count, keyword shape, duration and an eligibility criterion that is not free", async () => {
    expect((await open(streamer, { winnerCount: 11 })).status).toBe(400);
    expect((await open(streamer, { keyword: "two words" })).status).toBe(400);
    expect((await open(streamer, { durationMinutes: 1441 })).status).toBe(400);
    expect((await open(streamer, { eligibility: { subscriberOnly: true } })).status).toBe(400);
    expect((await open(streamer, { title: "‮​ " })).status).toBe(400);
    // Viewers cannot open one.
    expect((await open(viewers[0]!)).status).toBe(403);
  });

  test("scrubText keeps emoji joiners and drops direction overrides and controls", () => {
    expect(scrubText(" a‮b\u0000c \n d ")).toBe("a b c d");
    expect(scrubText("👩‍💻")).toBe("👩‍💻");
  });
});
