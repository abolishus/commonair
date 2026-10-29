// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Account deletion, E6 additions (docs/testing/e6-selectors.md "Account deletion (additions)"):
 * outbox and webhook deliveries scrubbed, free text cleared, exports deleted, history kept and
 * balanced, held data untouched, the completed mail sent. Runs as the app role against the
 * stack's Postgres, Valkey and Garage.
 */
import { BUS } from "@commonair/contracts/events";
import { exportObjectKey } from "@commonair/contracts/internal";
import { BotConfig } from "@commonair/contracts/shapes";
import { schema, uuidv7 } from "@commonair/db";
import { MemoryMailer } from "@commonair/email";
import type { ObjectStorage } from "@commonair/storage";
import { eq, inArray, sql } from "drizzle-orm";
import { Valkey } from "iovalkey";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { runAccountDeletions, scrubOutbox } from "../src/deletion/account-deletion.ts";
import { job as accountDeletionJob } from "../src/jobs/account-deletion.ts";
import { job as exportCleanupJob } from "../src/jobs/export-cleanup.ts";
import { job as vodRetentionJob } from "../src/jobs/vod-retention.ts";
import { EXPORTS_BUCKET, MEDIA_BUCKET, siteAt, stackStorage, tip } from "./e6-fixtures.ts";
import {
  broadcasterFields,
  insertEvent,
  makeApp,
  makeBroadcast,
  makeSubscription,
  makeToken,
  makeUser,
  setup,
  VALKEY_URL,
  waitFor,
  type TestEnv,
} from "./fixtures.ts";

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
    // Their anonymous tip is found by fingerprint only, so it is redacted, never deleted.
    const anonTip = await insertEvent(db(), "channel.tip", S.channel.id, {
      ...sb,
      user_id: null,
      user_login: null,
      user_name: null,
      is_anonymous: true,
      amount: { ...amount, value: 400 },
      message: anonymous,
    });
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
      .values([delivery(theirs[1]!.id), delivery(kept[0]!.id), delivery(anonTip.id)]);

    const d = await schedule(U.user.id);
    expect(await runAccountDeletions(ctx())).toMatchObject({ completed: 1, failed: 0 });

    // Outbox: every event naming them is gone, with its deliveries; the rest is kept.
    const left = await db()
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(
        inArray(
          schema.events.id,
          [...theirs, ...kept, anonTip].map((e) => e.id),
        ),
      );
    expect(left.map((e) => e.id).sort()).toEqual([...kept, anonTip].map((e) => e.id).sort());
    const deliveries = await db().select({ eventId: schema.webhookDeliveries.eventId }).from(schema.webhookDeliveries);
    expect(deliveries.map((x) => x.eventId).sort()).toEqual([kept[0]!.id, anonTip.id].sort());
    const [anonLeft] = await db().select().from(schema.events).where(eq(schema.events.id, anonTip.id));
    expect(anonLeft?.payload).toEqual({ ...anonTip.payload, message: "[deleted]" });

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
        events_redacted: 1,
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
    expect(await runAccountDeletions(ctx())).toMatchObject({ completed: 0, failed: 0 });
    expect(mailer.to(old.email)).toHaveLength(1);
  });

  /** Every events / webhook_deliveries row whose text contains one of `needles` (case-insensitive). */
  async function piiRows(needles: string[]) {
    const out: Record<string, number> = {};
    for (const table of ["events", "webhook_deliveries"]) {
      const rows = await env.t.sql.unsafe<{ n: number }[]>(
        `select count(*)::int as n from ${table} x where ${needles.map((_, i) => `strpos(lower(row_to_json(x)::text), lower($${i + 1})) > 0`).join(" or ")}`,
        needles,
      );
      out[table] = rows[0]?.n ?? 0;
    }
    return out;
  }

  test("a user live at completion: the stream.offline the completion emits is scrubbed too", async () => {
    const L = await makeUser(db());
    // A channel whose slug and display name differ from the username, so each is checked.
    const slug = `chan${uuidv7().slice(-8)}`;
    const display = `Display ${uuidv7().slice(-8)}`;
    await db().update(schema.channels).set({ slug, displayName: display }).where(eq(schema.channels.id, L.channel.id));
    const b = await makeBroadcast(db(), L.channel.id);
    await db().update(schema.channels).set({ liveBroadcastId: b.id }).where(eq(schema.channels.id, L.channel.id));
    const old = [L.user.email, L.user.username, L.user.name, slug, display];

    await schedule(L.user.id);
    expect(await runAccountDeletions(ctx())).toMatchObject({ completed: 1, failed: 0 });

    const [ended] = await db().select().from(schema.broadcasts).where(eq(schema.broadcasts.id, b.id));
    expect(ended?.endedAt).not.toBeNull();
    const offline = await db()
      .select()
      .from(schema.events)
      .where(sql`${schema.events.type} = 'stream.offline' and ${schema.events.channelId} = ${L.channel.id}`);
    expect(offline).toEqual([]);
    expect(await piiRows([L.user.id, ...old])).toEqual({ events: 0, webhook_deliveries: 0 });
  });

  test("names that are common words take no one else's events; mentions in kept text are redacted", async () => {
    const V = await makeUser(db());
    const S = await makeUser(db());
    // W's display name and username are words other payloads carry as values.
    const W = await makeUser(db());
    // Mixes letters and an underscore, so it is redacted bare in text too.
    const wLogin = `w_${uuidv7().slice(-10)}`;
    await db()
      .update(schema.users)
      .set({ name: "text", displayUsername: wLogin.toUpperCase(), username: wLogin })
      .where(eq(schema.users.id, W.user.id));
    await db()
      .update(schema.channels)
      .set({ slug: wLogin, displayName: "usd" })
      .where(eq(schema.channels.id, W.channel.id));
    await tip(app(), { from: W.user.id, channelId: S.channel.id, creatorUserId: S.user.id, cents: 100, message: "gg" });

    const sb = broadcasterFields(S.user);
    const vChat = (text: string, fragments: unknown[] = []) =>
      insertEvent(db(), "channel.chat.message", S.channel.id, {
        ...sb,
        chatter_user_id: V.user.id,
        chatter_user_login: V.user.username,
        chatter_user_name: V.user.name,
        message_id: uuidv7(),
        message: { text, fragments: [{ type: "text", text, emote: null }, ...fragments] },
        badges: [],
        color: "",
        reply: null,
        is_bot: false,
      });
    const others = [
      await vChat("gg"),
      await insertEvent(db(), "channel.tip", S.channel.id, {
        ...sb,
        user_id: V.user.id,
        user_login: V.user.username,
        user_name: V.user.name,
        is_anonymous: false,
        amount: { value: 100, decimal_places: 2, currency: "usd" },
        message: "gg",
      }),
    ];
    const mention = await vChat(`thanks ${wLogin} for the raid`, [
      { type: "mention", text: `@${wLogin}`, emote: null },
    ]);

    await schedule(W.user.id);
    expect(await runAccountDeletions(ctx())).toMatchObject({ completed: 1, failed: 0 });

    const left = await db()
      .select()
      .from(schema.events)
      .where(
        inArray(
          schema.events.id,
          [...others, mention].map((e) => e.id),
        ),
      );
    expect(left.map((e) => e.id).sort()).toEqual([...others, mention].map((e) => e.id).sort());
    for (const e of others) expect(left.find((x) => x.id === e.id)?.payload).toEqual(e.payload);
    const redacted = left.find((x) => x.id === mention.id)?.payload as { message: { text: string } };
    expect(redacted.message.text).toBe("thanks [deleted] for the raid");
    expect(await piiRows([W.user.id, wLogin, W.user.email])).toEqual({ events: 0, webhook_deliveries: 0 });
  });

  test("a login that is a common word rewrites no one else's text; a matching anonymous tip keeps its event", async () => {
    const V = await makeUser(db());
    const S = await makeUser(db());
    const T = await makeUser(db(), "the");
    await tip(app(), {
      from: T.user.id,
      channelId: S.channel.id,
      creatorUserId: S.user.id,
      cents: 100,
      message: "gg",
      anonymous: true,
    });
    const sb = broadcasterFields(S.user);
    const vChat = (text: string, fragments: unknown[] = [{ type: "text", text, emote: null }]) =>
      insertEvent(db(), "channel.chat.message", S.channel.id, {
        ...sb,
        chatter_user_id: V.user.id,
        chatter_user_login: V.user.username,
        chatter_user_name: V.user.name,
        message_id: uuidv7(),
        message: { text, fragments },
        badges: [],
        color: "",
        reply: { parent_message_id: uuidv7(), parent_user_login: S.user.username, parent_message_body: "the end" },
        is_bot: false,
      });
    const untouched = [
      await vChat("the stream was great"),
      await insertEvent(db(), "channel.ban", S.channel.id, {
        ...sb,
        user_id: V.user.id,
        user_login: V.user.username,
        user_name: V.user.name,
        moderator_user_id: S.user.id,
        moderator_user_login: S.user.username,
        moderator_user_name: S.user.name,
        reason: "broke the rules",
        banned_at: new Date().toISOString(),
        ends_at: null,
        is_permanent: true,
      }),
    ];
    const mention = await vChat("gg @the", [
      { type: "text", text: "gg ", emote: null },
      { type: "mention", text: "@the", emote: null },
    ]);
    // A stranger's anonymous tip with the same fingerprint (a 100-cent `gg`) on the same channel.
    const strangerTip = await insertEvent(db(), "channel.tip", S.channel.id, {
      ...sb,
      user_id: null,
      user_login: null,
      user_name: null,
      is_anonymous: true,
      amount: { value: 100, decimal_places: 2, currency: "usd" },
      message: "gg",
    });
    const sub = await makeSubscription(db(), {
      userId: S.user.id,
      type: "channel.tip",
      condition: { broadcaster_user_id: S.user.id },
      callbackUrl: "https://hooks.example.test/cb",
      secret: "s3cr3t-s3cr3t",
    });
    const deliveryId = uuidv7();
    await db()
      .insert(schema.webhookDeliveries)
      .values({ id: deliveryId, subscriptionId: sub.id, eventId: strangerTip.id, messageId: uuidv7() });

    await schedule(T.user.id);
    expect(await runAccountDeletions(ctx())).toMatchObject({ completed: 1, failed: 0 });

    const ids = [...untouched, mention, strangerTip].map((e) => e.id);
    const left = await db().select().from(schema.events).where(inArray(schema.events.id, ids));
    expect(left.map((e) => e.id).sort()).toEqual([...ids].sort());
    for (const e of untouched) expect(left.find((x) => x.id === e.id)?.payload).toEqual(e.payload);
    const m = left.find((x) => x.id === mention.id)?.payload as {
      message: { text: string; fragments: { text: string }[] };
    };
    expect(m.message.text).toBe("gg [deleted]");
    expect(m.message.fragments.map((f) => f.text)).toEqual(["gg ", "[deleted]"]);
    expect(left.find((x) => x.id === strangerTip.id)?.payload).toEqual({
      ...strangerTip.payload,
      message: "[deleted]",
    });
    expect(
      await db().select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.id, deliveryId)),
    ).toHaveLength(1);
  });

  test("the outbox is scanned in batches: every page is matched, deleted or redacted", async () => {
    const X = await makeUser(db());
    const S = await makeUser(db());
    const sb = broadcasterFields(S.user);
    const theirs = [];
    const mentions = [];
    for (let i = 0; i < 5; i++) {
      theirs.push(
        await insertEvent(db(), "channel.follow", S.channel.id, {
          ...sb,
          user_id: X.user.id,
          user_login: X.user.username,
          user_name: X.user.name,
          followed_at: new Date().toISOString(),
        }),
      );
      mentions.push(
        await insertEvent(db(), "channel.chat.message", S.channel.id, {
          ...sb,
          chatter_user_id: S.user.id,
          chatter_user_login: S.user.username,
          chatter_user_name: S.user.name,
          message_id: uuidv7(),
          message: { text: `hi @${X.user.username}`, fragments: [] },
          reply: null,
        }),
      );
    }
    const r = await app().transaction((tx) =>
      scrubOutbox(tx, { id: X.user.id, logins: [X.user.username], email: X.user.email, tips: [] }, { batch: 2 }),
    );
    expect(r).toEqual({ events: 5, deliveries: 0, redacted: 5 });
    const left = await db()
      .select()
      .from(schema.events)
      .where(
        inArray(
          schema.events.id,
          [...theirs, ...mentions].map((e) => e.id),
        ),
      );
    expect(left.map((e) => e.id).sort()).toEqual(mentions.map((e) => e.id).sort());
    for (const e of left) expect((e.payload as { message: { text: string } }).message.text).toBe("hi [deleted]");
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
    expect(await runAccountDeletions(ctx())).toMatchObject({ completed: 1, failed: 0 });

    const [after] = await db().select().from(schema.legalHolds).where(eq(schema.legalHolds.id, hold!.id));
    expect(after).toEqual(hold);
    expect(await S3.head(MEDIA_BUCKET, `vods/${vodId}/index.m3u8`)).not.toBeNull();
    expect(await S3.head(EXPORTS_BUCKET, exportObjectKey(H.user.id, exportId))).toBeNull();

    // The media stays pending while held: every run re-checks it and keeps it.
    const pendingOf = async () =>
      (
        await db()
          .select({ p: schema.accountDeletions.pendingObjects })
          .from(schema.accountDeletions)
          .where(eq(schema.accountDeletions.userId, H.user.id))
      )[0]?.p;
    expect(await pendingOf()).toMatchObject({
      mediaPrefixes: expect.arrayContaining([`vods/${vodId}/`]),
      exportKeys: [],
    });
    expect(await runAccountDeletions(ctx())).toMatchObject({ completed: 0, objectsHeld: 1 });
    expect(await S3.head(MEDIA_BUCKET, `vods/${vodId}/index.m3u8`)).not.toBeNull();

    // Released (owner only, as the hold CLI does): the next run deletes the media and clears it.
    await db()
      .update(schema.legalHolds)
      .set({ releasedAt: new Date(), releaseReason: "test release" })
      .where(eq(schema.legalHolds.id, hold!.id));
    expect(await runAccountDeletions(ctx())).toMatchObject({ completed: 0, objectsPurged: 1 });
    expect(await S3.head(MEDIA_BUCKET, `vods/${vodId}/index.m3u8`)).toBeNull();
    expect(await pendingOf()).toBeNull();
  });

  test("the channel bot is pseudonymized with its owner; its id and role stay (E8)", async () => {
    const O = await makeUser(db());
    const botName = `${O.user.username}_bot`;
    const [bot] = await db()
      .insert(schema.users)
      .values({
        name: botName,
        email: `bot+${uuidv7()}@bots.invalid`,
        username: botName,
        displayUsername: botName,
        accountType: "bot",
        botOwnerId: O.user.id,
      })
      .returning();
    await db()
      .insert(schema.botConfigs)
      .values({ channelId: O.channel.id, config: BotConfig.parse({}), enabled: true, botUserId: bot!.id });
    await db()
      .insert(schema.channelRoles)
      .values({ channelId: O.channel.id, userId: bot!.id, role: "moderator", grantedBy: O.user.id });
    // The owner's other bots are untouched: they were named by the owner, not derived from the slug.
    const otherName = `${O.user.username}_x`;
    const [other] = await db()
      .insert(schema.users)
      .values({
        name: otherName,
        email: `bot+${uuidv7()}@bots.invalid`,
        username: otherName,
        accountType: "bot",
        botOwnerId: O.user.id,
      })
      .returning();

    await schedule(O.user.id);
    expect(await runAccountDeletions(ctx())).toMatchObject({ completed: 1, failed: 0 });

    const [b] = await db().select().from(schema.users).where(eq(schema.users.id, bot!.id));
    expect(b?.username).toMatch(/^deleted_[0-9a-f]{12}$/);
    expect(b?.displayUsername).toBe(b?.username);
    expect(b?.name).toBe(b?.username);
    expect(b?.username).not.toContain(O.user.username);
    expect(b?.accountType).toBe("bot");
    expect(b?.pseudonymizedAt).not.toBeNull();
    const [role] = await db().select().from(schema.channelRoles).where(eq(schema.channelRoles.userId, bot!.id));
    expect(role?.role).toBe("moderator");
    const [o] = await db().select().from(schema.users).where(eq(schema.users.id, other!.id));
    expect(o?.username).toBe(otherName);
  });

  test("a deleted owner's OAuth apps go with every grant; each app's connections are told to close (E9)", async () => {
    const O = await makeUser(db());
    const V = await makeUser(db());
    const appRow = await makeApp(db(), O.user.id);
    // Another user authorized the app; that token and the device code it approved go with the app.
    const tok = await makeToken(db(), appRow.id, V.user.id, ["chat:read"]);
    await db()
      .insert(schema.oauthDeviceCodes)
      .values({
        appId: appRow.id,
        deviceCodeHash: `dc_${uuidv7()}`,
        userCodeHash: `uc_${uuidv7()}`,
        scopes: ["chat:read"],
        status: "approved",
        userId: V.user.id,
        decidedAt: new Date(),
        expiresAt: new Date(Date.now() + 600_000),
      });
    // A device code the deleted user approved for someone else's app goes too.
    const W = await makeUser(db());
    const otherApp = await makeApp(db(), W.user.id);
    const [ownCode] = await db()
      .insert(schema.oauthDeviceCodes)
      .values({
        appId: otherApp.id,
        deviceCodeHash: `dc_${uuidv7()}`,
        userCodeHash: `uc_${uuidv7()}`,
        scopes: ["chat:read"],
        status: "denied",
        userId: O.user.id,
        decidedAt: new Date(),
        expiresAt: new Date(Date.now() + 600_000),
      })
      .returning();

    const listener = new Valkey(VALKEY_URL);
    const messages: string[] = [];
    listener.on("pmessage", (_pattern: string, _channel: string, message: string) => messages.push(message));
    await listener.psubscribe(`*${BUS.userControl}`);
    try {
      await schedule(O.user.id);
      expect(await runAccountDeletions(ctx())).toMatchObject({ completed: 1, failed: 0 });
      const appRemoved = await waitFor(
        async () =>
          messages
            .map((m) => JSON.parse(m) as Record<string, unknown>)
            .find((m) => m.appId === appRow.id && m.reason === "app_removed"),
        { label: "app_removed" },
      );
      expect(appRemoved).toEqual({ op: "disconnect", appId: appRow.id, reason: "app_removed" });
    } finally {
      listener.disconnect();
    }

    expect(await db().select().from(schema.oauthApps).where(eq(schema.oauthApps.id, appRow.id))).toEqual([]);
    expect(await db().select().from(schema.oauthTokens).where(eq(schema.oauthTokens.id, tok.id))).toEqual([]);
    expect(
      await db().select().from(schema.oauthDeviceCodes).where(eq(schema.oauthDeviceCodes.appId, appRow.id)),
    ).toEqual([]);
    expect(
      await db().select().from(schema.oauthDeviceCodes).where(eq(schema.oauthDeviceCodes.id, ownCode!.id)),
    ).toEqual([]);
    // The other owner's app stays.
    expect(await db().select().from(schema.oauthApps).where(eq(schema.oauthApps.id, otherApp.id))).toHaveLength(1);
  });

  test("DMCA-hidden copies of the channel's media are deleted too", async () => {
    const D = await makeUser(db());
    const [b] = await db()
      .insert(schema.broadcasts)
      .values({ channelId: D.channel.id, ingestProtocol: "rtmp", path: `live/${D.channel.slug}`, endedAt: new Date() })
      .returning();
    const vodId = uuidv7();
    const goneVodId = uuidv7();
    for (const [id, status] of [
      [vodId, "ready"],
      [goneVodId, "deleted"],
    ] as const)
      await db()
        .insert(schema.vods)
        .values({ id, broadcastId: b!.id, channelId: D.channel.id, title: "v", storagePrefix: `vods/${id}/`, status });
    const clipId = uuidv7();
    await db()
      .insert(schema.clips)
      .values({
        id: clipId,
        channelId: D.channel.id,
        broadcastId: b!.id,
        title: "c",
        startOffset: 0,
        durationSeconds: 10,
        status: "ready",
        storageKey: `clips/${clipId}.mp4`,
        thumbnailKey: `clips/${clipId}.webp`,
      });
    // Hidden copies, whatever the row's status (a VOD deleted earlier keeps its hidden copy).
    const hidden = [
      `moderation/dmca/vods/${vodId}/index.m3u8`,
      `moderation/dmca/vods/${goneVodId}/index.m3u8`,
      `moderation/dmca/clips/${clipId}.mp4`,
      `moderation/dmca/clips/${clipId}.webp`,
      `moderation/dmca/thumbnails/${b!.id}/latest.jpg`,
    ];
    for (const k of hidden) await S3.put(MEDIA_BUCKET, k, new Uint8Array([35]));

    await schedule(D.user.id);
    expect(await runAccountDeletions(ctx())).toMatchObject({ completed: 1, failed: 0 });
    for (const k of hidden) expect(await S3.head(MEDIA_BUCKET, k), k).toBeNull();
  });

  test("VOD objects are deleted under both own prefixes (and their DMCA copies), whatever storage_prefix says", async () => {
    const R = await makeUser(db());
    const [b] = await db()
      .insert(schema.broadcasts)
      .values({ channelId: R.channel.id, ingestProtocol: "rtmp", path: `live/${R.channel.slug}`, endedAt: new Date() })
      .returning();
    const vodId = uuidv7();
    await db()
      .insert(schema.vods)
      .values({
        id: vodId,
        broadcastId: b!.id,
        channelId: R.channel.id,
        title: "v",
        storagePrefix: `recordings/${vodId}/`,
        thumbnailKey: `recordings/${vodId}/thumbnail.webp`,
        status: "ready",
        visibility: "subscribers",
      });
    // A placement move was in flight: copies under both prefixes.
    const keys = [
      `recordings/${vodId}/index.m3u8`,
      `recordings/${vodId}/thumbnail.webp`,
      `vods/${vodId}/index.m3u8`,
      `moderation/dmca/recordings/${vodId}/index.m3u8`,
    ];
    for (const k of keys) await S3.put(MEDIA_BUCKET, k, new Uint8Array([35]));

    await schedule(R.user.id);
    expect(await runAccountDeletions(ctx())).toMatchObject({ completed: 1, failed: 0 });
    for (const k of keys) expect(await S3.head(MEDIA_BUCKET, k), k).toBeNull();
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
