// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** E7 schema (0024, 0025): account actions, DMCA items and counter-notices, and their protections. */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  activeAccountAction,
  activeDmcaStrikes,
  DMCA_SUSPENSION_REASON,
  liftDmcaSuspensionInTx,
  lockAccountActions,
  reconcileDmcaTerminationInTx,
  reverseAccountActionInTx,
} from "../src/account-actions.ts";
import type { Database } from "../src/client.ts";
import * as s from "../src/schema/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";

const DAY_MS = 86_400_000;

let t: TestDatabase;
let app: Database;

beforeAll(async () => {
  t = await createTestDatabase();
  app = t.app.db;
});
afterAll(async () => {
  await t?.drop();
});

async function expectPgError(p: PromiseLike<unknown>, pattern: RegExp): Promise<void> {
  const err = await Promise.resolve(p).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, "expected the database to reject").toBeInstanceOf(Error);
  const e = err as Error & { cause?: Error };
  expect(e.cause?.message ?? e.message).toMatch(pattern);
}

let n = 0;
async function makeUser(): Promise<string> {
  n += 1;
  const name = `e7user${n}`;
  const [u] = await app
    .insert(s.users)
    .values({ name, email: `${name}@example.test`, username: name })
    .returning({ id: s.users.id });
  return u!.id;
}

async function strike(
  userId: string,
  createdAt = new Date(),
  action: "dmca_strike" | "dmca_termination" = "dmca_strike",
) {
  const [row] = await app
    .insert(s.accountActions)
    .values({ userId, action, sourceType: "dmca_notice", actorType: "moderator", createdAt })
    .returning();
  return row!;
}

async function makeNotice(): Promise<string> {
  const [row] = await app
    .insert(s.dmcaNotices)
    .values({
      claimantName: "Claimant",
      claimantEmail: "claimant@example.test",
      claimantAddress: "1 Street",
      copyrightedWork: "A song",
      infringingUrls: ["https://example.test/clip/1"],
      goodFaithStatement: true,
      accuracyStatement: true,
      signature: "Claimant",
    })
    .returning({ id: s.dmcaNotices.id });
  return row!.id;
}

describe("account_actions protections", () => {
  test("cannot be deleted, nor have action or user_id changed", async () => {
    const userId = await makeUser();
    const other = await makeUser();
    const row = await strike(userId);
    await expectPgError(app.delete(s.accountActions).where(eq(s.accountActions.id, row.id)), /permission denied/);
    await expectPgError(
      app.update(s.accountActions).set({ action: "dmca_termination" }).where(eq(s.accountActions.id, row.id)),
      /action is immutable/,
    );
    await expectPgError(
      app.update(s.accountActions).set({ userId: other }).where(eq(s.accountActions.id, row.id)),
      /user_id is immutable/,
    );
    // Even the owner (bypassing the REVOKE) hits the trigger.
    await expectPgError(t.db.delete(s.accountActions).where(eq(s.accountActions.id, row.id)), /never deleted/);
  });

  test("is reversed once; a second reversal is refused", async () => {
    const userId = await makeUser();
    const row = await strike(userId);
    await app
      .update(s.accountActions)
      .set({ reversedAt: new Date(), reversedReason: "appeal_overturned" })
      .where(eq(s.accountActions.id, row.id));
    await expectPgError(
      app
        .update(s.accountActions)
        .set({ reversedAt: new Date(Date.now() + 1000), reversedReason: "counter_notice_restored" })
        .where(eq(s.accountActions.id, row.id)),
      /reversed_at is set once/,
    );
  });

  test("the reversal check refuses reversed_at without a reason", async () => {
    const userId = await makeUser();
    const row = await strike(userId);
    await expectPgError(
      app.update(s.accountActions).set({ reversedAt: new Date() }).where(eq(s.accountActions.id, row.id)),
      /account_actions_reversal_ck/,
    );
    await expectPgError(
      app.insert(s.accountActions).values({
        userId,
        action: "dmca_strike",
        actorType: "system",
        reversedAt: new Date(),
      }),
      /account_actions_reversal_ck/,
    );
  });
});

describe("dmca protections", () => {
  test("dmca_notice_items: removed_at is set once, url is immutable", async () => {
    const noticeId = await makeNotice();
    const [item] = await app
      .insert(s.dmcaNoticeItems)
      .values({ noticeId, url: "https://example.test/clip/1" })
      .returning();
    await app.update(s.dmcaNoticeItems).set({ removedAt: new Date() }).where(eq(s.dmcaNoticeItems.id, item!.id));
    await expectPgError(
      app
        .update(s.dmcaNoticeItems)
        .set({ removedAt: new Date(Date.now() + 1000) })
        .where(eq(s.dmcaNoticeItems.id, item!.id)),
      /removed_at is set once/,
    );
    await expectPgError(
      app
        .update(s.dmcaNoticeItems)
        .set({ url: "https://example.test/other" })
        .where(eq(s.dmcaNoticeItems.id, item!.id)),
      /url is immutable/,
    );
    // Restore is a separate set-once column.
    await app.update(s.dmcaNoticeItems).set({ restoredAt: new Date() }).where(eq(s.dmcaNoticeItems.id, item!.id));
  });

  test("the app cannot delete from the four tables", async () => {
    const userId = await makeUser();
    const noticeId = await makeNotice();
    const [item] = await app.insert(s.dmcaNoticeItems).values({ noticeId, url: "https://example.test/v" }).returning();
    const [counter] = await app
      .insert(s.dmcaCounterNotices)
      .values({
        noticeId,
        userId,
        fullName: "Owner",
        address: "2 Street",
        phone: "+1 555 0100",
        itemIds: [item!.id],
        statement: "Mistake",
        goodFaithStatement: true,
        consentToJurisdiction: true,
        signature: "Owner",
        restoreAfter: new Date(Date.now() + 14 * DAY_MS),
      })
      .returning();
    const action = await strike(userId);
    await expectPgError(app.delete(s.accountActions).where(eq(s.accountActions.id, action.id)), /permission/);
    await expectPgError(app.delete(s.dmcaNoticeItems).where(eq(s.dmcaNoticeItems.id, item!.id)), /permission/);
    await expectPgError(app.delete(s.dmcaCounterNotices).where(eq(s.dmcaCounterNotices.id, counter!.id)), /permission/);
    await expectPgError(app.delete(s.dmcaNotices).where(eq(s.dmcaNotices.id, noticeId)), /permission/);
    // Notices and counter-notices stay updatable (status, suit).
    await app.update(s.dmcaNotices).set({ status: "countered" }).where(eq(s.dmcaNotices.id, noticeId));
    await app
      .update(s.dmcaCounterNotices)
      .set({ suitFiledAt: new Date() })
      .where(eq(s.dmcaCounterNotices.id, counter!.id));
  });

  test("one counter-notice per notice and user", async () => {
    const userId = await makeUser();
    const noticeId = await makeNotice();
    const values = {
      noticeId,
      userId,
      fullName: "Owner",
      address: "2 Street",
      phone: "+1 555 0100",
      itemIds: [],
      statement: "Mistake",
      goodFaithStatement: true,
      consentToJurisdiction: true,
      signature: "Owner",
      restoreAfter: new Date(),
    };
    await app.insert(s.dmcaCounterNotices).values(values);
    await expectPgError(app.insert(s.dmcaCounterNotices).values(values), /dmca_counter_notices_notice_user_uq/);
  });

  test("no truncate on account actions or dmca tables, even for the owner", async () => {
    for (const table of ["account_actions", "dmca_notice_items", "dmca_counter_notices", "dmca_notices"]) {
      await expectPgError(t.db.execute(sql.raw(`truncate ${table} cascade`)), /append-only/);
    }
  });

  test("the new indexes exist", async () => {
    const rows = await t.db.execute<{ indexname: string }>(
      sql`select indexname from pg_indexes where indexname in ('clips_broadcast_idx', 'consent_records_anon_created_idx', 'dmca_counter_notices_due_idx')`,
    );
    expect(rows.map((r) => r.indexname).sort()).toEqual([
      "clips_broadcast_idx",
      "consent_records_anon_created_idx",
      "dmca_counter_notices_due_idx",
    ]);
  });

  test("the integrity review list's index is newest first (0027)", async () => {
    const [row] = await t.db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where indexname = 'integrity_flags_created_idx'`,
    );
    expect(row?.indexdef).toMatch(/\(created_at DESC, id DESC\)/);
  });

  test("one unreversed termination per user; a new one is allowed after reversal (0026)", async () => {
    const userId = await makeUser();
    const first = await strike(userId, new Date(), "dmca_termination");
    await expectPgError(strike(userId, new Date(), "dmca_termination"), /account_actions_active_termination_uq/);
    await strike(userId); // strikes are not limited
    await strike(userId);
    expect(
      await reverseAccountActionInTx(app, { id: first.id, now: new Date(), byId: null, reason: "appeal_overturned" }),
    ).not.toBeNull();
    const second = await strike(userId, new Date(), "dmca_termination");
    expect((await activeAccountAction(app, userId, "dmca_termination"))?.id).toBe(second.id);
  });
});

describe("account-actions helpers", () => {
  test("activeDmcaStrikes counts unreversed strikes inside the window only", async () => {
    const userId = await makeUser();
    const now = new Date();
    const windowStart = now.getTime() - 365 * DAY_MS;
    await strike(userId, new Date(windowStart)); // exactly at the boundary: outside
    await strike(userId, new Date(windowStart + 1000)); // inside
    await strike(userId, new Date(now.getTime() - DAY_MS)); // inside
    const reversed = await strike(userId, new Date(now.getTime() - DAY_MS));
    await strike(userId, new Date(now.getTime() - DAY_MS), "dmca_termination"); // not a strike
    await app.transaction(async (tx) => {
      await reverseAccountActionInTx(tx, { id: reversed.id, now, byId: null, reason: "appeal_overturned" });
    });
    expect(await activeDmcaStrikes(app, userId, now)).toBe(2);
    expect(await activeDmcaStrikes(app, await makeUser(), now)).toBe(0);
  });

  test("activeAccountAction finds the unreversed row only", async () => {
    const userId = await makeUser();
    expect(await activeAccountAction(app, userId, "dmca_termination")).toBeNull();
    const term = await strike(userId, new Date(), "dmca_termination");
    expect((await activeAccountAction(app, userId, "dmca_termination"))?.id).toBe(term.id);
    expect(await activeAccountAction(app, userId, "dmca_strike")).toBeNull();
    await reverseAccountActionInTx(app, { id: term.id, now: new Date(), byId: null, reason: "appeal_overturned" });
    expect(await activeAccountAction(app, userId, "dmca_termination")).toBeNull();
  });

  test("reverseAccountActionInTx reverses once; the second call returns null", async () => {
    const userId = await makeUser();
    const moderator = await makeUser();
    const row = await strike(userId);
    const appealId = "019a0000-0000-7000-8000-0000000000aa";
    const first = await app.transaction((tx) =>
      reverseAccountActionInTx(tx, {
        id: row.id,
        now: new Date(),
        byId: moderator,
        reason: "appeal_overturned",
        appealId,
      }),
    );
    expect(first?.reversedReason).toBe("appeal_overturned");
    expect(first?.reversedById).toBe(moderator);
    expect(first?.reversalAppealId).toBe(appealId);
    const second = await app.transaction((tx) =>
      reverseAccountActionInTx(tx, { id: row.id, now: new Date(), byId: null, reason: "counter_notice_restored" }),
    );
    expect(second).toBeNull();
  });

  test("liftDmcaSuspensionInTx lifts the repeat-infringer suspension only", async () => {
    const dmca = await makeUser();
    const moderated = await makeUser();
    const active = await makeUser();
    await app.update(s.users).set({ banned: true, banReason: DMCA_SUSPENSION_REASON }).where(eq(s.users.id, dmca));
    await app.update(s.users).set({ banned: true, banReason: "moderation" }).where(eq(s.users.id, moderated));
    expect(await liftDmcaSuspensionInTx(app, dmca)).toBe(true);
    expect(await liftDmcaSuspensionInTx(app, moderated)).toBe(false);
    expect(await liftDmcaSuspensionInTx(app, active)).toBe(false);
    const rows = await app
      .select({ id: s.users.id, banned: s.users.banned, banReason: s.users.banReason })
      .from(s.users)
      .where(sql`${s.users.id} in (${dmca}, ${moderated})`);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(dmca)).toMatchObject({ banned: false, banReason: null });
    expect(byId.get(moderated)).toMatchObject({ banned: true, banReason: "moderation" });
  });

  test("reconcileDmcaTerminationInTx reverses the termination below the threshold and lifts the suspension", async () => {
    const userId = await makeUser();
    const now = new Date();
    await strike(userId, now);
    await strike(userId, now);
    const third = await strike(userId, now);
    await strike(userId, now, "dmca_termination");
    await app.update(s.users).set({ banned: true, banReason: DMCA_SUSPENSION_REASON }).where(eq(s.users.id, userId));

    // At the threshold (3): nothing changes.
    expect(await app.transaction((tx) => reconcileDmcaTerminationInTx(tx, { userId, now, byId: null }))).toBeNull();

    const result = await app.transaction(async (tx) => {
      await lockAccountActions(tx, userId);
      await reverseAccountActionInTx(tx, { id: third.id, now, byId: null, reason: "counter_notice_restored" });
      return reconcileDmcaTerminationInTx(tx, { userId, now, byId: null });
    });
    expect(result?.action).toBe("dmca_termination");
    expect(result?.reversedReason).toBe("strikes_below_threshold");
    const [u] = await app.select({ banned: s.users.banned }).from(s.users).where(eq(s.users.id, userId));
    expect(u?.banned).toBe(false);
    // Nothing left to reverse.
    expect(await app.transaction((tx) => reconcileDmcaTerminationInTx(tx, { userId, now, byId: null }))).toBeNull();
  });

  test("reconcileDmcaTerminationInTx with threshold 0 always reverses, and leaves a moderation suspension alone", async () => {
    const userId = await makeUser();
    const now = new Date();
    for (let i = 0; i < 5; i += 1) await strike(userId, now);
    await strike(userId, now, "dmca_termination");
    await app.update(s.users).set({ banned: true, banReason: "moderation" }).where(eq(s.users.id, userId));
    const result = await app.transaction((tx) =>
      reconcileDmcaTerminationInTx(tx, { userId, now, byId: null, threshold: 0 }),
    );
    expect(result?.reversedReason).toBe("strikes_below_threshold");
    const [u] = await app
      .select({ banned: s.users.banned, banReason: s.users.banReason })
      .from(s.users)
      .where(eq(s.users.id, userId));
    expect(u).toEqual({ banned: true, banReason: "moderation" });
  });

  test("lockAccountActions serializes two transactions on the same user", async () => {
    const userId = await makeUser();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => (locked = r));
    const first = app.transaction(async (tx) => {
      await lockAccountActions(tx, userId);
      locked();
      await held;
    });
    await lockTaken;
    const second = await t.db.transaction(async (tx) => {
      const [r] = await tx.execute<{ ok: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${`account_actions:${userId}`}, 0)) as ok`,
      );
      return r?.ok;
    });
    expect(second).toBe(false);
    release();
    await first;
  });
});
