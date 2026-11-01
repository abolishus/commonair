// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The relay purge emitter and cleanup (batch 7 decision (x), ADR 0016 Amendment 1): each event
 * writes the right prefixes exactly once, nothing is written without a relay, the feed is
 * nudged, and cleanup drops only rows past 7 days and records the watermark.
 */
import { createValkey } from "@commonair/service";
import { schema, uuidv7 } from "@commonair/db";
import { randomSecret, sha256Hex } from "@commonair/tokens";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import { job, cleanupJob } from "../src/jobs/relay-purge.ts";
import { cleanupPurges, RELAY_PURGE_WATERMARK_KEY } from "../src/relay-purge/cleanup.ts";
import { emitPurges, RELAY_PURGE_NUDGE_CHANNEL } from "../src/relay-purge/emit.ts";
import { broadcasterFields, makeBroadcast, makeUser, setup, type TestEnv, VALKEY_URL } from "./fixtures.ts";

let env: TestEnv;
beforeAll(async () => {
  env = await setup({ jobs: [], outbox: false, segments: false });
});
afterAll(async () => {
  await env.close();
});

const meta = { id: "t", attemptsMade: 0 };

async function addRelay(retired = false) {
  const { user } = await makeUser(env.t.db);
  await env.t.db.insert(schema.relayNodes).values({
    ownerId: user.id,
    name: `relay-${crypto.randomUUID().slice(0, 8)}`,
    publicUrl: "http://127.0.0.1:9999",
    declaredCapacityMbps: 100,
    publicKey: "k",
    tokenHash: await sha256Hex(randomSecret()),
    status: "active",
    ...(retired ? { retiredAt: new Date() } : {}),
  });
}

async function event(type: string, channelId: string | null, payload: Record<string, unknown>, at = new Date()) {
  const [e] = await env.t.db
    .insert(schema.events)
    .values({ id: uuidv7(), type, channelId, payload, occurredAt: at })
    .returning();
  return e!;
}

async function vod(channelId: string, broadcastId: string, status: "recording" | "ready" = "recording") {
  const id = uuidv7();
  await env.t.db
    .insert(schema.vods)
    .values({ id, broadcastId, channelId, title: "v", status, storagePrefix: `recordings/${id}/` });
  return id;
}

const rows = () =>
  env.t.db
    .select({ seq: schema.relayPurges.seq, prefix: schema.relayPurges.prefix, reason: schema.relayPurges.reason })
    .from(schema.relayPurges)
    .orderBy(asc(schema.relayPurges.seq));

async function clear() {
  // Rows younger than 7 days cannot be deleted by the app role; the test owner can.
  await env.t.sql`alter table relay_purges disable trigger relay_purges_guard`;
  await env.t.db.delete(schema.relayPurges);
  await env.t.sql`alter table relay_purges enable trigger relay_purges_guard`;
}

describe("emit", () => {
  test("no relay (or only retired ones): nothing is written", async () => {
    const { channel } = await makeUser(env.t.db);
    const e = await event("media.vod.state", channel.id, {
      vod_id: uuidv7(),
      channel_id: channel.id,
      public: false,
      reason: "moderation",
    });
    expect(await emitPurges(env.worker.ctx, e.id)).toEqual({ written: 0, skipped: 0, noRelays: 1 });
    await addRelay(true);
    expect(await emitPurges(env.worker.ctx, e.id)).toMatchObject({ noRelays: 1 });
    expect(await rows()).toEqual([]);
  });

  describe("with a relay", () => {
    beforeAll(async () => {
      await addRelay();
    });
    beforeEach(clear);

    test("a VOD going non-public purges its DVR once; going public purges nothing", async () => {
      const { channel } = await makeUser(env.t.db);
      const vodId = uuidv7();
      const hidden = await event("media.vod.state", channel.id, {
        vod_id: vodId,
        channel_id: channel.id,
        public: false,
        reason: "visibility",
      });
      expect(await job.handler({ eventId: hidden.id }, env.worker.ctx, meta)).toEqual({ written: 1, skipped: 0 });
      // Redelivered: idempotent.
      expect(await job.handler({ eventId: hidden.id }, env.worker.ctx, meta)).toEqual({ written: 0, skipped: 1 });
      const shown = await event("media.vod.state", channel.id, {
        vod_id: vodId,
        channel_id: channel.id,
        public: true,
        reason: "visibility",
      });
      expect(await emitPurges(env.worker.ctx, shown.id)).toEqual({ written: 0, skipped: 0 });
      expect(await rows()).toEqual([{ seq: expect.any(Number), prefix: `dvr/${vodId}/`, reason: "vod_hidden" }]);
    });

    test("a later event for the same prefix writes a new row", async () => {
      const { channel } = await makeUser(env.t.db);
      const vodId = uuidv7();
      const payload = { vod_id: vodId, channel_id: channel.id, public: false, reason: "moderation" };
      const first = await event("media.vod.state", channel.id, payload);
      await emitPurges(env.worker.ctx, first.id);
      // Occurred after the first row was written: it needs its own purge.
      const second = await event("media.vod.state", channel.id, payload, new Date(Date.now() + 1_000));
      expect(await emitPurges(env.worker.ctx, second.id)).toEqual({ written: 1, skipped: 0 });
      expect((await rows()).map((r) => r.prefix)).toEqual([`dvr/${vodId}/`, `dvr/${vodId}/`]);
    });

    test("a restriction purges the live path and the broadcast's recording", async () => {
      const { channel } = await makeUser(env.t.db);
      const b = await makeBroadcast(env.t.db, channel.id);
      const rec = await vod(channel.id, b.id);
      await vod(channel.id, b.id, "ready");
      const lifted = await event("moderation.restriction", channel.id, {
        broadcast_id: b.id,
        channel_id: channel.id,
        case_id: uuidv7(),
        restricted: false,
      });
      expect(await emitPurges(env.worker.ctx, lifted.id)).toEqual({ written: 0, skipped: 0 });
      const e = await event("moderation.restriction", channel.id, {
        broadcast_id: b.id,
        channel_id: channel.id,
        case_id: uuidv7(),
        restricted: true,
      });
      expect(await emitPurges(env.worker.ctx, e.id)).toEqual({ written: 2, skipped: 0 });
      expect(await emitPurges(env.worker.ctx, e.id)).toEqual({ written: 0, skipped: 2 });
      expect((await rows()).map(({ prefix, reason }) => ({ prefix, reason }))).toEqual([
        { prefix: `dvr/${rec}/`, reason: "restricted" },
        { prefix: `live/${channel.slug}/`, reason: "restricted" },
      ]);
    });

    test("a suspension purges the live path and every recording of the channel", async () => {
      const { channel } = await makeUser(env.t.db);
      const b = await makeBroadcast(env.t.db, channel.id);
      const rec = await vod(channel.id, b.id);
      const e = await event("channel.suspension", channel.id, { channel_id: channel.id, suspended: true });
      expect(await emitPurges(env.worker.ctx, e.id)).toEqual({ written: 2, skipped: 0 });
      const lifted = await event("channel.suspension", channel.id, { channel_id: channel.id, suspended: false });
      expect(await emitPurges(env.worker.ctx, lifted.id)).toEqual({ written: 0, skipped: 0 });
      expect((await rows()).map(({ prefix, reason }) => ({ prefix, reason }))).toEqual([
        { prefix: `dvr/${rec}/`, reason: "suspended" },
        { prefix: `live/${channel.slug}/`, reason: "suspended" },
      ]);
    });

    test("stream.offline purges the ended broadcast's VODs, not another broadcast's", async () => {
      const { user, channel } = await makeUser(env.t.db);
      const t0 = Date.now() - 60_000;
      const older = await makeBroadcast(env.t.db, channel.id, new Date(t0 - 60_000));
      await env.t.db
        .update(schema.broadcasts)
        .set({ endedAt: new Date(t0 - 30_000) })
        .where(eq(schema.broadcasts.id, older.id));
      await vod(channel.id, older.id, "ready");
      const b = await makeBroadcast(env.t.db, channel.id, new Date(t0));
      const ended = new Date();
      await env.t.db.update(schema.broadcasts).set({ endedAt: ended }).where(eq(schema.broadcasts.id, b.id));
      const rec = await vod(channel.id, b.id);
      const e = await event(
        "stream.offline",
        channel.id,
        broadcasterFields({ ...user, username: channel.slug }),
        ended,
      );
      expect(await emitPurges(env.worker.ctx, e.id)).toEqual({ written: 1, skipped: 0 });
      expect(await rows()).toEqual([{ seq: expect.any(Number), prefix: `dvr/${rec}/`, reason: "recording_ended" }]);
      // A broadcast without a recording purges nothing.
      const { user: u2, channel: c2 } = await makeUser(env.t.db);
      const b2 = await makeBroadcast(env.t.db, c2.id);
      await env.t.db.update(schema.broadcasts).set({ endedAt: ended }).where(eq(schema.broadcasts.id, b2.id));
      const e2 = await event("stream.offline", c2.id, broadcasterFields({ ...u2, username: c2.slug }), ended);
      expect(await emitPurges(env.worker.ctx, e2.id)).toEqual({ written: 0, skipped: 0 });
    });

    test("other events and unknown ids write nothing", async () => {
      const { channel } = await makeUser(env.t.db);
      const clip = await event("media.clip.state", channel.id, {
        clip_id: uuidv7(),
        channel_id: channel.id,
        public: false,
        reason: "moderation",
      });
      expect(await emitPurges(env.worker.ctx, clip.id)).toEqual({ written: 0, skipped: 0 });
      expect(await emitPurges(env.worker.ctx, uuidv7())).toEqual({ written: 0, skipped: 0, missing: 1 });
      expect(await rows()).toEqual([]);
    });

    test("concurrent runs of one event write one row", async () => {
      const { channel } = await makeUser(env.t.db);
      const e = await event("media.vod.state", channel.id, {
        vod_id: uuidv7(),
        channel_id: channel.id,
        public: false,
        reason: "dmca",
      });
      const results = await Promise.all([1, 2, 3].map(() => emitPurges(env.worker.ctx, e.id)));
      expect(results.reduce((a, r) => a + r.written, 0)).toBe(1);
      expect(await rows()).toHaveLength(1);
    });

    test("a write nudges the feed's pub/sub channel", async () => {
      const sub = createValkey(VALKEY_URL, { name: "relay-purge-test-sub" });
      try {
        const got: string[] = [];
        sub.on("message", (ch: string, msg: string) => {
          if (ch === RELAY_PURGE_NUDGE_CHANNEL) got.push(msg);
        });
        await sub.subscribe(RELAY_PURGE_NUDGE_CHANNEL);
        const { channel } = await makeUser(env.t.db);
        const e = await event("media.vod.state", channel.id, {
          vod_id: uuidv7(),
          channel_id: channel.id,
          public: false,
          reason: "moderation",
        });
        await job.handler({ eventId: e.id }, env.worker.ctx, meta);
        const deadline = Date.now() + 2_000;
        while (got.length === 0 && Date.now() < deadline) await Bun.sleep(10);
        expect(got.length).toBeGreaterThanOrEqual(1);
      } finally {
        sub.disconnect();
      }
    });
  });
});

describe("cleanup", () => {
  beforeEach(async () => {
    await clear();
    await env.worker.ctx.valkey.del(RELAY_PURGE_WATERMARK_KEY);
  });

  test("drops rows older than 7 days, keeps younger ones, and records the highest deleted seq", async () => {
    const day = 86_400_000;
    const at = (ms: number) => new Date(Date.now() - ms);
    const inserted = await env.t.db
      .insert(schema.relayPurges)
      .values([
        { prefix: "dvr/a/", reason: "vod_hidden", createdAt: at(9 * day) },
        { prefix: "dvr/b/", reason: "vod_hidden", createdAt: at(7 * day + 60_000) },
        { prefix: "dvr/c/", reason: "vod_hidden", createdAt: at(7 * day - 60_000) },
        { prefix: "live/x/", reason: "suspended", createdAt: at(0) },
      ])
      .returning({ seq: schema.relayPurges.seq });
    expect(await cleanupPurges(env.worker.ctx)).toEqual({ deleted: 2, watermark: inserted[1]!.seq });
    expect((await rows()).map((r) => r.prefix)).toEqual(["dvr/c/", "live/x/"]);
    expect(Number(await env.worker.ctx.valkey.get(RELAY_PURGE_WATERMARK_KEY))).toBe(inserted[1]!.seq);
    // Nothing old: no change, and the watermark never goes down.
    expect(await cleanupJob.handler({}, env.worker.ctx, meta)).toEqual({ deleted: 0, watermark: inserted[1]!.seq });
  });

  test("the watermark only grows", async () => {
    await env.worker.ctx.valkey.set(RELAY_PURGE_WATERMARK_KEY, String(Number.MAX_SAFE_INTEGER - 1));
    await env.t.db
      .insert(schema.relayPurges)
      .values({ prefix: "dvr/a/", reason: "vod_hidden", createdAt: new Date(Date.now() - 8 * 86_400_000) });
    const r = await cleanupPurges(env.worker.ctx);
    expect(r).toEqual({ deleted: 1, watermark: Number.MAX_SAFE_INTEGER - 1 });
  });

  test("the app role cannot delete a younger row", async () => {
    await env.t.db.insert(schema.relayPurges).values({ prefix: "dvr/a/", reason: "vod_hidden" });
    await expect(env.t.app.db.delete(schema.relayPurges)).rejects.toMatchObject({
      cause: { message: expect.stringContaining("kept 7 days") },
    });
  });
});
