// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Account deletion, E6 additions (docs/testing/e6-selectors.md "Account deletion (additions)"):
 * outbox and webhook deliveries scrubbed, free text cleared, exports deleted, history kept and
 * balanced, held data untouched, the completed mail sent. Runs as the app role against the
 * stack's Postgres, Valkey and Garage.
 */
import { exportObjectKey } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { MemoryMailer } from "@commonair/email";
import type { ObjectStorage } from "@commonair/storage";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { runAccountDeletions } from "../src/deletion/account-deletion.ts";
import { job as accountDeletionJob } from "../src/jobs/account-deletion.ts";
import { job as exportCleanupJob } from "../src/jobs/export-cleanup.ts";
import { job as vodRetentionJob } from "../src/jobs/vod-retention.ts";
import { EXPORTS_BUCKET, MEDIA_BUCKET, siteAt, stackStorage, tip } from "./e6-fixtures.ts";
import { broadcasterFields, insertEvent, makeSubscription, makeUser, setup, type TestEnv } from "./fixtures.ts";

const storage = stackStorage();
const site = siteAt("http://localhost:3000");
const mailer = new MemoryMailer({ site });
let env: TestEnv;

describe.skipIf(!storage)("account deletion (E6)", () => {
  const S3 = storage as ObjectStorage;

  beforeAll(async () => {
    env = await setup({
      jobs: [],
      outbox: false,
      segments: false,
      storage: S3,
      exportsBucket: EXPORTS_BUCKET,
      mediaBucket: MEDIA_BUCKET,
      mailer,
      site,
    });
    env.worker.ctx.db = env.t.app.db;
    env.worker.ctx.sql = env.t.app.sql;
  });
  afterAll(() => env?.close());

  const ctx = () => env.worker.ctx;
  const db = () => env.t.db;
  const app = () => env.t.app.db;
  const amount = { value: 300, decimal_places: 2, currency: "usd" };

  async function schedule(userId: string) {
    const [d] = await app()
      .insert(schema.accountDeletions)
      .values({ userId, scheduledFor: new Date(Date.now() - 1000) })
      .returning();
    return d!;
  }

  async function readyExport(userId: string) {
    const id = uuidv7();
    await app()
      .insert(schema.dataExports)
      .values({ id, userId, kind: "account", status: "ready", storageKey: exportObjectKey(userId, id), sizeBytes: 3 });
    await S3.put(EXPORTS_BUCKET, exportObjectKey(userId, id), new Uint8Array([1, 2, 3]));
    return id;
  }

  test("scrubs the outbox, clears free text, deletes exports, keeps history, mails the old address", async () => {
    const U = await makeUser(db());
    const S = await makeUser(db());
    const old = { email: U.user.email, username: U.user.username, name: U.user.name };
    const named = `named tip ${uuidv7()}`;
    const anonymous = `anon tip ${uuidv7()}`;
    const chat = `chat ${uuidv7()}`;
    const t1 = await tip(app(), {
      from: U.user.id,
      channelId: S.channel.id,
      creatorUserId: S.user.id,
      cents: 300,
      message: named,
    });
    const t2 = await tip(app(), {
      from: U.user.id,
      channelId: S.channel.id,
      creatorUserId: S.user.id,
      cents: 400,
      message: anonymous,
      anonymous: true,
    });
    await app().insert(schema.follows).values({ followerId: U.user.id, channelId: S.channel.id });
    await app()
      .insert(schema.chatMessages)
      .values({ id: uuidv7(), channelId: S.channel.id, userId: U.user.id, body: chat });
    await app().insert(schema.memberships).values({ userId: U.user.id, class: "viewer", basis: "share" });
    await app().insert(schema.auditLog).values({
      id: uuidv7(),
      actorType: "user",
      actorId: U.user.id,
      action: "test.action",
      subjectType: "user",
      subjectId: U.user.id,
    });
    const [report] = await app()
      .insert(schema.reports)
      .values({
        reporterId: U.user.id,
        subjectType: "channel",
        subjectId: S.channel.id,
        reason: "spam",
        details: `my words ${uuidv7()}`,
      })
      .returning();
    const [appeal] = await app()
      .insert(schema.appeals)
      .values({
        appellantId: U.user.id,
        kind: "account",
        subjectType: "user",
        subjectId: U.user.id,
        body: `please ${uuidv7()}`,
      })
      .returning();
    const exportId = await readyExport(U.user.id);

    const sb = broadcasterFields(S.user);
    const ub = { user_id: U.user.id, user_login: U.user.username, user_name: U.user.name };
    const theirs = [
      await insertEvent(db(), "channel.tip", S.channel.id, {
        ...sb,
        ...ub,
        is_anonymous: false,
        amount,
        message: named,
      }),
      await insertEvent(db(), "channel.tip", S.channel.id, {
        ...sb,
        user_id: null,
        user_login: null,
        user_name: null,
        is_anonymous: true,
        amount,
        message: anonymous,
      }),
      await insertEvent(db(), "channel.follow", S.channel.id, { ...sb, ...ub, followed_at: new Date().toISOString() }),
      await insertEvent(db(), "channel.subscribe", S.channel.id, { ...sb, ...ub, tier: "1000", is_gift: false }),
      await insertEvent(db(), "channel.chat.message", S.channel.id, {
        ...sb,
        chatter_user_id: U.user.id,
        chatter_user_login: U.user.username,
        chatter_user_name: U.user.name,
        message_id: uuidv7(),
        message: { text: chat, fragments: [] },
        reply: null,
      }),
      await insertEvent(db(), "channel.chat.message", S.channel.id, {
        ...sb,
        chatter_user_id: S.user.id,
        chatter_user_login: S.user.username,
        chatter_user_name: S.user.name,
        message_id: uuidv7(),
        message: { text: "hi back", fragments: [] },
        reply: { parent_message_id: uuidv7(), parent_user_login: U.user.username, parent_message_body: chat },
      }),
      await insertEvent(db(), "channel.ban", S.channel.id, {
        ...sb,
        ...ub,
        moderator_user_id: S.user.id,
        moderator_user_login: S.user.username,
        moderator_user_name: S.user.name,
        reason: "",
        banned_at: new Date().toISOString(),
        ends_at: null,
        is_permanent: true,
      }),
      await insertEvent(db(), "stream.online", U.channel.id, { ...broadcasterFields(U.user), type: "live" }),
    ];
    const kept = [
      await insertEvent(db(), "stream.online", S.channel.id, { ...sb, type: "live" }),
      await insertEvent(db(), "channel.chat.message", S.channel.id, {
        ...sb,
        chatter_user_id: S.user.id,
        chatter_user_login: S.user.username,
        chatter_user_name: S.user.name,
        message_id: uuidv7(),
        message: { text: "hello there", fragments: [] },
        reply: null,
      }),
    ];
    const sub = await makeSubscription(db(), {
      userId: S.user.id,
      type: "channel.follow",
      condition: { broadcaster_user_id: S.user.id },
      callbackUrl: "https://hooks.example.test/cb",
      secret: "s3cr3t-s3cr3t",
    });
    const delivery = (eventId: string) => ({ id: uuidv7(), subscriptionId: sub.id, eventId, messageId: uuidv7() });
    await db()
      .insert(schema.webhookDeliveries)
      .values([delivery(theirs[2]!.id), delivery(kept[0]!.id)]);

    const d = await schedule(U.user.id);
    expect(await runAccountDeletions(ctx())).toEqual({ completed: 1, failed: 0 });

    // Outbox: every event naming them is gone, with its deliveries; the rest is kept.
    const left = await db()
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(
        inArray(
          schema.events.id,
          [...theirs, ...kept].map((e) => e.id),
        ),
      );
    expect(left.map((e) => e.id).sort()).toEqual(kept.map((e) => e.id).sort());
    const deliveries = await db().select({ eventId: schema.webhookDeliveries.eventId }).from(schema.webhookDeliveries);
    expect(deliveries.map((x) => x.eventId)).toEqual([kept[0]!.id]);

    // Free text cleared; the rows stay.
    const tips = await db()
      .select()
      .from(schema.tips)
      .where(inArray(schema.tips.id, [t1.tipId, t2.tipId]));
    expect(tips.map((x) => x.message)).toEqual(["", ""]);
    expect((await db().select().from(schema.reports).where(eq(schema.reports.id, report!.id)))[0]?.details).toBe("");
    expect((await db().select().from(schema.appeals).where(eq(schema.appeals.id, appeal!.id)))[0]?.body).toBe("");

    // Exports: rows and archives gone.
    expect(await db().select().from(schema.dataExports).where(eq(schema.dataExports.userId, U.user.id))).toEqual([]);
    expect(await S3.head(EXPORTS_BUCKET, exportObjectKey(U.user.id, exportId))).toBeNull();

    // History kept, by id, and balanced.
    const payments = await db().select().from(schema.payments).where(eq(schema.payments.userId, U.user.id));
    expect(payments).toHaveLength(2);
    for (const txId of [t1.transactionId, t2.transactionId]) {
      const [sum] = await db()
        .select({
          n: sql<number>`count(*)::int`,
          total: sql<string>`coalesce(sum(${schema.ledgerEntries.amountCents}), 0)::text`,
        })
        .from(schema.ledgerEntries)
        .where(eq(schema.ledgerEntries.transactionId, txId));
      expect(sum?.n).toBeGreaterThan(0);
      expect(sum?.total).toBe("0");
    }
    const audits = await db().select().from(schema.auditLog).where(eq(schema.auditLog.actorId, U.user.id));
    expect(audits.map((a) => a.action)).toContain("test.action");
    const history = await db()
      .select()
      .from(schema.membershipHistory)
      .where(eq(schema.membershipHistory.userId, U.user.id));
    expect(history.length).toBeGreaterThan(0);
    const [done] = await db().select().from(schema.accountDeletions).where(eq(schema.accountDeletions.id, d.id));
    expect(done?.status).toBe("completed");
    const [completeAudit] = await db()
      .select()
      .from(schema.auditLog)
      .where(
        sql`${schema.auditLog.action} = 'account.deletion.complete' and ${schema.auditLog.subjectId} = ${U.user.id}`,
      );
    expect(completeAudit?.details).toMatchObject({
      deleted: {
        events: theirs.length,
        webhook_deliveries: 1,
        tip_messages: 2,
        report_details: 1,
        appeal_bodies: 1,
        data_exports: 1,
      },
    });

    // No personal data left in any retained table.
    const needles = [old.email, old.username, old.name, named, anonymous, chat, report!.details, appeal!.body];
    for (const table of [
      "events",
      "webhook_deliveries",
      "tips",
      "payments",
      "audit_log",
      "ledger_transactions",
      "ledger_entries",
      "ledger_accounts",
      "membership_history",
      "vote_history",
      "governance_settings_history",
    ]) {
      const rows = await env.t.sql.unsafe<{ n: number }[]>(
        `select count(*)::int as n from ${table} x where ${needles.map((_, i) => `strpos(lower(row_to_json(x)::text), lower($${i + 1})) > 0`).join(" or ")}`,
        needles,
      );
      expect({ table, n: rows[0]?.n }).toEqual({ table, n: 0 });
    }

    // The completed notice went to the address on file before pseudonymization.
    const sent = mailer.to(old.email);
    expect(sent.map((m) => m.template)).toEqual(["accountDeletionCompleted"]);
    const [pseudonymized] = await db().select().from(schema.users).where(eq(schema.users.id, U.user.id));
    expect(pseudonymized?.email).not.toBe(old.email);
    // A second run finds nothing due and mails nobody.
    expect(await runAccountDeletions(ctx())).toEqual({ completed: 0, failed: 0 });
    expect(mailer.to(old.email)).toHaveLength(1);
  });

  test("held data is untouched and held media stays; exports go regardless", async () => {
    const H = await makeUser(db());
    const [hold] = await db()
      .insert(schema.legalHolds)
      .values({ userId: H.user.id, reasonCode: "law_enforcement", reason: "preservation request" })
      .returning();
    const [b] = await db()
      .insert(schema.broadcasts)
      .values({ channelId: H.channel.id, ingestProtocol: "rtmp", path: `live/${H.channel.slug}`, endedAt: new Date() })
      .returning();
    const vodId = uuidv7();
    await db()
      .insert(schema.vods)
      .values({
        id: vodId,
        broadcastId: b!.id,
        channelId: H.channel.id,
        title: "v",
        storagePrefix: `vods/${vodId}/`,
        status: "ready",
      });
    await S3.put(MEDIA_BUCKET, `vods/${vodId}/index.m3u8`, new Uint8Array([35]));
    const exportId = await readyExport(H.user.id);

    await schedule(H.user.id);
    expect(await runAccountDeletions(ctx())).toEqual({ completed: 1, failed: 0 });

    const [after] = await db().select().from(schema.legalHolds).where(eq(schema.legalHolds.id, hold!.id));
    expect(after).toEqual(hold);
    expect(await S3.head(MEDIA_BUCKET, `vods/${vodId}/index.m3u8`)).not.toBeNull();
    expect(await S3.head(EXPORTS_BUCKET, exportObjectKey(H.user.id, exportId))).toBeNull();
    await S3.deletePrefix(MEDIA_BUCKET, `vods/${vodId}/`);
  });

  test("on-demand ops jobs answer `skipped` while their run lock is busy", async () => {
    const meta = { id: "t", attemptsMade: 0 };
    for (const [job, key] of [
      [accountDeletionJob, "worker:lock:deletions:account-deletion"],
      [exportCleanupJob, "worker:lock:exports:export-cleanup"],
      [vodRetentionJob, "worker:lock:retention:vod-retention"],
    ] as const) {
      await ctx().valkey.set(key, "someone-else", "PX", 10_000);
      try {
        expect(await job.handler({}, ctx(), meta)).toEqual({ skipped: 1 });
      } finally {
        await ctx().valkey.del(key);
      }
      // Free again: the job runs and returns counts only. (Not export cleanup: its orphan sweep
      // would list the stack's whole exports bucket, which this throwaway database knows nothing of.)
      if (job === exportCleanupJob) continue;
      const r = (await job.handler({}, ctx(), meta)) as Record<string, unknown>;
      for (const v of Object.values(r)) expect(Number.isInteger(v)).toBe(true);
    }
  });
});
