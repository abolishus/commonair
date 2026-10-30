// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * W1 schema (0037, 0038; ADR 0036, ADR 0012 amendment 1): the payment fraud flag lifecycle with
 * four eyes and the admin-only release of a confirmed flag, the payout hold while a flag holds,
 * self-blocks refused, and `chat_messages.media_ts`. Run as the least-privilege app role.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import type { Database } from "../src/client.ts";
import { uuidv7 } from "../src/ids.ts";
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

/** The SQLSTATE of a rejected query (drizzle wraps the driver error in `cause`). */
async function pgCode(p: PromiseLike<unknown>): Promise<string | undefined> {
  const err = await Promise.resolve(p).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, "expected the database to reject").toBeInstanceOf(Error);
  const e = err as Error & { code?: string; cause?: { code?: string } };
  return e.cause?.code ?? e.code;
}

type Role = (typeof s.users.$inferInsert)["role"];
async function newUser(role: Role = "user"): Promise<string> {
  const name = `w1_${uuidv7().replace(/-/g, "").slice(-12)}`;
  const [u] = await owner
    .insert(s.users)
    .values({ name, email: `${name}@example.test`, username: name, role })
    .returning({ id: s.users.id });
  return u!.id;
}

async function newFlag(payeeUserId: string): Promise<string> {
  const [f] = await app
    .insert(s.paymentFraudFlags)
    .values({ payeeUserId, kind: "manual", evidence: { payments: 3 } })
    .returning({ id: s.paymentFraudFlags.id });
  return f!.id;
}

const flag = async (id: string) =>
  (await app.select().from(s.paymentFraudFlags).where(eq(s.paymentFraudFlags.id, id)))[0]!;
const review = (id: string, by: string, recommendation: "clear" | "confirm" = "clear") =>
  app
    .update(s.paymentFraudFlags)
    .set({ status: "reviewed", reviewedById: by, recommendation, reviewedAt: new Date() })
    .where(eq(s.paymentFraudFlags.id, id));
const decide = (id: string, by: string, decision: "clear" | "confirm") =>
  app
    .update(s.paymentFraudFlags)
    .set({ status: decision === "clear" ? "cleared" : "confirmed", decidedById: by, decision, decidedAt: new Date() })
    .where(eq(s.paymentFraudFlags.id, id));
const release = (id: string, by: string) =>
  app
    .update(s.paymentFraudFlags)
    .set({ releasedById: by, releasedAt: new Date() })
    .where(eq(s.paymentFraudFlags.id, id));

/** A flag reviewed by one treasurer and decided by another. */
async function decidedFlag(payee: string, decision: "clear" | "confirm"): Promise<string> {
  const id = await newFlag(payee);
  await review(id, await newUser("treasurer"), decision);
  await decide(id, await newUser("treasurer"), decision);
  return id;
}

let period = 0;
const payout = (userId: string, status: "held" | "pending") => {
  period += 1;
  const start = new Date(Date.UTC(2026, 0, period));
  return {
    userId,
    periodStart: start,
    periodEnd: new Date(start.getTime() + 86_400_000),
    amountCents: 60_000,
    currency: "EUR",
    status,
    provider: "manual" as const,
    holdReason: status === "held" ? "fraud_review" : null,
  };
};
async function heldPayout(userId: string): Promise<string> {
  const [p] = await app.insert(s.payouts).values(payout(userId, "held")).returning({ id: s.payouts.id });
  return p!.id;
}
const toPending = (id: string) =>
  app.update(s.payouts).set({ status: "pending", holdReason: null }).where(eq(s.payouts.id, id));

describe("payment_fraud_flags lifecycle", () => {
  test("a flag starts open and undecided", async () => {
    const payee = await newUser();
    const treasurer = await newUser("treasurer");
    expect(
      await pgCode(
        app.insert(s.paymentFraudFlags).values({
          payeeUserId: payee,
          kind: "manual",
          status: "reviewed",
          reviewedById: treasurer,
          recommendation: "clear",
          reviewedAt: new Date(),
        }),
      ),
    ).toBe("23514");
    const id = await newFlag(payee);
    expect((await flag(id)).status).toBe("open");
  });

  test("open -> reviewed by a treasurer works, by a plain user is refused", async () => {
    const id = await newFlag(await newUser());
    expect(await pgCode(review(id, await newUser()))).toBe("42501");
    await review(id, await newUser("treasurer"));
    expect((await flag(id)).status).toBe("reviewed");
  });

  test("nobody reviews or decides a flag on their own payouts", async () => {
    const payeeTreasurer = await newUser("treasurer");
    const a = await newFlag(payeeTreasurer);
    expect(await pgCode(review(a, payeeTreasurer))).toBe("42501");
    await review(a, await newUser("treasurer"));
    expect(await pgCode(decide(a, payeeTreasurer, "clear"))).toBe("42501");
  });

  test("the reviewer cannot decide; a second treasurer or an admin can", async () => {
    const reviewer = await newUser("treasurer");
    const a = await newFlag(await newUser());
    await review(a, reviewer);
    expect(await pgCode(decide(a, reviewer, "clear"))).toBe("42501");
    await decide(a, await newUser("treasurer"), "clear");
    expect((await flag(a)).status).toBe("cleared");

    const b = await newFlag(await newUser());
    await review(b, reviewer, "confirm");
    await decide(b, await newUser("admin"), "confirm");
    expect((await flag(b)).status).toBe("confirmed");
  });

  test("the person who raised a flag cannot decide it", async () => {
    const raiser = await newUser("treasurer");
    const [f] = await app
      .insert(s.paymentFraudFlags)
      .values({ payeeUserId: await newUser(), kind: "manual", raisedById: raiser })
      .returning({ id: s.paymentFraudFlags.id });
    await review(f!.id, await newUser("treasurer"));
    expect(await pgCode(decide(f!.id, raiser, "clear"))).toBe("42501");
  });

  test("a decision must match the status; skipping review is refused", async () => {
    const a = await newFlag(await newUser());
    expect(await pgCode(decide(a, await newUser("treasurer"), "clear"))).toBe("23514");
    await review(a, await newUser("treasurer"));
    expect(
      await pgCode(
        app
          .update(s.paymentFraudFlags)
          .set({
            status: "cleared",
            decidedById: await newUser("treasurer"),
            decision: "confirm",
            decidedAt: new Date(),
          })
          .where(eq(s.paymentFraudFlags.id, a)),
      ),
    ).toBe("23514");
  });

  test("a decision cannot rewrite the review's time", async () => {
    const a = await newFlag(await newUser());
    await review(a, await newUser("treasurer"));
    for (const reviewedAt of [null, new Date("2026-01-01T00:00:00Z")])
      expect(
        await pgCode(
          app
            .update(s.paymentFraudFlags)
            .set({
              status: "cleared",
              decidedById: await newUser("treasurer"),
              decision: "clear",
              decidedAt: new Date(),
              reviewedAt,
            })
            .where(eq(s.paymentFraudFlags.id, a)),
        ),
      ).toBe("23514");
    expect((await flag(a)).status).toBe("reviewed");
  });

  test("an undecided flag's note can change, nothing else outside review and decision", async () => {
    const a = await newFlag(await newUser());
    await app.update(s.paymentFraudFlags).set({ note: "looked at it" }).where(eq(s.paymentFraudFlags.id, a));
    expect((await flag(a)).note).toBe("looked at it");
    expect(
      await pgCode(app.update(s.paymentFraudFlags).set({ kind: "new_payee" }).where(eq(s.paymentFraudFlags.id, a))),
    ).toBe("23514");
  });

  test("a decided flag is frozen", async () => {
    const a = await decidedFlag(await newUser(), "clear");
    expect(
      await pgCode(app.update(s.paymentFraudFlags).set({ note: "later" }).where(eq(s.paymentFraudFlags.id, a))),
    ).toBe("42501");
    expect(
      await pgCode(app.update(s.paymentFraudFlags).set({ status: "open" }).where(eq(s.paymentFraudFlags.id, a))),
    ).toBe("42501");
  });

  test("an admin releases a confirmed flag exactly once", async () => {
    const payee = await newUser();
    const a = await decidedFlag(payee, "confirm");
    expect(await pgCode(release(a, await newUser("treasurer")))).toBe("42501");
    await release(a, await newUser("admin"));
    const released = await flag(a);
    expect(released.releasedById).not.toBeNull();
    expect(released.releasedAt).not.toBeNull();
    expect(await pgCode(release(a, await newUser("admin")))).toBe("42501");
  });

  test("the payee, even as an admin, cannot release their own flag", async () => {
    const payeeAdmin = await newUser("admin");
    const a = await decidedFlag(payeeAdmin, "confirm");
    expect(await pgCode(release(a, payeeAdmin))).toBe("42501");
  });

  test("a release needs both the admin and the time", async () => {
    const a = await decidedFlag(await newUser(), "confirm");
    expect(
      await pgCode(
        app
          .update(s.paymentFraudFlags)
          .set({ releasedById: await newUser("admin") })
          .where(eq(s.paymentFraudFlags.id, a)),
      ),
    ).toBe("23514");
  });

  test("open, reviewed and cleared flags are never released", async () => {
    const admin = await newUser("admin");
    const open = await newFlag(await newUser());
    expect(await pgCode(release(open, admin))).toBe("23514");
    const reviewed = await newFlag(await newUser());
    await review(reviewed, await newUser("treasurer"));
    expect(await pgCode(release(reviewed, admin))).toBe("23514");
    const cleared = await decidedFlag(await newUser(), "clear");
    expect(await pgCode(release(cleared, admin))).toBe("42501");
  });

  test("flags are never deleted or truncated", async () => {
    const a = await newFlag(await newUser());
    expect(await pgCode(app.delete(s.paymentFraudFlags).where(eq(s.paymentFraudFlags.id, a)))).toBe("42501");
    expect(await pgCode(owner.delete(s.paymentFraudFlags).where(eq(s.paymentFraudFlags.id, a)))).toBe("42501");
    expect(await pgCode(owner.execute(sql`truncate payment_fraud_flags`))).toBeDefined();
  });

  test("one undecided flag per payee and kind", async () => {
    const payee = await newUser();
    await newFlag(payee);
    expect(await pgCode(newFlag(payee))).toBe("23505");
  });
});

describe("payouts under fraud review", () => {
  test("a flagged payee's payout is inserted held, never pending", async () => {
    const payee = await newUser();
    await newFlag(payee);
    expect(await pgCode(app.insert(s.payouts).values(payout(payee, "pending")))).toBe("23514");
    await heldPayout(payee);
  });

  test("held -> pending is refused while the flag is open or reviewed, works once cleared", async () => {
    const payee = await newUser();
    const id = await newFlag(payee);
    const p = await heldPayout(payee);
    expect(await pgCode(toPending(p))).toBe("23514");
    await review(id, await newUser("treasurer"));
    expect(await pgCode(toPending(p))).toBe("23514");
    await decide(id, await newUser("treasurer"), "clear");
    await toPending(p);
    expect((await app.select().from(s.payouts).where(eq(s.payouts.id, p)))[0]?.status).toBe("pending");
  });

  test("a confirmed flag holds until an admin releases it", async () => {
    const payee = await newUser();
    const id = await decidedFlag(payee, "confirm");
    const p = await heldPayout(payee);
    expect(await pgCode(toPending(p))).toBe("23514");
    await release(id, await newUser("admin"));
    await toPending(p);
  });

  test("a release racing an uncommitted flag waits for it and is refused", async () => {
    const payee = await newUser();
    const p = await heldPayout(payee);
    let inserted!: () => void;
    let commit!: () => void;
    const insertedP = new Promise<void>((r) => (inserted = r));
    const commitP = new Promise<void>((r) => (commit = r));
    const raise = app.transaction(async (tx) => {
      await tx.insert(s.paymentFraudFlags).values({ payeeUserId: payee, kind: "manual", evidence: {} });
      inserted();
      await commitP;
    });
    await insertedP;
    // Without the per-payee lock this would not see the uncommitted flag and would succeed.
    const release = pgCode(toPending(p));
    await new Promise((r) => setTimeout(r, 200));
    commit();
    await raise;
    expect(await release).toBe("23514");
    expect((await app.select().from(s.payouts).where(eq(s.payouts.id, p)))[0]?.status).toBe("held");
  });

  test("payees without a holding flag are unaffected", async () => {
    const payee = await newUser();
    const [p] = await app.insert(s.payouts).values(payout(payee, "pending")).returning({ status: s.payouts.status });
    expect(p?.status).toBe("pending");
  });
});

describe("user_blocks and media_ts", () => {
  test("a self-block is refused; a block is unique per pair", async () => {
    const [a, b] = [await newUser(), await newUser()];
    expect(await pgCode(app.insert(s.userBlocks).values({ userId: a, blockedUserId: a }))).toBe("23514");
    await app.insert(s.userBlocks).values({ userId: a, blockedUserId: b });
    expect(await pgCode(app.insert(s.userBlocks).values({ userId: a, blockedUserId: b }))).toBe("23505");
  });

  test("chat_messages.media_ts round-trips", async () => {
    const userId = await newUser();
    const [c] = await owner
      .insert(s.channels)
      .values({ ownerId: userId, slug: `c${userId.slice(-10)}`, displayName: "W1" })
      .returning({ id: s.channels.id });
    const mediaTs = new Date("2026-10-30T12:00:00.250Z");
    const [m] = await app.insert(s.chatMessages).values({ channelId: c!.id, userId, body: "hi", mediaTs }).returning();
    expect(m?.mediaTs?.toISOString()).toBe(mediaTs.toISOString());
  });
});

describe("W1 read indexes (0041)", () => {
  test("replay's sort key and the reconcile cursor have their indexes", async () => {
    const rows = await owner.execute<{ indexname: string; indexdef: string }>(
      sql`select indexname, indexdef from pg_indexes
          where indexname in ('chat_messages_broadcast_at_idx', 'ledger_transactions_ref_created_idx',
                              'chat_messages_broadcast_media_idx')`,
    );
    const defs = new Map(rows.map((r) => [r.indexname, r.indexdef]));
    expect(defs.has("chat_messages_broadcast_media_idx")).toBe(false);
    expect(defs.get("chat_messages_broadcast_at_idx")).toContain("COALESCE(media_ts, created_at), id");
    expect(defs.get("ledger_transactions_ref_created_idx")).toContain("(ref_type, created_at)");
  });
});
