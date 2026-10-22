// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Council recompute and membership sync against a real database, as the application role. */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema as s, type Database } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { recomputeCouncil, termWindow } from "../src/council.ts";
import { syncMemberships } from "../src/membership.ts";
import { uuidv7 } from "@commonair/db";

let t: TestDatabase;
let app: Database;
const NOW = new Date("2026-06-15T12:00:00Z");
const HOUR = 3_600_000;

beforeAll(async () => {
  t = await createTestDatabase();
  app = t.app.db;
});
afterAll(async () => {
  await t?.drop();
});

let seq = 0;
async function user(o: Partial<typeof s.users.$inferInsert> = {}): Promise<string> {
  const name = `jobuser${++seq}`;
  const [u] = await app
    .insert(s.users)
    .values({ name, email: `${name}@example.test`, username: name, ...o })
    .returning({ id: s.users.id });
  return u!.id;
}

/** A streamer with a channel and one broadcast. */
async function streamer(o: Partial<typeof s.users.$inferInsert> = {}) {
  const userId = await user(o);
  const [ch] = await app
    .insert(s.channels)
    .values({ ownerId: userId, slug: `ch${seq}`, displayName: `Channel ${seq}` })
    .returning({ id: s.channels.id });
  const [b] = await app
    .insert(s.broadcasts)
    .values({
      channelId: ch!.id,
      ingestProtocol: "rtmp",
      path: `live/ch${seq}`,
      startedAt: new Date(NOW.getTime() - 40 * 86_400_000),
    })
    .returning({ id: s.broadcasts.id });
  return { userId, channelId: ch!.id, broadcastId: b!.id };
}

/** `hours` full eligible hours spread from `start` (consecutive clock hours). */
async function streamHours(
  st: { channelId: string; broadcastId: string },
  start: Date,
  hours: number,
  eligible = true,
) {
  const rows = Array.from({ length: hours }, (_, i) => ({
    broadcastId: st.broadcastId,
    channelId: st.channelId,
    hourStart: new Date(start.getTime() + i * HOUR),
    liveSeconds: 3600,
    eligible,
    verifiedOtherViewers: eligible ? 1 : 0,
  }));
  if (rows.length) await app.insert(s.streamHours).values(rows);
}

const activeOf = async (userId: string) =>
  app
    .select({ class: s.memberships.class, basis: s.memberships.basis })
    .from(s.memberships)
    .where(and(eq(s.memberships.userId, userId), eq(s.memberships.status, "active")));

describe("syncMemberships", () => {
  test("activates, confirms and lapses streamer and viewer memberships per membership.classes", async () => {
    const day = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
    // Eligible streamer: 12 eligible hours over 3 days (each day under the 8 h cap).
    const good = await streamer();
    await streamHours(good, day(10), 4);
    await streamHours(good, day(9), 4);
    await streamHours(good, day(8), 4);
    // Capped: 20 hours on one day count as 8 → not eligible.
    const capped = await streamer();
    await streamHours(capped, new Date("2026-06-10T00:00:00Z"), 20);
    // Ineligible hours (no verified other viewer) never count.
    const lonely = await streamer();
    await streamHours(lonely, day(5), 8, false);
    await streamHours(lonely, day(4), 8, false);
    // Old hours fall outside the 90-day window; their existing membership lapses.
    const old = await streamer();
    await streamHours(old, day(120), 8);
    await streamHours(old, day(119), 8);
    await app.insert(s.memberships).values({ userId: old.userId, class: "streamer", basis: "streaming_hours" });
    // A banned streamer is never activated.
    const banned = await streamer({ banned: true });
    await streamHours(banned, day(3), 6);
    await streamHours(banned, day(2), 6);
    // Exited voluntarily: not re-enrolled.
    const exited = await streamer();
    await streamHours(exited, day(3), 6);
    await streamHours(exited, day(2), 6);
    await app
      .insert(s.memberships)
      .values({ userId: exited.userId, class: "streamer", basis: "streaming_hours", status: "exited" });

    // Viewers: held share, short share, active subscription, expired subscription, lapsing.
    const shareholder = await user();
    await heldShare(shareholder, 500);
    const shortShare = await user();
    await heldShare(shortShare, 100);
    const subscriber = await user();
    const expired = await user();
    await app.insert(s.subscriptions).values([
      {
        subscriberId: subscriber,
        channelId: good.channelId,
        tier: 1,
        status: "active",
        provider: "manual",
        priceCents: 499,
        currency: "usd",
        currentPeriodEnd: new Date(NOW.getTime() + 86_400_000),
      },
      {
        subscriberId: expired,
        channelId: good.channelId,
        tier: 1,
        status: "active",
        provider: "manual",
        priceCents: 499,
        currency: "usd",
        currentPeriodEnd: new Date(NOW.getTime() - 86_400_000),
      },
    ]);
    const lapsingViewer = await user();
    await app.insert(s.memberships).values({ userId: lapsingViewer, class: "viewer", basis: "share" });
    // A worker is never touched.
    const worker = await user();
    await app.insert(s.memberships).values({ userId: worker, class: "worker", basis: "board_appointment" });

    const r = await syncMemberships(app, NOW);

    expect(await activeOf(good.userId)).toEqual([{ class: "streamer", basis: "streaming_hours" }]);
    expect(await activeOf(capped.userId)).toEqual([]);
    expect(await activeOf(lonely.userId)).toEqual([]);
    expect(await activeOf(old.userId)).toEqual([]);
    expect(await activeOf(banned.userId)).toEqual([]);
    // Exited members who qualify again are re-activated with a new row.
    expect(await activeOf(exited.userId)).toEqual([{ class: "streamer", basis: "streaming_hours" }]);
    expect(await activeOf(shareholder)).toEqual([{ class: "viewer", basis: "share" }]);
    expect(await activeOf(shortShare)).toEqual([]);
    expect(await activeOf(subscriber)).toEqual([{ class: "viewer", basis: "subscription" }]);
    expect(await activeOf(expired)).toEqual([]);
    expect(await activeOf(lapsingViewer)).toEqual([]);
    expect(await activeOf(worker)).toEqual([{ class: "worker", basis: "board_appointment" }]);

    expect(r.activated.map((a) => a.userId).sort()).toEqual(
      [good.userId, exited.userId, shareholder, subscriber].sort(),
    );
    expect(r.lapsed.map((a) => a.userId).sort()).toEqual([old.userId, lapsingViewer].sort());

    // Lapsed rows keep their history; audit rows exist for every change, with ids only.
    const [lapsed] = await app.select().from(s.memberships).where(eq(s.memberships.userId, old.userId));
    expect(lapsed).toMatchObject({ status: "lapsed", lapsedAt: NOW });
    const audits = await app.select().from(s.auditLog).where(eq(s.auditLog.subjectType, "membership"));
    expect(audits).toHaveLength(6);
    expect(JSON.stringify(audits.map((a) => a.details))).not.toMatch(/@example/);
    const history = await app.select().from(s.membershipHistory).where(eq(s.membershipHistory.userId, old.userId));
    expect(history.map((h) => h.status)).toEqual(["active", "lapsed"]);

    // Idempotent: a second run with the same facts changes nothing.
    const again = await syncMemberships(app, NOW);
    expect(again.activated).toEqual([]);
    expect(again.lapsed).toEqual([]);
    expect(again.confirmed).toBe(4);
  });
});

describe("recomputeCouncil", () => {
  test("seats the top streamers once per term, with method and audit rows", async () => {
    // Fresh database state for this describe: only the streamers created here have memberships.
    const { startsAt, endsAt } = termWindow(NOW);
    const day = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
    const make = async (hoursPerDay: number[], revenueCents: number) => {
      const st = await streamer();
      for (const [i, h] of hoursPerDay.entries()) await streamHours(st, day(20 - i), h);
      await app.insert(s.memberships).values({ userId: st.userId, class: "streamer", basis: "streaming_hours" });
      if (revenueCents > 0) {
        await app.insert(s.payments).values({
          provider: "manual",
          providerRef: `ref-${st.userId}`,
          kind: "tip",
          status: "succeeded",
          channelId: st.channelId,
          amountCents: revenueCents,
          currency: "usd",
          succeededAt: day(3),
        });
      }
      return st;
    };
    const top = await make([8, 8], 10_000);
    const second = await make([8, 8], 1_000);
    const tooFew = await make([5], 1_000_000);

    const first = await recomputeCouncil(app, NOW);
    expect(first.created).toBe(true);
    const seated = first.seats.map((x) => x.userId);
    expect(seated.indexOf(top.userId)).toBeLessThan(seated.indexOf(second.userId));
    expect(seated).not.toContain(tooFew.userId);
    expect(first.seats.map((x) => x.rank)).toEqual(first.seats.map((_, i) => i + 1));

    const [term] = await app.select().from(s.councilTerms).where(eq(s.councilTerms.id, first.termId));
    expect(term).toMatchObject({ startsAt, endsAt });
    expect(term!.method).toMatchObject({ size: 7, minStreamingHours: 10, eligibilityWindowDays: 90 });
    const members = await app.select().from(s.councilMembers).where(eq(s.councilMembers.termId, first.termId));
    expect(members).toHaveLength(first.seats.length);

    // Same term: idempotent; returns the existing seating.
    const second2 = await recomputeCouncil(app, new Date(NOW.getTime() + 86_400_000));
    expect(second2).toEqual({ ...first, created: false });
    const terms = await app.select().from(s.councilTerms);
    expect(terms).toHaveLength(1);
    const audits = await app.select().from(s.auditLog).where(eq(s.auditLog.action, "council.recompute"));
    expect(audits).toHaveLength(1);

    // Concurrent calls in a new term create exactly one term.
    const next = new Date("2026-07-02T00:00:00Z");
    const results = await Promise.all([recomputeCouncil(app, next), recomputeCouncil(app, next)]);
    expect(results.filter((x) => x.created)).toHaveLength(1);
    expect(results[0]!.termId).toBe(results[1]!.termId);
  });
});

/**
 * A held share the way the API makes one (the share trigger requires it): a succeeded share
 * payment, the purchase posting, then pending → held.
 */
async function heldShare(userId: string, amountCents: number): Promise<void> {
  const [pay] = await app
    .insert(s.payments)
    .values({
      provider: "manual",
      providerRef: `CA-${uuidv7()}`,
      kind: "membership_share",
      status: "succeeded",
      succeededAt: new Date(),
      userId,
      amountCents,
      currency: "usd",
    })
    .returning({ id: s.payments.id });
  const [share] = await app
    .insert(s.membershipShares)
    .values({ userId, amountCents, currency: "usd", paymentId: pay!.id })
    .returning({ id: s.membershipShares.id });
  const account = async (code: string, type: "asset" | "liability") => {
    const [a] = await app
      .insert(s.ledgerAccounts)
      .values({ code: `${code}@usd`, type, name: code, currency: "usd" })
      .onConflictDoNothing()
      .returning({ id: s.ledgerAccounts.id });
    return (
      a?.id ??
      (
        await app
          .select()
          .from(s.ledgerAccounts)
          .where(eq(s.ledgerAccounts.code, `${code}@usd`))
      )[0]!.id
    );
  };
  const cash = await account("asset:cash:manual", "asset");
  const liability = await account(`liability:member-share:${userId}`, "liability");
  await app.transaction(async (tx) => {
    const [txn] = await tx
      .insert(s.ledgerTransactions)
      .values({
        kind: "share_purchase",
        description: "share",
        occurredAt: new Date(),
        idempotencyKey: `share-purchase:${share!.id}`,
      })
      .returning({ id: s.ledgerTransactions.id });
    await tx.insert(s.ledgerEntries).values([
      { transactionId: txn!.id, accountId: cash, amountCents, currency: "usd" },
      { transactionId: txn!.id, accountId: liability, amountCents: -amountCents, currency: "usd" },
    ]);
  });
  await app
    .update(s.membershipShares)
    .set({ status: "held", purchasedAt: new Date() })
    .where(eq(s.membershipShares.id, share!.id));
}
