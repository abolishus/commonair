// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Batch 7 schema (0045, 0046; .claude/briefs/w3/contract-step.md §3): the follower-count trigger
 * and its recount, watch-room age bands, draw commitments, giveaway entries and winners, prediction
 * bets, jury seats, cases and votes, federation key history, move links, portability signing keys,
 * relay purges, the jury settings and the seed. Run as the least-privilege app role, by direct
 * inserts, so no application check stands in for a refusal.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import type { Database } from "../src/client.ts";
import { uuidv7 } from "../src/ids.ts";
import { MIGRATIONS_DIR } from "../src/migrate.ts";
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

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const yearsAgo = (n: number, days = 0) => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - n);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
};
const ADULT = yearsAgo(30);
const MINOR = yearsAgo(15);

type Role = (typeof s.users.$inferInsert)["role"];
async function newUser(opts: { birthDate?: string | null; mature?: boolean; role?: Role } = {}): Promise<string> {
  const name = `b7_${uuidv7().replace(/-/g, "").slice(-12)}`;
  const [u] = await owner
    .insert(s.users)
    .values({
      name,
      email: `${name}@example.test`,
      username: name,
      role: opts.role ?? "user",
      birthDate: opts.birthDate === undefined ? ADULT : opts.birthDate,
      matureConfirmedAt: opts.mature ? new Date() : null,
    })
    .returning({ id: s.users.id });
  return u!.id;
}
async function newChannel(opts: { mature?: boolean } = {}): Promise<{ channelId: string; ownerId: string }> {
  const ownerId = await newUser();
  const [c] = await app
    .insert(s.channels)
    .values({ ownerId, slug: `c${ownerId.slice(-10)}`, displayName: "B7", mature: opts.mature ?? false })
    .returning({ id: s.channels.id });
  return { channelId: c!.id, ownerId };
}
async function newBroadcast(channelId: string, mature = false): Promise<string> {
  const [b] = await app
    .insert(s.broadcasts)
    .values({ channelId, ingestProtocol: "rtmp", path: "live/b7", mature })
    .returning({ id: s.broadcasts.id });
  return b!.id;
}
const count = async (channelId: string) =>
  (await owner.select({ n: s.channels.followerCount }).from(s.channels).where(eq(s.channels.id, channelId)))[0]!.n;
const hex = (bytes: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
const sha = (h: string) => createHash("sha256").update(Buffer.from(h, "hex")).digest("hex");

describe("follower count (decision (aa))", () => {
  test("the trigger counts non-excluded follows on insert, delete, exclusion and its reversal", async () => {
    const { channelId } = await newChannel();
    const [a, b, c] = [await newUser(), await newUser(), await newUser()];
    await app.insert(s.follows).values([a, b, c].map((followerId) => ({ followerId, channelId })));
    expect(await count(channelId)).toBe(3);
    await app.update(s.follows).set({ excludedAt: new Date() }).where(eq(s.follows.followerId, a));
    expect(await count(channelId)).toBe(2);
    // Touching an excluded follow again changes nothing; notify changes never count.
    await app.update(s.follows).set({ excludedAt: new Date() }).where(eq(s.follows.followerId, a));
    await app.update(s.follows).set({ notify: false }).where(eq(s.follows.followerId, b));
    expect(await count(channelId)).toBe(2);
    await app.delete(s.follows).where(eq(s.follows.followerId, a));
    expect(await count(channelId)).toBe(2);
    await app.update(s.follows).set({ excludedAt: null }).where(eq(s.follows.followerId, b));
    expect(await count(channelId)).toBe(2);
    await app.update(s.follows).set({ excludedAt: new Date() }).where(eq(s.follows.followerId, b));
    await app.update(s.follows).set({ excludedAt: null }).where(eq(s.follows.followerId, b));
    expect(await count(channelId)).toBe(2);
    await app.delete(s.follows).where(eq(s.follows.channelId, channelId));
    expect(await count(channelId)).toBe(0);
  });

  test("the app cannot write the count; the owner can repair it and the migration recount fixes drift", async () => {
    const { channelId } = await newChannel();
    await app.insert(s.follows).values({ followerId: await newUser(), channelId });
    expect(
      await refused(
        app.update(s.channels).set({ followerCount: 99 }).where(eq(s.channels.id, channelId)),
        /follows trigger/,
      ),
    ).toBe("42501");
    expect(
      await refused(
        app
          .insert(s.channels)
          .values({ ownerId: await newUser(), slug: `x${uuidv7().slice(-8)}`, displayName: "x", followerCount: 5 }),
        /follows trigger/,
      ),
    ).toBe("42501");
    // Other channel edits pass.
    await app.update(s.channels).set({ title: "still fine" }).where(eq(s.channels.id, channelId));
    // Simulate drift (as before 0046: exclusion never decremented), then run the migration's recount.
    await owner.update(s.channels).set({ followerCount: 41 }).where(eq(s.channels.id, channelId));
    const recount = readFileSync(join(MIGRATIONS_DIR, "0046_b7_protections.sql"), "utf8")
      .split("--> statement-breakpoint")[0]!
      .replace(/^--.*$/gm, "");
    await owner.execute(sql.raw(recount));
    expect(await count(channelId)).toBe(1);
  });

  test("a follow's move link belongs to the followed channel", async () => {
    const a = await newChannel();
    const b = await newChannel();
    const [link] = await app
      .insert(s.moveLinks)
      .values({ channelId: a.channelId, nonceHash: hex(32) })
      .returning({ id: s.moveLinks.id });
    expect(
      await refused(
        app
          .insert(s.follows)
          .values({ followerId: await newUser(), channelId: b.channelId, source: "move_link", moveLinkId: link!.id }),
        /move link/,
      ),
    ).toBe("23514");
    await app
      .insert(s.follows)
      .values({ followerId: await newUser(), channelId: a.channelId, source: "move_link", moveLinkId: link!.id });
    expect(
      await refused(
        app.insert(s.follows).values({ followerId: await newUser(), channelId: a.channelId, moveLinkId: link!.id }),
        /follows_move_link_source/,
      ),
    ).toBe("23514");
  });
});

describe("watch rooms (ADR 0017 decision 3)", () => {
  async function room(opts: { band?: "adult" | "minor"; mature?: boolean; hostMature?: boolean } = {}) {
    const { channelId } = await newChannel({ mature: opts.mature });
    const broadcastId = await newBroadcast(channelId);
    const band = opts.band ?? "adult";
    const hostId = await newUser({ birthDate: band === "adult" ? ADULT : MINOR, mature: opts.hostMature });
    const [r] = await app
      .insert(s.watchRooms)
      .values({ hostId, channelId, broadcastId, ageBand: band, inviteHash: hex(32) })
      .returning({ id: s.watchRooms.id });
    return { roomId: r!.id, channelId, broadcastId, hostId };
  }
  const join = (roomId: string, userId: string) => app.insert(s.watchRoomMembers).values({ roomId, userId });

  test("a room's band is its host's, and the host's age must be known", async () => {
    const { channelId } = await newChannel();
    const broadcastId = await newBroadcast(channelId);
    const minor = await newUser({ birthDate: MINOR });
    expect(
      await refused(
        app.insert(s.watchRooms).values({ hostId: minor, channelId, broadcastId, ageBand: "adult" }),
        /band is its host/,
      ),
    ).toBe("23514");
    const unknown = await newUser({ birthDate: null });
    expect(
      await refused(
        app.insert(s.watchRooms).values({ hostId: unknown, channelId, broadcastId, ageBand: "adult" }),
        /birth date/,
      ),
    ).toBe("23514");
    const other = await newChannel();
    expect(
      await refused(
        app
          .insert(s.watchRooms)
          .values({ hostId: await newUser(), channelId: other.channelId, broadcastId, ageBand: "adult" }),
        /broadcast of its channel/,
      ),
    ).toBe("23514");
  });

  test("a mixed-age member, an unknown age and a future birth date are refused by a direct insert", async () => {
    const adult = await room();
    await join(adult.roomId, adult.hostId);
    await join(adult.roomId, await newUser());
    expect(await refused(join(adult.roomId, await newUser({ birthDate: MINOR })), /room_age_band/)).toBe("23514");
    expect(await refused(join(adult.roomId, await newUser({ birthDate: null })), /room_age_band/)).toBe("23514");
    const minor = await room({ band: "minor" });
    await join(minor.roomId, await newUser({ birthDate: MINOR }));
    expect(await refused(join(minor.roomId, await newUser()), /room_age_band/)).toBe("23514");
    // The 18th birthday is the edge: a day short is a minor.
    expect(await refused(join(adult.roomId, await newUser({ birthDate: yearsAgo(18, 1) })), /room_age_band/)).toBe(
      "23514",
    );
    await join(adult.roomId, await newUser({ birthDate: yearsAgo(18) }));
  });

  test("mature content is for adults who confirmed mature viewing", async () => {
    // A minor cannot host on mature content; an adult host needs the confirmation too.
    const { channelId } = await newChannel({ mature: true });
    const broadcastId = await newBroadcast(channelId);
    const minorHost = await newUser({ birthDate: MINOR });
    expect(
      await refused(
        app.insert(s.watchRooms).values({ hostId: minorHost, channelId, broadcastId, ageBand: "minor" }),
        /mature/,
      ),
    ).toBe("23514");
    expect(
      await refused(
        app.insert(s.watchRooms).values({ hostId: await newUser(), channelId, broadcastId, ageBand: "adult" }),
        /mature/,
      ),
    ).toBe("23514");
    const r = await room({ mature: true, hostMature: true });
    expect(await refused(join(r.roomId, await newUser()), /room_mature/)).toBe("23514");
    await join(r.roomId, await newUser({ mature: true }));
    // A mature broadcast, or a mature category, counts too.
    const plain = await newChannel();
    const [cat] = await owner
      .insert(s.categories)
      .values({ slug: `m${uuidv7().slice(-8)}`, name: "Mature", mature: true })
      .returning({ id: s.categories.id });
    const [b] = await app
      .insert(s.broadcasts)
      .values({ channelId: plain.channelId, ingestProtocol: "rtmp", path: "live/b7", categoryId: cat!.id })
      .returning({ id: s.broadcasts.id });
    expect(
      await refused(
        app
          .insert(s.watchRooms)
          .values({ hostId: await newUser(), channelId: plain.channelId, broadcastId: b!.id, ageBand: "adult" }),
        /mature/,
      ),
    ).toBe("23514");
  });

  test("at most 8 active members; ended rooms take nobody; band, host and end are frozen", async () => {
    const r = await room();
    const members: string[] = [];
    for (let i = 0; i < 8; i++) {
      const u = await newUser();
      members.push(u);
      await join(r.roomId, u);
    }
    expect(await refused(join(r.roomId, await newUser()), /room_full/)).toBe("23514");
    await app
      .update(s.watchRoomMembers)
      .set({ leftAt: new Date() })
      .where(and(eq(s.watchRoomMembers.roomId, r.roomId), eq(s.watchRoomMembers.userId, members[0]!)));
    await join(r.roomId, await newUser());
    expect(
      await refused(
        app
          .update(s.watchRoomMembers)
          .set({ leftAt: null })
          .where(and(eq(s.watchRoomMembers.roomId, r.roomId), eq(s.watchRoomMembers.userId, members[0]!))),
        /only gains left_at/,
      ),
    ).toBe("42501");
    expect(await refused(app.update(s.watchRooms).set({ ageBand: "minor" }).where(eq(s.watchRooms.id, r.roomId)))).toBe(
      "42501",
    );
    await app
      .update(s.watchRooms)
      .set({ endedAt: new Date(), endReason: "host_closed", inviteHash: null })
      .where(eq(s.watchRooms.id, r.roomId));
    expect(await refused(join(r.roomId, await newUser()), /room_closed/)).toBe("23514");
    expect(
      await refused(
        app.update(s.watchRooms).set({ endedAt: null, endReason: null }).where(eq(s.watchRooms.id, r.roomId)),
        /stays ended/,
      ),
    ).toBe("42501");
    // Retention deletes the room; members and messages cascade.
    await app.insert(s.watchRoomMessages).values({ roomId: r.roomId, authorId: members[1]!, body: "hi" });
    await app.delete(s.watchRooms).where(eq(s.watchRooms.id, r.roomId));
    expect(await app.select().from(s.watchRoomMessages).where(eq(s.watchRoomMessages.roomId, r.roomId))).toEqual([]);
  });
});

describe("draws (decision (s))", () => {
  async function giveaway(channelId?: string) {
    const ch = channelId ?? (await newChannel()).channelId;
    const seed = hex(32);
    const [g] = await app
      .insert(s.giveaways)
      .values({
        channelId: ch,
        title: "Keyboard",
        prize: "A keyboard",
        eligibility: { minAccountAgeDays: 0, minFollowDays: null, minVerifiedWatchSeconds: 0 },
        winnerCount: 1,
        seedCommitment: sha(seed),
        sealedSeed: "sealed",
        salt: hex(16),
      })
      .returning({ id: s.giveaways.id });
    return { id: g!.id, seed, channelId: ch };
  }
  const set = (id: string, v: Partial<typeof s.giveaways.$inferInsert>) =>
    app.update(s.giveaways).set(v).where(eq(s.giveaways.id, id));

  test("one open giveaway per channel", async () => {
    const g = await giveaway();
    expect(await refused(giveaway(g.channelId), /giveaways_channel_open_uq/)).toBe("23505");
    await set(g.id, { status: "cancelled", cancelledAt: new Date() });
    await giveaway(g.channelId);
  });

  test("the commitment is immutable and the seed is revealed once, only if it matches", async () => {
    const g = await giveaway();
    expect(await refused(set(g.id, { seedCommitment: sha(hex(32)) }), /never changes/)).toBe("42501");
    await set(g.id, { status: "closed", closedAt: new Date() });
    expect(await refused(set(g.id, { seed: hex(32) }), /does not match/)).toBe("23514");
    expect(await refused(set(g.id, { status: "drawn" }), /seed revealed/)).toBe("23514");
    await set(g.id, { seed: g.seed, status: "drawn", drawnAt: new Date() });
    expect(await refused(set(g.id, { seed: hex(32) }), /revealed once/)).toBe("42501");
    expect(await refused(set(g.id, { status: "open" }), /cannot become/)).toBe("23514");
    // A seed at insert is refused; a UTF-8 seed matching its commitment is accepted.
    const ch = (await newChannel()).channelId;
    const text = "a text seed";
    const utf8 = createHash("sha256").update(text).digest("hex");
    expect(
      await refused(
        app.insert(s.giveaways).values({
          channelId: ch,
          title: "t",
          prize: "p",
          eligibility: { minAccountAgeDays: 0, minFollowDays: null, minVerifiedWatchSeconds: 0 },
          winnerCount: 1,
          seedCommitment: utf8,
          sealedSeed: "x",
          seed: text,
          salt: hex(16),
        }),
        /never at insert/,
      ),
    ).toBe("23514");
  });

  test("entries only while open and before closes_at; winners are entrants, append-only", async () => {
    const g = await giveaway();
    const [a, b] = [await newUser(), await newUser()];
    await app.insert(s.giveawayEntries).values({ giveawayId: g.id, userId: a, pseudonym: "p-a" });
    expect(
      await refused(app.update(s.giveawayEntries).set({ pseudonym: "x" }).where(eq(s.giveawayEntries.userId, a))),
    ).toBe("42501");
    expect(
      await refused(
        app.insert(s.giveawayWinners).values({ giveawayId: g.id, userId: a, rank: 1, drawIndex: 0 }),
        /after entries close/,
      ),
    ).toBe("23514");
    await set(g.id, { status: "closed", closedAt: new Date() });
    expect(
      await refused(
        app.insert(s.giveawayEntries).values({ giveawayId: g.id, userId: b, pseudonym: "p-b" }),
        /closed to entries/,
      ),
    ).toBe("23514");
    expect(await refused(app.delete(s.giveawayEntries).where(eq(s.giveawayEntries.userId, a)), /only while/)).toBe(
      "42501",
    );
    expect(
      await refused(
        app.insert(s.giveawayWinners).values({ giveawayId: g.id, userId: b, rank: 1, drawIndex: 0 }),
        /an entrant/,
      ),
    ).toBe("23514");
    expect(
      await refused(
        app.insert(s.giveawayWinners).values({ giveawayId: g.id, userId: a, rank: 2, drawIndex: 0 }),
        /winner_count/,
      ),
    ).toBe("23514");
    await app.insert(s.giveawayWinners).values({ giveawayId: g.id, userId: a, rank: 1, drawIndex: 0 });
    expect(
      await refused(app.update(s.giveawayWinners).set({ drawIndex: 3 }).where(eq(s.giveawayWinners.giveawayId, g.id))),
    ).toBe("42501");
    expect(await refused(app.delete(s.giveawayWinners).where(eq(s.giveawayWinners.giveawayId, g.id)))).toBe("42501");
    expect(await refused(app.delete(s.giveaways).where(eq(s.giveaways.id, g.id)))).toBe("42501");
    // A timed close: closes_at in the past refuses entries while the status still says open.
    const timed = await giveaway();
    await owner
      .update(s.giveaways)
      .set({ closesAt: new Date(Date.now() - 1000) })
      .where(eq(s.giveaways.id, timed.id));
    expect(
      await refused(
        app.insert(s.giveawayEntries).values({ giveawayId: timed.id, userId: b, pseudonym: "p-b" }),
        /closed to entries/,
      ),
    ).toBe("23514");
  });

  test("jury panels follow the same commitment rule", async () => {
    const seed = hex(32);
    const [p] = await app
      .insert(s.juryPanels)
      .values({ period: "2026-10", seedCommitment: sha(seed), sealedSeed: "sealed" })
      .returning({ id: s.juryPanels.id });
    const upd = (v: Partial<typeof s.juryPanels.$inferInsert>) =>
      app.update(s.juryPanels).set(v).where(eq(s.juryPanels.id, p!.id));
    expect(await refused(upd({ seedCommitment: sha(hex(32)) }))).toBe("42501");
    expect(await refused(upd({ seed: hex(32) }), /does not match/)).toBe("23514");
    await upd({ seed, closedAt: new Date() });
    expect(await refused(upd({ seed: hex(32) }))).toBe("42501");
  });
});

describe("predictions (decision (v))", () => {
  test("a bet at or after the lock media time is refused, as are the owner, moderators and editors", async () => {
    const { channelId, ownerId } = await newChannel();
    const lock = new Date("2026-11-01T10:00:00Z");
    const [p] = await app
      .insert(s.predictions)
      .values({
        channelId,
        title: "t",
        outcomes: [],
        windowSeconds: 60,
        locksAt: new Date(Date.now() + 60_000),
        lockMediaTs: lock,
      })
      .returning({ id: s.predictions.id });
    const bet = (userId: string, mediaTs: Date | null) =>
      owner.insert(s.predictionBets).values({ predictionId: p!.id, userId, outcomeId: "a", points: 1, mediaTs });
    // Owner-role inserts still pass through the trigger (it is the database rule, not a grant).
    expect(await refused(bet(await newUser(), lock), /locked at/)).toBe("23514");
    expect(await refused(bet(await newUser(), new Date(lock.getTime() + 1)), /locked at/)).toBe("23514");
    await bet(await newUser(), new Date(lock.getTime() - 1));
    expect(await refused(bet(ownerId, null), /cannot bet/)).toBe("23514");
    for (const role of ["moderator", "editor"] as const) {
      const u = await newUser();
      await app.insert(s.channelRoles).values({ channelId, userId: u, role });
      expect(await refused(bet(u, null), /cannot bet/)).toBe("23514");
    }
    const vip = await newUser();
    await app.insert(s.channelRoles).values({ channelId, userId: vip, role: "vip" });
    await bet(vip, null);
  });
});

describe("jury (decision (u))", () => {
  async function member(opts: { role?: Role; birthDate?: string | null; optIn?: boolean; active?: boolean } = {}) {
    const u = await newUser({ role: opts.role, birthDate: opts.birthDate });
    if (opts.active !== false) await app.insert(s.memberships).values({ userId: u, class: "viewer", basis: "share" });
    if (opts.optIn !== false) await app.insert(s.juryOptins).values({ userId: u });
    return u;
  }
  async function panel(period: string) {
    const [p] = await app
      .insert(s.juryPanels)
      .values({ period, seedCommitment: sha(hex(32)), sealedSeed: "sealed" })
      .returning({ id: s.juryPanels.id });
    return p!.id;
  }
  const seat = (panelId: string, userId: string) =>
    app.insert(s.jurySeats).values({ panelId, userId }).returning({ id: s.jurySeats.id });

  test("a seat needs an active membership, no staff role, a known adult age and a live opt-in", async () => {
    const p = await panel("2026-09");
    await seat(p, await member());
    expect(await refused(seat(p, await member({ active: false })), /active member/)).toBe("23514");
    expect(await refused(seat(p, await member({ role: "moderator" })), /staff/)).toBe("23514");
    expect(await refused(seat(p, await member({ birthDate: null })), /known adult/)).toBe("23514");
    expect(await refused(seat(p, await member({ birthDate: MINOR })), /known adult/)).toBe("23514");
    expect(await refused(seat(p, await member({ optIn: false })), /opted in/)).toBe("23514");
    const out = await member();
    await app.update(s.juryOptins).set({ optedOutAt: new Date() }).where(eq(s.juryOptins.userId, out));
    expect(await refused(seat(p, out), /opted in/)).toBe("23514");
    expect(await refused(app.delete(s.jurySeats).where(eq(s.jurySeats.panelId, p)))).toBe("42501");
  });

  test("never T0, hash-list, legal-hold or watch-room cases", async () => {
    const p = await panel("2026-08");
    const kase = async (v: Partial<typeof s.moderationCases.$inferInsert>) => {
      const [c] = await owner
        .insert(s.moderationCases)
        .values({ tier: "t1", origin: "classifier", subjectType: "broadcast", subjectId: uuidv7(), ...v })
        .returning({ id: s.moderationCases.id });
      return c!.id;
    };
    const add = (subjectKind: "moderation_case" | "report", subjectId: string) =>
      app.insert(s.juryCases).values({ panelId: p, subjectKind, subjectId });
    await add("moderation_case", await kase({}));
    expect(
      await refused(add("moderation_case", await kase({ tier: "t0", origin: "hash_list" })), /never sampled/),
    ).toBe("23514");
    expect(
      await refused(add("moderation_case", await kase({ listCategory: "ncii", origin: "hash_list" })), /never sampled/),
    ).toBe("23514");
    const held = await newUser();
    await owner.insert(s.legalHolds).values({ userId: held, reason: "litigation", reasonCode: "litigation" });
    expect(await refused(add("moderation_case", await kase({ userId: held })), /legal hold/)).toBe("23514");
    expect(await refused(add("moderation_case", uuidv7()), /names a moderation case/)).toBe("23503");
    const report = async (v: Partial<typeof s.reports.$inferInsert>) => {
      const [r] = await owner
        .insert(s.reports)
        .values({ subjectType: "user", subjectId: uuidv7(), reason: "spam", status: "actioned", ...v })
        .returning({ id: s.reports.id });
      return r!.id;
    };
    await add("report", await report({}));
    expect(await refused(add("report", await report({ subjectType: "watch_room" })), /never sampled/)).toBe("23514");
    expect(await refused(add("report", await report({ reason: "ncii" })), /never sampled/)).toBe("23514");
    expect(await refused(add("report", await report({ subjectId: held })), /legal hold/)).toBe("23514");
  });

  test("only a seat of the case's open panel votes, once, append-only", async () => {
    const p = await panel("2026-07");
    const other = await panel("2026-06");
    const [mine] = await seat(p, await member());
    const [foreign] = await seat(other, await member());
    const [c] = await owner
      .insert(s.moderationCases)
      .values({ tier: "t2", origin: "classifier", subjectType: "vod", subjectId: uuidv7() })
      .returning({ id: s.moderationCases.id });
    const [jc] = await app
      .insert(s.juryCases)
      .values({ panelId: p, subjectKind: "moderation_case", subjectId: c!.id })
      .returning({ id: s.juryCases.id });
    const vote = (seatId: string) =>
      app.insert(s.juryVotes).values({ caseId: jc!.id, seatId, vote: "agree", reasonCode: "clause_fits" });
    expect(await refused(vote(foreign!.id), /only a seat/)).toBe("23514");
    await vote(mine!.id);
    expect(await refused(vote(mine!.id), /jury_votes_case_seat_uq/)).toBe("23505");
    expect(await refused(app.update(s.juryVotes).set({ vote: "disagree" }).where(eq(s.juryVotes.caseId, jc!.id)))).toBe(
      "42501",
    );
    expect(await refused(app.delete(s.juryVotes).where(eq(s.juryVotes.caseId, jc!.id)))).toBe("42501");
    // A closed panel takes no votes.
    const [late] = await seat(p, await member());
    await app.update(s.juryPanels).set({ closedAt: new Date() }).where(eq(s.juryPanels.id, p));
    expect(await refused(vote(late!.id), /open panel/)).toBe("23514");
  });
});

describe("federation, move links, signing keys and relay purges", () => {
  test("actor key history is append-only", async () => {
    const { channelId } = await newChannel();
    await app
      .insert(s.federationActorKeys)
      .values({ channelId, keyId: "k#main-key", publicKeyPem: "pem", keyCreatedAt: new Date() });
    expect(
      await refused(
        app
          .update(s.federationActorKeys)
          .set({ publicKeyPem: "x" })
          .where(eq(s.federationActorKeys.channelId, channelId)),
      ),
    ).toBe("42501");
    expect(await refused(app.delete(s.federationActorKeys).where(eq(s.federationActorKeys.channelId, channelId)))).toBe(
      "42501",
    );
  });

  test("at most 10 active move links; revoked stays revoked; expired ones do not count", async () => {
    const { channelId } = await newChannel();
    const add = (expiresAt: Date | null = null) =>
      app
        .insert(s.moveLinks)
        .values({ channelId, nonceHash: hex(32), expiresAt })
        .returning({ id: s.moveLinks.id });
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push((await add())[0]!.id);
    expect(await refused(add(), /at most 10/)).toBe("23514");
    await app.update(s.moveLinks).set({ revokedAt: new Date() }).where(eq(s.moveLinks.id, ids[0]!));
    await add();
    expect(
      await refused(
        app.update(s.moveLinks).set({ revokedAt: null }).where(eq(s.moveLinks.id, ids[0]!)),
        /stays revoked/,
      ),
    ).toBe("42501");
    await app
      .update(s.moveLinks)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(s.moveLinks.id, ids[1]!));
    await add();
  });

  test("portability signing keys only gain retired_at and compromised_at", async () => {
    const pub = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const kid = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
    await app.insert(s.portabilitySigningKeys).values({ kid, publicKey: pub });
    expect(
      await refused(
        app.update(s.portabilitySigningKeys).set({ publicKey: "x" }).where(eq(s.portabilitySigningKeys.kid, kid)),
      ),
    ).toBe("42501");
    await app
      .update(s.portabilitySigningKeys)
      .set({ retiredAt: new Date() })
      .where(eq(s.portabilitySigningKeys.kid, kid));
    expect(await refused(app.delete(s.portabilitySigningKeys).where(eq(s.portabilitySigningKeys.kid, kid)))).toBe(
      "42501",
    );
  });

  test("relay purges get a seq from the app role, never change, and go only after 7 days", async () => {
    const [a] = await app.insert(s.relayPurges).values({ prefix: "dvr/x/", reason: "vod_hidden" }).returning();
    const [b] = await app.insert(s.relayPurges).values({ prefix: "dvr/y/", reason: "suspended" }).returning();
    expect(b!.seq).toBeGreaterThan(a!.seq);
    expect(await refused(app.update(s.relayPurges).set({ prefix: "x" }).where(eq(s.relayPurges.seq, a!.seq)))).toBe(
      "42501",
    );
    expect(await refused(app.delete(s.relayPurges).where(eq(s.relayPurges.seq, a!.seq)), /kept 7 days/)).toBe("42501");
    const [old] = await app
      .insert(s.relayPurges)
      .values({ prefix: "dvr/z/", reason: "restricted", createdAt: new Date(Date.now() - 8 * 86_400_000) })
      .returning();
    await app.delete(s.relayPurges).where(eq(s.relayPurges.seq, old!.seq));
  });
});

describe("governance and seed", () => {
  test("the jury settings are seeded off and range-checked", async () => {
    const rows = await owner
      .select({
        key: s.governanceSettings.key,
        value: s.governanceSettings.value,
        protected: s.governanceSettings.protected,
      })
      .from(s.governanceSettings)
      .where(sql`${s.governanceSettings.key} like 'jury.%'`);
    expect(Object.fromEntries(rows.map((r) => [r.key, r.value]))).toEqual({
      "jury.enabled": { enabled: false },
      "jury.panelSize": { panelSize: 7 },
      "jury.casesPerPanel": { casesPerPanel: 20 },
    });
    expect(rows.every((r) => !r.protected)).toBe(true);
    // Updates only happen through applied proposals; the check is BEFORE INSERT OR UPDATE, so
    // inserts exercise it (a valid value reaches the unique key, past the check).
    const insert = (key: string, value: unknown) =>
      owner.insert(s.governanceSettings).values({ key, description: "x", protected: false, value });
    for (const [key, value] of [
      ["jury.enabled", { enabled: true }],
      ["jury.panelSize", { panelSize: 3 }],
      ["jury.panelSize", { panelSize: 25 }],
      ["jury.casesPerPanel", { casesPerPanel: 100 }],
    ] as const)
      expect(await refused(insert(key, value), /duplicate key/)).toBe("23505");
    for (const [key, value] of [
      ["jury.enabled", { enabled: "yes" }],
      ["jury.panelSize", { panelSize: 2 }],
      ["jury.panelSize", { panelSize: 26 }],
      ["jury.casesPerPanel", { casesPerPanel: 1.5 }],
      ["jury.casesPerPanel", {}],
    ] as const)
      expect(await refused(insert(key, value), /jury\./)).toBe("23514");
  });

  test("new channels get onRaid and federation off by default", async () => {
    const { channelId } = await newChannel();
    const [c] = await app.select().from(s.channels).where(eq(s.channels.id, channelId));
    expect(c!.chatSettings.surgeGuard.onRaid).toBe(true);
    expect(c!.federationSettings).toEqual({ enabled: false });
    expect(c!.movedTo).toBeNull();
    expect(
      await refused(
        app
          .update(s.channels)
          .set({ movedTo: "http://x.test", movedAt: new Date() })
          .where(eq(s.channels.id, channelId)),
      ),
    ).toBe("23514");
    expect(
      await refused(app.update(s.channels).set({ movedTo: "https://x.test" }).where(eq(s.channels.id, channelId))),
    ).toBe("23514");
    await app
      .update(s.channels)
      .set({ movedTo: "https://x.test/me", movedAt: new Date() })
      .where(eq(s.channels.id, channelId));
  });
});
