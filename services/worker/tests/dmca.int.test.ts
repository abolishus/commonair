// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `dmca-disable` and `dmca-restore` against Postgres and an in-memory bucket (17 U.S.C. § 512;
 * not reviewed by a lawyer): objects move to the private prefix and back, the restore puts the
 * objects back before un-hiding, skips suit-filed and not-yet-due counter-notices, reverses the
 * notice's strike and an under-threshold termination, and leaves a retention-deleted VOD deleted.
 */
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { schema, uuidv7 } from "@commonair/db";
import { MemoryMailer } from "@commonair/email";
import type { ObjectInfo, ObjectStorage } from "@commonair/storage";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import type { WorkerContext } from "../src/context.ts";
import { disableNoticeObjects } from "../src/dmca/disable.ts";
import { DMCA_HIDDEN_PREFIX, dmcaHiddenKey } from "../src/dmca/objects.ts";
import { runDmcaRestoreOnce } from "../src/dmca/restore.ts";
import { siteAt } from "./e6-fixtures.ts";
import { makeBroadcast, makeUser } from "./fixtures.ts";

const BUCKET = "media";
const site = siteAt("http://localhost:3000");

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
}, 60_000);
afterAll(() => t?.drop());

/** In-memory bucket; `onPut` sees every write (to check what the database says at that moment). */
function memoryStorage(onPut?: (key: string) => Promise<void>) {
  const objects = new Map<string, Uint8Array>();
  const storage = {
    async put(_bucket: string, key: string, body: BodyInit) {
      await onPut?.(key);
      objects.set(key, new Uint8Array(await new Response(body).arrayBuffer()));
    },
    async get(_bucket: string, key: string) {
      const b = objects.get(key);
      return b ? new Response(new Uint8Array(b)) : null;
    },
    async delete(_bucket: string, key: string) {
      objects.delete(key);
    },
    async *list(_bucket: string, prefix: string): AsyncIterable<ObjectInfo> {
      for (const [key, b] of objects)
        if (key.startsWith(prefix)) yield { key, size: b.byteLength, etag: "", lastModified: new Date(0) };
    },
  };
  return { objects, storage: storage as unknown as ObjectStorage };
}

function context(storage: ObjectStorage, mailer: MemoryMailer, published: string[]): WorkerContext {
  return {
    db: t.db,
    storage,
    mediaBucket: BUCKET,
    mailer,
    site,
    now: () => new Date(),
    logger: { info() {}, warn() {}, error() {}, debug() {}, fatal() {} },
    moderation: { testHooks: true },
    valkey: {
      async publish(_channel: string, msg: string) {
        published.push(msg);
        return 1;
      },
    },
  } as unknown as WorkerContext;
}

const bytes = (s: string) => new TextEncoder().encode(s);

interface Fixture {
  userId: string;
  email: string;
  channelId: string;
  vodId: string;
  clipOfVod: string;
  lone: string;
  keys: { vod: string[]; clipOfVod: string; lone: string; thumb: string };
}

async function content(objects: Map<string, Uint8Array>): Promise<Fixture> {
  const { user, channel } = await makeUser(t.db);
  const b = await makeBroadcast(t.db, channel.id, new Date(Date.now() - 3_600_000));
  const other = await makeBroadcast(t.db, channel.id, new Date(Date.now() - 7_200_000));
  const vodId = uuidv7();
  await t.db.insert(schema.vods).values({
    id: vodId,
    broadcastId: b.id,
    channelId: channel.id,
    title: "the vod",
    storagePrefix: `vods/${vodId}/`,
    thumbnailKey: `thumbnails/${b.id}/vod.jpg`,
    status: "ready",
  });
  const clipOfVod = uuidv7();
  const lone = uuidv7();
  for (const [id, bid, vid] of [
    [clipOfVod, b.id, vodId],
    [lone, other.id, null],
  ] as const)
    await t.db.insert(schema.clips).values({
      id,
      channelId: channel.id,
      broadcastId: bid,
      vodId: vid,
      title: "the clip",
      startOffset: 0,
      durationSeconds: 5,
      status: "ready",
      storageKey: `clips/${id}.mp4`,
    });
  const keys = {
    vod: [`vods/${vodId}/index.m3u8`, `vods/${vodId}/seg0.ts`],
    clipOfVod: `clips/${clipOfVod}.mp4`,
    lone: `clips/${lone}.mp4`,
    thumb: `thumbnails/${b.id}/vod.jpg`,
  };
  for (const k of [...keys.vod, keys.clipOfVod, keys.lone, keys.thumb]) objects.set(k, bytes(k));
  return { userId: user.id, email: user.email, channelId: channel.id, vodId, clipOfVod, lone, keys };
}

/** What `safety.dmca.action` → actioned leaves behind for these subjects (and the owner's strike). */
async function actioned(f: Fixture, subjects: { type: "vod" | "clip"; id: string }[], at = new Date()) {
  const [n] = await t.db
    .insert(schema.dmcaNotices)
    .values({
      claimantName: "c",
      claimantEmail: "c@example.test",
      claimantAddress: "a",
      copyrightedWork: "w",
      infringingUrls: subjects.map((s) => `https://example.test/${s.id}`),
      goodFaithStatement: true,
      accuracyStatement: true,
      signature: "c",
      status: "actioned",
      actionedAt: at,
    })
    .returning();
  const noticeId = n!.id;
  const itemIds: string[] = [];
  for (const s of subjects) {
    const tbl = s.type === "vod" ? schema.vods : schema.clips;
    await t.db.update(tbl).set({ removedReason: "dmca" }).where(eq(tbl.id, s.id));
    const [i] = await t.db
      .insert(schema.dmcaNoticeItems)
      .values({
        noticeId,
        url: `https://example.test/${s.id}`,
        subjectType: s.type,
        subjectId: s.id,
        ownerId: f.userId,
        channelId: f.channelId,
        removedAt: at,
      })
      .returning();
    itemIds.push(i!.id);
  }
  await t.db.insert(schema.accountActions).values({
    userId: f.userId,
    action: "dmca_strike",
    sourceType: "dmca_notice",
    sourceId: noticeId,
    actorType: "moderator",
    actorId: uuidv7(),
    createdAt: at,
  });
  return { noticeId, itemIds };
}

async function counter(noticeId: string, userId: string, itemIds: string[], restoreAfter: Date) {
  const [c] = await t.db
    .insert(schema.dmcaCounterNotices)
    .values({
      noticeId,
      userId,
      fullName: "Ada",
      address: "2 Lane",
      phone: "+1 555 0200",
      itemIds,
      statement: "mistake",
      goodFaithStatement: true,
      consentToJurisdiction: true,
      signature: "Ada",
      restoreAfter,
    })
    .returning();
  await t.db.update(schema.dmcaNotices).set({ status: "countered" }).where(eq(schema.dmcaNotices.id, noticeId));
  return c!;
}

const reasonOf = async (type: "vod" | "clip", id: string) => {
  const tbl = type === "vod" ? schema.vods : schema.clips;
  const [r] = await t.db.select({ s: tbl.status, r: tbl.removedReason }).from(tbl).where(eq(tbl.id, id));
  return r;
};

describe("dmca-disable", () => {
  test("moves the VOD prefix, its clips, its thumbnail and the clip to the private prefix, once", async () => {
    const { objects, storage } = memoryStorage();
    const f = await content(objects);
    const { noticeId, itemIds } = await actioned(f, [
      { type: "vod", id: f.vodId },
      { type: "clip", id: f.lone },
    ]);
    const ctx = context(storage, new MemoryMailer({ site }), []);
    const first = await disableNoticeObjects(ctx, { noticeId });
    expect(first).toEqual({ items: 2, objects: 5 });
    for (const k of [...f.keys.vod, f.keys.clipOfVod, f.keys.lone, f.keys.thumb]) {
      expect(objects.has(k), k).toBe(false);
      expect(objects.has(dmcaHiddenKey(k)), k).toBe(true);
    }
    expect(dmcaHiddenKey("clips/x.mp4")).toBe(`${DMCA_HIDDEN_PREFIX}clips/x.mp4`);
    expect(DMCA_HIDDEN_PREFIX.startsWith("moderation/")).toBe(true);
    const items = await t.db.select().from(schema.dmcaNoticeItems).where(eq(schema.dmcaNoticeItems.noticeId, noticeId));
    expect(items.every((i) => i.objectsHiddenAt !== null)).toBe(true);
    // Idempotent: nothing left, nothing moved, the hidden copies stay.
    expect(await disableNoticeObjects(ctx, { noticeId })).toEqual({ items: 0, objects: 0 });
    expect(objects.has(dmcaHiddenKey(f.keys.lone))).toBe(true);
    expect(itemIds).toHaveLength(2);
  });

  test("a retry after a crash between the move and the mark finds the objects already moved", async () => {
    const { objects, storage } = memoryStorage();
    const f = await content(objects);
    const { noticeId } = await actioned(f, [{ type: "clip", id: f.lone }]);
    // The objects moved but the item was never marked.
    objects.set(dmcaHiddenKey(f.keys.lone), objects.get(f.keys.lone)!);
    objects.delete(f.keys.lone);
    const r = await disableNoticeObjects(context(storage, new MemoryMailer({ site }), []), { noticeId });
    expect(r).toEqual({ items: 1, objects: 0 });
    expect(objects.has(dmcaHiddenKey(f.keys.lone))).toBe(true);
  });
});

describe("dmca-restore", () => {
  test("moves the objects back before un-hiding, reverses the strike, marks everything restored, mails the owner", async () => {
    const reasonsAtPut: (string | null | undefined)[] = [];
    let fx: Fixture | null = null;
    const { objects, storage } = memoryStorage(async (key) => {
      if (fx && key === fx.keys.lone) reasonsAtPut.push((await reasonOf("clip", fx.lone))?.r);
    });
    const f = await content(objects);
    fx = f;
    const mailer = new MemoryMailer({ site });
    const ctx = context(storage, mailer, []);
    const { noticeId, itemIds } = await actioned(f, [
      { type: "vod", id: f.vodId },
      { type: "clip", id: f.lone },
    ]);
    await disableNoticeObjects(ctx, { noticeId });
    const due = new Date("2030-01-07T12:00:00Z");
    const c = await counter(noticeId, f.userId, itemIds, due);

    const early = await runDmcaRestoreOnce(ctx, new Date(due.getTime() - 60_000));
    expect(early.counters).toBe(0);
    expect((await reasonOf("clip", f.lone))?.r).toBe("dmca");
    expect(objects.has(f.keys.lone)).toBe(false);

    const r = await runDmcaRestoreOnce(ctx, new Date(due.getTime() + 60_000));
    expect(r.counters).toBeGreaterThanOrEqual(1);
    expect(r.restored).toBeGreaterThanOrEqual(2);
    // The object went back while the clip was still hidden.
    expect(reasonsAtPut).toEqual(["dmca"]);
    expect(await reasonOf("clip", f.lone)).toEqual({ s: "ready", r: null });
    expect(await reasonOf("vod", f.vodId)).toEqual({ s: "ready", r: null });
    for (const k of [...f.keys.vod, f.keys.clipOfVod, f.keys.lone, f.keys.thumb]) {
      expect(objects.has(k), k).toBe(true);
      expect(objects.has(dmcaHiddenKey(k)), k).toBe(false);
    }
    const [cc] = await t.db.select().from(schema.dmcaCounterNotices).where(eq(schema.dmcaCounterNotices.id, c.id));
    expect(cc?.restoredAt).not.toBeNull();
    const items = await t.db.select().from(schema.dmcaNoticeItems).where(eq(schema.dmcaNoticeItems.noticeId, noticeId));
    expect(items.every((i) => i.restoredAt !== null)).toBe(true);
    const [n] = await t.db.select().from(schema.dmcaNotices).where(eq(schema.dmcaNotices.id, noticeId));
    expect(n?.status).toBe("restored");
    const [strike] = await t.db
      .select()
      .from(schema.accountActions)
      .where(and(eq(schema.accountActions.sourceId, noticeId), eq(schema.accountActions.action, "dmca_strike")));
    expect(strike).toMatchObject({ reversedReason: "counter_notice_restored", reversedById: null });
    const [a] = await t.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectId, noticeId), eq(schema.auditLog.action, "dmca.content.restore")));
    expect(a).toMatchObject({ actorType: "system" });
    expect(a?.details).toMatchObject({ noticeId, counterNoticeId: c.id, restoredItems: 2, restorable: true });
    const events = (await t.db.select().from(schema.events)).filter(
      (e) =>
        (e.payload as { notice_id?: string }).notice_id === noticeId ||
        (e.payload as { account_action_id?: string }).account_action_id === strike?.id,
    );
    expect(events.map((e) => e.type).sort()).toEqual(["account.action.reversed", "dmca.content.restored"]);
    const mail = mailer.to(f.email);
    expect(mail).toHaveLength(1);
    expect(mail[0]?.subject).toContain("available again");

    // Nothing is due twice.
    const again = await runDmcaRestoreOnce(ctx, new Date(due.getTime() + 120_000));
    expect(mailer.to(f.email)).toHaveLength(1);
    expect(again.restored).toBe(0);
  });

  test("a counter-notice with a suit filed is never restored", async () => {
    const { objects, storage } = memoryStorage();
    const f = await content(objects);
    const ctx = context(storage, new MemoryMailer({ site }), []);
    const { noticeId, itemIds } = await actioned(f, [{ type: "clip", id: f.lone }]);
    await disableNoticeObjects(ctx, { noticeId });
    const c = await counter(noticeId, f.userId, itemIds, new Date("2030-02-04T12:00:00Z"));
    await t.db
      .update(schema.dmcaCounterNotices)
      .set({ suitFiledAt: new Date(), suitRecordedById: uuidv7(), suitNote: "docket" })
      .where(eq(schema.dmcaCounterNotices.id, c.id));
    await runDmcaRestoreOnce(ctx, new Date("2030-03-01T00:00:00Z"));
    expect((await reasonOf("clip", f.lone))?.r).toBe("dmca");
    expect(objects.has(f.keys.lone)).toBe(false);
    expect(objects.has(dmcaHiddenKey(f.keys.lone))).toBe(true);
    const [cc] = await t.db.select().from(schema.dmcaCounterNotices).where(eq(schema.dmcaCounterNotices.id, c.id));
    expect(cc?.restoredAt).toBeNull();
  });

  test("material another active notice still holds stays down", async () => {
    const { objects, storage } = memoryStorage();
    const f = await content(objects);
    const ctx = context(storage, new MemoryMailer({ site }), []);
    const first = await actioned(f, [{ type: "clip", id: f.lone }]);
    const second = await actioned(f, [{ type: "clip", id: f.lone }]);
    await disableNoticeObjects(ctx, { noticeId: first.noticeId });
    await counter(first.noticeId, f.userId, first.itemIds, new Date("2030-04-01T12:00:00Z"));
    await runDmcaRestoreOnce(ctx, new Date("2030-04-02T00:00:00Z"));
    expect((await reasonOf("clip", f.lone))?.r).toBe("dmca");
    expect(objects.has(f.keys.lone)).toBe(false);
    expect(second.itemIds).toHaveLength(1);
  });

  test("reverses a termination now under the threshold and lifts only the DMCA suspension", async () => {
    const { objects, storage } = memoryStorage();
    const f = await content(objects);
    const published: string[] = [];
    const ctx = context(storage, new MemoryMailer({ site }), published);
    // Strikes inside the window as of the restore.
    const at = new Date("2030-05-01T12:00:00Z");
    const a = await actioned(f, [{ type: "clip", id: f.lone }], at);
    await actioned(f, [{ type: "clip", id: f.clipOfVod }], at);
    await actioned(f, [{ type: "vod", id: f.vodId }], at);
    const [term] = await t.db
      .insert(schema.accountActions)
      .values({
        userId: f.userId,
        action: "dmca_termination",
        sourceType: "dmca_notice",
        sourceId: a.noticeId,
        actorType: "moderator",
        actorId: uuidv7(),
      })
      .returning();
    await t.db
      .update(schema.users)
      .set({ banned: true, banReason: "dmca_repeat_infringer" })
      .where(eq(schema.users.id, f.userId));
    await counter(a.noticeId, f.userId, a.itemIds, new Date("2030-05-06T12:00:00Z"));
    await runDmcaRestoreOnce(ctx, new Date("2030-05-07T00:00:00Z"));
    const [after] = await t.db.select().from(schema.accountActions).where(eq(schema.accountActions.id, term!.id));
    expect(after?.reversedReason).toBe("strikes_below_threshold");
    const [u] = await t.db.select().from(schema.users).where(eq(schema.users.id, f.userId));
    expect(u).toMatchObject({ banned: false, banReason: null });
    expect(published.map((m) => JSON.parse(m) as { op: string; userId: string })).toContainEqual(
      expect.objectContaining({ op: "invalidate", userId: f.userId }),
    );
  });

  test("a termination still at the threshold after the restore stays in force", async () => {
    const { objects, storage } = memoryStorage();
    const f = await content(objects);
    const extra = await content(objects);
    const ctx = context(storage, new MemoryMailer({ site }), []);
    const at = new Date("2030-07-01T12:00:00Z");
    const a = await actioned(f, [{ type: "clip", id: f.lone }], at);
    await actioned(f, [{ type: "clip", id: f.clipOfVod }], at);
    await actioned(f, [{ type: "vod", id: f.vodId }], at);
    // A fourth strike for the same owner.
    await actioned({ ...extra, userId: f.userId }, [{ type: "clip", id: extra.lone }], at);
    const [term] = await t.db
      .insert(schema.accountActions)
      .values({ userId: f.userId, action: "dmca_termination", actorType: "moderator", actorId: uuidv7() })
      .returning();
    await counter(a.noticeId, f.userId, a.itemIds, new Date("2030-07-02T12:00:00Z"));
    await runDmcaRestoreOnce(ctx, new Date("2030-07-03T00:00:00Z"));
    const [after] = await t.db.select().from(schema.accountActions).where(eq(schema.accountActions.id, term!.id));
    expect(after?.reversedAt).toBeNull();
  });

  test("a VOD deleted by retention while down stays deleted, and its objects stay private", async () => {
    const { objects, storage } = memoryStorage();
    const f = await content(objects);
    const ctx = context(storage, new MemoryMailer({ site }), []);
    const { noticeId, itemIds } = await actioned(f, [{ type: "vod", id: f.vodId }]);
    await disableNoticeObjects(ctx, { noticeId });
    // Housekeeping: `status = 'deleted'`, `removed_reason = coalesce(removed_reason, 'retention')`.
    await t.db.update(schema.vods).set({ status: "deleted" }).where(eq(schema.vods.id, f.vodId));
    await counter(noticeId, f.userId, itemIds, new Date("2030-06-03T12:00:00Z"));
    await runDmcaRestoreOnce(ctx, new Date("2030-06-04T00:00:00Z"));
    expect(await reasonOf("vod", f.vodId)).toEqual({ s: "deleted", r: "retention" });
    for (const k of f.keys.vod) expect(objects.has(k), k).toBe(false);
    const [a] = await t.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectId, noticeId), eq(schema.auditLog.action, "dmca.content.restore")));
    expect(a?.details).toMatchObject({ restorable: false, unrestorableItems: 1 });
    const [item] = await t.db
      .select()
      .from(schema.dmcaNoticeItems)
      .where(eq(schema.dmcaNoticeItems.noticeId, noticeId));
    expect(item?.restoredAt).not.toBeNull();
  });
});
